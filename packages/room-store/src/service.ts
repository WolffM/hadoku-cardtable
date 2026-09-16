/*
 * P5 — the service participant.
 *
 * A `role: 'service'` with an attachment lifecycle the room owns: attach,
 * detach, heartbeat, crash → the room survives, clients are told, state resyncs
 * on re-attach. Transport-agnostic: `ServicePeer` is two methods, this file
 * never imports `socket.io`, and the clock is injected so ten minutes of
 * `holdMs` is a test that runs instantly.
 *
 * ## A service does NOT hold a seat, and this is not negotiable
 *
 * `SeatRole` is `'player' | 'spectator'`, DERIVED from the seat table by
 * `roleOf` and never stored; `SeatOccupant` admits `human` and `bot`. Widening
 * either would give a service a draft slot, put it in `humanSeats` and count it
 * against `capacity`. So the lifecycle hangs off the room BESIDE the seat table,
 * not inside it — which is also why nothing here needs a fourth
 * `ParticipantId` tier: a service is identified by its peer id, and a peer id is
 * never seated, never rostered and never counted.
 *
 * ## `lost` is entered by the room's clock, not by the peer
 *
 * That is the distinction between `lost` and `detached` and it is the one that
 * earns its keep: a crashed process cannot tell you it crashed. A clean shutdown
 * and a crash want different behaviour from the room — the first makes it
 * reap-eligible immediately, the second holds it open for `holdMs` while a
 * replacement starts — and only the room can tell them apart.
 *
 *              attach()                    ack()
 *   detached  ──────────▶  attaching  ──────────▶  attached
 *       ▲                      │                    │   │ missed heartbeats
 *       │◀── reject/timeout ───┘                    │   ▼
 *       │◀── detach('shutdown'|'handoff') ──────────┘  lost ── attach() ──▶ attaching
 *       └────────────── holdMs elapsed ───────────────┘
 */

import {
  evaluateRoom,
  SKIP,
  type ClientMeta,
  type CoreRoomState,
  type GCEvalResult,
  type GCTimings,
} from '@wolffm/rooms-server';
import type { SeatTable } from '@wolffm/rooms-protocol';
import { systemClock, type Clock, type TimerHandle } from './clock.ts';

/** The transport seam. The host implements it; this package never sees a socket. */
export interface ServicePeer {
  /** Stable across restarts of the peer process. */
  readonly id: string;
  send(envelope: unknown): void;
  close(reason: string): void;
}

export type ServiceStatus = 'detached' | 'attaching' | 'attached' | 'lost';

export type DetachReason = 'shutdown' | 'handoff';

/** Calibration from P5 §6. A draft round is longer than a redeploy plus a cold start. */
export const DEFAULT_SERVICE_CONFIG = {
  heartbeatMs: 5_000,
  lossAfterMs: 15_000,
  holdMs: 10 * 60_000,
} as const;

export interface ServiceConfig {
  /** How often the peer is expected to beat. */
  heartbeatMs: number;
  /** No heartbeat for this long ⇒ `lost`. */
  lossAfterMs: number;
  /** Stay alive in `lost` this long before falling back to `detached`. */
  holdMs: number;
  /** Which client action kinds are routed to the service. */
  routes: (kind: string) => boolean;
  /** How long an `attaching` handshake may take before it is abandoned. */
  attachTimeoutMs?: number;
}

/**
 * What clients are told. §5.2: a room-level status, not an error toast and not a
 * generic disconnect — "your socket dropped" and "the table's engine dropped"
 * need different UI (a spinner versus a spinner plus a hard input lock), so they
 * are different notices.
 */
export interface ServiceNotice {
  kind: 'service-attached' | 'service-lost' | 'service-detached';
  roomId: string;
  at: number;
  /** Present on `service-detached`. Absent on a crash, which announces nothing. */
  reason?: DetachReason;
}

export interface ServiceSession<TClient> {
  /** The attached peer's id. Not a `ParticipantId`: a service is never seated. */
  serviceId: string;
  /** §5.6 — handed the roster, not asked to guess it. */
  roster: ReadonlyArray<ClientMeta<TClient>>;
  seats: SeatTable;
  /**
   * Push a full state, projected per recipient.
   *
   * §5.3's other half: this also OPENS the delta window. Until a snapshot has
   * been published in the current generation, `publishDelta` refuses.
   */
  publishSnapshot<P>(project: (client: ClientMeta<TClient>) => P | typeof SKIP): void;
}

export type ServiceErrorCode =
  /** The action's kind is not routed to the service at all. */
  | 'not-service-routed'
  /** §4 — the service is not `attached`. */
  | 'service-unavailable'
  /** §5.5 — a service is already `attached`, or a handshake is in flight. */
  | 'service-already-attached'
  /** The handshake did not complete inside `attachTimeoutMs`. */
  | 'attach-timeout'
  /** §5.3 — a delta was offered before the post-loss snapshot. */
  | 'delta-before-snapshot';

export interface ServiceError {
  code: ServiceErrorCode;
  status: ServiceStatus;
  message: string;
}

/** A typed rejection, never a throw — the same reasoning as the engine's. */
export type ServiceResult<T = void> = { ok: true; value: T } | { ok: false; error: ServiceError };

function fail(code: ServiceErrorCode, status: ServiceStatus, message: string): ServiceResult<never> {
  return { ok: false, error: { code, status, message } };
}

/**
 * The one place a rejection is a throw rather than a value: `attach` returns a
 * promise, and a promise's failure channel is an exception. It carries the same
 * typed `code`/`status` as every other rejection here.
 */
export class ServiceRejection extends Error implements ServiceError {
  readonly code: ServiceErrorCode;
  readonly status: ServiceStatus;
  constructor(code: ServiceErrorCode, status: ServiceStatus, message: string) {
    super(message);
    this.name = 'ServiceRejection';
    this.code = code;
    this.status = status;
  }
}

export interface ServiceLifecycleOptions {
  clock?: Clock;
  /** Fans a notice out to the room's clients. Called at most once per transition. */
  onNotice?: (notice: ServiceNotice) => void;
  onStatusChange?: (from: ServiceStatus, to: ServiceStatus) => void;
}

/**
 * The lifecycle for one room.
 *
 * Exactly one service per room (§5.5). Two processes writing one game is the
 * failure least worth debugging, so the room refuses rather than arbitrates.
 */
export class ServiceLifecycle<TApp, TClient = unknown> {
  readonly config: ServiceConfig;

  #room: CoreRoomState<TApp, TClient>;
  #clock: Clock;
  #onNotice: (notice: ServiceNotice) => void;
  #onStatusChange: (from: ServiceStatus, to: ServiceStatus) => void;

  #status: ServiceStatus = 'detached';
  #peer: ServicePeer | null = null;
  #pending: {
    peer: ServicePeer;
    resolve: (session: ServiceSession<TClient>) => void;
    reject: (err: ServiceRejection) => void;
    timer: TimerHandle;
    /** Preserved so a failed replacement attach does not shorten the hold. */
    holdDeadline: number | null;
  } | null = null;
  /** What the last `publishSnapshot` built, per recipient. */
  #lastSnapshot: Array<{ client: ClientMeta<TClient>; payload: unknown }> = [];

  #lastHeartbeat = 0;
  #lossTimer: TimerHandle | null = null;
  #holdTimer: TimerHandle | null = null;
  #holdDeadline: number | null = null;

  /**
   * Bumped on every transition into `lost`. §5.3's loss boundary made into a
   * number: a delta stamped with an older generation is from before the
   * boundary, and no delta may cross one.
   */
  #generation = 0;
  #snapshotPublishedIn = -1;

  /** Counters the tests quote. Cheap, and they make "exactly once" assertable. */
  readonly counts = { notices: 0, lost: 0, attached: 0, rejectedActions: 0, snapshots: 0, deltas: 0 };

  constructor(
    room: CoreRoomState<TApp, TClient>,
    config: ServiceConfig,
    opts: ServiceLifecycleOptions = {},
  ) {
    this.#room = room;
    this.config = config;
    this.#clock = opts.clock ?? systemClock;
    this.#onNotice = opts.onNotice ?? (() => {});
    this.#onStatusChange = opts.onStatusChange ?? (() => {});
  }

  status(): ServiceStatus {
    return this.#status;
  }

  /** The attached peer's id, or null when there is none live. */
  peerId(): string | null {
    return this.#peer?.id ?? null;
  }

  /** The current loss generation. Deltas from an older one are refused. */
  generation(): number {
    return this.#generation;
  }

  #setStatus(to: ServiceStatus): void {
    const from = this.#status;
    if (from === to) return;
    this.#status = to;
    this.#onStatusChange(from, to);
  }

  #notify(kind: ServiceNotice['kind'], reason?: DetachReason): void {
    const notice: ServiceNotice = { kind, roomId: this.#room.roomId, at: this.#clock.now() };
    if (reason !== undefined) notice.reason = reason;
    this.counts.notices += 1;
    this.#onNotice(notice);
  }

  /**
   * §5.5. Begin a handshake.
   *
   * Rejected while `attached` (there is already one) and while `attaching` (a
   * handshake is in flight, and admitting a second is how you get two). Accepted
   * while `lost` — that is the replacement path and the whole reason `lost`
   * exists as a state.
   *
   * Resolves when the peer calls `ack`. The peer is sent the roster and seats
   * immediately so it can start rebuilding its routing table (§5.6); the session
   * — and with it the right to publish — arrives only on the ack.
   */
  attach(peer: ServicePeer): Promise<ServiceSession<TClient>> {
    if (this.#status === 'attached' || this.#status === 'attaching') {
      return Promise.reject(
        new ServiceRejection(
          'service-already-attached',
          this.#status,
          `room ${this.#room.roomId} already has a service (${this.#status})`,
        ),
      );
    }

    // Hold the remaining `lost` window across the handshake. A replacement
    // process that fails to start must not cost the room the rest of its hold —
    // otherwise one bad start turns a recoverable crash into a reaped room.
    const holdDeadline = this.#status === 'lost' ? this.#holdDeadline : null;
    this.#clearHoldTimer();
    this.#setStatus('attaching');

    return new Promise<ServiceSession<TClient>>((resolve, reject) => {
      const timeoutMs = this.config.attachTimeoutMs ?? this.config.lossAfterMs;
      const timer = this.#clock.setTimer(() => {
        this.#failPending(
          new ServiceRejection(
            'attach-timeout',
            'attaching',
            `attach handshake for room ${this.#room.roomId} timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.#pending = { peer, resolve, reject, timer, holdDeadline };
      peer.send({
        type: 'service/attach',
        roomId: this.#room.roomId,
        roster: [...this.#room.clients.values()],
        seats: this.#room.seats,
      });
    });
  }

  #failPending(error: ServiceRejection): void {
    const pending = this.#pending;
    if (pending === null) return;
    this.#pending = null;
    this.#clock.clearTimer(pending.timer);
    // Back to where it came from: `lost` with its ORIGINAL deadline if there is
    // any hold left, otherwise `detached`.
    const remaining = pending.holdDeadline === null ? 0 : pending.holdDeadline - this.#clock.now();
    if (remaining > 0) {
      this.#setStatus('lost');
      this.#armHold(remaining, pending.holdDeadline as number);
    } else {
      this.#setStatus('detached');
      this.#holdDeadline = null;
    }
    pending.reject(error);
  }

  /** The peer completed the handshake. `attaching` → `attached`. */
  ack(peerId: string): ServiceResult {
    const pending = this.#pending;
    if (pending === null || pending.peer.id !== peerId) {
      return fail('service-unavailable', this.#status, `no handshake in flight for peer ${peerId}`);
    }
    this.#pending = null;
    this.#clock.clearTimer(pending.timer);
    this.#clearHoldTimer();
    this.#holdDeadline = null;
    this.#peer = pending.peer;
    this.#lastHeartbeat = this.#clock.now();
    this.#setStatus('attached');
    this.counts.attached += 1;
    this.#armLossTimer();
    this.#notify('service-attached');
    pending.resolve(this.#session(pending.peer));
    return { ok: true, value: undefined };
  }

  #session(peer: ServicePeer): ServiceSession<TClient> {
    return {
      serviceId: peer.id,
      roster: [...this.#room.clients.values()],
      seats: this.#room.seats,
      publishSnapshot: <P>(project: (client: ClientMeta<TClient>) => P | typeof SKIP): void => {
        this.#publishSnapshot(project);
      },
    };
  }

  #publishSnapshot<P>(project: (client: ClientMeta<TClient>) => P | typeof SKIP): void {
    const built: Array<{ client: ClientMeta<TClient>; payload: P }> = [];
    for (const client of this.#room.clients.values()) {
      const payload = project(client);
      if (payload === SKIP) continue;
      built.push({ client, payload: payload as P });
    }
    this.#snapshotPublishedIn = this.#generation;
    this.counts.snapshots += 1;
    this.#lastSnapshot = built;
  }

  /** What the last `publishSnapshot` built, per recipient. For the host's emit. */
  lastSnapshot(): ReadonlyArray<{ client: ClientMeta<TClient>; payload: unknown }> {
    return this.#lastSnapshot;
  }

  /**
   * §5.3. Offer a delta.
   *
   * Refused unless a full state has been published since the last transition
   * into `lost`. A client that received delta *n* before the loss and delta
   * *n+1* after it would be applying a diff against a state that no longer
   * exists — so on re-attach the room does not resume the stream, the
   * replacement pushes a full state, and only then do deltas resume.
   */
  publishDelta(delta: unknown): ServiceResult {
    if (this.#status !== 'attached') {
      return fail('service-unavailable', this.#status, 'no service attached');
    }
    if (this.#snapshotPublishedIn !== this.#generation) {
      return fail(
        'delta-before-snapshot',
        this.#status,
        'a full state must be published before deltas resume after a loss',
      );
    }
    this.counts.deltas += 1;
    void delta;
    return { ok: true, value: undefined };
  }

  /** Called by the peer. Resets the loss clock. */
  heartbeat(): void {
    if (this.#status !== 'attached') return;
    this.#lastHeartbeat = this.#clock.now();
    this.#armLossTimer();
  }

  #armLossTimer(): void {
    if (this.#lossTimer !== null) this.#clock.clearTimer(this.#lossTimer);
    this.#lossTimer = this.#clock.setTimer(() => {
      this.#lossTimer = null;
      if (this.#status !== 'attached') return;
      if (this.#clock.now() - this.#lastHeartbeat < this.config.lossAfterMs) {
        this.#armLossTimer();
        return;
      }
      this.#enterLost();
    }, this.config.lossAfterMs);
  }

  /**
   * §5.1. The room survives.
   *
   * No participant is evicted, no seat vacated, no socket closed, no room state
   * deleted. The peer is dropped and clients are told once. `isReapExempt` then
   * keeps the reaper off the room for the whole hold window.
   */
  #enterLost(): void {
    this.#peer = null;
    this.#generation += 1;
    this.counts.lost += 1;
    this.#setStatus('lost');
    const deadline = this.#clock.now() + this.config.holdMs;
    this.#armHold(this.config.holdMs, deadline);
    this.#notify('service-lost');
  }

  #armHold(ms: number, deadline: number): void {
    this.#clearHoldTimer();
    this.#holdDeadline = deadline;
    this.#holdTimer = this.#clock.setTimer(() => {
      this.#holdTimer = null;
      this.#holdDeadline = null;
      if (this.#status !== 'lost') return;
      // Hold expired with no replacement. The room drops back to `detached` and
      // is reaped on the normal rules from here.
      this.#setStatus('detached');
    }, ms);
  }

  #clearHoldTimer(): void {
    if (this.#holdTimer !== null) {
      this.#clock.clearTimer(this.#holdTimer);
      this.#holdTimer = null;
    }
  }

  /** §8.6. A clean shutdown. Different from a crash, and says so. */
  detach(reason: DetachReason): void {
    if (this.#status === 'detached') return;
    const peer = this.#peer;
    this.#peer = null;
    // A handshake in flight is settled, never abandoned: an unsettled promise is
    // a caller waiting forever with nothing to log.
    const pending = this.#pending;
    if (pending !== null) {
      this.#pending = null;
      this.#clock.clearTimer(pending.timer);
      pending.reject(
        new ServiceRejection(
          'service-unavailable',
          'detached',
          `room ${this.#room.roomId} detached ('${reason}') during the handshake`,
        ),
      );
    }
    if (this.#lossTimer !== null) {
      this.#clock.clearTimer(this.#lossTimer);
      this.#lossTimer = null;
    }
    this.#clearHoldTimer();
    this.#holdDeadline = null;
    this.#setStatus('detached');
    this.#notify('service-detached', reason);
    peer?.close(reason);
  }

  /**
   * §4. Route a client action to the service.
   *
   * An action that arrives while the service is not `attached` is rejected with
   * a typed error and changes NO room state — never silently dropped, never
   * queued, never applied by the room itself.
   *
   * Rejected rather than queued because a game action is only meaningful against
   * the state it was composed against; a land drop replayed thirty seconds later
   * into a state the client can no longer see is worse than an error. Rejected
   * rather than dropped because a client that gets no answer will guess, and the
   * guess we cannot allow is optimistic local application.
   */
  routeAction(kind: string, envelope: unknown): ServiceResult {
    if (!this.config.routes(kind)) {
      return fail('not-service-routed', this.#status, `action '${kind}' is not routed to a service`);
    }
    if (this.#status !== 'attached' || this.#peer === null) {
      this.counts.rejectedActions += 1;
      return fail(
        'service-unavailable',
        this.#status,
        `room ${this.#room.roomId}'s service is '${this.#status}'; action '${kind}' was not applied`,
      );
    }
    this.#peer.send({ type: 'service/action', kind, envelope });
    return { ok: true, value: undefined };
  }

  /**
   * §5.1. Is the room exempt from reaping right now?
   *
   * True whenever a service is live or expected back. `evaluateRoom` destroys on
   * `room.clients.size === 0` plus `emptyGraceMs`, and a match whose humans have
   * all briefly dropped — a redeploy of the UI, say — is empty by that
   * definition while the game is still running inside it. The decision must not
   * be "the room looked empty for a moment".
   */
  isReapExempt(): boolean {
    return this.#status !== 'detached';
  }
}

/**
 * `evaluateRoom`, with the service exemption applied.
 *
 * `GCTimings` is two numbers and `evaluateRoom` is pure, so the exemption
 * arrives as a wrapper rather than as a change to either. `idle` and `empty`
 * come back untouched — they are facts about the room and stay true — and only
 * `shouldDestroy` is overridden, so a caller that logs the reason still sees
 * that the room was empty.
 *
 * With `lifecycle` null or undefined this is exactly `evaluateRoom`. That is the
 * §6 default: with the service config undefined, none of it exists.
 */
export function evaluateRoomWithService<TApp, TClient>(
  room: CoreRoomState<TApp, TClient>,
  timings: GCTimings,
  lifecycle: ServiceLifecycle<TApp, TClient> | null | undefined,
  now?: number,
): GCEvalResult {
  const base = evaluateRoom(room, timings, now);
  if (lifecycle == null || !lifecycle.isReapExempt()) return base;
  return { ...base, shouldDestroy: false };
}

/**
 * Build a lifecycle, or don't.
 *
 * With `config` undefined the answer is `null`: no lifecycle object, no
 * heartbeat clock, no GC exemption, no behaviour change for a room that never
 * asked. Nothing is scheduled on the clock either, which is the assertable form
 * of "none of it exists".
 */
export function createServiceLifecycle<TApp, TClient = unknown>(
  room: CoreRoomState<TApp, TClient>,
  config: ServiceConfig | undefined,
  opts: ServiceLifecycleOptions = {},
): ServiceLifecycle<TApp, TClient> | null {
  if (config === undefined) return null;
  return new ServiceLifecycle<TApp, TClient>(room, config, opts);
}

export { SKIP };

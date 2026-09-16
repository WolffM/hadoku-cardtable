/**
 * SPDX-License-Identifier: MIT
 *
 * Part of `@hadoku/room-ask`, which is MIT — the single carve-out in a repo
 * that is otherwise GPL-3.0-or-later. Written clean-room from the requirement
 * in `docs/requests/P4_ASK_REGISTRY.md` and from nothing else.
 *
 * ## What this is
 *
 * A server-side caller puts a question to ONE seated participant and awaits the
 * answer while the rest of the room keeps running. "Pick a card." "Mulligan?"
 *
 * The one idea underneath every rule here: **participants and seats are
 * durable, sockets are not.** Every ask is keyed to the durable things, so a
 * mid-draft browser refresh moves an ask from `delivered` back to `queued` and
 * settles nothing at all.
 *
 * ## What it deliberately does not do
 *
 * It opens nothing, imports no transport, and reads no clock it was not handed.
 * Sockets reach it only as opaque string keys through {@link AskRegistry.attach}
 * and {@link AskRegistry.detach}; envelopes leave through a delivery callback.
 * That is what makes requirement 8 — "an unknown id is dropped and counted,
 * never thrown" — testable without a live socket.
 */

import {
  occupantOf,
  seatOf,
  isDurableParticipantId,
  type ParticipantId,
  type SeatId,
  type SeatTable,
} from '@wolffm/rooms-protocol';

import { createSystemClock, type AskClock, type AskTimer } from './clock.ts';
import { AskCancelledError, AskNotSeatedError, AskTimeoutError } from './errors.ts';
import type {
  AskCancelReason,
  AskDeliverFn,
  AskEnvelope,
  AskId,
  AskOptions,
  AskReply,
  AskState,
  AskStats,
  PendingAskView,
} from './types.ts';

export interface AskRegistryOptions {
  /**
   * The room's live seat table. Held by reference and read at issue time only —
   * the registry never mutates it and never polls it. A seat losing its
   * occupant reaches the registry through {@link AskRegistry.seatExit}, not
   * through this table changing under it.
   */
  seats: SeatTable;
  /** How an envelope reaches one socket. */
  deliver: AskDeliverFn;
  /** Defaults to `Date.now` + `setTimeout`. Tests pass a manual clock. */
  clock?: AskClock;
}

interface AskRecord {
  readonly askId: AskId;
  readonly kind: string;
  readonly target: ParticipantId;
  readonly seat: SeatId | null;
  readonly envelope: AskEnvelope;
  readonly issuedAt: number;
  readonly deadlineAt: number;
  readonly timeoutMs: number;
  state: AskState;
  emitCount: number;
  timer: AskTimer | null;
  detachAbort: (() => void) | null;
  settle: (outcome: Settlement) => void;
}

type Settlement =
  | { kind: 'replied'; value: unknown }
  | { kind: 'timedOut' }
  | { kind: 'cancelled'; reason: AskCancelReason };

export interface AskRegistry {
  /**
   * Put a question to one seated participant.
   *
   * Target resolution happens ONCE, here. A {@link SeatId} resolves to whoever
   * occupies that seat at this instant and the ask is then bound to that
   * *participant* for its whole life — if the occupant changes, the ask is
   * cancelled (`reason: 'seat-exit'`) rather than silently handed to the new
   * occupant. One player's hidden-state question never reaches another player.
   *
   * Rejects at issue with {@link AskNotSeatedError} when the target holds no
   * seat, or names a seat that is empty, out of range, or occupied by a bot
   * (see the §6.8 note on {@link AskRegistry.seatExit}'s sibling decision). No
   * `askId` is allocated and no counter moves.
   *
   * `timeoutMs` is wall-clock from here and does NOT pause while queued: a
   * draft's pick timer means what it says.
   */
  ask<T>(
    target: ParticipantId | SeatId,
    kind: string,
    payload: unknown,
    opts: AskOptions<T>,
  ): Promise<T>;

  /** Snapshot of everything not yet settled, in ascending `askId` order. */
  pending(): ReadonlyArray<PendingAskView>;

  /** Monotonic counters plus the `queued` gauge. Never reset. */
  stats(): AskStats;

  /**
   * Cancel one pending ask. `true` if it was pending and is now cancelled,
   * `false` if it had already settled or never existed. Safe to call repeatedly.
   */
  cancel(askId: AskId, reason?: AskCancelReason): boolean;

  /**
   * A socket became live for this participant.
   *
   * Every still-pending ask for them is (re-)written to the new socket in
   * ascending `askId` order, unchanged: same `askId`, the same frozen envelope
   * object, no new deadline. Replaying n times and replaying once are
   * indistinguishable to the caller — only the `delivered` emit counter moves.
   *
   * `socketKey` is opaque; the registry only ever compares it for equality and
   * hands it back to `deliver`. Attaching a key that is already attached does
   * nothing at all.
   *
   * Replay is for durable participants. An `eph:` id IS the socket id, so "the
   * same participant attaches a second socket" is not a thing that can happen
   * to one — their first attach delivers normally, and if that socket goes away
   * their queued asks can only time out. `isDurableParticipantId` is the gate.
   */
  attach(participantId: ParticipantId, socketKey: string): void;

  /**
   * A socket went away. If it was the participant's last one, their `delivered`
   * asks move back to `queued` and NOTHING settles. This is the only effect a
   * socket drop has anywhere in this module.
   */
  detach(participantId: ParticipantId, socketKey: string): void;

  /**
   * The participant genuinely left their seat: every pending ask for them is
   * cancelled with `reason: 'seat-exit'`.
   *
   * ## The contract, which is the whole of requirement 7
   *
   * **The host decides what "left the seat" means, and it must NOT mean "a
   * socket dropped".** A mid-draft refresh drops a socket and leaves a stale
   * disconnect behind while the participant is already back on a new one; if
   * that path calls `seatExit`, it cancels every pending ask for a drafter who
   * never went anywhere — precisely the outcome requirement 7 exists to forbid,
   * arriving through the door we thought we had closed.
   *
   * So: call {@link AskRegistry.detach} on a disconnect, and call this only on a
   * deliberate departure — leaving the pod, being removed from a seat, a seat's
   * occupant being swapped. The registry cannot tell the two apart and does not
   * try; that judgement is the caller's, and it is the caller's whole job here.
   *
   * Idempotent: running the sweep twice cancels the same set once.
   */
  seatExit(participantId: ParticipantId): void;

  /**
   * The room is over. Every pending ask is cancelled with
   * `reason: 'room-closed'` and the socket registry is emptied.
   *
   * Asks issued after this point are accepted, counted and immediately
   * cancelled the same way — the counters stay consistent, but a host that
   * relies on it is asking a question of a room that no longer exists.
   */
  closeRoom(): void;

  /**
   * Ingress for the transport adapter, and the seam that makes requirement 8
   * testable without a socket. NEVER throws.
   *
   * `'matched'` only when the `askId` is pending here AND `from` is that ask's
   * resolved target participant. Everything else — an id that never existed,
   * one that already settled, a second reply to the same id, a valid id from
   * the wrong participant, an id from a previous room — is discarded, bumps
   * `droppedUnknownReplies` by exactly one, and returns `'dropped'`. No throw
   * reaches the transport handler and no caller's promise is disturbed.
   */
  submitReply(from: ParticipantId, reply: AskReply): 'matched' | 'dropped';
}

const EMPTY_SOCKETS: ReadonlySet<string> = new Set<string>();

export function createAskRegistry(opts: AskRegistryOptions): AskRegistry {
  const { seats, deliver } = opts;
  const clock = opts.clock ?? createSystemClock();

  /** Strictly increasing, +1 each time, never reused, never reset. */
  let nextAskId = 1;

  const asks = new Map<AskId, AskRecord>();
  const sockets = new Map<ParticipantId, Set<string>>();
  /** Participants that have held a socket at some point — the re-attach test. */
  const everAttached = new Set<ParticipantId>();
  let roomClosed = false;

  const counters = {
    issued: 0,
    delivered: 0,
    replied: 0,
    timedOut: 0,
    cancelled: 0,
    droppedUnknownReplies: 0,
  };

  function socketsOf(participantId: ParticipantId): ReadonlySet<string> {
    return sockets.get(participantId) ?? EMPTY_SOCKETS;
  }

  /** Pending asks for one participant, ascending `askId`. */
  function pendingFor(participantId: ParticipantId): AskRecord[] {
    const out: AskRecord[] = [];
    for (const record of asks.values()) {
      if (record.target === participantId) out.push(record);
    }
    out.sort((a, b) => a.askId - b.askId);
    return out;
  }

  function emitTo(record: AskRecord, socketKey: string): void {
    record.emitCount += 1;
    counters.delivered += 1;
    deliver(record.target, socketKey, record.envelope);
  }

  function finish(record: AskRecord, outcome: Settlement): void {
    // Terminal is terminal: a late reply, a late timer, a late abort or a late
    // seat-exit against an ask that has already gone changes nothing. The map
    // delete below is what makes every one of those a lookup miss.
    if (!asks.delete(record.askId)) return;
    record.timer?.cancel();
    record.timer = null;
    record.detachAbort?.();
    record.detachAbort = null;
    record.settle(outcome);
  }

  function resolveTarget(
    target: ParticipantId | SeatId,
  ): { participantId: ParticipantId; seat: SeatId | null } | null {
    if (typeof target === 'number') {
      const occupant = occupantOf(seats, target);
      // A bot has no socket and never will, so queueing an ask for one is a
      // guaranteed timeout dressed up as a pending request. Same answer as an
      // empty seat: refuse at issue.
      if (occupant === null || occupant.kind !== 'human') return null;
      return { participantId: occupant.participantId, seat: target };
    }
    const seat = seatOf(seats, target);
    if (seat === null) return null;
    return { participantId: target, seat };
  }

  function ask<T>(
    target: ParticipantId | SeatId,
    kind: string,
    payload: unknown,
    options: AskOptions<T>,
  ): Promise<T> {
    const resolved = resolveTarget(target);
    if (resolved === null) return Promise.reject(new AskNotSeatedError(target));

    const askId = nextAskId as AskId;
    nextAskId += 1;

    const issuedAt = clock.now();
    const timeoutMs = options.timeoutMs;
    const envelope: AskEnvelope = Object.freeze({ askId, kind, payload });

    let resolveOuter!: (value: T) => void;
    let rejectOuter!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolveOuter = res;
      rejectOuter = rej;
    });

    const record: AskRecord = {
      askId,
      kind,
      target: resolved.participantId,
      seat: resolved.seat,
      envelope,
      issuedAt,
      deadlineAt: issuedAt + timeoutMs,
      timeoutMs,
      state: 'queued',
      emitCount: 0,
      timer: null,
      detachAbort: null,
      settle(outcome) {
        switch (outcome.kind) {
          case 'replied':
            counters.replied += 1;
            resolveOuter(outcome.value as T);
            return;
          case 'timedOut':
            counters.timedOut += 1;
            if (options.onTimeout.mode === 'value') resolveOuter(options.onTimeout.value);
            else rejectOuter(new AskTimeoutError(askId, timeoutMs));
            return;
          case 'cancelled':
            counters.cancelled += 1;
            rejectOuter(new AskCancelledError(askId, outcome.reason));
            return;
        }
      },
    };

    asks.set(askId, record);
    counters.issued += 1;

    record.timer = clock.setTimer(timeoutMs, () => {
      finish(record, { kind: 'timedOut' });
    });

    const signal = options.signal;
    if (signal) {
      const onAbort = () => finish(record, { kind: 'cancelled', reason: 'signal' });
      if (signal.aborted) {
        onAbort();
        return promise;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      record.detachAbort = () => signal.removeEventListener('abort', onAbort);
    }

    if (roomClosed) {
      finish(record, { kind: 'cancelled', reason: 'room-closed' });
      return promise;
    }

    // T1 / T2, same tick either way: deliver to every live socket, or queue.
    const live = socketsOf(record.target);
    if (live.size > 0) {
      record.state = 'delivered';
      for (const socketKey of live) emitTo(record, socketKey);
    }

    return promise;
  }

  function cancel(askId: AskId, reason: AskCancelReason = 'cancelled'): boolean {
    const record = asks.get(askId);
    if (!record) return false;
    finish(record, { kind: 'cancelled', reason });
    return true;
  }

  function attach(participantId: ParticipantId, socketKey: string): void {
    let live = sockets.get(participantId);
    if (!live) {
      live = new Set();
      sockets.set(participantId, live);
    }
    if (live.has(socketKey)) return; // idempotent: already present, nothing moves

    const isReattach = everAttached.has(participantId);
    live.add(socketKey);
    everAttached.add(participantId);

    // An ephemeral participant cannot come back — their id is the socket that
    // just died — so a second attach under that id is a host mistake, not a
    // reconnect, and replaying someone's hidden-state question onto it would be
    // worse than letting the ask time out.
    if (isReattach && !isDurableParticipantId(participantId)) return;

    for (const record of pendingFor(participantId)) {
      record.state = 'delivered'; // T4 from queued, T5 self-loop from delivered
      emitTo(record, socketKey);
    }
  }

  function detach(participantId: ParticipantId, socketKey: string): void {
    const live = sockets.get(participantId);
    if (!live || !live.delete(socketKey)) return; // not attached: nothing moves
    if (live.size > 0) return;

    sockets.delete(participantId);
    // T3, and T3 is the ONLY thing a socket drop does. Nothing settles.
    for (const record of pendingFor(participantId)) record.state = 'queued';
  }

  function seatExit(participantId: ParticipantId): void {
    for (const record of pendingFor(participantId)) {
      finish(record, { kind: 'cancelled', reason: 'seat-exit' });
    }
  }

  function closeRoom(): void {
    roomClosed = true;
    for (const record of [...asks.values()].sort((a, b) => a.askId - b.askId)) {
      finish(record, { kind: 'cancelled', reason: 'room-closed' });
    }
    sockets.clear();
  }

  function submitReply(from: ParticipantId, reply: AskReply): 'matched' | 'dropped' {
    const record = asks.get(reply?.askId);
    // Both halves of §2.5's match rule, and the only place either is decided.
    if (!record || record.target !== from) {
      counters.droppedUnknownReplies += 1;
      return 'dropped';
    }
    finish(record, { kind: 'replied', value: reply.value });
    return 'matched';
  }

  function pending(): ReadonlyArray<PendingAskView> {
    return [...asks.values()]
      .sort((a, b) => a.askId - b.askId)
      .map((record) => ({
        askId: record.askId,
        kind: record.kind,
        target: record.target,
        seat: record.seat,
        state: record.state,
        issuedAt: record.issuedAt,
        deadlineAt: record.deadlineAt,
        emitCount: record.emitCount,
      }));
  }

  function stats(): AskStats {
    let queued = 0;
    for (const record of asks.values()) if (record.state === 'queued') queued += 1;
    return { ...counters, queued };
  }

  return { ask, pending, stats, cancel, attach, detach, seatExit, closeRoom, submitReply };
}

/*
 * Wave 47 — Fast Mode is a setting, off by default. This is the pacer:
 * `pacedMatchTransport` wraps a `MatchTransport` (`./match.ts`'s own seam —
 * unowned this wave, and never edited here) so that inbound `forge:s2c`
 * payloads are released on a schedule instead of applied the instant the
 * socket hands them over. Nothing else about the transport changes: every
 * other inbound event (`connect`, `disconnect`, `forge:full-control`,
 * `forge:seats`, `forge:role`) and EVERY outgoing call (`emit`, `request`)
 * pass straight through, untouched and undelayed — see the wave file's own
 * settled rule, "pacing is a transport wrapper, not a change to the fold."
 *
 * ## The rule, as code
 *
 * A leaky bucket of size one, keyed by wall-clock time (`Date.now()` by
 * default, injectable for `pace.test.ts`'s fake timers):
 *
 *   - `lastDeliveredAt` starts at `-Infinity`: the first payload this pacer
 *     ever sees has nothing to wait on, so it goes out AT ONCE. That is the
 *     whole of "an event arriving after the table has been quiet is applied
 *     at once" — quiet is not a separate timer, it falls out of the same
 *     formula: by the time a payload arrives, enough wall-clock time may
 *     already have passed that its own required gap is already satisfied.
 *   - Every later payload must wait until `lastDeliveredAt + its own delay`
 *     (`PACE_DELAYS_MS[classify(payload)]`) before it goes out. A BURST —
 *     several payloads arriving before the previous one's gap has elapsed —
 *     queues, FIFO, and each one is paced off the one actually delivered
 *     before it, never off whenever it happened to arrive.
 *   - `setFast(true)` cancels whatever is pending and drains the whole queue
 *     in one tick, in order — "toggling Fast Mode on mid-match flushes the
 *     queue at once." `setFast(false)` does nothing to anything already
 *     queued (there is nothing queued while fast, since every wait resolves
 *     to zero and the queue never has a chance to build one); pacing simply
 *     resumes for whatever arrives next.
 *
 * ## Classifying an event: from the frame's own content, never its prose
 *
 * `classify` reads `frame.kind`/`frame.method` and, for `applyDelta`, the
 * packet's own objects — `WireType.Game`'s `Stack` and `Phase` properties,
 * `WireType.Player`'s `Hand` property (`../adapter.ts` reads the identical
 * three off the folded state: `readIds(game, 'Stack')`, `readEnum(game,
 * 'Phase')`, `readIds(p, 'Hand')`). Never a regex over `showPromptMessage`'s
 * text — the wave's own rule (§0b, carried from wave 24) and `./match.ts`'s
 * module header both forbid it, and a wire property that is already folded
 * into the board is the one signal this file does not have to invent.
 *
 * An ask, and every notify Forge sends to show, refresh or stop an input
 * (`match.ts`'s own `INPUT_FRAMES` set, copied here rather than imported —
 * it is not exported, and this file does not touch `match.ts`), is never
 * held: a player's own prompt or button bar appearing late is not "nice
 * pacing", it is a seat staring at a frozen board.
 *
 * ## What a resync needs from the pacer: nothing
 *
 * `forge:join` and `forge:resync` are not `forge:s2c` payloads — they travel
 * on `request()`/its ack callback, which this wrapper never queues (see
 * `pace.test.ts`'s "a snapshot jumps the queue"). A snapshot can therefore
 * never be stuck behind a queue of stale deltas, because it never enters
 * this queue at all. The only cost of a delta sitting in THIS queue while a
 * resync is in flight elsewhere is that `match.ts`'s own `awaitingSnapshot`
 * buffering (its module header: "hand it frames in any order and the driver
 * has to behave") sees that delta a little later than it otherwise would —
 * and `classifySeq`/`needsResync` are already built to treat an arbitrarily
 * late, duplicate, or now-stale frame as exactly that, never as a correctness
 * bug. Holding a stale delta an extra few hundred ms is slower, not wrong.
 */

import type { MatchTransport } from './match.ts';
import { MATCH_EVENTS } from './transport.ts';

/* ── Classifying an event ────────────────────────────────────────────── */

export type PaceClass = 'input' | 'resolve' | 'phase' | 'draw' | 'default';

/**
 * Starting values (wave file §P step 2) — the operator's to tune by feel
 * after the next playtest (the tracker's own watch, wave file's closing
 * section). `input` is zero on purpose: an ask or a bar is the player's own
 * turn to act, never a thing to visually pace.
 */
export const PACE_DELAYS_MS: Readonly<Record<PaceClass, number>> = {
  input: 0,
  /** A stack mutation — something going on, or something resolving/leaving. */
  resolve: 600,
  /** `GameView.Phase` changed. */
  phase: 250,
  /** A player's `Hand` list changed — a draw, most often; a discard or a cast reads the same way, and holding those too is harmless. */
  draw: 200,
  /** Everything else on the state channel, and every `message` log line. */
  default: 150,
};

/** `match.ts`'s own `INPUT_FRAMES` — see this module's header for why it is copied, not imported. */
const INPUT_NOTIFY_METHODS: ReadonlySet<string> = new Set([
  'showPromptMessage',
  'updateButtons',
  'setSelectables',
  'clearSelectables',
  'setHighlighted',
  'setWeaklySelectable',
  'clearWeaklySelectable',
]);

/** `WireType.Game` / `WireType.Player`, `../wire.ts` — copied as bare numbers rather than imported, for the same reason: this file reads the wire, it does not fold it. */
const WIRE_TYPE_GAME = 3;
const WIRE_TYPE_PLAYER = 1;

/** Every object a packet's two arms carry, annotation keys (`_omitted`) dropped. */
function packetObjects(packet: unknown): Record<string, unknown>[] {
  if (typeof packet !== 'object' || packet === null) return [];
  const p = packet as Record<string, unknown>;
  const out: Record<string, unknown>[] = [];
  for (const arm of ['newObjects', 'objectDeltas'] as const) {
    const map = p[arm];
    if (typeof map !== 'object' || map === null) continue;
    for (const [key, obj] of Object.entries(map as Record<string, unknown>)) {
      if (key.startsWith('_')) continue;
      if (typeof obj === 'object' && obj !== null) out.push(obj as Record<string, unknown>);
    }
  }
  return out;
}

/**
 * One raw `forge:s2c` payload (the server envelope — unparsed, same reason
 * `./transport.ts`'s own `frame` field is `unknown`: a payload this cannot
 * read is not this file's to reject, only to leave at `'default'`) to a pace
 * class. Exported so `pace.test.ts` can pin every branch directly, against
 * shapes built from this module's own header rather than guessed.
 */
export function classify(payload: unknown): PaceClass {
  if (typeof payload !== 'object' || payload === null) return 'default';
  const frame = (payload as Record<string, unknown>).frame;
  if (typeof frame !== 'object' || frame === null) return 'default';
  const f = frame as Record<string, unknown>;
  if (f.kind === 'ask') return 'input';
  if (f.kind !== 'notify') return 'default';
  const method = f.method;
  if (typeof method === 'string' && INPUT_NOTIFY_METHODS.has(method)) return 'input';
  if (method !== 'applyDelta') return 'default';
  const packetPayload = f.payload;
  const packet =
    typeof packetPayload === 'object' && packetPayload !== null
      ? (packetPayload as Record<string, unknown>).packet
      : undefined;
  let sawPhase = false;
  let sawHand = false;
  for (const obj of packetObjects(packet)) {
    const type = obj._type;
    if (type === WIRE_TYPE_GAME) {
      if ('Stack' in obj) return 'resolve';
      if ('Phase' in obj) sawPhase = true;
    } else if (type === WIRE_TYPE_PLAYER) {
      if ('Hand' in obj) sawHand = true;
    }
  }
  if (sawPhase) return 'phase';
  if (sawHand) return 'draw';
  return 'default';
}

/* ── The wrapper ─────────────────────────────────────────────────────── */

/** `MatchTransport`, plus the one knob a mid-match toggle needs. */
export interface PacedMatchTransport extends MatchTransport {
  /** `true`: today's behaviour exactly — every queued payload flushes at once and nothing new is held. `false`: paced. */
  setFast(fast: boolean): void;
  /**
   * `true` from an End Turn press until the turn changes: a frame that only moves the phase goes out at once,
   * so the rest of the turn does not step past on screen one phase at a time (the operator, 2026-10-11:
   * "'end turn' skips the remaining phases and goes straight to the opponents turn"). A stack change, a draw
   * or anything else in those phases keeps its own pace.
   */
  setEndingTurn(ending: boolean): void;
}

/** Narrows a plain `MatchTransport` (the dev harness's, a test's own stub) from one this wrapper built. Structural, not a brand: `setFast` is this interface's only addition. */
export function isPacedTransport(transport: MatchTransport): transport is PacedMatchTransport {
  return typeof (transport as Partial<PacedMatchTransport>).setFast === 'function';
}

export interface PaceOptions {
  /** Default `false` — paced. `MatchScreen.tsx` passes the loaded preference (or its own module-eval default) so the FIRST frame is never paced in a mode the viewer did not ask for. */
  initialFast?: boolean;
  /** Overrides, for a test or a future tuning pass; unlisted classes keep {@link PACE_DELAYS_MS}'s value. */
  delays?: Partial<Record<PaceClass, number>>;
  /** Test seam: `pace.test.ts`'s fake clock. Defaults to the real one. */
  now?: () => number;
  /** Test seam: `pace.test.ts`'s fake timer. Defaults to the real `setTimeout`. */
  schedule?: (run: () => void, delayMs: number) => unknown;
  /** Test seam, paired with `schedule`. Defaults to the real `clearTimeout`. */
  cancel?: (handle: unknown) => void;
}

export function pacedMatchTransport(inner: MatchTransport, options: PaceOptions = {}): PacedMatchTransport {
  const delays: Readonly<Record<PaceClass, number>> = { ...PACE_DELAYS_MS, ...options.delays };
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((run: () => void, delayMs: number) => setTimeout(run, delayMs));
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let fast = options.initialFast ?? false;
  let endingTurn = false;
  let queue: unknown[] = [];
  let timer: unknown = null;
  let lastDeliveredAt = -Infinity;
  /** The handler `startMatch` registered for `MATCH_EVENTS.serverToClient` — null until `on` is called for it, which `startMatch` always does before anything can arrive. */
  let deliverTo: ((payload: unknown) => void) | null = null;

  function delayFor(payload: unknown): number {
    if (fast) return 0;
    const pace = classify(payload);
    return endingTurn && pace === 'phase' ? 0 : delays[pace];
  }

  function deliverNext(): void {
    const payload = queue.shift();
    if (payload === undefined) return;
    lastDeliveredAt = now();
    deliverTo?.(payload);
  }

  /** Deliver whatever is due, and schedule a timer for whatever is not — never more than one timer live at once. */
  function pump(): void {
    if (timer !== null || queue.length === 0) return;
    const waitMs = Math.max(0, lastDeliveredAt + delayFor(queue[0]) - now());
    if (waitMs <= 0) {
      deliverNext();
      pump();
      return;
    }
    timer = schedule(() => {
      timer = null;
      deliverNext();
      pump();
    }, waitMs);
  }

  /** Cancel whatever is pending and deliver the rest of the queue right now, in order. */
  function flush(): void {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    while (queue.length > 0) deliverNext();
  }

  return {
    on(event, handler) {
      if (event !== MATCH_EVENTS.serverToClient) {
        inner.on(event, handler);
        return;
      }
      deliverTo = handler;
      inner.on(event, (payload) => {
        queue.push(payload);
        pump();
      });
    },
    // Outgoing, and the ack of a request: never paced. See the module header's own note on why a resync's snapshot never enters this queue at all.
    emit(event, payload) {
      inner.emit(event, payload);
    },
    request(event, payload, onAck) {
      inner.request(event, payload, onAck);
    },
    disconnect() {
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      queue = [];
      inner.disconnect();
    },
    setFast(value: boolean): void {
      fast = value;
      if (value) flush();
    },
    setEndingTurn(value: boolean): void {
      endingTurn = value;
      // A phase frame already waiting on its gap goes now: the wait was computed before the press.
      if (value && timer !== null) {
        cancel(timer);
        timer = null;
        pump();
      }
    },
  };
}

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
 * `WireType.Player`'s `Hand` property, `WireType.Card`'s `Zone` and `Tapped`
 * (`../adapter.ts` reads the same properties off the folded state:
 * `readIds(game, 'Stack')`, `readEnum(game, 'Phase')`, `readIds(p, 'Hand')`).
 * Never a regex over `showPromptMessage`'s
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
 * ## A cast is one moment
 *
 * The operator, 2026-10-11: *"the sequence is: 1. release card 2. reveal it
 * 3. pay for mana 4. resolve card. can we squish together 1-3 so they all
 * happen simultaneously?"* Forge sends a cast as several frames inside about
 * 80 ms — the card leaving the hand, the lands tapping for it, the spell
 * joining the stack (`PlaySpellAbility.java:624-727`: the card is moved, the
 * cost is paid, then the item is added) — and each one used to wait its own
 * class's gap: measured in `e2e/w71-tap-reveal.spec.ts`, the taps drew 717 ms
 * after the release and the face 1319 ms, on a cast Forge had finished by
 * 300 ms. Those frames are `cast`, and go out as they come. What paces is the
 * resolution after it: the stack SHRINKING is still `resolve`.
 *
 * Telling a stack that grew from one that shrank takes the depth before the
 * frame, so the wrapper remembers the last `Stack` length it saw
 * ({@link PaceMemory}), in arrival order. Before it has seen one (a snapshot
 * never passes through here), a frame that brings a new stack item is a cast.
 *
 * ## The game's end keeps its place
 *
 * The server tells every seat the game is over (`finishGame`) the moment the bridge says so, and the
 * bridge says so BEFORE the frame that shows it — the last attacker's damage, the bolt that took the
 * last life (`PlayBridge.maybeEmitGameOverFirst`). Every frame here carries the server's cursor, and
 * `match.ts` reads one out of order as a gap and resyncs: the view is rebuilt, and the board draws the
 * killing blow a second time beside the first (`e2e/cp-lethal-blow.spec.ts`, the operator, 2026-10-17:
 * "a duplicate copy of the tapped attacking creatures"). So the end goes out in its place like any
 * frame, and it is the result screen that waits for the frame that shows the end
 * (`LiveBoard.tsx`'s `useGameEnded`), and then for the board to draw it (`../motion.ts`'s `whenBoardStill`).
 *
 * ## One act at a time, and the board's beats first
 *
 * A person acts seconds apart; the Forge AI acts within milliseconds, and its turn reached the other
 * screen as one burst (the operator, 2026-10-19: *"they attack me and i dont even see their creatures
 * do the attack because everything happens so fast"*). Forge moves the phase in the same frame as the
 * attack (`Attacking` with `Phase=COMBAT_DECLARE_ATTACKERS`) and as the combat damage (`Life` with
 * `Phase=COMBAT_DAMAGE`), and those were read as phase steps: a phase with something queued behind it goes
 * at once, so the AI's attack, its damage and the next turn went out in one task and were drawn as ONE
 * view — no attacker drawn attacking, no ram, the life simply lower (`e2e/aa-ai-beats.spec.ts`; in
 * production, `m-dfc6932a95be`'s seq 192→209 and 212→222). So, whoever acts:
 *
 *   - what a frame draws decides its class before the step it moves to ({@link classify});
 *   - a frame the board draws ({@link HELD_BY_THE_BOARD}) never goes out in the same task as another: React
 *     draws each as its own view, and every beat of it is diffed on its own;
 *   - and it waits while the board is still drawing the beats of what came before
 *     (`../motion.ts`'s `whenBoardStill`: a ram, a bolt, a death, an attack being shown), at most
 *     {@link BOARD_HOLD_MAX_MS}. A beat is as long as it always was; the next act simply starts after it,
 *     as a person's would. A cast's own pieces draw no beat, so a cast is still one moment.
 *
 * A new turn is drawn too — its "Your turn" (`TurnCue.tsx`), its sound, the edge light moving to the
 * other seat — so the frame that moves `Turn` or `PlayerTurn` is a {@link classify | `turn`}, held by the
 * board like any drawn frame: the AI's End of Turn is already in Forge's burst behind its combat damage,
 * and as a phase step it went out with the blow and announced the next turn as the ram set off (the
 * operator, 2026-10-20: the turn banner waits until the AI's attack animation has finished). Between it
 * and the frame before it, it keeps a phase step's gap, passed straight through like one.
 *
 * Input, a log line, a frame of nothing drawn and a phase step are never held by the board: an ask is
 * still drawn at once, over the motion (`../motion.ts`), once what came before it in the queue has gone.
 * Fast Mode holds nothing.
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

import { CLIENT_EVENT, type ClientEvent } from '@hadoku/shared';

import { whenBoardStill } from '../motion.ts';
import type { MatchTransport } from './match.ts';
import { MATCH_EVENTS } from './transport.ts';

/* ── Classifying an event ────────────────────────────────────────────── */

export type PaceClass = 'input' | 'cast' | 'unseen' | 'log' | 'resolve' | 'phase' | 'turn' | 'draw' | 'default';

/**
 * Starting values (wave file §P step 2) — the operator's to tune by feel
 * after the next playtest (the tracker's own watch, wave file's closing
 * section). `input` is zero on purpose: an ask or a bar is the player's own
 * turn to act, never a thing to visually pace.
 */
export const PACE_DELAYS_MS: Readonly<Record<PaceClass, number>> = {
  input: 0,
  /** A spell going on the stack and what pays for it: the card leaving a hand, a land tapping, the stack growing — one moment (module header). */
  cast: 0,
  /** A delta that changes only what the board never draws ({@link UNDRAWN_PROPERTIES}), or a notify it never reads ({@link UNDRAWN_NOTIFIES}): there is nothing to show, so nothing to wait for. */
  unseen: 0,
  /**
   * A `message` notify — a line of Forge's game log. It draws nothing on the board, and Forge writes one for
   * every mana ability and cast inside a cast's own burst, so a gap here would pull the cast apart again.
   */
  log: 0,
  /** The stack shrinking or changing in place — something resolving or leaving. */
  resolve: 600,
  /** `GameView.Phase` changed. */
  phase: 250,
  /** `GameView.Turn` or `PlayerTurn` changed: a turn began. A phase step's gap; what it waits for is the board. */
  turn: 250,
  /** A card arrived in a hand (its `Zone` is `Hand`) — a draw, most often. */
  draw: 200,
  /** Everything else on the state channel. */
  default: 150,
};

/** The classes of frame that start something the board draws: each waits for the board's beats, and goes out in a task of its own. */
export const HELD_BY_THE_BOARD: ReadonlySet<PaceClass> = new Set<PaceClass>(['cast', 'resolve', 'turn', 'draw', 'default']);

/** The classes that step the game on: one queued behind another frame was passed straight through, so it keeps no gap. */
const STEPS: ReadonlySet<PaceClass> = new Set<PaceClass>(['phase', 'turn']);

/** The longest a frame waits on the board's beats: a beat that never says it is over must not freeze the table. */
export const BOARD_HOLD_MAX_MS = 5_000;

/**
 * A decision — an ask, or Forge's prompt line — that waited at least this long behind what came before it is
 * reported (`input-held`): how long, and how much of that was the board's beats and the classes' gaps (the
 * operator, 2026-10-20, of a looped combo: "it seems i have to wait for the life gain sound to play before i
 * can do the combo again?"). The other input notifies ride with it and say nothing more.
 */
export const INPUT_HELD_REPORT_MS = 100;

/** What an `input-held` report says: the frame's method, its wait, and what the wait was spent on. */
export interface InputHeld {
  what: 'input-held';
  method: string;
  ms: number;
  boardMs: number;
  gapMs: number;
  /** Frames that went out ahead of it while it waited. */
  ahead: number;
  /** Their classes, counted: `resolve×2 default×3`. */
  classes: string;
  /** What the `default` frames among them changed (`Type.Property`, or a notify's method), the gaps nobody named. */
  defaults: string;
}

/** A report's string field: at most what the telemetry schema keeps. */
const REPORT_TEXT_MAX = 80;

/** Whether a frame opens a decision: an ask, or Forge's prompt line. */
function opensDecision(payload: unknown): boolean {
  const frame = (payload as { frame?: { kind?: unknown; method?: unknown } } | null)?.frame;
  return frame?.kind === 'ask' || frame?.method === 'showPromptMessage';
}

const WIRE_TYPE_NAMES: Readonly<Record<number, string>> = { 0: 'Card', 1: 'Player', 2: 'StackItem', 3: 'Game' };

/** The `Type.Property` names a delta changes, or any other frame's own method, for a report. */
function changedProperties(payload: unknown): string[] {
  const frame = (payload as { frame?: { method?: unknown; payload?: { packet?: unknown } } } | null)?.frame;
  if (frame?.method !== 'applyDelta') return [methodOf(payload)];
  const packet = frame.payload?.packet;
  const names = new Set<string>();
  for (const { obj } of packetObjects(packet)) {
    const type = typeof obj._type === 'number' ? (WIRE_TYPE_NAMES[obj._type] ?? String(obj._type)) : '?';
    for (const key of Object.keys(obj)) if (key !== '_type' && key !== '_id') names.add(`${type}.${key}`);
  }
  return [...names];
}

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

/** `WireType.*`, `../wire.ts` — copied as bare numbers rather than imported, for the same reason: this file reads the wire, it does not fold it. */
const WIRE_TYPE_CARD = 0;
const WIRE_TYPE_PLAYER = 1;
const WIRE_TYPE_STACK_ITEM = 2;
const WIRE_TYPE_GAME = 3;

/**
 * Properties nothing on the board reads. Forge flips `MindSlaveMaster` on the caster twice in every
 * cast (measured: alone in a frame at the cast's start and again at its payment), and each such
 * frame cost the cast a `default` gap — the first one in front of the cast's own ability ask.
 */
const UNDRAWN_PROPERTIES: ReadonlySet<string> = new Set(['MindSlaveMaster']);

/**
 * Notifies nothing in this client reads: Forge closing the zones a `tempShowZones` opened. Each one cost the
 * next question a `default` gap — measured in `e2e/tf-thopter-sword.spec.ts`, two `hideZones` ahead of the
 * priority after every Thopter Foundry sacrifice.
 */
const UNDRAWN_NOTIFIES: ReadonlySet<string> = new Set(['hideZones', 'restoreOldZones']);

/** What {@link classify} remembers between frames: the stack's depth after the last frame that carried it, or null before one has. */
export interface PaceMemory {
  stackDepth: number | null;
}

/** A tagged value's `v`, when it is the shape asked for. */
function tagged(obj: Record<string, unknown>, key: string): unknown {
  const value = obj[key];
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>).v : undefined;
}

/** Every object a packet's two arms carry, annotation keys (`_omitted`) dropped. */
function packetObjects(packet: unknown): { obj: Record<string, unknown>; isNew: boolean }[] {
  if (typeof packet !== 'object' || packet === null) return [];
  const p = packet as Record<string, unknown>;
  const out: { obj: Record<string, unknown>; isNew: boolean }[] = [];
  for (const arm of ['newObjects', 'objectDeltas'] as const) {
    const map = p[arm];
    if (typeof map !== 'object' || map === null) continue;
    for (const [key, obj] of Object.entries(map as Record<string, unknown>)) {
      if (key.startsWith('_')) continue;
      if (typeof obj === 'object' && obj !== null) out.push({ obj: obj as Record<string, unknown>, isNew: arm === 'newObjects' });
    }
  }
  return out;
}

/**
 * One raw `forge:s2c` payload (the server envelope — unparsed, same reason
 * `./transport.ts`'s own `frame` field is `unknown`: a payload this cannot
 * read is not this file's to reject, only to leave at `'default'`) to a pace
 * class. `memory` carries the stack's depth from one frame to the next (the
 * wrapper keeps one per match); it is updated here. Exported so `pace.test.ts`
 * can pin every branch directly, against shapes built from this module's own
 * header rather than guessed.
 */
export function classify(payload: unknown, memory: PaceMemory = { stackDepth: null }): PaceClass {
  if (typeof payload !== 'object' || payload === null) return 'default';
  const frame = (payload as Record<string, unknown>).frame;
  if (typeof frame !== 'object' || frame === null) return 'default';
  const f = frame as Record<string, unknown>;
  if (f.kind === 'ask') return 'input';
  if (f.kind !== 'notify') return 'default';
  const method = f.method;
  if (typeof method === 'string' && INPUT_NOTIFY_METHODS.has(method)) return 'input';
  if (method === 'message') return 'log';
  if (typeof method === 'string' && UNDRAWN_NOTIFIES.has(method)) return 'unseen';
  if (method !== 'applyDelta') return 'default';
  const packetPayload = f.payload;
  const packet =
    typeof packetPayload === 'object' && packetPayload !== null
      ? (packetPayload as Record<string, unknown>).packet
      : undefined;
  const objects = packetObjects(packet);
  let stack: number | null = null;
  let newStackItem = false;
  let sawPhase = false;
  let newTurn = false;
  let arrivedInHand = false;
  let castPiece = false;
  let drawn = false;
  let hit = false;
  for (const { obj, isNew } of objects) {
    const type = obj._type;
    if (Object.keys(obj).some((k) => k !== '_type' && k !== '_id' && !UNDRAWN_PROPERTIES.has(k))) drawn = true;
    if (type === WIRE_TYPE_GAME) {
      const list = tagged(obj, 'Stack');
      if (Array.isArray(list)) stack = list.length;
      else if ('Stack' in obj) stack = 0;
      if ('Phase' in obj) sawPhase = true;
      if ('Turn' in obj || 'PlayerTurn' in obj) newTurn = true;
    } else if (type === WIRE_TYPE_STACK_ITEM) {
      if (isNew) newStackItem = true;
    } else if (type === WIRE_TYPE_PLAYER) {
      // A hand that changed with no card arriving in it: a card left it — cast, played or discarded. A mana
      // pool changing is a cost being paid: the sacrifice after Thopter Foundry's {1} waited a `default` gap on it.
      if ('Hand' in obj || 'Mana' in obj) castPiece = true;
      if ('Life' in obj) hit = true;
    } else if (type === WIRE_TYPE_CARD) {
      const zone = tagged(obj, 'Zone');
      if (zone === 'Hand') arrivedInHand = true;
      if (zone === 'Stack' || tagged(obj, 'Tapped') === true) castPiece = true;
      if ('Damage' in obj) hit = true;
    }
  }
  if (stack !== null) {
    const before = memory.stackDepth;
    memory.stackDepth = stack;
    return (before === null ? newStackItem : stack > before) ? 'cast' : 'resolve';
  }
  // What the board draws decides before the step: Forge moves the phase in the same frame as an attack, combat
  // damage or a draw, and a "phase" there was let straight through with everything behind it.
  if (hit) return 'default';
  if (arrivedInHand) return 'draw';
  if (castPiece) return 'cast';
  if (newTurn) return 'turn';
  if (sawPhase) return 'phase';
  if (objects.length > 0 && !drawn) return 'unseen';
  return 'default';
}

/* ── The wrapper ─────────────────────────────────────────────────────── */

/** A queued payload: its class, and what the waits had been spent on when it arrived ({@link InputHeld}). */
interface Entry {
  payload: unknown;
  pace: PaceClass;
  arrivedAt: number;
  boardAt: number;
  gapAt: number;
  deliveredAt: number;
}

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
  /** Runs `done` once the board has drawn every beat it is drawing, at once when it is still; returns a cancel. Defaults to `../motion.ts`'s `whenBoardStill`. */
  boardStill?: (done: () => void) => () => void;
  /** Where an {@link InputHeld} goes, with the payload it is about. Defaults to the match's client telemetry, on the inner transport. */
  report?: (held: InputHeld, payload: unknown) => void;
}

/** The match's client telemetry: the server writes it into the match's log (`@hadoku/shared`'s `telemetry.ts`). */
function reportOn(inner: MatchTransport): (held: InputHeld, payload: unknown) => void {
  return (held, payload) => {
    const matchId = (payload as { matchId?: unknown }).matchId;
    if (typeof matchId !== 'string' || matchId === '') return;
    inner.emit(CLIENT_EVENT, { matchId, kind: 'effect', data: { ...held } } satisfies ClientEvent);
  };
}

/** The method a frame names, for a report. */
function methodOf(payload: unknown): string {
  const method = ((payload as { frame?: { method?: unknown } } | null)?.frame ?? {}).method;
  return typeof method === 'string' ? method : '?';
}

export function pacedMatchTransport(inner: MatchTransport, options: PaceOptions = {}): PacedMatchTransport {
  const delays: Readonly<Record<PaceClass, number>> = { ...PACE_DELAYS_MS, ...options.delays };
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((run: () => void, delayMs: number) => setTimeout(run, delayMs));
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const boardStill = options.boardStill ?? whenBoardStill;
  const report = options.report ?? reportOn(inner);

  let fast = options.initialFast ?? false;
  let endingTurn = false;
  /** Each payload with its class, read on arrival — in arrival order, which is what `memory` needs and the cursor `match.ts` checks. */
  let queue: Entry[] = [];
  const memory: PaceMemory = { stackDepth: null };
  let timer: unknown = null;
  let lastDeliveredAt = -Infinity;
  /** The handler `startMatch` registered for `MATCH_EVENTS.serverToClient` — null until `on` is called for it, which `startMatch` always does before anything can arrive. */
  let deliverTo: ((payload: unknown) => void) | null = null;

  /*
   * A phase frame with something already queued behind it is a phase Forge passed straight through: nobody
   * stopped there, so it goes at once instead of holding the board for its 250 ms. On every screen, so the other
   * seat's End Turn no longer steps past one phase (and one phase sound) at a time either (the operator,
   * 2026-10-12: "hearing some duplicate sounds" — 15-19 phase sounds 250 ms apart a game, each an opponent's
   * End Turn). The phase that is still the newest keeps its pace.
   */
  function delayFor(pace: PaceClass, superseded: boolean): number {
    if (fast) return 0;
    return STEPS.has(pace) && (endingTurn || superseded) ? 0 : delays[pace];
  }

  /*
   * What the waits were spent on, for {@link InputHeld}: the time spent on the board's beats and on the classes'
   * gaps so far, each counting the wait still running.
   */
  let boardMs = 0;
  let gapMs = 0;
  let boardSince: number | null = null;
  let gapSince: number | null = null;
  let delivered = 0;
  /** The classes of the latest frames delivered, and a `default` frame's properties, for a report: `delivered` counts them all. */
  const recent: { pace: PaceClass; properties: string[] }[] = [];
  const RECENT_MAX = 64;
  const spent = (): { board: number; gap: number } => ({
    board: boardMs + (boardSince === null ? 0 : now() - boardSince),
    gap: gapMs + (gapSince === null ? 0 : now() - gapSince),
  });
  function entryOf(payload: unknown, pace: PaceClass): Entry {
    const at = spent();
    return { payload, pace, arrivedAt: now(), boardAt: at.board, gapAt: at.gap, deliveredAt: delivered };
  }

  function deliverNext(): void {
    const next = queue.shift();
    if (next === undefined) return;
    lastDeliveredAt = now();
    const held = lastDeliveredAt - next.arrivedAt;
    if (next.pace === 'input' && held >= INPUT_HELD_REPORT_MS && opensDecision(next.payload)) {
      const at = spent();
      const ahead = recent.slice(Math.max(0, recent.length - (delivered - next.deliveredAt)));
      const counts = new Map<PaceClass, number>();
      for (const r of ahead) counts.set(r.pace, (counts.get(r.pace) ?? 0) + 1);
      report(
        {
          what: 'input-held',
          method: methodOf(next.payload),
          ms: Math.round(held),
          boardMs: Math.round(at.board - next.boardAt),
          gapMs: Math.round(at.gap - next.gapAt),
          ahead: delivered - next.deliveredAt,
          classes: [...counts].map(([pace, n]) => `${pace}×${n}`).join(' ').slice(0, REPORT_TEXT_MAX),
          defaults: [...new Set(ahead.flatMap((r) => r.properties))].join(',').slice(0, REPORT_TEXT_MAX),
        },
        next.payload,
      );
    }
    recent.push({ pace: next.pace, properties: next.pace === 'default' ? changedProperties(next.payload) : [] });
    if (recent.length > RECENT_MAX) recent.shift();
    delivered += 1;
    deliverTo?.(next.payload);
  }

  /** The queued frame the board has let go: a frame waits for the board once, never again (the cap's own promise). */
  let boardFreed: Entry | null = null;
  /** Stops the wait on the board, while one is running. */
  let boardWait: (() => void) | null = null;
  /** A frame the board draws went out in the task now running. */
  let drewThisTask = false;

  /** Start waiting for the board's beats before `entry` goes out, when it must: `false` when it need not, or the board is already still. */
  function waitForBoard(entry: Entry): boolean {
    if (fast || !HELD_BY_THE_BOARD.has(entry.pace) || boardFreed === entry) return false;
    let waiting = false;
    let stillNow = false;
    const release = (): void => {
      if (!waiting) {
        stillNow = true;
        return;
      }
      if (boardWait === null) return;
      const stop = boardWait;
      boardWait = null;
      stop();
      boardFreed = entry;
      endBoardWait();
      pump();
    };
    const stopStill = boardStill(release);
    if (stillNow) return false;
    waiting = true;
    boardSince = now();
    const cap = schedule(release, BOARD_HOLD_MAX_MS);
    boardWait = () => {
      stopStill();
      cancel(cap);
    };
    return true;
  }

  /** Deliver whatever is due, and schedule a timer for whatever is not — never more than one timer, or one wait on the board, live at once. */
  function pump(): void {
    if (timer !== null || boardWait !== null || queue.length === 0) return;
    const head = queue[0]!;
    const waitMs = Math.max(0, lastDeliveredAt + delayFor(head.pace, queue.length > 1) - now());
    if (waitMs > 0) {
      gapSince = now();
      timer = schedule(() => {
        timer = null;
        endGap();
        drewThisTask = false;
        pump();
      }, waitMs);
      return;
    }
    const drawn = !fast && HELD_BY_THE_BOARD.has(head.pace);
    if (drawn && drewThisTask) {
      // Another frame the board draws went out in this task: this one waits for a task of its own, after that one's render.
      timer = schedule(() => {
        timer = null;
        drewThisTask = false;
        pump();
      }, 0);
      return;
    }
    if (waitForBoard(head)) return;
    deliverNext();
    if (drawn) {
      drewThisTask = true;
      // React draws what went out at the end of this task (its own microtask); a frame arriving in a later task is a new view.
      void Promise.resolve().then(() => {
        drewThisTask = false;
      });
    }
    pump();
  }

  function endGap(): void {
    if (gapSince !== null) gapMs += now() - gapSince;
    gapSince = null;
  }
  function endBoardWait(): void {
    if (boardSince !== null) boardMs += now() - boardSince;
    boardSince = null;
  }

  /** Stop the timer, when one is pending. */
  function stopTimer(): void {
    if (timer === null) return;
    cancel(timer);
    timer = null;
    endGap();
  }

  /** Stop whatever is pending: the timer, and any wait on the board. */
  function stopPending(): void {
    stopTimer();
    if (boardWait !== null) {
      const stop = boardWait;
      boardWait = null;
      stop();
      endBoardWait();
    }
  }

  /** Cancel whatever is pending and deliver the rest of the queue right now, in order. */
  function flush(): void {
    stopPending();
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
        queue.push(entryOf(payload, classify(payload, memory)));
        // A step waiting on its gap has just been superseded: let it go now.
        if (timer !== null && queue.length === 2 && STEPS.has(queue[0]!.pace) && !fast) stopTimer();
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
      stopPending();
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
        stopTimer();
        pump();
      }
    },
  };
}

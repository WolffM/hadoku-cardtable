/*
 * `pace.ts` on its own, never through `./match.ts` (unowned this wave, and
 * these tests are about the wrapper's own scheduling, not the fold). Every
 * payload below is the one shape `classify` reads — see `pace.ts`'s module
 * header for where each field name comes from (`../adapter.ts`'s own reads
 * off the folded state) — never a fixture built from a real capture, because
 * the wrapper does not care what a real game looks like, only what the
 * ENVELOPE'S OWN SHAPE says.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MatchTransport } from './match.ts';
import { MATCH_EVENTS } from './transport.ts';
import { FLIP_MS } from './CoinToss.tsx';
import { DIE_STAGGER_MS, POP_MS, TUMBLE_MS } from './dice.ts';
import { actMemory, BOARD_HOLD_MAX_MS, classify, inTheAir, isPacedTransport, ownAct, pacedMatchTransport, PACE_DELAYS_MS, type PaceClass } from './pace.ts';

/* ── Building the shapes `classify` reads ────────────────────────────── */

const ASK = { frame: { kind: 'ask', callId: 'c1', method: 'showConfirmDialog' } };
const INPUT_NOTIFY = { frame: { kind: 'notify', method: 'setWeaklySelectable', cards: [] } };
const MESSAGE = { frame: { kind: 'notify', method: 'message', message: 'Alice cast Lightning Bolt targeting Bob', title: '', log: { type: 'STACK_ADD', cards: [{ id: 3, name: 'Lightning Bolt' }] } } };

function deltaOf(objects: Record<string, Record<string, unknown>>, newObjects: Record<string, Record<string, unknown>> = {}): unknown {
  return { frame: { kind: 'notify', method: 'applyDelta', payload: { packet: { newObjects, objectDeltas: objects } } } };
}

const stackOf = (ids: number[]) => ({ _type: 3, _id: 1, Stack: { t: 'list', v: ids.map((v) => ({ t: 'int', v })) } });
const zone = (id: number, v: string) => ({ _type: 0, _id: id, Zone: { t: 'enum', c: 'ZoneType', v } });

const RESOLVE = deltaOf({ g: stackOf([]) });
const PHASE = deltaOf({ g: { _type: 3, _id: 1, Phase: { t: 'enum', c: 'PhaseType', v: 'MAIN1' } } });
/** Forge's next turn beginning: `Turn`, `PlayerTurn` and `Phase` in one Game delta (`e2e/aa-ai-beats.spec.ts`'s wire record). */
const NEW_TURN = deltaOf({ g: { _type: 3, _id: 1, Turn: { t: 'int', v: 3 }, PlayerTurn: { t: 'int', v: 0 }, Phase: { t: 'enum', c: 'PhaseType', v: 'UPKEEP' } } });
const DRAW = deltaOf({ c9: zone(9, 'Hand'), p0: { _type: 1, _id: 0, Hand: { t: 'list', v: [{ t: 'int', v: 9 }] } } });
const DEFAULT_DELTA = deltaOf({ p0: { _type: 1, _id: 0, Life: { t: 'int', v: 17 } } });
const FINISH = { frame: { kind: 'notify', method: 'finishGame', losers: [1] } };
/** The frame that shows the end: the bolt resolving, the last life gone, the game over. */
const LETHAL = deltaOf({ g: { ...stackOf([]), GameOver: { t: 'bool', v: true } }, p1: { _type: 1, _id: 1, Life: { t: 'int', v: 0 } } });

/*
 * A cast as Forge sends it (`e2e/w71-tap-reveal.spec.ts`'s wire record of Grizzly Bears paid by two
 * Forests): the caster flagged, the card out of the hand, the lands tapped, the spell on the stack —
 * then, after priority goes round, the stack empty again and the creature on the battlefield.
 */
const CAST_FLAG = deltaOf({ p0: { _type: 1, _id: 0, MindSlaveMaster: { t: 'int', v: 0 } } });
const HAND_OUT = deltaOf({ p0: { _type: 1, _id: 0, Hand: { t: 'list', v: [] } } });
const TAPS = deltaOf({
  c167: { _type: 0, _id: 167, Tapped: { t: 'bool', v: true }, NeedsTapAnimation: { t: 'bool', v: true } },
  c168: { _type: 0, _id: 168, Tapped: { t: 'bool', v: true }, NeedsTapAnimation: { t: 'bool', v: true } },
  p0: { _type: 1, _id: 0, Mana: { t: 'map', v: [] } },
});
const ON_STACK = deltaOf({ g: stackOf([3]) }, { c160: zone(160, 'Stack'), s3: { _type: 2, _id: 3, SourceCard: { t: 'int', v: 160 } } });
const RESOLVED = deltaOf({ c160: zone(160, 'Battlefield'), g: stackOf([]) });

describe('classify', () => {
  it('an ask is input', () => expect(classify(ASK)).toBe('input'));
  it('an input-showing notify is input', () => expect(classify(INPUT_NOTIFY)).toBe('input'));
  it('a Stack delta is resolve, even alongside a Phase key — resolve wins', () =>
    expect(classify(deltaOf({ g: { _type: 3, _id: 3, Stack: { t: 'list', v: [] }, Phase: { t: 'enum', c: 'PhaseType', v: 'MAIN1' } } }))).toBe(
      'resolve',
    ));
  it('a Phase delta with no Stack key is phase', () => expect(classify(PHASE)).toBe('phase'));
  it('a frame that moves the turn is a turn, not a phase step', () => expect(classify(NEW_TURN)).toBe('turn'));
  it('the active player changing alone is a turn too', () => expect(classify(deltaOf({ g: { _type: 3, _id: 1, PlayerTurn: { t: 'int', v: 0 } } }))).toBe('turn'));
  /* The Forge AI's turn as it reached the defender (`e2e/aa-ai-beats.spec.ts`, cursors 41, 51 and 67): the step moves with the act. */
  const phaseTo = (v: string) => ({ _type: 3, _id: 1, Phase: { t: 'enum', c: 'PhaseType', v } });
  it('attackers declared in the frame that moves to Declare Attackers are a cast piece, not a phase step', () =>
    expect(classify(deltaOf({ c131: { _type: 0, _id: 131, Attacking: { t: 'bool', v: true }, Tapped: { t: 'bool', v: true } }, g: phaseTo('COMBAT_DECLARE_ATTACKERS') }))).toBe('cast'));
  it('combat damage in the frame that moves to Combat Damage is a drawn change, not a phase step', () =>
    expect(classify(deltaOf({ p0: { _type: 1, _id: 0, Life: { t: 'int', v: 15 } }, g: phaseTo('COMBAT_DAMAGE') }))).toBe('default'));
  it('a creature hurt in a phase frame is a drawn change too', () =>
    expect(classify(deltaOf({ c7: { _type: 0, _id: 7, Damage: { t: 'int', v: 2 } }, g: phaseTo('COMBAT_DAMAGE') }))).toBe('default'));
  it("the turn's draw in the frame that moves to the draw step is a draw", () =>
    expect(classify(deltaOf({ c121: zone(121, 'Hand'), g: phaseTo('DRAW') }))).toBe('draw'));
  it('a card arriving in a hand is draw', () => expect(classify(DRAW)).toBe('draw'));
  it('an unrecognised delta is default', () => expect(classify(DEFAULT_DELTA)).toBe('default'));
  it('a delta of nothing the board draws is unseen', () => expect(classify(CAST_FLAG)).toBe('unseen'));
  it('a mana pool paying a cost is cast', () =>
    expect(classify(deltaOf({ p0: { _type: 1, _id: 0, MindSlaveMaster: { t: 'int', v: 0 }, Mana: { t: 'map', v: [] } } }))).toBe('cast'));
  it('Forge closing the zones it showed for a question draws nothing: unseen', () => {
    expect(classify({ frame: { kind: 'notify', method: 'hideZones' } })).toBe('unseen');
    expect(classify({ frame: { kind: 'notify', method: 'restoreOldZones' } })).toBe('unseen');
  });
  it('a card leaving a hand is cast', () => expect(classify(HAND_OUT)).toBe('cast'));
  it('a land tapping is cast', () => expect(classify(TAPS)).toBe('cast'));
  it('a card untapping is not', () => expect(classify(deltaOf({ c1: { _type: 0, _id: 1, Tapped: { t: 'bool', v: false } } }))).toBe('default'));
  it('the stack growing is cast; shrinking, or the same depth, is resolve', () => {
    const memory = { stackDepth: null };
    expect(classify(ON_STACK, memory)).toBe('cast');
    expect(memory.stackDepth).toBe(1);
    expect(classify(deltaOf({ g: stackOf([3, 4]) }), memory)).toBe('cast');
    expect(classify(deltaOf({ g: stackOf([5, 3]) }), memory)).toBe('resolve');
    expect(classify(deltaOf({ g: stackOf([3]) }), memory)).toBe('resolve');
    expect(classify(RESOLVED, memory)).toBe('resolve');
    expect(memory.stackDepth).toBe(0);
  });
  it('with no depth remembered yet, a frame bringing a new stack item is cast, any other stack frame resolve', () => {
    expect(classify(ON_STACK)).toBe('cast');
    expect(classify(deltaOf({ g: stackOf([3]) }))).toBe('resolve');
  });
  it('a message notify — a game log line — is log, and waits on nothing', () => {
    expect(classify(MESSAGE)).toBe('log');
    expect(PACE_DELAYS_MS.log).toBe(0);
  });
  it('garbage is default, never a throw', () => {
    expect(classify(null)).toBe('default');
    expect(classify(42)).toBe('default');
    expect(classify({})).toBe('default');
    expect(classify({ frame: null })).toBe('default');
  });
});

/* ── The wrapper ──────────────────────────────────────────────────────── */

interface FakeInner extends MatchTransport {
  /** What `pacedMatchTransport` registered for `MATCH_EVENTS.serverToClient`. */
  deliver(payload: unknown): void;
  /** Fire whatever was registered for `event` (any event, not just serverToClient). */
  fire(event: string, payload: unknown): void;
  emits: { event: string; payload: unknown }[];
  requests: { event: string; payload: unknown }[];
  /** The ack `request()` was told to answer with, on its NEXT call. */
  nextAck: { err: Error | null; response: unknown };
  disconnected: boolean;
}

function fakeInner(): FakeInner {
  const handlers = new Map<string, (payload: unknown) => void>();
  const inner: FakeInner = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    emit(event, payload) {
      inner.emits.push({ event, payload });
    },
    request(event, payload, onAck) {
      inner.requests.push({ event, payload });
      onAck(inner.nextAck.err, inner.nextAck.response);
    },
    disconnect() {
      inner.disconnected = true;
    },
    deliver(payload) {
      handlers.get(MATCH_EVENTS.serverToClient)?.(payload);
    },
    fire(event, payload) {
      handlers.get(event)?.(payload);
    },
    emits: [],
    requests: [],
    nextAck: { err: null, response: null },
    disconnected: false,
  };
  return inner;
}

/** `pacedMatchTransport`'s own `on(MATCH_EVENTS.serverToClient, …)` registration, captured for assertions. */
function paced(inner: MatchTransport, opts: Parameters<typeof pacedMatchTransport>[1] = {}) {
  const transport = pacedMatchTransport(inner, opts);
  const received: unknown[] = [];
  transport.on(MATCH_EVENTS.serverToClient, (payload) => received.push(payload));
  return { transport, received };
}

describe('pacedMatchTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('quiet: the first payload is applied at once, no timer needed', () => {
    const inner = fakeInner();
    const { received } = paced(inner);
    inner.deliver(RESOLVE);
    expect(received).toEqual([RESOLVE]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('quiet: a payload arriving long after the previous one is also applied at once', () => {
    const inner = fakeInner();
    const { received } = paced(inner);
    inner.deliver(PHASE);
    expect(received).toEqual([PHASE]);
    vi.advanceTimersByTime(PACE_DELAYS_MS.phase + 5_000);
    inner.deliver(DRAW);
    // No timer was needed: the required gap after PHASE had long elapsed.
    expect(received).toEqual([PHASE, DRAW]);
  });

  it('a burst is spread by the table: each payload waits its OWN class delay after the previous delivery', () => {
    const inner = fakeInner();
    const { received } = paced(inner);
    inner.deliver(RESOLVE); // delivered at t=0
    inner.deliver(PHASE); // queued — needs PHASE's own delay after t=0
    expect(received).toEqual([RESOLVE]);
    vi.advanceTimersByTime(PACE_DELAYS_MS.phase - 1);
    expect(received).toEqual([RESOLVE]); // still held
    vi.advanceTimersByTime(1);
    expect(received).toEqual([RESOLVE, PHASE]);
  });

  it('order is kept across a three-deep burst', () => {
    const inner = fakeInner();
    const { received } = paced(inner);
    // A phase in the middle would be superseded and go at once (its own test, below): a default frame keeps a gap.
    inner.deliver(RESOLVE);
    inner.deliver(DEFAULT_DELTA);
    inner.deliver(DRAW);
    expect(received).toEqual([RESOLVE]);
    vi.advanceTimersByTime(PACE_DELAYS_MS.default);
    expect(received).toEqual([RESOLVE, DEFAULT_DELTA]);
    vi.advanceTimersByTime(PACE_DELAYS_MS.draw);
    expect(received).toEqual([RESOLVE, DEFAULT_DELTA, DRAW]);
  });

  it('a cast goes out as Forge sends it — release, taps and the stack card at once — and its resolution keeps its pace', async () => {
    const inner = fakeInner();
    const { received } = paced(inner);
    inner.deliver(PHASE); // the table was just busy: the next paced frame would wait
    // Each frame its own socket message, so its own task.
    for (const frame of [CAST_FLAG, ASK, HAND_OUT, CAST_FLAG, TAPS, ON_STACK]) {
      inner.deliver(frame);
      await Promise.resolve();
    }
    expect(received).toEqual([PHASE, CAST_FLAG, ASK, HAND_OUT, CAST_FLAG, TAPS, ON_STACK]);
    expect(vi.getTimerCount()).toBe(0);
    inner.deliver(RESOLVED);
    expect(received).toHaveLength(7);
    vi.advanceTimersByTime(PACE_DELAYS_MS.resolve);
    expect(received.at(-1)).toBe(RESOLVED);
  });

  it("the game log's lines inside a cast — the mana that paid, the cast itself — do not pull it apart", async () => {
    const inner = fakeInner();
    const { received } = paced(inner);
    inner.deliver(PHASE);
    for (const frame of [HAND_OUT, MESSAGE, TAPS, MESSAGE, ON_STACK]) {
      inner.deliver(frame);
      await Promise.resolve();
    }
    expect(received).toEqual([PHASE, HAND_OUT, MESSAGE, TAPS, MESSAGE, ON_STACK]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an input frame is never held, even mid-burst: its own delay is zero, so it is due the instant it is next', () => {
    const inner = fakeInner();
    const { received } = paced(inner);
    inner.deliver(RESOLVE); // quiet: delivered at once
    inner.deliver(ASK); // next in the FIFO queue, but ASK's own delay is 0 — no wait at all
    expect(received).toEqual([RESOLVE, ASK]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the toggle flushes the queue at once', () => {
    const inner = fakeInner();
    const { transport, received } = paced(inner);
    inner.deliver(RESOLVE);
    inner.deliver(DEFAULT_DELTA);
    inner.deliver(DRAW);
    expect(received).toEqual([RESOLVE]);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    transport.setFast(true);
    expect(received).toEqual([RESOLVE, DEFAULT_DELTA, DRAW]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ending the turn lets phase-only frames straight through, and keeps every other pace', () => {
    const inner = fakeInner();
    const { transport, received } = paced(inner);
    inner.deliver(RESOLVE);
    inner.deliver(PHASE); // waiting on its 250 ms when End Turn is pressed
    expect(received).toEqual([RESOLVE]);
    transport.setEndingTurn(true);
    expect(received).toEqual([RESOLVE, PHASE]);
    inner.deliver(PHASE);
    inner.deliver(PHASE);
    expect(received).toEqual([RESOLVE, PHASE, PHASE, PHASE]);
    inner.deliver(DRAW);
    expect(received).toHaveLength(4);
    vi.advanceTimersByTime(PACE_DELAYS_MS.draw);
    expect(received).toHaveLength(5);
  });

  it('a phase with another frame behind it was passed straight through: it goes at once, on any screen', () => {
    const inner = fakeInner();
    const { received } = paced(inner);
    inner.deliver(RESOLVE);
    inner.deliver(PHASE); // waiting on its 250 ms
    expect(received).toEqual([RESOLVE]);
    inner.deliver(PHASE); // the first is superseded
    expect(received).toEqual([RESOLVE, PHASE]);
    inner.deliver(DRAW); // and so is the second
    expect(received).toEqual([RESOLVE, PHASE, PHASE]);
    vi.advanceTimersByTime(PACE_DELAYS_MS.draw);
    expect(received).toEqual([RESOLVE, PHASE, PHASE, DRAW]);
  });

  it('the newest phase keeps its pace', () => {
    const inner = fakeInner();
    const { received } = paced(inner);
    inner.deliver(RESOLVE);
    inner.deliver(PHASE);
    vi.advanceTimersByTime(PACE_DELAYS_MS.phase - 1);
    expect(received).toEqual([RESOLVE]);
    vi.advanceTimersByTime(1);
    expect(received).toEqual([RESOLVE, PHASE]);
  });

  it('once the turn has changed, phases are paced again', () => {
    const inner = fakeInner();
    const { transport, received } = paced(inner);
    transport.setEndingTurn(true);
    transport.setEndingTurn(false);
    inner.deliver(RESOLVE);
    inner.deliver(PHASE);
    expect(received).toEqual([RESOLVE]);
    vi.advanceTimersByTime(PACE_DELAYS_MS.phase);
    expect(received).toEqual([RESOLVE, PHASE]);
  });

  it('the end notice keeps its place: the frame that shows the end goes out behind it, in the order the server sent them', () => {
    const inner = fakeInner();
    const { received } = paced(inner);
    inner.deliver(RESOLVE);
    inner.deliver(FINISH);
    inner.deliver(LETHAL);
    vi.runAllTimers();
    expect(received).toEqual([RESOLVE, FINISH, LETHAL]);
  });

  it('fast mode from the start holds nothing', () => {
    const inner = fakeInner();
    const { received } = paced(inner, { initialFast: true });
    inner.deliver(RESOLVE);
    inner.deliver(PHASE);
    inner.deliver(DRAW);
    expect(received).toEqual([RESOLVE, PHASE, DRAW]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('toggling back to paced resumes pacing for what arrives next', () => {
    const inner = fakeInner();
    const { transport, received } = paced(inner, { initialFast: true });
    inner.deliver(RESOLVE);
    transport.setFast(false);
    vi.advanceTimersByTime(60_000); // long quiet gap
    inner.deliver(PHASE);
    inner.deliver(DRAW);
    expect(received).toEqual([RESOLVE, PHASE]); // PHASE: quiet, applied at once
    vi.advanceTimersByTime(PACE_DELAYS_MS.draw);
    expect(received).toEqual([RESOLVE, PHASE, DRAW]);
  });

  it('a snapshot jumps the queue: request() and its ack are never paced, queue or no queue', () => {
    const inner = fakeInner();
    inner.nextAck = { err: null, response: { matchId: 'm1', seat: 0, playerId: 0, cursor: null, frames: [] } };
    const { transport } = paced(inner);
    inner.deliver(RESOLVE);
    inner.deliver(PHASE); // now queued, mid-pace — PHASE is still waiting
    let ack: unknown = 'never answered';
    transport.request(MATCH_EVENTS.resync, { matchId: 'm1' }, (err, response) => {
      ack = response;
    });
    // The ack landed in the SAME synchronous call, with the pace queue still
    // holding PHASE — a snapshot never waits behind a queue of stale deltas
    // because it never enters this queue at all.
    expect(inner.requests).toEqual([{ event: MATCH_EVENTS.resync, payload: { matchId: 'm1' } }]);
    expect(ack).toEqual(inner.nextAck.response);
  });

  it('outgoing frames (emit) are never delayed, queue or no queue', () => {
    const inner = fakeInner();
    const { transport } = paced(inner);
    inner.deliver(RESOLVE);
    inner.deliver(PHASE); // queued
    transport.emit(MATCH_EVENTS.clientToServer, { matchId: 'm1', frame: { kind: 'act', method: 'selectButtonOk' } });
    expect(inner.emits).toEqual([{ event: MATCH_EVENTS.clientToServer, payload: { matchId: 'm1', frame: { kind: 'act', method: 'selectButtonOk' } } }]);
  });

  it('every other event name passes straight through `on`, unpaced', () => {
    const inner = fakeInner();
    const transport = pacedMatchTransport(inner);
    const seen: unknown[] = [];
    transport.on(MATCH_EVENTS.fullControl, (p) => seen.push(p));
    // Firing the handler INNER actually holds for this event — proving the
    // wrapper registered the caller's own handler with `inner`, not one of
    // its own, and nothing about it is queued or delayed.
    inner.fire(MATCH_EVENTS.fullControl, { matchId: 'm1', on: true });
    expect(seen).toEqual([{ matchId: 'm1', on: true }]);
  });

  it('disconnect clears the queue and any pending timer, then forwards', () => {
    const inner = fakeInner();
    const { transport, received } = paced(inner);
    inner.deliver(RESOLVE);
    inner.deliver(PHASE); // queued, timer pending
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    transport.disconnect();
    expect(inner.disconnected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(PACE_DELAYS_MS.phase);
    expect(received).toEqual([RESOLVE]); // PHASE was dropped with the match, not delivered late
  });

  it('isPacedTransport narrows a wrapper and refuses a plain MatchTransport', () => {
    const inner = fakeInner();
    const wrapped = pacedMatchTransport(inner);
    expect(isPacedTransport(wrapped)).toBe(true);
    expect(isPacedTransport(inner)).toBe(false);
  });
});

/** A board that is drawing beats until told it is still: `pace.ts`'s `boardStill` seam. */
function fakeBoard(): { still: (done: () => void) => () => void; busy: (on: boolean) => void } {
  let drawing = false;
  const waiters = new Set<() => void>();
  return {
    still(done) {
      if (!drawing) {
        done();
        return () => undefined;
      }
      waiters.add(done);
      return () => waiters.delete(done);
    },
    busy(on) {
      drawing = on;
      if (on) return;
      for (const wake of [...waiters]) {
        waiters.delete(wake);
        wake();
      }
    },
  };
}

/*
 * The operator, 2026-10-19: "they attack me and i dont even see their creatures do the attack because everything
 * happens so fast". The Forge AI's turn reached the other screen as a burst, and went out as one drawn view.
 */
describe('pacedMatchTransport: one act at a time', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const ATTACK = deltaOf({ c5: { _type: 0, _id: 5, Attacking: { t: 'bool', v: true }, Tapped: { t: 'bool', v: true } } });
  const BLOW = deltaOf({ p0: { _type: 1, _id: 0, Life: { t: 'int', v: 15 } } });

  it('two frames the board draws, arriving in one task, go out in two: each is its own view', async () => {
    const inner = fakeInner();
    const { received } = paced(inner);
    inner.deliver(HAND_OUT);
    inner.deliver(MESSAGE);
    inner.deliver(TAPS);
    expect(received, 'the log line rides with the first; the taps wait for a task of their own').toEqual([HAND_OUT, MESSAGE]);
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual([HAND_OUT, MESSAGE, TAPS]);
  });

  it('a frame the board draws waits while the board draws the beats before it, and goes once they are over', async () => {
    const inner = fakeInner();
    const board = fakeBoard();
    const { received } = paced(inner, { boardStill: board.still });
    inner.deliver(ATTACK);
    board.busy(true); // the attack being shown (`numbers.ts`'s attack beat)
    await vi.advanceTimersByTimeAsync(0);
    inner.deliver(BLOW);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(received, 'the blow waits for the attack to have been seen').toEqual([ATTACK]);
    board.busy(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual([ATTACK, BLOW]);
  });

  it('an AI burst — the attack and its blow in one breath — is drawn as two views, the blow after the attack beat', async () => {
    const inner = fakeInner();
    const board = fakeBoard();
    const { received } = paced(inner, { boardStill: board.still });
    const drawn: unknown[][] = [];
    // The board: each delivered frame drawn at the end of its task; an attack holds it for its beat.
    const render = (): void => {
      if (received.length === drawn.flat().length) return;
      const view = received.slice(drawn.flat().length);
      drawn.push(view);
      if (view.includes(ATTACK)) {
        board.busy(true);
        setTimeout(() => board.busy(false), 600);
      }
    };
    inner.deliver(ATTACK);
    inner.deliver(BLOW);
    await Promise.resolve();
    render();
    for (let t = 0; t < 1_000; t += 50) {
      await vi.advanceTimersByTimeAsync(50);
      render();
    }
    expect(drawn, 'the attack, then its blow: never one view').toEqual([[ATTACK], [BLOW]]);
  });

  it("the AI's blow, its End of Turn and the next turn in one burst: the turn waits for the blow's beats, and is a view of its own", async () => {
    const inner = fakeInner();
    const board = fakeBoard();
    const { received } = paced(inner, { boardStill: board.still });
    inner.deliver(BLOW);
    board.busy(true); // the ram (`numbers.ts`'s combat beats)
    inner.deliver(PHASE);
    inner.deliver(NEW_TURN);
    expect(received, 'the step passed straight through rides with the blow').toEqual([BLOW, PHASE]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(received, 'the next turn waits while the ram is drawn').toEqual([BLOW, PHASE]);
    board.busy(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual([BLOW, PHASE, NEW_TURN]);
  });

  it('a new turn is not held when nothing is being drawn, and keeps no gap when another frame is behind it', async () => {
    const inner = fakeInner();
    const { received } = paced(inner);
    inner.deliver(RESOLVE);
    inner.deliver(NEW_TURN);
    expect(received).toEqual([RESOLVE]);
    inner.deliver(PHASE);
    await vi.advanceTimersByTimeAsync(0);
    expect(received, 'the turn goes in a task of its own, its gap waived; the newest phase keeps its own').toEqual([RESOLVE, NEW_TURN]);
  });

  it('Fast Mode holds a new turn for nothing', () => {
    const inner = fakeInner();
    const board = fakeBoard();
    const { transport, received } = paced(inner, { boardStill: board.still });
    transport.setFast(true);
    board.busy(true);
    inner.deliver(BLOW);
    inner.deliver(NEW_TURN);
    expect(received).toEqual([BLOW, NEW_TURN]);
  });

  it('an ask at the head of the queue is never held by the board', () => {
    const inner = fakeInner();
    const board = fakeBoard();
    const { received } = paced(inner, { boardStill: board.still });
    board.busy(true);
    inner.deliver(ASK);
    inner.deliver(MESSAGE);
    expect(received).toEqual([ASK, MESSAGE]);
  });

  it('an ask held behind the board is reported with what it waited on, to the match log', async () => {
    // Thopter Foundry + Sword of the Meek (match m-22c72c4dd6cd): the next loop's question waited on the life gain's beat.
    // The resolution waits its 600 ms gap, then the rest of the beat.
    const inner = fakeInner();
    const board = fakeBoard();
    const { received } = paced(inner, { boardStill: board.still });
    const withMatch = (payload: unknown) => ({ ...(payload as object), matchId: 'm-1' });
    inner.deliver(withMatch(BLOW));
    board.busy(true);
    inner.deliver(withMatch(RESOLVE));
    const ask = withMatch(ASK);
    inner.deliver(ask);
    await vi.advanceTimersByTimeAsync(850);
    board.busy(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(received.at(-1)).toBe(ask);
    expect(inner.emits).toEqual([
      { event: 'forge:client', payload: { matchId: 'm-1', kind: 'effect', data: { what: 'input-held', method: 'showConfirmDialog', ms: 850, boardMs: 250, gapMs: 600, ahead: 1, classes: 'resolve×1', defaults: '' } } },
    ]);
  });

  it("an ask held behind a default frame's gap names what that frame changed", async () => {
    const inner = fakeInner();
    const { received } = paced(inner);
    inner.deliver({ ...(HAND_OUT as object), matchId: 'm-1' });
    inner.deliver({ ...(DEFAULT_DELTA as object), matchId: 'm-1' });
    inner.deliver({ ...ASK, matchId: 'm-1' });
    await vi.advanceTimersByTimeAsync(PACE_DELAYS_MS.default);
    expect(received).toHaveLength(3);
    expect(inner.emits.map((e) => (e.payload as { data: unknown }).data)).toEqual([
      { what: 'input-held', method: 'showConfirmDialog', ms: 150, boardMs: 0, gapMs: 150, ahead: 1, classes: 'default×1', defaults: 'Player.Life' },
    ]);
  });

  it('an ask that goes out at once reports nothing', () => {
    const inner = fakeInner();
    paced(inner);
    inner.deliver({ ...ASK, matchId: 'm-1' });
    expect(inner.emits).toEqual([]);
  });

  it('a beat that never ends holds a frame no longer than the cap', async () => {
    const inner = fakeInner();
    const board = fakeBoard();
    const { received } = paced(inner, { boardStill: board.still });
    board.busy(true);
    inner.deliver(BLOW);
    await vi.advanceTimersByTimeAsync(BOARD_HOLD_MAX_MS - 1);
    expect(received).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(received).toEqual([BLOW]);
  });

  it('a hold that reaches the cap is reported, with what the board was still waiting on; one the board frees is not', async () => {
    const inner = fakeInner();
    const board = fakeBoard();
    const reports: unknown[] = [];
    const { received } = paced(inner, {
      boardStill: board.still,
      report: (r) => reports.push(r),
      boardHold: () => ({ drawing: 1, waitingOn: 'turn-cue×1', lastBeatAt: null }),
    });
    board.busy(true);
    inner.deliver(BLOW);
    await vi.advanceTimersByTimeAsync(BOARD_HOLD_MAX_MS);
    expect(received).toEqual([BLOW]);
    expect(reports).toEqual([{ what: 'board-hold-capped', method: 'applyDelta', pace: 'default', ms: BOARD_HOLD_MAX_MS, drawing: 1, waitingOn: 'turn-cue×1', lastBeatMs: -1 }]);
    inner.deliver(ATTACK);
    await vi.advanceTimersByTimeAsync(PACE_DELAYS_MS.default + 10);
    board.busy(false);
    await vi.advanceTimersByTimeAsync(BOARD_HOLD_MAX_MS);
    expect(reports, 'a hold the board ends in time says nothing').toHaveLength(1);
  });

  it('Fast Mode holds nothing for the board, and turning it on lets a held frame go', async () => {
    const inner = fakeInner();
    const board = fakeBoard();
    const { transport, received } = paced(inner, { boardStill: board.still });
    board.busy(true);
    inner.deliver(BLOW);
    expect(received).toEqual([]);
    transport.setFast(true);
    expect(received).toEqual([BLOW]);
    inner.deliver(ATTACK);
    inner.deliver(DEFAULT_DELTA);
    expect(received).toEqual([BLOW, ATTACK, DEFAULT_DELTA]);
  });
});

/*
 * The operator, 2026-10-20, of Thopter Foundry + Sword of the Meek: "let my click jump animations", "shorten
 * own-resolve pauses" — "i like the idea of lots of animations happening at the same time, seems fun."
 */
describe('the seat’s own act', () => {
  const ALICE = 0;
  const BOB = 1;
  /** A stack item `id` of `activator`'s going on the stack, alone on it after `below`. */
  const pushed = (id: number, activator: number, below: number[] = []) =>
    deltaOf({ g: stackOf([id, ...below]) }, { [`s${id}`]: { _type: 2, _id: id, ActivatingPlayer: { t: 'int', v: activator } } });
  const popped = (left: number[] = []) => deltaOf({ g: stackOf(left) });
  const THOPTER = deltaOf({}, { c50: { ...zone(50, 'Battlefield'), Token: { t: 'bool', v: true } } });
  const SACRIFICE = deltaOf({ c7: zone(7, 'Graveyard') });

  describe('ownAct', () => {
    it("the seat's stack item and every frame after it are its act, until another player's item comes", () => {
      const acts = actMemory();
      expect(ownAct(pushed(3, ALICE), acts, ALICE)).toBe(true);
      expect(ownAct(THOPTER, acts, ALICE)).toBe(true);
      expect(ownAct(popped(), acts, ALICE), 'its resolution').toBe(true);
      expect(ownAct(pushed(4, BOB), acts, ALICE), "the opponent's response").toBe(false);
      expect(ownAct(SACRIFICE, acts, ALICE), 'what follows it is theirs').toBe(false);
      expect(ownAct(popped(), acts, ALICE), "their item resolving is theirs").toBe(false);
    });

    it("an item resolving is whoever put it there's, whoever acted last", () => {
      const acts = actMemory();
      ownAct(pushed(3, BOB), acts, ALICE);
      ownAct(pushed(4, ALICE, [3]), acts, ALICE);
      expect(ownAct(popped([3]), acts, ALICE), "alice's response resolves first").toBe(true);
      expect(ownAct(popped(), acts, ALICE), "then bob's spell").toBe(false);
    });

    it('a question the seat is asked makes what follows its act; a new step makes it nobody’s', () => {
      const acts = actMemory();
      expect(ownAct(SACRIFICE, acts, ALICE), 'nobody has acted yet').toBe(false);
      expect(ownAct(ASK, acts, ALICE)).toBe(true);
      expect(ownAct(SACRIFICE, acts, ALICE), 'the cost the seat chose').toBe(true);
      expect(ownAct(PHASE, acts, ALICE)).toBe(false);
      expect(ownAct(SACRIFICE, acts, ALICE)).toBe(false);
      ownAct(ASK, acts, ALICE);
      expect(ownAct(NEW_TURN, acts, ALICE)).toBe(false);
    });

    it('a watcher has no act of its own', () => {
      const acts = actMemory();
      expect(ownAct(ASK, acts, null)).toBe(false);
      expect(ownAct(pushed(3, ALICE), acts, null)).toBe(false);
      expect(ownAct(popped(), acts, null)).toBe(false);
    });

    it('an item whose activator never reached this seat is not its own', () => {
      const acts = actMemory();
      expect(ownAct(deltaOf({ g: stackOf([9]) }), acts, ALICE)).toBe(false);
    });
  });

  describe('pacedMatchTransport', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** One loop of the combo after the sacrifice pick, as Forge sends it: the cost, the ability resolving, the Sword's trigger, the next question. */
    const loop = (n: number) => [SACRIFICE, pushed(10 + 2 * n, ALICE), { frame: { kind: 'notify', method: 'message', message: 'x' } }, popped(), THOPTER, pushed(11 + 2 * n, ALICE), popped(), ASK];

    it("the seat's own loop goes out as Forge sends it: no resolve gap, no wait on the board, each drawn frame a view of its own", async () => {
      const inner = fakeInner();
      const board = fakeBoard();
      const held: unknown[] = [];
      const { transport, received } = paced(inner, { boardStill: board.still, report: (h) => held.push(h) });
      transport.setSeatPlayer(() => ALICE);
      inner.deliver(ASK); // the activation's own question: the act is the seat's
      board.busy(true); // the last loop's beats, still playing
      const frames = loop(0);
      const from = Date.now();
      for (const frame of frames) inner.deliver(frame);
      // Only the hop between two drawn frames (a task each, a fake millisecond here) separates them: nothing waits on a gap or a beat.
      const views: number[] = [];
      while (received.length < frames.length + 1 && Date.now() - from < PACE_DELAYS_MS.default) {
        views.push(received.length);
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(received).toEqual([ASK, ...frames]);
      expect(Date.now() - from, 'no gap waited').toBeLessThan(frames.length);
      expect(new Set(views).size, 'the drawn frames went out one task apart').toBe(views.length);
      expect(held, 'the question was held by nothing').toEqual([]);
    });

    it("the opponent's act after the seat's waits for the seat's beats and keeps its gaps", async () => {
      const inner = fakeInner();
      const board = fakeBoard();
      const { transport, received } = paced(inner, { boardStill: board.still });
      transport.setSeatPlayer(() => ALICE);
      inner.deliver(pushed(3, ALICE));
      inner.deliver(popped());
      await vi.advanceTimersByTimeAsync(0);
      expect(received).toHaveLength(2);
      board.busy(true); // the seat's resolution being drawn
      inner.deliver(pushed(4, BOB));
      inner.deliver(popped());
      await vi.advanceTimersByTimeAsync(2_000);
      expect(received, "bob's spell waits for alice's beats").toHaveLength(2);
      board.busy(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(received).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(PACE_DELAYS_MS.resolve - 1);
      expect(received, 'and its resolution keeps its gap').toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(received).toHaveLength(4);
    });

    /** What the seat sends: a card click, the prompt bar's OK. */
    const sent = (method: string) => ({ matchId: 'm1', frame: { kind: 'act', method } });
    const attacking = (id: number) => deltaOf({ [`c${id}`]: { _type: 0, _id: id, Attacking: { t: 'bool', v: true } } });
    const blocking = (id: number) => deltaOf({ [`c${id}`]: { _type: 0, _id: id, Blocking: { t: 'bool', v: true } } });
    const PROMPT = { frame: { kind: 'notify', method: 'showPromptMessage', message: 'Declare attackers' } };
    const step = (v: string) => deltaOf({ g: { _type: 3, _id: 1, Phase: { t: 'enum', c: 'PhaseType', v } } });
    const ATTACKERS_STEP = step('COMBAT_DECLARE_ATTACKERS');
    const BLOCKERS_STEP = step('COMBAT_DECLARE_BLOCKERS');

    it('what follows a click the seat sends is its act: its attackers and the prompt go out as Forge sends them', async () => {
      const inner = fakeInner();
      const board = fakeBoard();
      const held: unknown[] = [];
      const { transport, received } = paced(inner, { boardStill: board.still, report: (h) => held.push(h) });
      transport.setSeatPlayer(() => ALICE);
      inner.deliver(ATTACKERS_STEP); // a step began: nobody's act
      await vi.advanceTimersByTimeAsync(1_000);
      board.busy(true); // the board is still drawing something
      for (let i = 0; i < 8; i++) transport.emit(MATCH_EVENTS.clientToServer, sent('selectCard'));
      const frames = [...[1, 2, 3, 4, 5, 6, 7, 8].map(attacking), PROMPT];
      const from = Date.now();
      for (const frame of frames) inner.deliver(frame);
      while (received.length < frames.length + 1 && Date.now() - from < PACE_DELAYS_MS.default) await vi.advanceTimersByTimeAsync(1);
      expect(received).toEqual([ATTACKERS_STEP, ...frames]);
      expect(Date.now() - from, 'no gap waited, no beat').toBeLessThan(frames.length);
      expect(held, 'the prompt was held by nothing').toEqual([]);
    });

    it("after the seat's OK, the step moving on makes the opponent's blocks nobody's: each keeps its gap", async () => {
      const inner = fakeInner();
      const { transport, received } = paced(inner);
      transport.setSeatPlayer(() => ALICE);
      transport.emit(MATCH_EVENTS.clientToServer, sent('selectButtonOk'));
      inner.deliver(BLOCKERS_STEP);
      inner.deliver(blocking(20));
      inner.deliver(blocking(21));
      await vi.advanceTimersByTimeAsync(PACE_DELAYS_MS.default - 1);
      expect(received, "the AI's first block keeps its gap after the step").toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(received).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(PACE_DELAYS_MS.default - 1);
      expect(received, 'and its second, after the first').toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(received).toHaveLength(3);
    });

    it('a watcher sends nothing that is an act, and a setting the seat changes is not one either', async () => {
      const inner = fakeInner();
      const { transport, received } = paced(inner);
      transport.setSeatPlayer(() => null);
      transport.emit(MATCH_EVENTS.clientToServer, sent('selectCard'));
      inner.deliver(attacking(1));
      inner.deliver(attacking(2));
      await vi.advanceTimersByTimeAsync(PACE_DELAYS_MS.default - 1);
      expect(received).toHaveLength(1);
      transport.setSeatPlayer(() => ALICE);
      transport.emit(MATCH_EVENTS.autoYield, { matchId: 'm1', on: true });
      inner.deliver(attacking(3));
      await vi.advanceTimersByTimeAsync(1);
      expect(received).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(PACE_DELAYS_MS.default - 1);
      expect(received, 'a setting starts no act').toHaveLength(2);
    });

    it('a watcher, or a seat not yet named, paces the same frames as before', async () => {
      const inner = fakeInner();
      const { transport, received } = paced(inner);
      transport.setSeatPlayer(() => null);
      inner.deliver(pushed(3, ALICE));
      inner.deliver(popped());
      await vi.advanceTimersByTimeAsync(PACE_DELAYS_MS.resolve - 1);
      expect(received).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(received).toHaveLength(2);
    });
  });
});

describe('a die or a coin in the air', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const ALICE = 0;
  const player = { id: ALICE, name: 'Alice' };
  const rolled = (results: number[], ignored?: number[]) => ({
    frame: { kind: 'notify', method: 'message', message: 'Alice rolled', title: '', roll: { player, sides: 20, results, ...(ignored ? { ignored } : {}), source: null } },
  });
  const flipped = { frame: { kind: 'notify', method: 'message', message: 'Alice flipped heads', title: '', flip: { player, outcome: 'heads', won: null, source: null } } };
  const ONE_DIE = TUMBLE_MS + POP_MS;

  it('inTheAir: a die until it pops down, each further die a stagger later, a coin until it lands, anything else not at all', () => {
    expect(inTheAir(rolled([14]))).toBe(ONE_DIE);
    expect(inTheAir(rolled([16], [13]))).toBe(DIE_STAGGER_MS + ONE_DIE);
    expect(inTheAir(flipped)).toBe(FLIP_MS);
    expect(inTheAir(MESSAGE)).toBe(0);
    expect(inTheAir(ASK)).toBe(0);
  });

  it("the seat's own question after its own roll waits for the die to land", async () => {
    const inner = fakeInner();
    const { transport, received } = paced(inner, { reducedMotion: () => false });
    transport.setSeatPlayer(() => ALICE);
    inner.deliver(ASK); // the seat's act: nothing of it would otherwise wait
    inner.deliver(rolled([14]));
    inner.deliver(DEFAULT_DELTA);
    inner.deliver(ASK);
    await vi.advanceTimersByTimeAsync(ONE_DIE - 1);
    expect(received).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(received).toEqual([ASK, rolled([14]), DEFAULT_DELTA, ASK]);
  });

  it("a die that started late: once the clock has run, the seat's own question also waits for it to land on the board", async () => {
    const inner = fakeInner();
    const board = fakeBoard();
    const { transport, received } = paced(inner, { initialFast: true, boardStill: board.still, reducedMotion: () => false });
    transport.setSeatPlayer(() => ALICE);
    inner.deliver(ASK);
    inner.deliver(rolled([14]));
    board.busy(true); // the die, drawn a render after its frame went out
    inner.deliver(ASK);
    await vi.advanceTimersByTimeAsync(ONE_DIE + 200);
    expect(received, 'still in the air on the board').toHaveLength(2);
    board.busy(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toHaveLength(3);
    board.busy(true); // a later beat: the seat's own act no longer waits for it
    inner.deliver(DEFAULT_DELTA);
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toHaveLength(4);
  });

  it('two dice: held until the second has landed', async () => {
    const inner = fakeInner();
    const { received } = paced(inner, { reducedMotion: () => false });
    inner.deliver(rolled([16], [13]));
    inner.deliver(DEFAULT_DELTA);
    await vi.advanceTimersByTimeAsync(DIE_STAGGER_MS + ONE_DIE - 1);
    expect(received).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(received).toHaveLength(2);
  });

  it('a coin holds until it lands, in Fast Mode too', async () => {
    const inner = fakeInner();
    const { received } = paced(inner, { initialFast: true, reducedMotion: () => false });
    inner.deliver(flipped);
    inner.deliver(ASK);
    await vi.advanceTimersByTimeAsync(FLIP_MS - 1);
    expect(received).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(received).toEqual([flipped, ASK]);
  });

  it('reduced motion: nothing is thrown, so nothing waits', () => {
    const inner = fakeInner();
    const { received } = paced(inner, { initialFast: true, reducedMotion: () => true });
    inner.deliver(rolled([14]));
    inner.deliver(ASK);
    expect(received).toHaveLength(2);
  });
});

/** Every class the delay table promises, so a renamed or dropped entry fails loudly. */
describe('PACE_DELAYS_MS', () => {
  it('has a non-negative delay for every PaceClass, and zero for input, a cast and an unseen change', () => {
    const classes: PaceClass[] = ['input', 'cast', 'unseen', 'resolve', 'phase', 'turn', 'draw', 'default'];
    for (const c of classes) expect(PACE_DELAYS_MS[c]).toBeGreaterThanOrEqual(0);
    expect(PACE_DELAYS_MS.input).toBe(0);
    expect(PACE_DELAYS_MS.cast).toBe(0);
    expect(PACE_DELAYS_MS.unseen).toBe(0);
  });
});

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
import { classify, isPacedTransport, pacedMatchTransport, PACE_DELAYS_MS, type PaceClass } from './pace.ts';

/* ── Building the shapes `classify` reads ────────────────────────────── */

const ASK = { frame: { kind: 'ask', callId: 'c1', method: 'showConfirmDialog' } };
const INPUT_NOTIFY = { frame: { kind: 'notify', method: 'setWeaklySelectable', cards: [] } };
const MESSAGE = { frame: { kind: 'notify', method: 'message', message: 'auto-passed Upkeep step' } };

function deltaOf(objects: Record<string, Record<string, unknown>>, newObjects: Record<string, Record<string, unknown>> = {}): unknown {
  return { frame: { kind: 'notify', method: 'applyDelta', payload: { packet: { newObjects, objectDeltas: objects } } } };
}

const stackOf = (ids: number[]) => ({ _type: 3, _id: 1, Stack: { t: 'list', v: ids.map((v) => ({ t: 'int', v })) } });
const zone = (id: number, v: string) => ({ _type: 0, _id: id, Zone: { t: 'enum', c: 'ZoneType', v } });

const RESOLVE = deltaOf({ g: stackOf([]) });
const PHASE = deltaOf({ g: { _type: 3, _id: 1, Phase: { t: 'enum', c: 'PhaseType', v: 'MAIN1' } } });
const DRAW = deltaOf({ c9: zone(9, 'Hand'), p0: { _type: 1, _id: 0, Hand: { t: 'list', v: [{ t: 'int', v: 9 }] } } });
const DEFAULT_DELTA = deltaOf({ p0: { _type: 1, _id: 0, Life: { t: 'int', v: 17 } } });

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
  it('a card arriving in a hand is draw', () => expect(classify(DRAW)).toBe('draw'));
  it('an unrecognised delta is default', () => expect(classify(DEFAULT_DELTA)).toBe('default'));
  it('a delta of nothing the board draws is unseen', () => expect(classify(CAST_FLAG)).toBe('unseen'));
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
  it('a message notify is default', () => expect(classify(MESSAGE)).toBe('default'));
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

  it('a cast goes out as Forge sends it — release, taps and the stack card at once — and its resolution keeps its pace', () => {
    const inner = fakeInner();
    const { received } = paced(inner);
    inner.deliver(PHASE); // the table was just busy: the next paced frame would wait
    for (const frame of [CAST_FLAG, ASK, HAND_OUT, CAST_FLAG, TAPS, ON_STACK]) inner.deliver(frame);
    expect(received).toEqual([PHASE, CAST_FLAG, ASK, HAND_OUT, CAST_FLAG, TAPS, ON_STACK]);
    expect(vi.getTimerCount()).toBe(0);
    inner.deliver(RESOLVED);
    expect(received).toHaveLength(7);
    vi.advanceTimersByTime(PACE_DELAYS_MS.resolve);
    expect(received.at(-1)).toBe(RESOLVED);
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

/** Every class the delay table promises, so a renamed or dropped entry fails loudly. */
describe('PACE_DELAYS_MS', () => {
  it('has a non-negative delay for every PaceClass, and zero for input, a cast and an unseen change', () => {
    const classes: PaceClass[] = ['input', 'cast', 'unseen', 'resolve', 'phase', 'draw', 'default'];
    for (const c of classes) expect(PACE_DELAYS_MS[c]).toBeGreaterThanOrEqual(0);
    expect(PACE_DELAYS_MS.input).toBe(0);
    expect(PACE_DELAYS_MS.cast).toBe(0);
    expect(PACE_DELAYS_MS.unseen).toBe(0);
  });
});

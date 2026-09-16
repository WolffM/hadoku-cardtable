/*
 * The connection phases, and the disconnect story end to end.
 *
 * Two halves, and the second is the one that matters:
 *
 *  1. `connectionState` over hand-built facts — every phase, including the two
 *     that only differ by whether a payload has landed since the re-join.
 *  2. The SAME function over facts read off a real `SocketDraft` being driven
 *     through a drop and a reconnect with the stub transport. That is the half
 *     that can catch the banner drifting from what the socket is doing: a
 *     phase table that only ever sees literals it was written against proves
 *     that the literals are consistent with themselves.
 */

import { describe, expect, it } from 'vitest';
import { stateMessage, updateMessage, type DraftView } from '@hadoku/shared';

import { connectionState, isWorthShowing, type ConnectionFacts } from './connection.ts';
import { loadFixtures } from './fixtures.ts';
import {
  connectionFacts,
  ingest,
  startDraft,
  type DraftTransport,
  type SocketDraft,
} from './socket.ts';

/** Healthy and boring: connected, seated, nothing outstanding. */
function healthy(over: Partial<ConnectionFacts> = {}): ConnectionFacts {
  return {
    connected: true,
    everConnected: true,
    joins: 1,
    applied: 3,
    appliedAtLastJoin: 0,
    resyncPending: false,
    seatId: 3,
    lastVerdict: 'ok',
    ...over,
  };
}

describe('the phases', () => {
  it('connecting — before anything has ever connected', () => {
    const state = connectionState(healthy({ connected: false, everConnected: false, applied: 0 }));
    expect(state.phase).toBe('connecting');
    expect(state.stalled).toBe(true);
    expect(state.seatHeld).toBe(false);
  });

  it('live — connected and in sync says nothing at all', () => {
    const state = connectionState(healthy());
    expect(state.phase).toBe('live');
    expect(state.stalled).toBe(false);
    expect(isWorthShowing(state)).toBe(false);
  });

  // ── the done-when: a disconnect shows a HELD seat ────────────────────
  it('offline with a seat — the seat is HELD, and it says so in the label', () => {
    const state = connectionState(healthy({ connected: false }));
    expect(state.phase).toBe('offline');
    expect(state.seatHeld).toBe(true);
    expect(state.stalled).toBe(true);
    expect(state.label).toContain('Seat 3');
    expect(state.label).toContain('held');
    expect(state.detail).toContain('holding your seat');
    expect(isWorthShowing(state)).toBe(true);
  });

  it('offline as a spectator — nothing is held, because there is no seat', () => {
    const state = connectionState(healthy({ connected: false, seatId: null }));
    expect(state.phase).toBe('offline');
    expect(state.seatHeld).toBe(false);
    expect(state.label).toBe('Disconnected');
  });

  it('resyncing — an outstanding request outranks everything else', () => {
    const state = connectionState(healthy({ resyncPending: true, joins: 2 }));
    expect(state.phase).toBe('resyncing');
    expect(state.stalled).toBe(true);
  });

  // ── the done-when: recovery is a state of its own ────────────────────
  it('reconnecting — back on the socket, nothing has arrived yet', () => {
    const state = connectionState(healthy({ joins: 2, applied: 7, appliedAtLastJoin: 7 }));
    expect(state.phase).toBe('reconnecting');
    expect(state.stalled).toBe(true);
    expect(state.detail).toContain('full snapshot');
  });

  it('recovered — the first payload after the re-join', () => {
    const state = connectionState(healthy({ joins: 2, applied: 8, appliedAtLastJoin: 7 }));
    expect(state.phase).toBe('recovered');
    expect(state.stalled).toBe(false);
    expect(isWorthShowing(state)).toBe(true);
  });

  it('recovered is BOUNDED — it does not linger for the rest of the draft', () => {
    const state = connectionState(healthy({ joins: 2, applied: 30, appliedAtLastJoin: 7 }));
    expect(state.phase).toBe('live');
    expect(isWorthShowing(state)).toBe(false);
  });
});

/* ── The same rules, over a real driver ──────────────────────────────── */

interface Stub {
  transport: DraftTransport;
  fire(event: string, payload?: unknown): void;
}

function makeStub(): Stub {
  const handlers = new Map<string, ((payload: unknown) => void)[]>();
  return {
    fire(event, payload) {
      for (const h of handlers.get(event) ?? []) h(payload);
    },
    transport: {
      on(event, handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      emit() {},
      disconnect() {},
    },
  };
}

const FIXTURES = loadFixtures();

/** A committed fixture, re-stamped onto a point in a stream. */
function at(seq: number, epoch = 'e1', index = 0): DraftView {
  const base = FIXTURES[index];
  if (base === undefined) throw new Error('no fixture');
  return { ...base, epoch, seq };
}

const phaseOf = (draft: SocketDraft) => connectionState(connectionFacts(draft)).phase;

describe('a drop and a reconnect, driven through the real socket driver', () => {
  it('walks connecting → live → offline(seat held) → reconnecting → recovered → live', () => {
    const stub = makeStub();
    const draft = startDraft({ draftId: 'draft:test', transport: stub.transport });

    // Nothing has connected yet.
    expect(phaseOf(draft)).toBe('connecting');

    stub.fire('connect');
    ingest(draft, stateMessage(at(1)));
    ingest(draft, updateMessage(at(2)));
    expect(phaseOf(draft)).toBe('live');

    // The socket drops. The server holds the seat; the screen must say so.
    stub.fire('disconnect');
    const offline = connectionState(connectionFacts(draft));
    expect(offline.phase).toBe('offline');
    expect(offline.seatHeld).toBe(true);
    // The seat came from the payload, not from anything this test invented.
    expect(offline.label).toContain(`Seat ${connectionFacts(draft).seatId}`);

    // It comes back. The driver re-joins; the server has not answered yet.
    stub.fire('connect');
    expect(phaseOf(draft)).toBe('reconnecting');

    // The re-join is answered with a full snapshot, and the table is back.
    ingest(draft, stateMessage(at(9)));
    expect(phaseOf(draft)).toBe('recovered');

    // The draft carries on and the banner gets out of the way.
    ingest(draft, updateMessage(at(10)));
    expect(phaseOf(draft)).toBe('live');
  });

  it('a gap after the reconnect reads as catching up, not as recovered', () => {
    const stub = makeStub();
    const draft = startDraft({ draftId: 'draft:test', transport: stub.transport });
    stub.fire('connect');
    ingest(draft, stateMessage(at(1)));
    stub.fire('disconnect');
    stub.fire('connect');

    // An update arrives ahead of the snapshot: the driver drops it and asks
    // for the whole state, so the banner must not claim recovery.
    ingest(draft, updateMessage(at(40)));
    expect(draft.resyncPending).toBe(true);
    expect(phaseOf(draft)).toBe('resyncing');
  });

  it('the facts are read off the driver, never duplicated beside it', () => {
    const stub = makeStub();
    const draft = startDraft({ draftId: 'draft:test', transport: stub.transport });
    stub.fire('connect');
    ingest(draft, stateMessage(at(1)));
    const facts = connectionFacts(draft);
    expect(facts.applied).toBe(draft.stats.applied);
    expect(facts.joins).toBe(draft.stats.joins);
    expect(facts.connected).toBe(draft.connected);
    expect(facts.appliedAtLastJoin).toBe(draft.appliedAtLastJoin);
    expect(facts.lastVerdict).toBe(draft.lastVerdict);
  });
});

/**
 * The pending-pick state: what the table shows between clicking a card and the
 * server answering.
 *
 * The rejections are the interesting half. §B.3 says the engine rejects an
 * out-of-turn or unknown pick as a *value*, and these assert the client agrees
 * — a misclick must never throw and must never produce a state that claims a
 * card the payload did not offer.
 */

import { describe, expect, it } from 'vitest';

import { loadFixtures, openingStream } from './fixtures.ts';
import {
  applyPayload,
  initialState,
  isAwaitingConfirmation,
  pick,
  pickBlockedBy,
  visiblePack,
  visiblePool,
} from './table.ts';
import { viewerSeat } from './types.ts';

const opening = () => initialState(openingStream()[0]);

describe('picking', () => {
  it('moves the clicked card out of the pack and into the pool', () => {
    const before = opening();
    expect(visiblePack(before)).toHaveLength(15);
    expect(visiblePool(before)).toHaveLength(0);

    const target = visiblePack(before)[3];
    const result = pick(before, target.cardId);
    if (!result.ok) throw new Error('a legal pick was rejected');

    expect(visiblePool(result.state)).toHaveLength(1);
    expect(visiblePool(result.state)[0].cardId).toBe(target.cardId);
    expect(isAwaitingConfirmation(result.state)).toBe(true);
  });

  it('does not invent the next pack — it waits for one', () => {
    const result = pick(opening(), visiblePack(opening())[0].cardId);
    if (!result.ok) throw new Error('a legal pick was rejected');
    // 14 cards are left in that pack, but they are in front of the NEXT seat.
    expect(visiblePack(result.state)).toEqual([]);
  });

  it('leaves the authoritative payload untouched', () => {
    const before = opening();
    const result = pick(before, visiblePack(before)[0].cardId);
    if (!result.ok) throw new Error('a legal pick was rejected');
    expect(result.state.view).toBe(before.view);
    expect(viewerSeat(result.state.view)?.pool).toHaveLength(0);
  });

  it('rejects a card that is not in the pack, as a value', () => {
    const result = pick(opening(), 'draft:fx-open/c999');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.rejection).toEqual({ reason: 'not-in-pack', cardId: 'draft:fx-open/c999' });
  });

  it('rejects a second pick while the first is in flight', () => {
    const first = pick(opening(), visiblePack(opening())[0].cardId);
    if (!first.ok) throw new Error('a legal pick was rejected');
    const second = pick(first.state, visiblePack(opening())[1].cardId);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.rejection.reason).toBe('already-picked');
  });

  it('rejects a pick from a seat that is not on the clock', () => {
    const view = openingStream()[2]; // waitingOn is [0, 2, 5]
    const notWaiting = { ...view, waitingOn: [2, 5] };
    const state = initialState(notWaiting);
    expect(pickBlockedBy(state)).toEqual({ reason: 'not-your-turn', seatId: 0 });
    const result = pick(state, visiblePack(state)[0].cardId);
    expect(result.ok).toBe(false);
  });

  it('rejects any pick from a spectator, and shows them nothing', () => {
    const spectator = loadFixtures().find((v) => v.viewer.kind === 'spectator');
    if (!spectator) throw new Error('expected a spectator fixture');
    const state = initialState(spectator);
    expect(visiblePack(state)).toEqual([]);
    expect(visiblePool(state)).toEqual([]);
    expect(pickBlockedBy(state)).toEqual({ reason: 'spectator' });
    expect(pick(state, 'anything').ok).toBe(false);
  });
});

describe('applying the next payload', () => {
  it('replaces the view wholesale and clears the pending pick', () => {
    const [first, second] = openingStream();
    const pending = pick(initialState(first), visiblePack(initialState(first))[5].cardId);
    if (!pending.ok) throw new Error('a legal pick was rejected');

    const next = applyPayload(pending.state, second);
    expect(next.view.seq).toBe(second.seq);
    expect(isAwaitingConfirmation(next)).toBe(false);
    expect(visiblePool(next)).toHaveLength(1);
    expect(visiblePack(next)).toHaveLength(14);
  });

  it('ignores a stale or replayed payload rather than applying it backwards', () => {
    const [first, second] = openingStream();
    const at2 = applyPayload(initialState(first), second);
    expect(applyPayload(at2, first)).toBe(at2);
    expect(applyPayload(at2, second)).toBe(at2);
  });

  it('switches outright when the draft id changes', () => {
    const [first] = openingStream();
    const other = loadFixtures().find((v) => v.draftId === 'draft:fx-mid');
    if (!other) throw new Error('expected an fx-mid fixture');
    const switched = applyPayload(initialState(first), other);
    expect(switched.view.draftId).toBe('draft:fx-mid');
  });
});

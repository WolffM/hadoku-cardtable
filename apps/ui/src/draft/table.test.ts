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
  decidePayload,
  initialState,
  isAwaitingConfirmation,
  isDraftComplete,
  pick,
  pickBlockedBy,
  visiblePack,
  visiblePool,
} from './table.ts';
import { viewerSeat, type DraftView } from './types.ts';

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

/*
 * The sequencing rules, which are `classifySeq`'s and not this file's.
 *
 * `applyPayload` used to be `if (next.seq <= state.view.seq) return state`, and
 * the first test below is the one that bug could never pass: a server restart
 * keeps the draft id and counts `seq` from 1 again, so a table holding seq 20
 * read every payload of the new incarnation as stale and froze for the rest of
 * the draft. That is precisely the case `epoch` was added to the envelope for
 * (`packages/shared/src/draft.ts`) and precisely our own P6 requirement.
 *
 * These assert the VERDICT as well as the state, because "the view changed" and
 * "the view changed for the right reason" are different facts and only the
 * second one survives a refactor.
 */
describe('classifySeq decides what the table does with a payload', () => {
  const restamp = (view: DraftView, epoch: string, seq: number): DraftView => ({
    ...view,
    epoch,
    seq,
  });

  it('ok — the next payload applies, and asks for nothing', () => {
    const [first, second] = openingStream();
    const decision = decidePayload(initialState(first), second);
    expect(decision.verdict).toBe('ok');
    expect(decision.applied).toBe(true);
    expect(decision.resync).toBe(false);
    expect(decision.state.view.seq).toBe(second.seq);
  });

  it('duplicate — dropped, and NEVER answered with a resync', () => {
    const [first, second] = openingStream();
    const at2 = initialState(second);
    for (const stale of [first, second]) {
      const decision = decidePayload(at2, stale);
      expect(decision.verdict).toBe('duplicate');
      expect(decision.applied).toBe(false);
      expect(decision.resync).toBe(false);
      // Same object, so React re-renders nothing either.
      expect(decision.state).toBe(at2);
    }
  });

  it('gap — dropped and resynced, the same answer the socket driver gives', () => {
    const [first] = openingStream();
    const ahead = restamp(first, first.epoch, first.seq + 8);
    const decision = decidePayload(initialState(first), ahead);
    expect(decision.verdict).toBe('gap');
    expect(decision.applied).toBe(false);
    expect(decision.resync).toBe(true);
    expect(decision.state.view.seq).toBe(first.seq);
  });

  // ── the bug ──────────────────────────────────────────────────────────
  it('epoch-change — a restarted server counting from 1 is NOT stale', () => {
    const [first] = openingStream();
    // The table is deep into a draft…
    const late = initialState(restamp(first, 'fx-epoch-1', 20));
    // …and the server restarts. Same draft id, new incarnation, seq 1.
    const reborn = restamp(first, 'fx-epoch-2', 1);

    const decision = decidePayload(late, reborn);
    expect(decision.verdict).toBe('epoch-change');
    // A seq comparison would have refused this and frozen the screen.
    expect(decision.applied).toBe(true);
    expect(decision.state.view.epoch).toBe('fx-epoch-2');
    expect(decision.state.view.seq).toBe(1);
    // And the caller is told to refetch, because one payload of a new
    // incarnation is not a baseline for the rest of it.
    expect(decision.resync).toBe(true);
  });

  it('applyPayload is decidePayload’s state, for callers with no transport', () => {
    const [first, second] = openingStream();
    const state = initialState(first);
    expect(applyPayload(state, second)).toEqual(decidePayload(state, second).state);
  });

  it('a different draft is not a sequencing question at all', () => {
    const [first] = openingStream();
    const other = loadFixtures().find((v) => v.draftId === 'draft:fx-mid');
    if (!other) throw new Error('expected an fx-mid fixture');
    const decision = decidePayload(initialState(first), other);
    expect(decision.verdict).toBe('other-draft');
    expect(decision.applied).toBe(true);
    expect(decision.resync).toBe(false);
  });
});

/*
 * "The draft is over" — the condition the deck view hangs off.
 */
describe('a finished draft', () => {
  const full = (base: DraftView): DraftView => {
    if (base.viewer.kind !== 'seat') throw new Error('expected a seat fixture');
    const template = base.viewer.pack[0] ?? base.viewer.pool[0];
    if (!template) throw new Error('expected at least one card');
    const pool = Array.from({ length: base.packCount * base.packSize }, (_, i) => ({
      ...template,
      cardId: `done-${i}`,
    }));
    return { ...base, viewer: { ...base.viewer, pack: [], pool } };
  };

  it('is not complete part-way through', () => {
    expect(isDraftComplete(initialState(openingStream()[0]))).toBe(false);
  });

  it('is complete when the pool holds every pick the draft has', () => {
    const state = initialState(full(openingStream()[0]));
    expect(isDraftComplete(state)).toBe(true);
    expect(visiblePool(state)).toHaveLength(45);
  });

  it('counts a pick still in flight, so the deck is not one round trip late', () => {
    const base = openingStream()[0];
    if (base.viewer.kind !== 'seat') throw new Error('expected a seat fixture');
    const template = base.viewer.pack[0];
    // 44 in the pool, one card left in the pack: the forty-fifth pick.
    const pool = Array.from({ length: 44 }, (_, i) => ({ ...template, cardId: `done-${i}` }));
    const last = { ...base, viewer: { ...base.viewer, pack: [template], pool } };
    const state = initialState(last);
    expect(isDraftComplete(state)).toBe(false);

    const picked = pick(state, template.cardId);
    if (!picked.ok) throw new Error('the last pick was rejected');
    expect(isDraftComplete(picked.state)).toBe(true);
  });

  it('a spectator is never complete — they have no pool to finish', () => {
    const spectator = loadFixtures().find((v) => v.viewer.kind === 'spectator');
    if (!spectator) throw new Error('expected a spectator fixture');
    expect(isDraftComplete(initialState(spectator))).toBe(false);
  });
});

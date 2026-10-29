/*
 * `offer-hold.ts` on its own: when a held offer is drawn, and every fact that ends it.
 * The frame-by-frame case — a click, Forge's clears, the asks the browser answers itself — runs
 * through the real driver in `match.test.ts` ("the offer through a click's turnaround").
 */
import { describe, expect, it } from 'vitest';

import type { LiveClickables } from './match.ts';
import type { BoardView, StackEntry } from '../adapter.ts';
import { drawnOfferOf, dropMarked, resolvedByAnother, type OfferFacts, type OfferHold } from './offer-hold.ts';
import { HOLD_MAX_MS } from './timed-hold.ts';

const offer = (cards: number[], players: number[] = []): LiveClickables => ({
  selectable: new Set(cards),
  selectablePlayers: new Set(players),
  selectionOpen: false,
});
const NOTHING = offer([]);
const hold = (): OfferHold => ({ offer: offer([1, 2]), since: 1_000, turn: 3, pressed: { cards: new Set(), players: new Set() } });
const silent: OfferFacts = { now: 1_100, turn: 3, askedByHand: false, waitingOnAnother: false };

describe('drawnOfferOf', () => {
  it('draws the held offer while Forge is silent', () => {
    expect(drawnOfferOf(NOTHING, hold(), silent).selectable).toEqual(new Set([1, 2]));
  });

  it('draws what Forge’s own state still names beside it, never less', () => {
    const drawn = drawnOfferOf(offer([2, 7], [9]), hold(), silent);
    expect(drawn.selectable).toEqual(new Set([1, 2, 7]));
    expect(drawn.selectablePlayers).toEqual(new Set([9]));
  });

  it('a choice pressed under the hold is not drawn from Forge’s stale selection either', () => {
    const h = { ...hold(), offer: { ...offer([5]), selectionOpen: true }, pressed: { cards: new Set([6]), players: new Set([9]) } };
    const drawn = drawnOfferOf({ ...offer([5, 6], [8, 9]), selectionOpen: true }, h, silent);
    expect(drawn.selectable).toEqual(new Set([5]));
    expect(drawn.selectablePlayers).toEqual(new Set([8]));
  });

  it('with no hold, Forge’s own offer, empty or not', () => {
    expect(drawnOfferOf(NOTHING, null, silent)).toBe(NOTHING);
  });

  it.each<[string, Partial<OfferFacts>]>([
    ['a question this seat answers by hand is open', { askedByHand: true }],
    ['the game waits on another seat', { waitingOnAnother: true }],
    ['the turn moved on', { turn: 4 }],
    ['the bound ran out', { now: 1_000 + HOLD_MAX_MS }],
  ])('draws only Forge’s own once %s', (_why, change) => {
    const real = offer([7]);
    expect(drawnOfferOf(NOTHING, hold(), { ...silent, ...change })).toBe(NOTHING);
    expect(drawnOfferOf(real, hold(), { ...silent, ...change })).toBe(real);
  });

  it('holds right up to the bound', () => {
    expect(drawnOfferOf(NOTHING, hold(), { ...silent, now: 1_000 + HOLD_MAX_MS - 1 }).selectable.size).toBe(2);
  });
});

describe('dropMarked', () => {
  it('a held selection loses what Forge has marked in it: a chosen target is not offered again', () => {
    const h = { ...hold(), offer: { ...offer([5, 6], [1, 2]), selectionOpen: true } };
    dropMarked(h, { cards: new Set([6]), players: new Set([2]) });
    expect(h.offer.selectable).toEqual(new Set([5]));
    expect(h.offer.selectablePlayers).toEqual(new Set([1]));
  });

  it('a held actionable set stays whole: a mark outside a selection is no choice', () => {
    const h = hold();
    dropMarked(h, { cards: new Set([2]), players: null });
    expect(h.offer.selectable).toEqual(new Set([1, 2]));
  });
});

/*
 * The operator, 2026-10-29, of the other seat's counter: "from what i can see it's 0% now not 90%?" — the hand
 * stayed drawn lit, the held offer, through what the counter did, with nothing it could do until the next offer.
 */
describe('resolvedByAnother', () => {
  const item = (id: number, controllerName: string): StackEntry => ({ id, controllerName }) as StackEntry;
  const board = (...stack: StackEntry[]): BoardView => ({ stack }) as unknown as BoardView;

  it("bob's spell resolving, and his counter taking hers with it, are another seat's", () => {
    expect(resolvedByAnother(board(item(4, 'Bob'), item(3, 'Alice')), board(item(3, 'Alice')), 'Alice')).toBe(true);
    expect(resolvedByAnother(board(item(6, 'Bob'), item(5, 'Alice')), board(), 'Alice')).toBe(true);
  });

  it("her own spell, and her counter taking his with it, are not: her hold stands", () => {
    expect(resolvedByAnother(board(item(3, 'Alice')), board(), 'Alice')).toBe(false);
    expect(resolvedByAnother(board(item(5, 'Alice'), item(4, 'Bob')), board(), 'Alice')).toBe(false);
  });

  it('a seat whose Forge name is not known yet holds as before', () => {
    expect(resolvedByAnother(board(item(4, 'Bob')), board(), null)).toBe(false);
  });

  it('a spell arriving, an unchanged stack, or no view is no resolution', () => {
    expect(resolvedByAnother(board(item(3, 'Alice')), board(item(4, 'Bob'), item(3, 'Alice')), 'Alice')).toBe(false);
    expect(resolvedByAnother(board(item(4, 'Bob')), board(item(4, 'Bob')), 'Alice')).toBe(false);
    expect(resolvedByAnother(null, board(), 'Alice')).toBe(false);
  });
});

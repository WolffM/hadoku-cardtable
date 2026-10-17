/*
 * `offer-hold.ts` on its own: when a held offer is drawn, and every fact that ends it.
 * The frame-by-frame case — a click, Forge's clears, the asks the browser answers itself — runs
 * through the real driver in `match.test.ts` ("the offer through a click's turnaround").
 */
import { describe, expect, it } from 'vitest';

import type { LiveClickables } from './match.ts';
import { drawnOfferOf, followOffer, OFFER_HOLD_MAX_MS, type OfferFacts, type OfferHold } from './offer-hold.ts';

const offer = (cards: number[], players: number[] = []): LiveClickables => ({
  selectable: new Set(cards),
  selectablePlayers: new Set(players),
  selectionOpen: false,
});
const NOTHING = offer([]);
const hold = (): OfferHold => ({ offer: offer([1, 2]), since: 1_000, turn: 3, phase: 'MAIN1' });
const UNMARKED = { cards: null, players: null };
const silent: OfferFacts = { now: 1_100, turn: 3, phase: 'MAIN1', forgeNamedASet: false, askedByHand: false, waitingOnAnother: false };

describe('drawnOfferOf', () => {
  it('draws the held offer while Forge is silent after the click', () => {
    expect(drawnOfferOf(NOTHING, hold(), silent).selectable).toEqual(new Set([1, 2]));
  });

  it('never covers an offer Forge has made: a non-empty one is drawn as it is', () => {
    const real = offer([7]);
    expect(drawnOfferOf(real, hold(), silent)).toBe(real);
  });

  it('with no hold, Forge’s own offer, empty or not', () => {
    expect(drawnOfferOf(NOTHING, null, silent)).toBe(NOTHING);
  });

  it.each<[string, Partial<OfferFacts>]>([
    ['Forge named a set, even an empty one', { forgeNamedASet: true }],
    ['a question this seat answers by hand is open', { askedByHand: true }],
    ['the game waits on another seat', { waitingOnAnother: true }],
    ['the phase moved on', { phase: 'COMBAT_BEGIN' }],
    ['the turn moved on', { turn: 4 }],
    ['the bound ran out', { now: 1_000 + OFFER_HOLD_MAX_MS }],
  ])('draws nothing once %s', (_why, change) => {
    expect(drawnOfferOf(NOTHING, hold(), { ...silent, ...change })).toBe(NOTHING);
  });

  it('holds right up to the bound', () => {
    expect(drawnOfferOf(NOTHING, hold(), { ...silent, now: 1_000 + OFFER_HOLD_MAX_MS - 1 }).selectable.size).toBe(2);
  });
});

describe('followOffer', () => {
  it('keeps the newest non-empty offer, and ignores an empty one', () => {
    const h = hold();
    followOffer(h, offer([5]), UNMARKED);
    expect(h.offer.selectable).toEqual(new Set([5]));
    followOffer(h, NOTHING, UNMARKED);
    expect(h.offer.selectable).toEqual(new Set([5]));
  });

  it('keeps a selection less what Forge has marked in it: a chosen target is not offered again', () => {
    const h = hold();
    followOffer(h, { ...offer([5, 6], [1, 2]), selectionOpen: true }, { cards: new Set([6]), players: new Set([2]) });
    expect(h.offer.selectable).toEqual(new Set([5]));
    expect(h.offer.selectablePlayers).toEqual(new Set([1]));
  });

  it('keeps an actionable set whole: a mark outside a selection is no choice', () => {
    const h = hold();
    followOffer(h, offer([5, 6]), { cards: new Set([6]), players: null });
    expect(h.offer.selectable).toEqual(new Set([5, 6]));
  });
});

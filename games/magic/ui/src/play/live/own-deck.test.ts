// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';

import { fetchOwnDeck, OwnDeckPeek, type OwnDeck } from './own-deck.tsx';

const answer = (status: number, body: unknown) => async (input: string) => {
  calls.push(input);
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
};
const calls: string[] = [];

afterEach(cleanup);

describe('fetchOwnDeck', () => {
  it('reads the seat’s own list off the match’s deck route, cost included', async () => {
    const deck = { name: 'Mono White', main: [{ name: 'Plains', count: 16, cost: '' }], sideboard: [{ name: 'Disenchant', count: 2, cost: '{1}{W}' }] };
    expect(await fetchOwnDeck('m-1', answer(200, deck), '/cardtable/api/')).toEqual(deck);
    expect(calls.at(-1)).toBe('/cardtable/api/play/matches/m-1/deck');
  });

  it('is null when the server has no list for this browser, or answers something else', async () => {
    expect(await fetchOwnDeck('m-1', answer(404, { error: 'no deck of yours in that match' }), '/api/')).toBeNull();
    expect(await fetchOwnDeck('m-1', answer(200, { name: 'x', main: 'nope', sideboard: [] }), '/api/')).toBeNull();
  });
});

/*
 * measured on the operator's own pod r-67759762d971, deck hash 81aea98e4291 (prod log
 * `room-match-started`): the server holds no copy of that exact 40-card deck text (`lockedDecks`
 * in the room's own on-disk store is empty, and nothing else persists it — the server keeps a
 * deck's text live in the match's spec only), so this is reconstructed from what DOES survive on
 * disk, read-only, under `~/srv-data/cardtable`: the drafter's own 45-card pool
 * (`drafts/<room>.json`, `app.state.pools[1]` — `displayNames['1']` is "Hadoku"), a real line-up
 * of Abzan (W/B/G) cube cards from TDM. Fifteen of them here, main-decked, stand in for the 40;
 * `Qarsi Revenant` is the one card of the 41 distinct names in that pool with a `LIBRARY_CARD_COSTS`
 * entry (a 6/41 sample would still show the bug; this uses all fifteen it's given costs for below,
 * through the match's own per-line `cost`, exactly as `/matches/:id/deck` now answers it).
 */
describe('OwnDeckPeek: a drafted cube deck colours and costs off its OWN lines, not the static table', () => {
  const HADOKU_POOL_DECK: OwnDeck = {
    name: 'Cube draft r-67759762d971',
    main: [
      { name: 'Qarsi Revenant', count: 1, cost: '{1}{B}{B}' }, // the ONE name LIBRARY_CARD_COSTS also has
      { name: 'Severance Priest', count: 1, cost: '{W}{B}{G}' },
      { name: 'Abzan Devotee', count: 2, cost: '{1}{B}' },
      { name: 'Betor, Kin to All', count: 2, cost: '{2}{W}{B}{G}' },
      { name: 'Felothar, Dawn of the Abzan', count: 1, cost: '{W}{B}{G}' },
      { name: 'Hollowmurk Siege', count: 1, cost: '{B}{G}' },
      { name: "Nature's Rhythm", count: 1, cost: '{X}{G}{G}' },
      { name: 'Sage of the Fang', count: 1, cost: '{2}{G}' },
      { name: 'Dusyut Earthcarver', count: 2, cost: '{5}{G}' },
      { name: 'Skirmish Rhino', count: 1, cost: '{W}{B}{G}' },
      { name: 'Teval, Arbiter of Virtue', count: 1, cost: '{2}{B}{G}{U}' },
      { name: 'Yathan Roadwatcher', count: 2, cost: '{1}{W}{B}{G}' },
      { name: 'Armament Dragon', count: 1, cost: '{3}{W}{B}{G}' },
      { name: 'Gurmag Rakshasa', count: 1, cost: '{4}{B}{B}' },
      { name: 'Plains', count: 8, cost: '' },
      { name: 'Swamp', count: 7, cost: '' },
      { name: 'Forest', count: 7, cost: '' },
    ],
    sideboard: [],
  };

  function peek() {
    render(createElement(OwnDeckPeek, { deck: HADOKU_POOL_DECK, from: document.createElement('div'), onClose: () => undefined }));
    return screen.getByTestId('deck-peek');
  }

  it('folds colours off every costed line, not just the one LIBRARY_CARD_COSTS happens to cover', () => {
    const el = peek();
    // Before the fix this read "B" alone (Qarsi Revenant's own colour, the only line
    // `deckColorsByName` had a cost for). The deck is Abzan (W/B/G) with a Teval splash (U).
    expect(el.querySelector('[data-testid="deck-colors"]')?.getAttribute('data-colors')).toBe('WUBG');
  });

  it('shows a cost pip on a cube card with no LIBRARY_CARD_COSTS entry, not only on Qarsi Revenant', () => {
    const el = peek();
    const lineOf = (name: string) => [...el.querySelectorAll('.peek__line')].find((li) => li.textContent?.includes(name));
    expect(lineOf('Dusyut Earthcarver')?.querySelector('.cost')).not.toBeNull();
    expect(lineOf('Qarsi Revenant')?.querySelector('.cost')).not.toBeNull();
    // A basic land still carries none — absence still means "no coloured pip", unchanged.
    expect(lineOf('Forest')?.querySelector('.cost')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import { fetchOwnDeck } from './own-deck.tsx';

const answer = (status: number, body: unknown) => async (input: string) => {
  calls.push(input);
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
};
const calls: string[] = [];

describe('fetchOwnDeck', () => {
  it('reads the seat’s own list off the match’s deck route', async () => {
    const deck = { name: 'Mono White', main: [{ name: 'Plains', count: 16 }], sideboard: [{ name: 'Disenchant', count: 2 }] };
    expect(await fetchOwnDeck('m-1', answer(200, deck), '/cardtable/api/')).toEqual(deck);
    expect(calls.at(-1)).toBe('/cardtable/api/play/matches/m-1/deck');
  });

  it('is null when the server has no list for this browser, or answers something else', async () => {
    expect(await fetchOwnDeck('m-1', answer(404, { error: 'no deck of yours in that match' }), '/api/')).toBeNull();
    expect(await fetchOwnDeck('m-1', answer(200, { name: 'x', main: 'nope', sideboard: [] }), '/api/')).toBeNull();
  });
});

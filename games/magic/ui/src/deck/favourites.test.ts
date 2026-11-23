/*
 * The Library's read of `GET /api/me/library` and its star press (`PUT /api/me/favourites/:deckId`):
 * an entry the page cannot read is left out rather than failing the page.
 */
import { describe, expect, it } from 'vitest';

import { favouritesClient, libraryOf } from './favourites.ts';

describe('libraryOf', () => {
  it('reads stars, last-played stamps and built decks, leaving out what does not parse', () => {
    const lib = libraryOf({
      favourites: { 'draft:a': 1, 'built:b': 2, 'draft:bad': 'x' },
      decks: { 'draft:a': { lastPlayedAt: 5 }, 'draft:bad': { lastPlayedAt: null }, 'draft:worse': 7 },
      built: [{ id: 'built:b', name: 'B', format: 'any', dck: '', createdAt: 1, updatedAt: 2 }, { id: 'nope' }],
    });
    expect([...lib.favourites]).toEqual(['draft:a', 'built:b']);
    expect([...lib.lastPlayed]).toEqual([['draft:a', 5]]);
    expect(lib.built.map((b) => b.id)).toEqual(['built:b']);
    expect(libraryOf(null)).toEqual({ favourites: new Set(), lastPlayed: new Map(), built: [] });
  });
});

describe('favouritesClient', () => {
  it('puts a star by its deck id, and says why when the server refuses', async () => {
    const asked: string[] = [];
    const answer = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const client = favouritesClient(async (input, init) => {
      asked.push(`${init?.method ?? 'GET'} ${String(input)} ${String(init?.body ?? '')}`);
      return asked.length === 1 ? answer(200, { favourites: { 'draft:p 1': 1 } }) : answer(429, { error: 'too many changes' });
    }, '/api/');
    expect(await client.setFavourite('draft:p 1', true)).toEqual({ ok: true });
    expect(await client.setFavourite('draft:p 1', false)).toEqual({ ok: false, message: 'too many changes' });
    expect(asked).toEqual(['PUT /api/me/favourites/draft%3Ap%201 {"on":true}', 'PUT /api/me/favourites/draft%3Ap%201 {"on":false}']);
  });
});

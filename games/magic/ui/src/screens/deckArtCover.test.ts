// @vitest-environment jsdom
/*
 * A drafted deck's tile always draws a cover. The operator, 2026-11-23: "many of the decks are
 * missing a cover image". On prod's 174 finished seats the card the art rule ranked first had no
 * row in the committed artist table on 106 of them, and `DeckArt` draws no art it cannot credit,
 * so the tile was an empty band. The pool here is one of those seats, reduced to a fixture: none
 * of its ids is in `art-artists.json`, and its artists are the ones the server's own lookup
 * (`GET /api/art/<id>/artist`, `card-art.ts`) answers from the Scryfall corpus.
 *
 * Its own file: `artists.ts` keeps what it has heard about each id for the page's life.
 */

import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { DraftCard } from '@hadoku/shared';

import { DeckArt, draftedDeckOf, draftedDeckOption } from './ConstructedScreen.tsx';
import { assignDeckArt } from './deckArt.ts';
import { artCredit } from '../draft/artists.ts';
import { cardImageUrl } from '../draft/cardImage.ts';
import artistTable from '../draft/art-artists.json' with { type: 'json' };
import fixture from './deckArtCover.fixture.json' with { type: 'json' };

const pool = fixture.pool as DraftCard[];
const corpusArtists: Readonly<Record<string, string>> = fixture.artists;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Art decodes at once, and `fetch` answers `/art/<id>/artist` from the corpus rows, as the server does. */
function stubBrowser(): string[] {
  vi.stubGlobal(
    'Image',
    class {
      complete = false;
      naturalWidth = 0;
      src = '';
      fetchPriority = 'auto';
      decode(): Promise<void> {
        return Promise.resolve();
      }
    },
  );
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    asked.push(url);
    // A basic's art is asked by name (`namedPeekLine`); these tiles never show one.
    if (url.includes('/cards/art?')) return new Response(JSON.stringify({ art: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    const id = /\/art\/([0-9a-f-]{36})\/artist$/.exec(url)?.[1];
    const artist = id === undefined ? undefined : corpusArtists[id];
    return artist === undefined
      ? new Response('not found', { status: 404 })
      : new Response(JSON.stringify({ artist }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return asked;
}

it('draws the cover of a real drafted deck whose every card the committed artist table misses', async () => {
  const committed: Readonly<Record<string, number>> = artistTable.ids;
  expect(pool.filter((c) => c.scryfallId !== undefined && c.scryfallId in committed), 'the seat is one the table cannot credit').toEqual([]);
  const asked = stubBrowser();

  const option = draftedDeckOption('pod', 'Deck', draftedDeckOf('pod', pool), pool);
  const [artId] = assignDeckArt([option.art ?? []]);
  expect(artId, 'the rule chose a card').toBeDefined();
  const { container } = render(createElement(DeckArt, { artId }));

  await waitFor(() => expect(container.querySelector('.deckpick__credit')?.textContent).toBe(artCredit(corpusArtists[artId!]!)));
  expect(container.querySelector('img')?.getAttribute('src')).toBe(cardImageUrl(artId!));
  expect(asked.filter((url) => url.endsWith(`/art/${artId}/artist`)), 'one lookup for the id').toHaveLength(1);
});

it('falls back to the cube’s own cover when no drafted card has art, and to the empty band when there is none', async () => {
  stubBrowser();
  // A pool whose cards resolved no id (an imported cube's names the catalog never knew).
  const idless = pool.map(({ scryfallId: _dropped, ...card }) => card);
  const cover = pool[0]!.scryfallId!;

  const option = draftedDeckOption('pod', 'Deck', draftedDeckOf('pod', idless), idless, cover);
  const [artId] = assignDeckArt([option.art ?? []]);
  expect(artId).toBe(cover);
  const { container } = render(createElement(DeckArt, { artId }));
  await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe(cardImageUrl(cover)));

  expect(assignDeckArt([draftedDeckOption('pod', 'Deck', draftedDeckOf('pod', idless), idless).art ?? []])).toEqual([undefined]);
});

it('takes the cube’s cover before repeating a card a deck above already shows', () => {
  stubBrowser();
  const deck = draftedDeckOf('pod', pool);
  const cover = 'cover-art';
  const above = draftedDeckOption('a', 'A', deck, pool);
  // The same pool twice on one page: the second deck has nothing left the first did not take.
  const second = draftedDeckOption('b', 'B', deck, pool, cover);
  const ranks = (above.art ?? []).length;
  const page = assignDeckArt([...Array.from({ length: ranks }, () => above.art ?? []), second.art ?? []]);
  expect(page.at(-1)).toBe(cover);
});

it('draws the empty band for an id no printing has, and asks the server about it once', async () => {
  const asked = stubBrowser();
  const nobody = '00000000-0000-4000-8000-000000000000';
  for (let i = 0; i < 2; i++) {
    const { container, unmount } = render(createElement(DeckArt, { artId: nobody }));
    await waitFor(() => expect(asked.filter((url) => url.endsWith(`/art/${nobody}/artist`))).toHaveLength(1));
    expect(container.querySelector('.deckpick__art--none')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
    unmount();
  }
});

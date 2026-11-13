// @vitest-environment jsdom
/*
 * The Decks page holds its tiles until their art can be drawn — the operator,
 * 2026-10-19: "the cards load the images a second later after opening, that's
 * ugly". Its own file: `cardImage.ts`'s art cache is module-wide, and every
 * piece of art here must start cold.
 */

import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { DraftCard } from '@hadoku/shared';

import { DecksScreen } from './DecksScreen.tsx';
import type { MyDeck, MyDecksClient } from '../deck/myDecks.ts';
import { draftedDeckOf } from './ConstructedScreen.tsx';
import { dckTextOf } from '../draft/deckFromPool.ts';
import poolJson from '../draft/pool.json';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('shows the tiles’ outlines until every tile’s art has decoded, then the tiles with it', async () => {
  const decodes: (() => void)[] = [];
  class HeldImage {
    complete = false;
    naturalWidth = 0;
    src = '';
    fetchPriority = 'auto';
    decode(): Promise<void> {
      return new Promise((done) => decodes.push(done));
    }
  }
  vi.stubGlobal('Image', HeldImage);
  const pool: DraftCard[] = (poolJson as { cards: DraftCard[] }).cards.slice(0, 45).map((c, i) => ({ ...c, cardId: `draft:p/p${i}` }));
  const deck: MyDeck = { id: 'a', name: 'Pod a', cube: 'Cube', createdAt: 1, pool, deck: dckTextOf(draftedDeckOf('a', pool)), concluded: true };
  const client: MyDecksClient = { list: async () => [deck], rename: () => Promise.reject(new Error('unused')), remove: () => Promise.reject(new Error('unused')) };
  render(createElement(DecksScreen, { decks: client, deckRecords: async () => new Map() }));

  await waitFor(() => expect(decodes.length).toBeGreaterThan(0));
  expect(screen.queryAllByTestId('deck-option'), 'no tile before its art').toEqual([]);
  expect(screen.getByTestId('deck-mine').querySelectorAll('.skeleton--tile').length).toBeGreaterThan(0);

  await act(async () => {
    for (const done of decodes) done();
  });
  await waitFor(() => expect(screen.getAllByTestId('deck-option')).toHaveLength(1));
});

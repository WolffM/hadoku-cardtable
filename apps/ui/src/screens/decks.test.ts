// @vitest-environment jsdom
/*
 * `#/decks`: every finished draft as a tile with its record, opening the
 * editor, and renamed or deleted only once its tournament is over — and the
 * lobby's button beside the trophy that leads there.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DraftCard } from '@hadoku/shared';

import { DecksScreen } from './DecksScreen.tsx';
import { LobbyScreen } from './LobbyScreen.tsx';
import { parseRoute, routeHash } from './route.ts';
import type { MyDeck, MyDecksClient } from '../deck/myDecks.ts';
import { draftedDeckOf } from './ConstructedScreen.tsx';
import { dckTextOf } from '../draft/deckFromPool.ts';
import type { DeckRecords } from '../stats/deckOrder.ts';
import poolJson from '../draft/pool.json';

afterEach(cleanup);

const POOL: DraftCard[] = (poolJson as { cards: DraftCard[] }).cards.slice(0, 45).map((c, i) => ({ ...c, cardId: `draft:p/p${i}` }));
const deck = (id: string, over: Partial<MyDeck> = {}): MyDeck => ({
  id,
  name: `Pod ${id}`,
  cube: 'Cube',
  createdAt: Date.UTC(2026, 9, 18),
  pool: POOL,
  deck: dckTextOf(draftedDeckOf(id, POOL)),
  concluded: true,
  ...over,
});

function stub(decks: MyDeck[] | Promise<MyDeck[]>) {
  const calls: string[] = [];
  const client: MyDecksClient = {
    list: async () => decks,
    rename: async (id, name) => {
      calls.push(`rename ${id} ${name}`);
      return { ok: true, deck: { ...(await decks).find((d) => d.id === id)!, name } };
    },
    remove: async (id) => {
      calls.push(`delete ${id}`);
      return { ok: true };
    },
  };
  return { calls, client };
}

const records = (entries: [string, number, number][]): (() => Promise<DeckRecords>) => () =>
  Promise.resolve(new Map(entries.map(([id, wins, losses]) => [id, { games: wins + losses, wins, losses, draws: 0 }])));

const tile = (id: string): HTMLElement => {
  const found = screen.getAllByTestId('decks-tile').find((t) => t.dataset['deckId'] === id);
  if (found === undefined) throw new Error(`no tile ${id}`);
  return found;
};

describe('DecksScreen', () => {
  it('draws nothing until the decks and their records have both answered, then each deck with its W–L', async () => {
    let answer!: (r: DeckRecords) => void;
    const { client } = stub([deck('a'), deck('b', { concluded: false })]);
    render(createElement(DecksScreen, { decks: client, deckRecords: () => new Promise<DeckRecords>((done) => (answer = done)) }));
    await act(async () => undefined);
    expect(screen.queryByTestId('decks-grid')).toBeNull();
    expect(screen.queryByTestId('decks-empty')).toBeNull();

    await act(async () => answer(new Map([['draft:a', { games: 3, wins: 2, losses: 1, draws: 0 }]])));
    expect(within(tile('a')).getByTestId('decks-record').textContent).toBe('2–1');
    expect(within(tile('b')).getByTestId('decks-record').textContent).toBe('0–0');
    expect(within(tile('a')).getByRole('link').getAttribute('href')).toBe(routeHash({ kind: 'decks', draftId: 'a' }));
    expect(parseRoute(routeHash({ kind: 'decks', draftId: 'a' }))).toEqual({ kind: 'decks', draftId: 'a' });
  });

  it('offers rename and delete only on a deck whose tournament is over', async () => {
    const { client } = stub([deck('a'), deck('b', { concluded: false })]);
    render(createElement(DecksScreen, { decks: client, deckRecords: records([]) }));
    await screen.findByTestId('decks-grid');
    expect(within(tile('a')).getByTestId('decks-rename')).toBeTruthy();
    expect(within(tile('a')).getByTestId('decks-delete')).toBeTruthy();
    expect(within(tile('b')).queryByTestId('decks-rename')).toBeNull();
    expect(within(tile('b')).queryByTestId('decks-delete')).toBeNull();
  });

  it('renames in place, and deletes after a second press', async () => {
    const { client, calls } = stub([deck('a'), deck('c')]);
    render(createElement(DecksScreen, { decks: client, deckRecords: records([]) }));
    await screen.findByTestId('decks-grid');

    fireEvent.click(within(tile('a')).getByTestId('decks-rename'));
    fireEvent.change(within(tile('a')).getByTestId('decks-name-input'), { target: { value: 'Blue tempo' } });
    fireEvent.click(within(tile('a')).getByTestId('decks-name-save'));
    await waitFor(() => expect(within(tile('a')).getByTestId('decks-name').textContent).toBe('Blue tempo'));

    fireEvent.click(within(tile('c')).getByTestId('decks-delete'));
    expect(calls).toEqual(['rename a Blue tempo']);
    fireEvent.click(within(tile('c')).getByTestId('decks-delete-confirm'));
    await waitFor(() => expect(screen.getAllByTestId('decks-tile').map((t) => t.dataset['deckId'])).toEqual(['a']));
    expect(calls).toEqual(['rename a Blue tempo', 'delete c']);
  });

  it('says there are none, once it knows', async () => {
    const { client } = stub([]);
    render(createElement(DecksScreen, { decks: client, deckRecords: records([]) }));
    expect((await screen.findByTestId('decks-empty')).textContent).toBe('No decks yet');
  });
});

describe('the lobby', () => {
  it('has a Decks button beside the trophy that opens #/decks', () => {
    const rooms = { list: () => new Promise(() => undefined) } as unknown as NonNullable<Parameters<typeof LobbyScreen>[0]['rooms']>;
    render(createElement(LobbyScreen, { rooms, feed: { follow: () => () => undefined } }));
    const button = screen.getByTestId('lobby-decks');
    expect(button.getAttribute('href')).toBe('#/decks');
    expect(button.nextElementSibling?.getAttribute('data-testid')).toBe('lobby-stats');
  });
});

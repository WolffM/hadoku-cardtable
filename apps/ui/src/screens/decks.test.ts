// @vitest-environment jsdom
/*
 * `#/decks`: every finished draft as a tile with its record, opening the
 * editor, and renamed or deleted only once its tournament is over — and the
 * lobby's button beside the trophy that leads there.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DraftCard } from '@hadoku/shared';

import { DecksScreen } from './DecksScreen.tsx';
import { LobbyScreen } from './LobbyScreen.tsx';
import { parseRoute } from './route.ts';
import { DeckManage } from './DeckManage.tsx';
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
  const found = screen.getAllByTestId('deck-option').find((t) => t.dataset['deckId'] === id);
  if (found === undefined) throw new Error(`no tile ${id}`);
  return found;
};

describe('DecksScreen', () => {
  it('draws only the tiles’ outlines until the decks and their records have answered, then the room’s own deck tiles with their W–L', async () => {
    let answer!: (r: DeckRecords) => void;
    const { client } = stub([deck('a'), deck('b', { concluded: false })]);
    render(createElement(DecksScreen, { decks: client, deckRecords: () => new Promise<DeckRecords>((done) => (answer = done)) }));
    await act(async () => undefined);
    expect(screen.queryAllByTestId('deck-option')).toEqual([]);
    expect(screen.getByTestId('deck-mine').querySelectorAll('.skeleton--tile').length).toBeGreaterThan(0);

    await act(async () => answer(new Map([['draft:a', { games: 3, wins: 2, losses: 1, draws: 0 }]])));
    await waitFor(() => expect(screen.getAllByTestId('deck-option')).toHaveLength(2));
    // The 1v1 chooser's tile: the name, then the pilot line, which here is the record.
    expect(tile('a').querySelector('.deckpick__name')?.textContent).toBe('Pod a');
    expect(tile('a').querySelector('.deckpick__pilot')?.textContent).toBe('2–1');
    expect(tile('b').querySelector('.deckpick__pilot')?.textContent).toBe('0–0');
    expect(screen.getByTestId('deck-mine').querySelectorAll('.skeleton--tile')).toHaveLength(0);
  });

  it('opens a deck in the editor on a click', async () => {
    const { client } = stub([deck('a')]);
    render(createElement(DecksScreen, { decks: client, deckRecords: records([]) }));
    await waitFor(() => expect(screen.getAllByTestId('deck-option')).toHaveLength(1));
    fireEvent.click(tile('a'));
    expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'decks', draftId: 'a' });
  });

  it('says there are none, once it knows', async () => {
    const { client } = stub([]);
    render(createElement(DecksScreen, { decks: client, deckRecords: records([]) }));
    expect((await screen.findByTestId('deck-none')).textContent).toBe('No decks yet');
  });

  it('filters the drafted decks with the room’s filter row, by colour and by card name, and offers no play style', async () => {
    const poolB = (poolJson as { cards: DraftCard[] }).cards.slice(45, 90).map((c, i) => ({ ...c, cardId: `draft:q/q${i}` }));
    const { client } = stub([deck('a'), deck('b', { pool: poolB, deck: dckTextOf(draftedDeckOf('b', poolB)) })]);
    render(createElement(DecksScreen, { decks: client, deckRecords: records([]) }));
    await waitFor(() => expect(screen.getAllByTestId('deck-option')).toHaveLength(2));
    expect(screen.queryAllByTestId(/^deck-filter-style-/)).toEqual([]);
    const shown = (): string[] => screen.queryAllByTestId('deck-option').map((t) => t.dataset['deckId']!);

    const [colorsA, colorsB] = [tile('a').dataset['colors']!, tile('b').dataset['colors']!];
    const only = [...'WUBRG'].find((c) => colorsA.includes(c) !== colorsB.includes(c))!;
    expect(only, 'the fixture decks differ in a colour').toBeDefined();
    fireEvent.click(screen.getByTestId(`deck-filter-color-${only}`));
    expect(shown()).toEqual([colorsA.includes(only) ? 'a' : 'b']);
    fireEvent.click(screen.getByTestId(`deck-filter-color-${only}`));
    expect(shown()).toEqual(['a', 'b']);

    const namesB = new Set(draftedDeckOf('b', poolB).main.map((e) => e.card.name));
    const onlyInA = draftedDeckOf('a', POOL).main.find((e) => !namesB.has(e.card.name))!.card.name;
    fireEvent.change(screen.getByTestId('deck-filter-text'), { target: { value: onlyInA.toUpperCase() } });
    expect(shown()).toEqual(['a']);
    fireEvent.change(screen.getByTestId('deck-filter-text'), { target: { value: 'no card is called this' } });
    expect(shown()).toEqual([]);
    expect(screen.getByTestId('deck-none').textContent).toBe('No decks');
  });

  it('deletes a finished deck from its tile after a second press, and offers no delete on a deck whose tournament runs', async () => {
    globalThis.location.hash = '#/decks';
    const { calls, client } = stub([deck('a'), deck('b', { concluded: false })]);
    render(createElement(DecksScreen, { decks: client, deckRecords: records([]) }));
    await waitFor(() => expect(screen.getAllByTestId('deck-option')).toHaveLength(2));
    const bins = screen.getAllByTestId('decks-tile-delete');
    expect(bins).toHaveLength(1);
    expect(bins[0]!.closest('.deckpick__cell')?.querySelector('[data-testid="deck-option"]')).toBe(tile('a'));

    fireEvent.click(bins[0]!);
    expect(calls).toEqual([]);
    expect(globalThis.location.hash).toBe('#/decks');
    fireEvent.click(screen.getByTestId('decks-tile-delete-cancel'));
    expect(screen.queryByTestId('decks-tile-delete-confirm')).toBeNull();

    fireEvent.click(screen.getByTestId('decks-tile-delete'));
    fireEvent.click(screen.getByTestId('decks-tile-delete-confirm'));
    await waitFor(() => expect(screen.getAllByTestId('deck-option').map((t) => t.dataset['deckId'])).toEqual(['b']));
    expect(calls).toEqual(['delete a']);
  });
});

describe('a deck’s name, rename and delete, over its editor', () => {
  const manage = (d: MyDeck, client: MyDecksClient, onDeleted = () => undefined) =>
    render(createElement(DeckManage, { deck: d, client, onRenamed: () => undefined, onDeleted }));

  it('offers rename and delete only once its tournament is over', () => {
    const { client } = stub([deck('b', { concluded: false })]);
    manage(deck('b', { concluded: false }), client);
    expect(screen.getByTestId('decks-name').textContent).toBe('Pod b');
    expect(screen.queryByTestId('decks-rename')).toBeNull();
    expect(screen.queryByTestId('decks-delete')).toBeNull();
  });

  it('renames in place, and deletes after a second press', async () => {
    const { client, calls } = stub([deck('a')]);
    let deleted = false;
    let renamed: MyDeck | null = null;
    render(createElement(DeckManage, { deck: deck('a'), client, onRenamed: (d: MyDeck) => (renamed = d), onDeleted: () => (deleted = true) }));
    fireEvent.click(screen.getByTestId('decks-rename'));
    fireEvent.change(screen.getByTestId('decks-name-input'), { target: { value: 'Blue tempo' } });
    fireEvent.click(screen.getByTestId('decks-name-save'));
    await waitFor(() => expect(renamed?.name).toBe('Blue tempo'));

    fireEvent.click(screen.getByTestId('decks-delete'));
    expect(calls).toEqual(['rename a Blue tempo']);
    fireEvent.click(screen.getByTestId('decks-delete-confirm'));
    await waitFor(() => expect(deleted).toBe(true));
    expect(calls).toEqual(['rename a Blue tempo', 'delete a']);
  });
});

describe('the lobby', () => {
  it('has a Decks button beside the trophy that opens #/decks, with Inventory (AF305 §B) beside it', () => {
    const rooms = { list: () => new Promise(() => undefined) } as unknown as NonNullable<Parameters<typeof LobbyScreen>[0]['rooms']>;
    render(createElement(LobbyScreen, { rooms, feed: { follow: () => () => undefined } }));
    const button = screen.getByTestId('lobby-decks');
    expect(button.getAttribute('href')).toBe('#/decks');
    expect(button.nextElementSibling?.getAttribute('data-testid'), 'Inventory sits beside Decks').toBe('lobby-inventory');
    expect(button.nextElementSibling?.nextElementSibling?.getAttribute('data-testid')).toBe('lobby-stats');
  });
});

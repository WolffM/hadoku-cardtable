// @vitest-environment jsdom
/*
 * The Library's Decks tab (`#/library`, wave 125): every built deck and every finished draft as a
 * tile with its record and when it was last played, in Favourites / Your decks / From drafts,
 * opening the editor, a drafted deck deleted only once its tournament is over; the old `#/decks`
 * moved to it; and the lobby's one Library button beside the trophy.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serveNamedArt } from '@hadoku/magic-ui/play/art.testing.ts';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DraftCard } from '@hadoku/shared';

import { LibraryScreen } from '@hadoku/magic-ui/screens/LibraryScreen.tsx';
import { LobbyScreen } from './LobbyScreen.tsx';
import { Screen } from './Screen.tsx';
import { currentRoute, navigate } from '@hadoku/game-ui/screens/route.ts';
import type { FavouritesClient, MyLibrary } from '@hadoku/magic-ui/deck/favourites.ts';
import type { BuiltDeck } from '@hadoku/magic-ui/deck/builtDecks.ts';
import { DeckManage } from '@hadoku/magic-ui/screens/DeckManage.tsx';
import type { MyDeck, MyDecksClient } from '@hadoku/magic-ui/deck/myDecks.ts';
import { draftedDeckOf } from '@hadoku/magic-ui/screens/ConstructedScreen.tsx';
import { dckTextOf } from '@hadoku/magic-ui/draft/deckFromPool.ts';
import type { DeckRecords } from '@hadoku/magic-ui/stats/deckOrder.ts';
import poolJson from '@hadoku/magic-ui/draft/pool.json';

// A card known by its name is answered as the server answers it (`GET /api/cards/art`).
beforeEach(serveNamedArt);

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
  touched: false,
  inTournament: false,
  concludedAt: Date.UTC(2026, 9, 19),
  ...over,
});
/** A deck whose tournament still runs. */
const live = { concluded: false, inTournament: true, concludedAt: null } as const;

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

const at = (month: number, day: number): number => Date.UTC(2026, month - 1, day, 12);
const built = (id: string, over: Partial<BuiltDeck> = {}): BuiltDeck => ({
  id: `built:${id}`,
  name: `Built ${id}`,
  format: 'any',
  dck: '[metadata]\nName=x\n[Main]\n4 Lightning Bolt\n16 Mountain\n',
  createdAt: at(10, 1),
  updatedAt: at(10, 1),
  ...over,
});

/** The caller's document: starred decks, last-played stamps, built decks; every star it is asked for. */
function doc(over: Partial<MyLibrary> = {}) {
  const starred: string[] = [];
  const client: FavouritesClient = {
    library: async () => ({ favourites: new Set(), lastPlayed: new Map(), built: [], ...over }),
    setFavourite: async (deckId, on) => {
      starred.push(`${on ? 'star' : 'unstar'} ${deckId}`);
      return { ok: true };
    },
  };
  return { starred, client };
}

const decksTab = (client: MyDecksClient, deckRecords = records([]), library = doc().client, cube?: string) =>
  createElement(LibraryScreen, { decks: client, deckRecords, library, ...(cube === undefined ? {} : { cube }) });

/** The section a tile is drawn in. */
const sectionOfTile = (id: string): string | undefined => tile(id).closest<HTMLElement>('[data-testid^="library-section-"]')?.dataset['testid'];
const shownIn = (section: string): string[] =>
  [...screen.getByTestId(`library-section-${section}`).querySelectorAll<HTMLElement>('[data-testid="deck-option"]')].map((t) => t.dataset['deckId']!);

describe('the Library’s Decks tab', () => {
  it('draws only the tiles’ outlines until the decks, their records and the document have answered, then the room’s own deck tiles with their W–L and when last played', async () => {
    let answer!: (r: DeckRecords) => void;
    const { client } = stub([deck('a'), deck('b', { ...live, createdAt: at(10, 18) })]);
    const { client: library } = doc({ lastPlayed: new Map([['draft:a', at(11, 19)]]) });
    render(decksTab(client, () => new Promise<DeckRecords>((done) => (answer = done)), library));
    await act(async () => undefined);
    expect(screen.queryAllByTestId('deck-option')).toEqual([]);
    expect(screen.getByTestId('deck-mine').querySelectorAll('.skeleton--tile').length).toBeGreaterThan(0);

    await act(async () => answer(new Map([['draft:a', { games: 3, wins: 2, losses: 1, draws: 0 }]])));
    await waitFor(() => expect(screen.getAllByTestId('deck-option')).toHaveLength(2));
    expect(tile('a').querySelector('.deckpick__name')?.textContent).toBe('Pod a');
    expect(tile('a').querySelector('.deckpick__pilot')?.textContent).toBe('2–1 · Last played Nov 19');
    expect(tile('b').querySelector('.deckpick__pilot')?.textContent).toBe('0–0 · Never played · drafted Oct 18');
    expect(screen.queryAllByTestId('deck-mine').flatMap((g) => [...g.querySelectorAll('.skeleton--tile')])).toHaveLength(0);
  });

  it('is titled Library, marks its Decks tab, and its arrow goes home', () => {
    const { client } = stub([]);
    globalThis.location.hash = '#/library';
    render(decksTab(client));
    expect(screen.getByRole('heading', { level: 1, name: 'Library' })).not.toBeNull();
    expect(screen.getByTestId('library-tab-decks').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('library-tab-cubes').getAttribute('href')).toBe('#/library/cubes');
    fireEvent.click(screen.getByTestId('back-to-lobby'));
    expect(currentRoute()).toEqual({ kind: 'lobby' });
  });

  it('puts starred decks first, your decks next, untouched drafts last, each by last played', async () => {
    const { client } = stub([
      deck('old', { createdAt: at(9, 1) }),
      deck('renamed', { touched: true }),
      deck('starred'),
      deck('recent'),
      deck('running', live),
    ]);
    const { client: library } = doc({
      favourites: new Set(['draft:starred']),
      lastPlayed: new Map([
        ['draft:recent', at(11, 20)],
        ['draft:renamed', at(11, 1)],
        ['built:b1', at(11, 10)],
      ]),
      built: [built('b1'), built('b2', { createdAt: at(11, 21) })],
    });
    render(decksTab(client, records([]), library));
    await waitFor(() => expect(screen.getAllByTestId('deck-option')).toHaveLength(7));
    expect(screen.getAllByTestId(/^library-section-/).map((s) => s.dataset['testid'])).toEqual(['library-section-favourites', 'library-section-yours', 'library-section-drafts']);
    expect(shownIn('favourites')).toEqual(['starred']);
    expect(shownIn('yours')).toEqual(['built:b1', 'renamed', 'built:b2']);
    expect(shownIn('drafts')).toEqual(['recent', 'running', 'old']);
    // A deck still in its tournament wears the chip, and offers no delete.
    const cellOf = (id: string) => tile(id).closest('.deckpick__cell')!;
    expect(cellOf('running').querySelector('[data-testid="library-tile-locked"]')?.textContent).toBe('In tournament');
    expect(cellOf('running').querySelector('[data-testid="decks-tile-delete"]')).toBeNull();
    expect(cellOf('recent').querySelector('[data-testid="library-tile-locked"]')).toBeNull();
    expect(cellOf('recent').querySelector('[data-testid="decks-tile-delete"]')).not.toBeNull();
  });

  it('stars a deck into Favourites at once, and unstars it back where it was', async () => {
    const { client } = stub([deck('a')]);
    const { starred, client: library } = doc();
    render(decksTab(client, records([]), library));
    await waitFor(() => expect(sectionOfTile('a')).toBe('library-section-drafts'));
    const star = () => tile('a').closest('.deckpick__cell')!.querySelector<HTMLButtonElement>('[data-testid="library-tile-star"]')!;
    expect(star().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(star());
    await waitFor(() => expect(sectionOfTile('a')).toBe('library-section-favourites'));
    expect(star().getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(star());
    await waitFor(() => expect(sectionOfTile('a')).toBe('library-section-drafts'));
    expect(starred).toEqual(['star draft:a', 'unstar draft:a']);
  });

  it('puts a star back and says why when the server refuses it', async () => {
    const { client } = stub([deck('a')]);
    const library: FavouritesClient = { library: doc().client.library, setFavourite: async () => ({ ok: false, message: 'too many changes' }) };
    render(decksTab(client, records([]), library));
    await waitFor(() => expect(sectionOfTile('a')).toBe('library-section-drafts'));
    fireEvent.click(tile('a').closest('.deckpick__cell')!.querySelector('[data-testid="library-tile-star"]')!);
    expect((await screen.findByTestId('library-error')).textContent).toBe('too many changes');
  });

  it('sorts every section by name when asked', async () => {
    const { client } = stub([deck('zed', { name: 'Zed' }), deck('mid', { name: 'Mid' })]);
    render(decksTab(client));
    await waitFor(() => expect(screen.getAllByTestId('deck-option')).toHaveLength(2));
    expect(screen.queryAllByTestId(/^library-source-/)).toEqual([]);
    fireEvent.change(screen.getByTestId('library-sort'), { target: { value: 'name' } });
    expect(shownIn('drafts')).toEqual(['mid', 'zed']);
  });

  it('finds decks by their name, a card in them, or the cube they came from, in its one text box', async () => {
    const { client } = stub([deck('a', { name: 'Blue tempo', cube: 'Vintage' }), deck('b', { name: 'Red', cube: 'Pauper' })]);
    render(decksTab(client, records([]), doc({ built: [built('x', { name: 'Mono-red' })] }).client));
    await waitFor(() => expect(screen.getAllByTestId('deck-option')).toHaveLength(3));
    const shown = (): string[] => screen.queryAllByTestId('deck-option').map((t) => t.dataset['deckId']!).sort();
    const box = screen.getByTestId('deck-filter-text');
    expect(box.getAttribute('placeholder')).toBe('Deck, card or cube');
    fireEvent.change(box, { target: { value: 'tempo' } });
    expect(shown()).toEqual(['a']);
    fireEvent.change(box, { target: { value: 'pauper' } });
    expect(shown()).toEqual(['b']);
    fireEvent.change(box, { target: { value: 'lightning bolt' } });
    expect(shown()).toEqual(['built:x']);
  });

  it('opens from the Cubes tab with that cube’s name in the box, and nothing else to take off', async () => {
    const { client } = stub([deck('a', { cube: 'Vintage' }), deck('b', { cube: 'Pauper' })]);
    render(decksTab(client, records([]), doc({ built: [built('x')] }).client, 'Vintage'));
    await waitFor(() => expect(screen.getAllByTestId('deck-option').map((t) => t.dataset['deckId'])).toEqual(['a']));
    expect((screen.getByTestId('deck-filter-text') as HTMLInputElement).value).toBe('Vintage');
    expect(screen.queryByTestId('library-cube-filter')).toBeNull();
    fireEvent.change(screen.getByTestId('deck-filter-text'), { target: { value: '' } });
    expect(screen.getAllByTestId('deck-option')).toHaveLength(3);
  });

  it('opens a drafted deck, a built deck, or a new one in the editor', async () => {
    const { client } = stub([deck('a')]);
    render(decksTab(client, records([]), doc({ built: [built('b')] }).client));
    await waitFor(() => expect(screen.getAllByTestId('deck-option')).toHaveLength(2));
    fireEvent.click(tile('a'));
    expect(currentRoute()).toEqual({ kind: 'decks', draftId: 'a' });
    fireEvent.click(tile('built:b'));
    expect(currentRoute()).toEqual({ kind: 'decks', draftId: 'built:b' });
    fireEvent.click(screen.getByTestId('library-new-deck'));
    expect(currentRoute()).toEqual({ kind: 'decks', draftId: 'new' });
  });

  it('says there are none, once it knows', async () => {
    const { client } = stub([]);
    render(decksTab(client));
    expect((await screen.findByTestId('deck-none')).textContent).toBe('No decks yet');
  });

  it('filters the decks with the room’s filter row, by colour and by card name, and offers no play style', async () => {
    const poolB = (poolJson as { cards: DraftCard[] }).cards.slice(45, 90).map((c, i) => ({ ...c, cardId: `draft:q/q${i}` }));
    const { client } = stub([deck('a'), deck('b', { pool: poolB, deck: dckTextOf(draftedDeckOf('b', poolB)) })]);
    render(decksTab(client));
    await waitFor(() => expect(screen.getAllByTestId('deck-option')).toHaveLength(2));
    expect(screen.queryAllByTestId(/^deck-filter-style-/)).toEqual([]);
    const shown = (): string[] => screen.queryAllByTestId('deck-option').map((t) => t.dataset['deckId']!);

    const [colorsA, colorsB] = [tile('a').dataset['colors']!, tile('b').dataset['colors']!];
    const only = [...'WUBRG'].find((c) => colorsA.includes(c) !== colorsB.includes(c))!;
    expect(only, 'the fixture decks differ in a colour').toBeDefined();
    fireEvent.click(screen.getByTestId(`deck-filter-color-${only}`));
    expect(shown()).toEqual([colorsA.includes(only) ? 'a' : 'b']);
    fireEvent.click(screen.getByTestId(`deck-filter-color-${only}`));
    expect(shown().sort()).toEqual(['a', 'b']);

    const namesB = new Set(draftedDeckOf('b', poolB).main.map((e) => e.card.name));
    const onlyInA = draftedDeckOf('a', POOL).main.find((e) => !namesB.has(e.card.name))!.card.name;
    fireEvent.change(screen.getByTestId('deck-filter-text'), { target: { value: onlyInA.toUpperCase() } });
    expect(shown()).toEqual(['a']);
    fireEvent.change(screen.getByTestId('deck-filter-text'), { target: { value: 'no card is called this' } });
    expect(shown()).toEqual([]);
    expect(screen.getByTestId('deck-none').textContent).toBe('No decks');
  });

  it('deletes a finished deck from its tile after a second press', async () => {
    globalThis.location.hash = '#/library';
    const { calls, client } = stub([deck('a'), deck('b', live)]);
    render(decksTab(client));
    await waitFor(() => expect(screen.getAllByTestId('deck-option')).toHaveLength(2));
    const bins = screen.getAllByTestId('decks-tile-delete');
    expect(bins).toHaveLength(1);
    expect(bins[0]!.closest('.deckpick__cell')?.querySelector('[data-testid="deck-option"]')).toBe(tile('a'));

    fireEvent.click(bins[0]!);
    expect(calls).toEqual([]);
    expect(globalThis.location.hash).toBe('#/library');
    fireEvent.click(screen.getByTestId('decks-tile-delete-cancel'));
    expect(screen.queryByTestId('decks-tile-delete-confirm')).toBeNull();

    fireEvent.click(screen.getByTestId('decks-tile-delete'));
    fireEvent.click(screen.getByTestId('decks-tile-delete-confirm'));
    await waitFor(() => expect(screen.getAllByTestId('deck-option').map((t) => t.dataset['deckId'])).toEqual(['b']));
    expect(calls).toEqual(['delete a']);
  });
});

describe('the old addresses', () => {
  it('move #/decks to the Decks tab and #/inventory to the Cubes tab, in place', async () => {
    render(createElement(Screen));
    act(() => navigate({ kind: 'decks' }));
    await waitFor(() => expect(currentRoute()).toEqual({ kind: 'library' }));
    act(() => navigate({ kind: 'inventory' }));
    await waitFor(() => expect(currentRoute()).toEqual({ kind: 'library', tab: 'cubes' }));
  });
});

describe('a deck’s name, rename and delete, over its editor', () => {
  const manage = (d: MyDeck, client: MyDecksClient, onDeleted = () => undefined) =>
    render(createElement(DeckManage, { deck: d, client, onRenamed: () => undefined, onDeleted }));

  it('offers rename and delete only once its tournament is over', () => {
    const { client } = stub([deck('b', live)]);
    manage(deck('b', live), client);
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
  it('has one Library button beside the trophy that opens #/library', () => {
    const rooms = { list: () => new Promise(() => undefined) } as unknown as NonNullable<Parameters<typeof LobbyScreen>[0]['rooms']>;
    render(createElement(LobbyScreen, { rooms, feed: { follow: () => () => undefined } }));
    const button = screen.getByTestId('lobby-library');
    expect(button.getAttribute('href')).toBe('#/library');
    expect(button.getAttribute('aria-label')).toBe('Library');
    expect(screen.queryByTestId('lobby-inventory')).toBeNull();
    expect(button.nextElementSibling?.getAttribute('data-testid')).toBe('lobby-stats');
  });
});

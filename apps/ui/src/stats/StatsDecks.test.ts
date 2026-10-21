// @vitest-environment jsdom
/*
 * The stats page's Decks section (`StatsDecks.tsx`) over the REAL game-stats
 * client and a stubbed fetch: what its filter bar asks the store for, what the
 * name search narrows without asking, and the list a deck row opens on hover.
 */

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { createStatsCache } from '@wolffm/game-stats-ui';
import { createGameStatsClient, type BreakdownRow } from '@wolffm/prefs-client/games';
import type { MyDeck } from '@hadoku/shared';

import { PEEK_DELAY_MS, PEEK_GRACE_MS } from '../screens/DeckPeek.tsx';
import type { TableDeck } from '../screens/tables.ts';
import { StatsPopout, type StatsSource } from './StatsPopout.tsx';
import { deckLookup, filterDeckRows, matchFormats, NO_DECK_FILTER, type DeckLookup } from './StatsDecks.tsx';

afterEach(() => {
  cleanup();
});

const totals = (wins: number, losses: number) => ({ games: wins + losses, wins, losses, draws: 0 });

const LIBRARY_ID = 'power-2016-1-azorius';
const POD = 'r-0123456789ab';

const DECKS: BreakdownRow[] = [
  { value: 'Azorius Fliers (Ana)', ...totals(5, 2), attrs: { colors: ['W', 'U'], deckId: LIBRARY_ID } },
  { value: `Cube draft ${POD}`, ...totals(1, 1), attrs: { colors: ['B'], deckId: `draft:${POD}` } },
];

const LIBRARY: TableDeck = {
  id: LIBRARY_ID,
  collection: 'power',
  era: '2016-07-22',
  name: 'Azorius Fliers (Ana)',
  archetype: 'Azorius Fliers',
  pilot: 'Ana',
  format: '2016-07-22',
  date: '2016-07-22',
  provenance: '',
  citation: '',
  main: [
    { count: 4, name: 'Serra Angel' },
    { count: 20, name: 'Island' },
  ],
  sideboard: [{ count: 2, name: 'Negate' }],
};

const MINE: MyDeck = {
  id: POD,
  name: 'My cube deck',
  cube: 'vintage',
  createdAt: 1,
  pool: [],
  deck: '[metadata]\nName=My cube deck\n[Main]\n17 Swamp\n',
  concluded: true,
};

function stub() {
  const asked: URL[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    asked.push(url);
    const path = url.pathname.replace('/prefs/api/v1/_games/cardtable', '');
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    if (path === '/profile') return json({ name: 'Bella', isMe: true, totals: totals(0, 0), ratings: [], counters: {}, lastPlayedAt: null });
    if (path === '/matches') return json({ matches: [], nextBefore: null });
    if (path === '/leaderboard') return json({ by: 'rating', rows: [] });
    return json({ attr: url.searchParams.get('attr'), rows: url.searchParams.get('attr') === 'deck' ? DECKS : [] });
  }) as typeof globalThis.fetch;
  const source: StatsSource = {
    client: createGameStatsClient({ gameId: 'cardtable', baseUrl: 'https://hadoku.me/prefs', fetch }),
    cache: createStatsCache(),
  };
  const deckReads = () => asked.filter((u) => u.pathname.endsWith('/breakdown') && u.searchParams.get('attr') === 'deck');
  return { source, deckReads };
}

const lookupOf = () => {
  const tables = { decks: vi.fn(async () => [LIBRARY]) };
  const mine = { list: vi.fn(async () => [MINE]) };
  return { lookup: deckLookup(tables, mine), tables, mine };
};

const popout = (source: StatsSource, decks: DeckLookup, player?: string) =>
  createElement(StatsPopout, { source, decks, ...(player === undefined ? {} : { player }) });

describe('the Decks filter', () => {
  it('a format keeps that format; a room keeps its formats; a format wins over a room', () => {
    expect(matchFormats(NO_DECK_FILTER)).toBeUndefined();
    expect(matchFormats({ ...NO_DECK_FILTER, formats: new Set(['modern']) })).toEqual(['modern']);
    expect(matchFormats({ ...NO_DECK_FILTER, rooms: new Set(['draft']) })).toEqual(['draft']);
    expect(matchFormats({ ...NO_DECK_FILTER, rooms: new Set(['constructed']) })).toEqual(['standard', 'modern', 'legacy', 'free']);
    expect(matchFormats({ formats: new Set(['legacy']), rooms: new Set(['constructed']), text: '' })).toEqual(['legacy']);
  });

  it('the name search ignores case and surrounding space', () => {
    expect(filterDeckRows(DECKS, '  AZORIUS ').map((r) => r.value)).toEqual(['Azorius Fliers (Ana)']);
    expect(filterDeckRows(DECKS, '')).toBe(DECKS);
  });

  it('asks the store for the chosen formats and rooms, and searches names without asking', async () => {
    const { source, deckReads } = stub();
    render(popout(source, lookupOf().lookup));
    const section = await screen.findByTestId('gs-breakdown-section-deck');
    await within(section).findByTestId('gs-breakdown-deck');
    expect(deckReads()[0]!.searchParams.has('match.format')).toBe(false);
    expect(deckReads()[0]!.searchParams.get('with')).toBe('colors,deckId');

    fireEvent.click(screen.getByTestId('stats-deck-format-modern'));
    await waitFor(() => expect(deckReads().at(-1)!.searchParams.getAll('match.format')).toEqual(['modern']));
    expect((screen.getByTestId('stats-deck-room-draft') as HTMLButtonElement).disabled, 'no format is played in a draft pod').toBe(true);

    fireEvent.click(screen.getByTestId('stats-deck-format-modern'));
    fireEvent.click(screen.getByTestId('stats-deck-room-draft'));
    await waitFor(() => expect(deckReads().at(-1)!.searchParams.getAll('match.format')).toEqual(['draft']));
    expect((screen.getByTestId('stats-deck-format-standard') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('stats-deck-room-draft'));
    await within(section).findByTestId('gs-breakdown-deck');
    const before = deckReads().length;
    fireEvent.change(screen.getByTestId('stats-deck-text'), { target: { value: 'cube' } });
    const rows = within(screen.getByTestId('gs-breakdown-deck')).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining(`Cube draft ${POD}`)]);
    expect(deckReads(), 'a name search asks nothing').toHaveLength(before);

    fireEvent.change(screen.getByTestId('stats-deck-text'), { target: { value: 'nothing like it' } });
    expect(section.textContent).toContain('No games yet');
    expect(within(section).getByTestId('stats-deck-filter'), 'the bar stays to undo it').toBeTruthy();
  });
});

describe('a deck row', () => {
  const useTimers = () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
  };
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const rowOf = (deckId: string) => document.querySelector<HTMLElement>(`[data-testid="stats-deck"][data-deck-id="${deckId}"]`)!;

  it('draws its pips, and opens a library deck’s list on hover, closing once the pointer leaves', async () => {
    const { source } = stub();
    const { lookup, tables } = lookupOf();
    render(popout(source, lookup));
    await screen.findByTestId('gs-breakdown-deck');
    const row = rowOf(LIBRARY_ID);
    expect(row.querySelector('[data-colors="WU"]')).not.toBeNull();

    useTimers();
    fireEvent.pointerEnter(row, { pointerType: 'mouse' });
    await advance(PEEK_DELAY_MS);
    const peek = screen.getByTestId('deck-peek');
    expect(peek.querySelector('.peek__title')?.textContent).toBe('Azorius Fliers');
    expect(peek.querySelector('.peek__pilot')?.textContent).toBe('Ana');
    expect(peek.textContent).toContain('Main 24');
    expect(peek.textContent).toContain('Sideboard 2');
    expect(row.getAttribute('aria-describedby')).toBe('stats-deck-peek');

    fireEvent.pointerLeave(row);
    await advance(PEEK_GRACE_MS);
    expect(screen.queryByTestId('deck-peek')).toBeNull();
    fireEvent.pointerEnter(row, { pointerType: 'mouse' });
    await advance(PEEK_DELAY_MS);
    expect(screen.getByTestId('deck-peek')).toBeTruthy();
    expect(tables.decks, 'the library is read once').toHaveBeenCalledTimes(1);
  });

  it('opens the viewer’s own drafted deck, and nobody else’s', async () => {
    const { source } = stub();
    const own = lookupOf();
    render(popout(source, own.lookup));
    await screen.findByTestId('gs-breakdown-deck');
    useTimers();
    fireEvent.pointerEnter(rowOf(`draft:${POD}`), { pointerType: 'mouse' });
    await advance(PEEK_DELAY_MS);
    expect(screen.getByTestId('deck-peek').textContent).toContain('Swamp');
    vi.useRealTimers();
    cleanup();

    const theirs = lookupOf();
    render(popout(stub().source, theirs.lookup, 'Ash'));
    await screen.findByTestId('gs-breakdown-deck');
    useTimers();
    fireEvent.pointerEnter(rowOf(`draft:${POD}`), { pointerType: 'mouse' });
    await advance(PEEK_DELAY_MS);
    expect(screen.queryByTestId('deck-peek')).toBeNull();
    expect(theirs.mine.list, 'their drafted deck is not looked for among mine').not.toHaveBeenCalled();
  });
});

describe('deckLookup', () => {
  it('finds a library deck by id and a drafted one by its pod, reading each source once', async () => {
    const { lookup, tables, mine } = lookupOf();
    expect((await lookup(LIBRARY_ID))?.name).toBe('Azorius Fliers');
    expect((await lookup(`draft:${POD}`))?.label).toBe('My cube deck');
    expect(await lookup('power-nothing')).toBeNull();
    expect(await lookup('draft:r-elsewhere')).toBeNull();
    expect(tables.decks).toHaveBeenCalledTimes(1);
    expect(mine.list).toHaveBeenCalledTimes(1);
  });

  it('a drafted deck with no saved build has no list to show', async () => {
    const lookup = deckLookup({ decks: async () => [] }, { list: async () => [{ ...MINE, deck: null }] });
    expect(await lookup(`draft:${POD}`)).toBeNull();
  });
});

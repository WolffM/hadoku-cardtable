// @vitest-environment jsdom
/*
 * The stats popout over the REAL game-stats client (`@wolffm/prefs-client/games`)
 * and a stubbed fetch answering in the store's own read shapes: what
 * cardtable passes the shared screen (pips, deck names, turns, links, the
 * pool), that the lobby prefetches it so it opens drawn, and how it closes.
 * `@wolffm/game-stats-ui` tests the screen itself.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createStatsCache } from '@wolffm/game-stats-ui';

import {
  createGameStatsClient,
  GameStatsError,
  type BreakdownRow,
  type LeaderboardRow,
  type MatchView,
  type ProfileView,
} from '@wolffm/prefs-client/games';

import { LobbyScreen } from '../screens/LobbyScreen.tsx';
import type { RoomFeed } from '../rooms/feed.ts';
import { prefsBaseUrl, signedInStatsClient, type StatsSource } from './StatsPopout.tsx';

afterEach(() => {
  cleanup();
  globalThis.location.hash = '';
});

const totals = (wins: number, losses: number, draws = 0) => ({ games: wins + losses + draws, wins, losses, draws });

const PROFILE: ProfileView = {
  name: 'Bella',
  isMe: true,
  totals: totals(7, 3),
  ratings: [{ mode: 'constructed', rating: 1562.4, games: 10 }],
  counters: {},
  lastPlayedAt: 1_760_000_000_000,
};

const seat = (n: number, name: string, isMe: boolean, outcome: 'win' | 'loss', deck: string, colors: string[]) => ({
  seat: n,
  kind: 'user' as const,
  name,
  isMe,
  placement: outcome === 'win' ? 1 : 2,
  outcome,
  ratingBefore: 1500,
  ratingAfter: 1516,
  attrs: { deck, colors },
  counters: {},
});

const MATCH: MatchView = {
  matchId: 'm-0123456789ab',
  gameId: 'cardtable',
  mode: 'constructed',
  startedAt: 1_760_000_000_000,
  endedAt: 1_760_000_900_000,
  rated: true,
  attrs: { endReason: 'life' },
  counters: { turns: 9 },
  seats: [seat(0, 'Ash', false, 'loss', 'Mono Red', ['R']), seat(1, 'Bella', true, 'win', 'Azorius Fliers', ['W', 'U'])],
};

const COLORS: BreakdownRow[] = [
  { value: 'U', ...totals(4, 1) },
  { value: 'W', ...totals(5, 2) },
];
const DECKS: BreakdownRow[] = [
  { value: 'Azorius Fliers', ...totals(5, 2), attrs: { colors: ['W', 'U'], deckId: 'power-2016-1-azorius' } },
  { value: 'Cube draft r-0123456789ab', ...totals(1, 1), attrs: { colors: ['B'], deckId: 'draft:r-0123456789ab' } },
  { value: 'Mono Red', ...totals(0, 1), attrs: { colors: ['R'] } },
];
const RATINGS: LeaderboardRow[] = [
  { rank: 1, name: 'Bella', isMe: true, value: 1562.4, totals: totals(7, 3) },
  { rank: 2, name: 'Ash', isMe: false, value: 1490, totals: totals(2, 5) },
];

function stub() {
  const asked: URL[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    asked.push(url);
    expect(init?.credentials).toBe('include');
    const path = url.pathname.replace('/prefs/api/v1/_games/cardtable', '');
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (path === '/profile') return json(PROFILE);
    if (path === '/matches') return json({ matches: [MATCH], nextBefore: null });
    if (path === '/leaderboard') return json({ by: 'rating', rows: RATINGS });
    if (path === '/breakdown') {
      const attr = url.searchParams.get('attr');
      return json({ attr, rows: attr === 'colors' ? COLORS : DECKS });
    }
    return json({ message: 'not found' }, 404);
  }) as typeof globalThis.fetch;
  const source: StatsSource = {
    client: createGameStatsClient({ gameId: 'cardtable', baseUrl: 'https://hadoku.me/prefs', fetch }),
    cache: createStatsCache(),
  };
  return { source, asked };
}

const NO_ROOMS = { list: async () => ({ rooms: [], featured: null }) } as never;
/** The room list reads once and is never told anything changed: no socket here. */
const QUIET: RoomFeed = {
  follow: (_target, refresh) => {
    refresh();
    return () => undefined;
  },
};

/** The lobby, with the popout open for `player` when `open`. */
const lobby = (source: StatsSource, open?: { player?: string }) =>
  createElement(LobbyScreen, { rooms: NO_ROOMS, feed: QUIET, statsSource: source, stats: open });

describe('the stats popout', () => {
  it('draws colours as pips, decks on each seat, turns, and names as links to their page, all in the constructed pool', async () => {
    const { source, asked } = stub();
    render(lobby(source, {}));
    const popout = screen.getByTestId('stats');
    expect(within(popout).getByRole('heading', { level: 1 }).textContent).toBe('Stats');

    const history = await screen.findByTestId('gs-matches');
    const row = within(history).getAllByRole('row')[1]!;
    expect(row.textContent).toContain('Azorius Fliers');
    expect(row.textContent).toContain('9');
    expect(row.querySelector('[data-attr="colors"] [data-colors="WU"]')).not.toBeNull();
    expect(within(row).getByRole('link', { name: 'Ash' }).getAttribute('href')).toBe('#/stats/Ash');

    const colors = await screen.findByTestId('gs-breakdown-colors');
    const colorRows = within(colors).getAllByRole('row').slice(1);
    expect(colorRows.map((r) => r.querySelector('[data-colors]')?.getAttribute('data-colors'))).toEqual(['W', 'U']);

    const decks = await screen.findByTestId('gs-breakdown-deck');
    const deckRow = within(decks).getAllByRole('row')[1]!;
    expect(deckRow.textContent).toContain('Azorius Fliers');
    expect(deckRow.querySelector('[data-testid="stats-deck"] [data-colors="WU"]'), 'a deck row keeps its pips').not.toBeNull();
    expect(screen.queryByTestId('gs-breakdown-deck-everyone'), 'one Decks section').toBeNull();

    const board = await screen.findByTestId('gs-leaderboard-rating');
    expect(within(board).getByRole('link', { name: 'Ash' }).getAttribute('href')).toBe('#/stats/Ash');

    await waitFor(() => expect(asked).toHaveLength(5));
    for (const url of asked) expect(url.searchParams.get('mode')).toBe('constructed');
  });

  it('reads rated matches only, so no bot, guest or test-account match reaches the page', async () => {
    const { source, asked } = stub();
    render(lobby(source, {}));
    await waitFor(() => expect(asked).toHaveLength(5));
    const reads = asked.filter((u) => !u.pathname.endsWith('/leaderboard'));
    expect(reads.map((u) => u.pathname.split('/').pop()).sort()).toEqual(['breakdown', 'breakdown', 'matches', 'profile']);
    for (const url of reads) expect(url.searchParams.get('rated'), url.pathname).toBe('1');
  });

  it("is headed by the named player's name, with a way back to the viewer's own", () => {
    const { source } = stub();
    render(lobby(source, { player: 'Ash' }));
    const popout = screen.getByTestId('stats');
    expect(within(popout).getByRole('heading', { level: 1 }).textContent).toBe('Ash');
    expect(screen.getByTestId('stats-mine').getAttribute('href')).toBe('#/stats');
  });

  it('the lobby has already read everything it shows: it opens with nothing busy and nothing more asked', async () => {
    const { source, asked } = stub();
    const { rerender } = render(lobby(source));
    expect(screen.queryByTestId('stats')).toBeNull();
    await waitFor(() => expect(asked).toHaveLength(5));
    await act(async () => {
      await Promise.resolve();
    });

    rerender(lobby(source, {}));
    expect(document.querySelectorAll('.gs-section[aria-busy="true"]'), 'drawn on its first render').toHaveLength(0);
    expect(screen.getByTestId('gs-record').textContent).toContain('1562');
    expect(asked).toHaveLength(5);
  });

  it('Escape, the close button and a press on the backdrop each go back to the lobby', () => {
    const { source } = stub();
    render(lobby(source, {}));
    expect(screen.getByTestId('stats-close').getAttribute('href')).toBe('#/');

    globalThis.location.hash = '#/stats';
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(globalThis.location.hash).toBe('#/');

    globalThis.location.hash = '#/stats';
    fireEvent.pointerDown(screen.getByTestId('stats'));
    expect(globalThis.location.hash, 'a press inside the panel keeps it open').toBe('#/stats');
    fireEvent.pointerDown(document.querySelector('.ct-stats-popout__backdrop')!);
    expect(globalThis.location.hash).toBe('#/');
  });
});

describe('the way in', () => {
  it('the trophy beside the gear opens the stats', () => {
    const { source } = stub();
    render(lobby(source));
    const button = screen.getByTestId('lobby-stats');
    expect(button.getAttribute('href')).toBe('#/stats');
    expect(button.getAttribute('aria-label')).toBe('Stats');
  });
});

describe('a viewer the store will refuse', () => {
  /** The store's reads behind the page's guard, every one answered `status`. */
  function refusing(status: number, signedIn: boolean) {
    const asked: URL[] = [];
    const fetch = (async (input: RequestInfo | URL) => {
      asked.push(new URL(String(input)));
      return new Response(JSON.stringify({ message: 'no' }), { status, headers: { 'Content-Type': 'application/json' } });
    }) as typeof globalThis.fetch;
    const source: StatsSource = {
      client: signedInStatsClient(createGameStatsClient({ gameId: 'cardtable', baseUrl: 'https://hadoku.me/prefs', fetch }), async () => signedIn),
      cache: createStatsCache(),
    };
    return { source, asked };
  }

  it('signed out: nothing is asked of the store — not on the lobby, not on hover, not when opened — and the popout says to sign in', async () => {
    const { source, asked } = refusing(401, false);
    const { rerender } = render(lobby(source));
    fireEvent.pointerEnter(screen.getByTestId('lobby-stats'));
    rerender(lobby(source, {}));
    await waitFor(() => expect(screen.getByTestId('stats').textContent).toContain('Sign in to see stats.'));
    fireEvent.pointerEnter(screen.getByTestId('lobby-stats'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(asked.map((u) => u.pathname)).toEqual([]);
  });

  it('a 401 is final: each read is asked once, and neither hovering nor opening asks again', async () => {
    const { source, asked } = refusing(401, true);
    const { rerender } = render(lobby(source));
    await waitFor(() => expect(asked).toHaveLength(5));
    expect(new Set(asked.map((u) => `${u.pathname}${u.search}`)).size, 'five different reads, each once').toBe(5);

    fireEvent.pointerEnter(screen.getByTestId('lobby-stats'));
    rerender(lobby(source, {}));
    await waitFor(() => expect(screen.getByTestId('stats').textContent).toContain('Sign in to see stats.'));
    fireEvent.pointerEnter(screen.getByTestId('lobby-stats'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(asked, 'nothing asked after the refusal').toHaveLength(5);
  });

  it('a refusal of another kind is not final: the next read asks again', async () => {
    const { source, asked } = refusing(503, true);
    await expect(source.client.profile()).rejects.toBeInstanceOf(GameStatsError);
    await expect(source.client.profile()).rejects.toBeInstanceOf(GameStatsError);
    expect(asked).toHaveLength(2);
  });
});

describe('where the reads go', () => {
  it("follows the page's prefs mount when one is set, and otherwise leaves the SDK's default", () => {
    const g = globalThis as { __HADOKU_PREFS_API_BASE__?: unknown };
    expect(prefsBaseUrl()).toBeUndefined();
    g.__HADOKU_PREFS_API_BASE__ = 'http://127.0.0.1:19001/prefs';
    try {
      expect(prefsBaseUrl()).toBe('http://127.0.0.1:19001/prefs');
    } finally {
      delete g.__HADOKU_PREFS_API_BASE__;
    }
  });
});

// @vitest-environment jsdom
/*
 * The stats page over the REAL game-stats client (`@wolffm/prefs-client/games`)
 * and a stubbed fetch answering in the store's own read shapes: what cardtable
 * hands `@wolffm/game-stats-ui`'s blocks (pips, decks, a match's format and turns,
 * links, the pool, rated only) and draws itself (winning decks, colours, the
 * Decks table), that the lobby prefetches the Leaderboard so it opens drawn,
 * which reads each tab makes, and how the page treats a viewer the store refuses.
 * The package tests its blocks themselves.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
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
import type { RoomFeed } from '@hadoku/magic-ui/rooms/follow.ts';
import { StatsPage, type StatsPageProps } from '@hadoku/magic-ui/stats/StatsPage.tsx';
import { StatsPage as LazyStatsPage } from '@hadoku/magic-ui/stats/StatsButton.tsx';
import { prefsBaseUrl, signedInStatsClient, type StatsSource } from '@hadoku/magic-ui/stats/source.ts';
import { matchAttr } from '@hadoku/magic-ui/stats/magic.tsx';
import { winningDecks } from '@hadoku/magic-ui/stats/StatsDecks.tsx';

afterEach(() => {
  cleanup();
  globalThis.location.hash = '';
});

const totals = (wins: number, losses: number, draws = 0) => ({ games: wins + losses + draws, wins, losses, draws });

const profileOf = (name: string, isMe: boolean): ProfileView => ({
  name,
  isMe,
  totals: totals(7, 3),
  ratings: [{ mode: 'constructed', rating: 1562.4, games: 10 }],
  counters: {},
  lastPlayedAt: 1_760_000_000_000,
});

const seat = (n: number, name: string, isMe: boolean, outcome: 'win' | 'loss', deck: string, colors: string[], ratingAfter: number) => ({
  seat: n,
  kind: 'user' as const,
  name,
  isMe,
  placement: outcome === 'win' ? 1 : 2,
  outcome,
  ratingBefore: 1500,
  ratingAfter,
  attrs: { deck, colors },
  counters: {},
});

const match = (id: string, endedAt: number, bellaWins: boolean): MatchView => ({
  matchId: id,
  gameId: 'cardtable',
  mode: 'constructed',
  startedAt: endedAt - 900_000,
  endedAt,
  rated: true,
  attrs: { endReason: 'life', format: 'modern', pool: '2016-07-22' },
  counters: { turns: 9 },
  seats: [
    seat(0, 'Ash', false, bellaWins ? 'loss' : 'win', 'Mono Red', ['R'], 1490),
    seat(1, 'Bella', true, bellaWins ? 'win' : 'loss', 'Azorius Fliers', ['W', 'U'], bellaWins ? 1516 : 1484),
  ],
});

const MATCHES: MatchView[] = [match('m-0123456789ab', 1_760_000_900_000, true), match('m-0123456789ac', 1_759_000_900_000, false)];
const OLDER: MatchView[] = [match('m-0123456789ad', 1_758_000_900_000, true)];

const COLORS: BreakdownRow[] = [
  { value: 'U', ...totals(4, 1) },
  { value: 'W', ...totals(5, 2) },
];
const DECKS: BreakdownRow[] = [
  { value: 'Azorius Fliers', ...totals(5, 2), attrs: { colors: ['W', 'U'], deckId: 'power-2016-1-azorius' }, lastPlayedAt: Date.now() - 2.5 * 3_600_000 },
  { value: 'Cube draft r-0123456789ab', ...totals(1, 1), attrs: { colors: ['B'], deckId: 'draft:r-0123456789ab' } },
  { value: 'Mono Red', ...totals(0, 6), attrs: { colors: ['R'] } },
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
    const player = url.searchParams.get('player');
    if (path === '/profile') return json(profileOf(player ?? 'Bella', player === null));
    if (path === '/matches') {
      const older = url.searchParams.has('before');
      return json({ matches: older ? OLDER : MATCHES, nextBefore: older ? null : MATCHES.at(-1)!.endedAt });
    }
    if (path === '/leaderboard') return json({ by: url.searchParams.get('by'), rows: RATINGS });
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

const lobby = (source: StatsSource) => createElement(LobbyScreen, { rooms: NO_ROOMS, feed: QUIET, statsSource: source });
const page = (source: StatsSource, props: Omit<StatsPageProps, 'source'> = {}) => createElement(StatsPage, { source, parked: async () => [], ...props });

/** Each read as `endpoint player attr-or-board limit`, sorted: what a tab asked for. */
const readsOf = (asked: readonly URL[]): string[] =>
  asked
    .map((u) =>
      [u.pathname.split('/').pop(), u.searchParams.get('player'), u.searchParams.get('attr') ?? u.searchParams.get('by'), u.searchParams.get('limit'), u.searchParams.has('before') ? 'older' : null]
        .filter((p) => p !== null)
        .join(' '),
    )
    .sort();

/** What `#/stats` reads: the rating board, everyone's rating moves, everyone's first page, the winning decks and the colours. */
const LEADERBOARD_READS = ['breakdown * colors', 'breakdown * deck', 'leaderboard rating 100', 'matches * 10', 'matches * 50'];

// The page is a chunk of its own, which the lobby's trophy loads before it is opened (`./StatsButton.tsx`).
beforeAll(() => LazyStatsPage.preload());

/**
 * How long a wait on the lobby's prefetch, or on a page saying a refused viewer must sign in, may
 * take: the prefetch waits for an idle page and a chunk, and the page draws every section first —
 * past waitFor's 1 s default on a host at load 50.
 */
const LOADED_HOST_MS = 5_000;

describe('the Leaderboard', () => {
  it('ranks everyone, lists the winning decks and every colour, and everyone’s matches with pips, decks, format, turns and links', async () => {
    const { source, asked } = stub();
    render(page(source));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Stats');
    expect(screen.getByTestId('stats-tab-leaderboard').getAttribute('aria-current')).toBe('page');

    const board = await within(screen.getByTestId('stats-rankings')).findByTestId('gs-rankings');
    expect(within(board).getByRole('link', { name: 'Ash' }).getAttribute('href')).toBe('#/stats/Ash');

    const winners = await screen.findAllByTestId('stats-winning-deck');
    expect(winners.map((w) => w.querySelector('.ct-stats-deck__name')?.textContent), 'five games or more, best first').toEqual(['Azorius Fliers', 'Mono Red']);
    expect(winners[0]!.querySelector('[data-colors="WU"]'), 'a deck keeps its pips').not.toBeNull();
    expect(winners[0]!.textContent).toContain('71%');

    const colours = within(await screen.findByTestId('stats-colours')).getAllByTestId('stats-colour');
    expect(colours.map((c) => c.getAttribute('data-colour')), 'the pie, in its order').toEqual(['W', 'U', 'B', 'R', 'G']);
    expect(colours[0]!.textContent).toContain('71%');
    expect(colours[0]!.textContent).toContain('7 games');
    expect(colours[2]!.textContent).toContain('—');

    const feed = await within(screen.getByTestId('stats-history')).findByTestId('gs-feed');
    const row = feed.querySelector<HTMLElement>(`[data-match="${MATCHES[0]!.matchId}"]`)!;
    expect(row.textContent).toContain('Azorius Fliers');
    expect(row.querySelector('[data-attr="colors"] [data-colors="WU"]')).not.toBeNull();
    expect(within(row).getByRole('link', { name: 'Ash' }).getAttribute('href')).toBe('#/stats/Ash');
    expect([...row.querySelectorAll('[data-meta]')].map((m) => m.textContent)).toEqual(['Modern', '2016', '9 turns', 'Life']);

    await waitFor(() => expect(readsOf(asked)).toEqual(LEADERBOARD_READS));
    for (const url of asked) expect(url.searchParams.get('mode')).toBe('constructed');
  });

  it('reads rated matches only, so no bot, guest or test-account match reaches the page', async () => {
    const { source, asked } = stub();
    render(page(source));
    await waitFor(() => expect(asked).toHaveLength(LEADERBOARD_READS.length));
    const reads = asked.filter((u) => !u.pathname.endsWith('/leaderboard'));
    expect(reads).toHaveLength(4);
    for (const url of reads) expect(url.searchParams.get('rated'), url.pathname).toBe('1');
  });

  it('ranks by what its chips say, and its history shows a room’s matches, then older ones', async () => {
    const { source, asked } = stub();
    render(page(source));
    const rankings = screen.getByTestId('stats-rankings');
    await within(rankings).findByTestId('gs-rankings');
    fireEvent.click(rankings.querySelector('[data-value="winrate"]')!);
    await waitFor(() => expect(asked.some((u) => u.pathname.endsWith('/leaderboard') && u.searchParams.get('by') === 'winrate')).toBe(true));
    expect(rankings.querySelector('[data-value="winrate"]')!.getAttribute('aria-pressed')).toBe('true');

    const history = screen.getByTestId('stats-history');
    fireEvent.click(history.querySelector('[data-value="draft"]')!);
    await waitFor(() => expect(asked.at(-1)!.searchParams.getAll('match.format')).toEqual(['draft']));
    await within(history).findByTestId('gs-feed');

    fireEvent.click(within(history).getByTestId('gs-feed-older'));
    await waitFor(() => expect(within(history).getByTestId('gs-feed').querySelectorAll('[data-match]')).toHaveLength(3));
    const older = asked.at(-1)!;
    expect(older.searchParams.get('before')).toBe(String(MATCHES.at(-1)!.endedAt));
    expect(older.searchParams.getAll('match.format'), 'an older page keeps the room').toEqual(['draft']);
    expect(older.searchParams.get('rated')).toBe('1');
    expect(within(history).queryByTestId('gs-feed-older'), 'the last page offers no more').toBeNull();
  });

  it('finds a player by name, offering the ranked ones', async () => {
    const { source } = stub();
    render(page(source));
    const find = screen.getByTestId('stats-find');
    await waitFor(() => expect([...document.querySelectorAll(`#${CSS.escape(find.getAttribute('list')!)} option`)].map((o) => o.getAttribute('value'))).toEqual(['Bella', 'Ash']));
    fireEvent.change(find, { target: { value: ' Ash ' } });
    fireEvent.submit(find.closest('form')!);
    expect(globalThis.location.hash).toBe('#/stats/Ash');
  });

  it('leads home to the lobby', () => {
    const { source } = stub();
    render(page(source));
    expect(screen.getByTestId('back-to-lobby').getAttribute('href')).toBe('#/');
  });
});

describe('a profile', () => {
  it('yours: its header, rating, recent matches, head to head, decks and colours, every read rated', async () => {
    const { source, asked } = stub();
    render(page(source, { tab: 'profile' }));
    expect(screen.getByTestId('stats-tab-profile').getAttribute('aria-current')).toBe('page');
    // The header is drawn anew once its reads land, so it is found after they have.
    await waitFor(() => expect(screen.getByTestId('stats-profile').querySelector('h2')?.textContent).toBe('Bella'));
    const header = screen.getByTestId('stats-profile');
    expect(header.textContent, 'first of the two on the rating board').toContain('#1 of 2');
    expect(header.textContent).toContain('1562');

    expect(await within(screen.getByTestId('stats-rating')).findByTestId('gs-rating-chart')).toBeTruthy();
    const recent = await within(screen.getByTestId('stats-recent')).findByTestId('gs-feed');
    expect(recent.querySelectorAll('[data-match]')).toHaveLength(2);
    const rivals = await within(screen.getByTestId('stats-head-to-head')).findByTestId('gs-h2h');
    expect(rivals.querySelector('[data-opponent="Ash"]')?.textContent, 'every match the history holds').toContain('2–1');

    const decks = within(await screen.findByTestId('stats-decks-table')).getAllByRole('row').slice(1);
    expect(decks.map((r) => r.querySelector('.ct-stats-deck__name')?.textContent), 'most played first').toEqual(['Azorius Fliers', 'Mono Red', 'Cube draft r-0123456789ab']);
    expect(decks[0]!.textContent).toContain('5–2');
    expect(decks.map((r) => r.querySelector('.ct-stats__last')?.textContent), 'last played, and nothing for a row the store gave no date').toEqual(['2 h ago', '', '']);
    const colour = within(screen.getByTestId('stats-colours')).getAllByTestId('stats-colour')[0]!;
    expect([colour.querySelector('.ct-colours__record')?.textContent, colour.querySelector('.ct-colours__games')?.textContent]).toEqual(['5–2', '7 games']);
    expect(colour.querySelector('.gs-bar__fill')?.getAttribute('style')).toContain('width: 71%');

    await waitFor(() =>
      expect(readsOf(asked)).toEqual(['breakdown colors', 'breakdown deck', 'leaderboard rating 100', 'matches 10', 'matches 50', 'matches 50 older', 'profile']),
    );
    for (const url of asked.filter((u) => !u.pathname.endsWith('/leaderboard'))) expect(url.searchParams.get('rated'), url.pathname).toBe('1');
  });

  it('lists your unfinished games, and nobody else’s', async () => {
    const { source } = stub();
    const parked = async () => [
      {
        matchId: 'm-parked',
        room: 'Friday',
        format: 'Free pick',
        turn: 4,
        parkedAt: '2026-11-02T21:00:00.000Z',
        seats: [{ name: 'Ash', deck: null, ai: false, you: false }],
        resumed: null,
      },
    ];
    render(page(source, { tab: 'profile', parked }));
    expect((await screen.findByTestId('unfinished-game')).textContent).toContain('vs Ash');
    cleanup();
    render(page(stub().source, { player: 'Ash', parked }));
    await waitFor(() => expect(screen.getByTestId('stats-profile').querySelector('h2')?.textContent).toBe('Ash'));
    expect(screen.queryByTestId('unfinished'), 'another player’s page lists none').toBeNull();
  });

  it('another player’s: headed by their name and read by it, under no tab', async () => {
    const { source, asked } = stub();
    render(page(source, { player: 'Ash' }));
    // The header is drawn anew once its reads land, so it is found after they have.
    await waitFor(() => expect(screen.getByTestId('stats-profile').querySelector('h2')?.textContent).toBe('Ash'));
    const header = screen.getByTestId('stats-profile');
    expect(header.textContent).toContain('#2 of 2');
    for (const tab of ['leaderboard', 'profile', 'tournaments']) expect(screen.getByTestId(`stats-tab-${tab}`).getAttribute('aria-current')).toBeNull();
    await waitFor(() => expect(readsOf(asked.filter((u) => !u.pathname.endsWith('/leaderboard')))).toHaveLength(6));
    for (const url of asked.filter((u) => !u.pathname.endsWith('/leaderboard'))) expect(url.searchParams.get('player'), url.pathname).toBe('Ash');
    expect(asked.filter((u) => u.pathname.endsWith('/profile')), 'the header and the own-name check are one read').toHaveLength(1);
    expect(globalThis.location.hash).toBe('');
  });

  it('your own name, followed from a board, is Your profile', async () => {
    const { source } = stub();
    const viewerByName: StatsSource = {
      ...source,
      client: { ...source.client, profile: async (s) => ({ ...(await source.client.profile(s)), isMe: true }) },
    };
    globalThis.location.hash = '#/stats/Bella';
    render(page(viewerByName, { player: 'Bella' }));
    await waitFor(() => expect(globalThis.location.hash).toBe('#/profile'));
  });

  it('the Your profile tab warms the profile’s reads on hover', async () => {
    const { source, asked } = stub();
    render(page(source));
    await waitFor(() => expect(asked).toHaveLength(LEADERBOARD_READS.length));
    fireEvent.pointerEnter(screen.getByTestId('stats-tab-profile'));
    await waitFor(() =>
      expect(readsOf(asked.slice(LEADERBOARD_READS.length))).toEqual(['breakdown colors', 'breakdown deck', 'matches 10', 'matches 50', 'matches 50 older', 'profile']),
    );
  });
});

describe('the way in', () => {
  it('the trophy beside the gear opens the Leaderboard', () => {
    const { source } = stub();
    render(lobby(source));
    const button = screen.getByTestId('lobby-stats');
    expect(button.getAttribute('href')).toBe('#/stats');
    expect(button.getAttribute('aria-label')).toBe('Stats');
  });

  it('the lobby has already read everything the Leaderboard shows: it opens with nothing busy and nothing more asked', async () => {
    const { source, asked } = stub();
    render(lobby(source));
    await waitFor(() => expect(readsOf(asked)).toEqual(LEADERBOARD_READS), { timeout: LOADED_HOST_MS });
    await act(async () => {
      await Promise.resolve();
    });
    cleanup();

    render(page(source));
    expect(document.querySelectorAll('[aria-busy="true"]'), 'drawn on its first render').toHaveLength(0);
    expect(screen.getByTestId('gs-rankings').textContent).toContain('1562');
    expect(asked).toHaveLength(LEADERBOARD_READS.length);
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

  it('signed out: nothing is asked of the store — not on the lobby, not on hover, not when opened — and the page says to sign in', async () => {
    const { source, asked } = refusing(401, false);
    render(lobby(source));
    fireEvent.pointerEnter(screen.getByTestId('lobby-stats'));
    cleanup();
    render(page(source));
    await waitFor(() => expect(screen.getByTestId('stats-rankings').textContent).toContain('Sign in to see stats.'), { timeout: LOADED_HOST_MS });
    fireEvent.pointerEnter(screen.getByTestId('stats-tab-profile'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(asked.map((u) => u.pathname)).toEqual([]);
  });

  it('a 401 is final: each read is asked once, and neither hovering nor opening asks again', async () => {
    const { source, asked } = refusing(401, true);
    render(lobby(source));
    await waitFor(() => expect(asked).toHaveLength(LEADERBOARD_READS.length), { timeout: LOADED_HOST_MS });
    expect(new Set(asked.map((u) => `${u.pathname}${u.search}`)).size, 'different reads, each once').toBe(LEADERBOARD_READS.length);

    fireEvent.pointerEnter(screen.getByTestId('lobby-stats'));
    cleanup();
    render(page(source, { tab: 'profile' }));
    await waitFor(() => expect(screen.getByTestId('stats-profile').textContent).toContain('Sign in to see stats.'), { timeout: LOADED_HOST_MS });
    await act(async () => {
      await Promise.resolve();
    });
    expect(asked, 'nothing asked after the refusal').toHaveLength(LEADERBOARD_READS.length);
  });

  it('a refusal of another kind is not final: the next read asks again', async () => {
    const { source, asked } = refusing(503, true);
    await expect(source.client.profile()).rejects.toBeInstanceOf(GameStatsError);
    await expect(source.client.profile()).rejects.toBeInstanceOf(GameStatsError);
    expect(asked).toHaveLength(2);
  });
});

describe('a match’s facts', () => {
  it('name its format as a room does, its era, and how it ended', () => {
    expect(matchAttr('format', 'modern')).toBe('Modern');
    expect(matchAttr('format', 'free')).toBe('Free pick');
    expect(matchAttr('format', 'draft')).toBe('Draft pod');
    expect(matchAttr('format', 'unknown')).toBeNull();
    expect(matchAttr('pool', '2016-07-22')).toBe('2016');
    expect(matchAttr('pool', 'draft:r-1'), 'a pod’s pool has no era').toBeNull();
    expect(matchAttr('endReason', 'concede')).toBe('Concede');
    expect(matchAttr('endReason', 'other')).toBeNull();
  });

  it('a winning deck has five games or more behind it', () => {
    expect(winningDecks(DECKS).map((r) => r.value)).toEqual(['Azorius Fliers', 'Mono Red']);
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

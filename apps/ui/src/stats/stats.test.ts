// @vitest-environment jsdom
/*
 * The stats screen over the REAL game-stats client (`@wolffm/prefs-client/games`)
 * and a stubbed fetch answering in the store's own read shapes: what
 * cardtable passes the shared screen: pips, deck names, turns, links, the pool.
 * `@wolffm/game-stats-ui` tests the screen itself.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';

import { createGameStatsClient, type BreakdownRow, type LeaderboardRow, type MatchView, type ProfileView } from '@wolffm/prefs-client/games';

import { LobbyScreen } from '../screens/LobbyScreen.tsx';
import { StatsScreen } from './StatsScreen.tsx';

afterEach(() => {
  cleanup();
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
const DECKS: BreakdownRow[] = [{ value: 'Azorius Fliers', ...totals(5, 2) }];
const WINNERS: BreakdownRow[] = [
  { value: 'Mono Red', ...totals(3, 6) },
  { value: 'Azorius Fliers', ...totals(9, 4) },
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
      const everyone = url.searchParams.get('player') === '*';
      return json({ attr, rows: attr === 'colors' ? COLORS : everyone ? WINNERS : DECKS });
    }
    return json({ message: 'not found' }, 404);
  }) as typeof globalThis.fetch;
  return { client: createGameStatsClient({ gameId: 'cardtable', baseUrl: 'https://hadoku.me/prefs', fetch }), asked };
}

describe('the stats screen', () => {
  it('draws colours as pips, decks on each seat, turns, and names as links to their page, all in the constructed pool', async () => {
    const { client, asked } = stub();
    render(createElement(StatsScreen, { client }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Stats');

    const history = await screen.findByTestId('gs-matches');
    const row = within(history).getAllByRole('row')[1]!;
    expect(row.textContent).toContain('Azorius Fliers');
    expect(row.textContent).toContain('9');
    expect(row.querySelector('[data-attr="colors"] [data-colors="WU"]')).not.toBeNull();
    expect(within(row).getByRole('link', { name: 'Ash' }).getAttribute('href')).toBe('#/stats/Ash');

    const colors = await screen.findByTestId('gs-breakdown-colors');
    const colorRows = within(colors).getAllByRole('row').slice(1);
    expect(colorRows.map((r) => r.querySelector('[data-colors]')?.getAttribute('data-colors'))).toEqual(['W', 'U']);

    const winners = await screen.findByTestId('gs-breakdown-deck-everyone');
    expect(within(winners).getAllByRole('row')[1]!.textContent).toContain('Azorius Fliers');

    const board = await screen.findByTestId('gs-leaderboard-rating');
    expect(within(board).getByRole('link', { name: 'Ash' }).getAttribute('href')).toBe('#/stats/Ash');

    await waitFor(() => expect(asked).toHaveLength(6));
    for (const url of asked) expect(url.searchParams.get('mode')).toBe('constructed');
  });

  it("is headed by the named player's name", () => {
    const { client } = stub();
    render(createElement(StatsScreen, { client, player: 'Ash' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Ash');
  });
});

describe('the way in', () => {
  it('the lobby links to the stats', () => {
    render(createElement(LobbyScreen, { rooms: { list: async () => [] } as never }));
    expect(screen.getByTestId('lobby-stats').getAttribute('href')).toBe('#/stats');
  });
});

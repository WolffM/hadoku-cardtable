// @vitest-environment jsdom
// A table between games says what step it is at and who it waits on (with how long they have been
// away), lists the games played, and in a tournament how far the round has got. The operator's room
// of 2026-11-19: rhomancer 1–0 up on a bot, sideboarding, gone two hours.
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { POD_SEATS, type PodView, type RoomTable } from '@hadoku/shared';

import { awayLabel, TableStatus, tableStatus, type TableStatusInput } from './TableStatus.tsx';

afterEach(cleanup);

const NOW = Date.UTC(2026, 10, 19, 3);
const HOUR = 60 * 60_000;
const names: Record<string, string> = { rho: 'rhomancer', 'ai:4': 'Cleric', bo: 'Bo' };

function pod(over: Partial<PodView> = {}): PodView {
  return {
    phase: 'rounds',
    seats: Array.from({ length: POD_SEATS }, () => null),
    round: 1,
    rounds: 3,
    // Three bot matches of round 1 are done; the human's table is not.
    results: [
      { round: 1, playerA: 'ai:3', playerB: 'ai:7', gamesA: 0, gamesB: 2 },
      { round: 1, playerA: 'ai:1', playerB: 'ai:5', gamesA: 2, gamesB: 0 },
      { round: 1, playerA: 'ai:2', playerB: 'ai:6', gamesA: 2, gamesB: 1 },
    ],
    standings: [],
    pairings: [{ tableId: 't-1', players: ['rho', 'ai:4'] }],
    bye: null,
    drafters: [],
    built: [],
    personas: {},
    plan: null,
    roundNames: null,
    verdict: null,
    ...over,
  } as PodView;
}

function table(over: Partial<RoomTable['series']> = {}, matchId: string | null = null): RoomTable {
  return {
    id: 't-1',
    players: [{ memberId: 'rho', name: 'rhomancer' }],
    matchId,
    series: { length: 3, wins: [1, 0], games: [{ matchId: 'm-1', winner: 0 }], phase: 'sideboarding', ...over },
  };
}

const input = (over: Partial<TableStatusInput> = {}): TableStatusInput => ({
  table: table(),
  seats: ['rho', 'ai:4'],
  pod: pod(),
  myMemberId: 'watcher',
  away: { rho: new Date(NOW - 2 * HOUR).toISOString() },
  nameOf: (id) => names[id] ?? id,
  now: NOW,
  ...over,
});

describe('tableStatus', () => {
  it('a series between games: its step, who it waits on and how long they have been gone, the games so far, the round', () => {
    expect(tableStatus(input())).toEqual({
      step: 'Sideboarding before game 2',
      waiting: [{ id: 'rho', name: 'rhomancer', away: 'away 2h' }],
      games: [{ label: 'Game 1', result: 'rhomancer won' }],
      round: 'Round 1 · 3 of 4 matches done',
    });
  });

  it('never waits on the AI, on me, or on a seat already Ready; someone here has no away', () => {
    expect(tableStatus(input({ myMemberId: 'rho' })).waiting).toEqual([]);
    const two = table({ phase: 'seating', games: [], wins: [0, 0] });
    two.players.push({ memberId: 'bo', name: 'Bo' });
    expect(tableStatus(input({ table: two, seats: ['rho', 'bo'], away: {} })).waiting).toEqual([
      { id: 'rho', name: 'rhomancer' },
      { id: 'bo', name: 'Bo' },
    ]);
    expect(tableStatus(input({ table: two, seats: ['rho', 'bo'], away: {}, ready: [true, false] })).waiting.map((w) => w.id)).toEqual(['bo']);
    expect(tableStatus(input({ table: two, seats: ['rho', 'bo'] })).step).toBe('Before game 1');
  });

  it('says nothing of a step while a game is on, and counts a finished round as all done', () => {
    const live = tableStatus(input({ table: table({ phase: 'playing' }, 'm-2') }));
    expect(live.step).toBeNull();
    expect(live.waiting).toEqual([]);
    const settled = pod({ results: [...pod().results, { round: 1, playerA: 'rho', playerB: 'ai:4', gamesA: 2, gamesB: 0 }] });
    expect(tableStatus(input({ pod: settled })).round).toBe('Round 1 · 4 of 4 matches done');
    expect(tableStatus(input({ pod: null })).round).toBeNull();
  });

  it('names a draw', () => {
    expect(tableStatus(input({ table: table({ games: [{ matchId: 'm-1', winner: null }] }) })).games).toEqual([{ label: 'Game 1', result: 'Draw' }]);
  });
});

describe('awayLabel', () => {
  it('minutes, then hours, then days; bare when the server has not seen them since it started', () => {
    expect(awayLabel(new Date(NOW - 30_000).toISOString(), NOW)).toBe('away 1m');
    expect(awayLabel(new Date(NOW - 59 * 60_000).toISOString(), NOW)).toBe('away 59m');
    expect(awayLabel(new Date(NOW - 5 * HOUR).toISOString(), NOW)).toBe('away 5h');
    expect(awayLabel(new Date(NOW - 50 * HOUR).toISOString(), NOW)).toBe('away 2d');
    expect(awayLabel(null, NOW)).toBe('away');
  });
});

describe('TableStatus', () => {
  it('draws the step, the waited-on with their away tag, the games and the round', () => {
    render(createElement(TableStatus, input()));
    expect(screen.getByTestId('table-status-step').textContent).toBe('Sideboarding before game 2·waiting onrhomanceraway 2h');
    expect(screen.getByTestId('table-status-away').textContent).toBe('away 2h');
    expect(screen.getByTestId('table-status-games').textContent).toBe('Game 1 rhomancer won');
    expect(screen.getByTestId('table-status-round').textContent).toBe('Round 1 · 3 of 4 matches done');
  });

  it('draws nothing for a plain room’s table that has not played', () => {
    render(createElement(TableStatus, input({ pod: null, table: table({ phase: 'playing', games: [], wins: [0, 0] }, 'm-1') })));
    expect(screen.queryByTestId('table-status')).toBeNull();
  });
});

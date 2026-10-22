// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import type { Tournament } from '@hadoku/shared';

import { fetchTournaments, Tournaments } from './Tournaments.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const cubeNight: Tournament = {
  id: 'r-1-1',
  name: 'Cube night',
  startedAt: Date.UTC(2026, 9, 18),
  endedAt: Date.UTC(2026, 9, 19),
  closed: true,
  rounds: 1,
  names: { 'u-alice': 'Alice', ai: 'AI' },
  standings: [
    { id: 'u-alice', matchPoints: 3, opponentMatchWinPct: 0.33, gameWinPct: 1, opponentGameWinPct: 0, rank: 1 },
    { id: 'ai', matchPoints: 0, opponentMatchWinPct: 1, gameWinPct: 0, opponentGameWinPct: 1, rank: 2 },
  ],
  results: [{ round: 1, playerA: 'u-alice', playerB: 'ai', gamesA: 2, gamesB: 0 }],
};

describe('the Tournaments tab', () => {
  it('draws nothing but its outline until the list arrives, then each pod with its standings by name', async () => {
    let answer: (t: Tournament[]) => void = () => {};
    const load = () => new Promise<Tournament[]>((r) => (answer = r));
    render(createElement(Tournaments, { load }));
    expect(screen.getByTestId('tournaments-pending')).toBeTruthy();
    expect(screen.queryByTestId('tournament')).toBeNull();

    answer([cubeNight]);
    await waitFor(() => expect(screen.getAllByTestId('tournament')).toHaveLength(1));
    expect(screen.getByTestId('tournament').textContent).toContain('Cube night');
    expect(screen.getByTestId('tournament').textContent).toContain('Closed early');
    expect(screen.getByTestId('pod-standings-row-1').textContent).toContain('Alice');
    expect(screen.getByTestId('pod-standings-row-2').textContent).toContain('AI');
  });

  it('says when there are none', async () => {
    render(createElement(Tournaments, { load: async () => [] }));
    await waitFor(() => expect(screen.getByTestId('tournaments-none')).toBeTruthy());
  });

  it('reads /api/tournaments and keeps only the records it understands', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ tournaments: [cubeNight, { id: 'broken' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchTournaments(fetchImpl)).toEqual([cubeNight]);
    expect(calls[0]).toMatch(/\/api\/tournaments$/);
  });

  it('keeps exactly what the server keeps: a record without its start or its rounds is not one', async () => {
    const { startedAt: _startedAt, ...noStart } = cubeNight;
    const { rounds: _rounds, ...noRounds } = cubeNight;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ tournaments: [noStart, noRounds, cubeNight] }), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchTournaments(fetchImpl)).toEqual([cubeNight]);
  });
});

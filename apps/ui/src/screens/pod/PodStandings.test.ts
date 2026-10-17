// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';

import { PodStandings, type PodStandingsRowLike } from './PodStandings.tsx';

afterEach(cleanup);

const names: Record<string, string> = { 'u-alice': 'Alice', 'u-bob': 'Bob' };
const nameOf = (id: string) => names[id] ?? id;

const row = (over: Partial<PodStandingsRowLike>): PodStandingsRowLike => ({
  id: 'u-alice',
  matchPoints: 3,
  opponentMatchWinPct: 0.5,
  gameWinPct: 1,
  opponentGameWinPct: 0.5,
  rank: 1,
  ...over,
});

describe('the pod standings', () => {
  it('draws nothing before any round has finished', () => {
    render(createElement(PodStandings, { rows: [], nameOf, myMemberId: null }));
    expect(screen.queryByTestId('pod-standings')).toBeNull();
  });

  it('draws one row per standing, in rank order, with resolved names and rounded percentages', () => {
    const rows = [row({ id: 'u-alice', rank: 1, matchPoints: 3 }), row({ id: 'u-bob', rank: 2, matchPoints: 0, gameWinPct: 0.333 })];
    render(createElement(PodStandings, { rows, nameOf, myMemberId: null }));

    const r1 = screen.getByTestId('pod-standings-row-1');
    expect(r1.textContent).toContain('Alice');
    expect(r1.textContent).toContain('3');
    const r2 = screen.getByTestId('pod-standings-row-2');
    expect(r2.textContent).toContain('Bob');
    expect(r2.textContent).toContain('33%');
  });

  it('marks my own row "(you)" and nobody else’s', () => {
    const rows = [row({ id: 'u-alice', rank: 1 }), row({ id: 'u-bob', rank: 2 })];
    render(createElement(PodStandings, { rows, nameOf, myMemberId: 'u-bob' }));

    expect(screen.getByTestId('pod-standings-row-1').textContent).not.toContain('(you)');
    expect(screen.getByTestId('pod-standings-row-2').textContent).toContain('Bob (you)');
  });
});

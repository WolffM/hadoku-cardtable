// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';

import { PodStandings, type PodStandingsRowLike } from './PodStandings.tsx';

afterEach(cleanup);

const names: Record<string, string> = { 'u-alice': 'Alice', 'u-bob': 'Bob', 'u-carol': 'Carol', ai: 'AI' };
const nameOf = (id: string) => names[id] ?? id;

const row = (over: Partial<PodStandingsRowLike>): PodStandingsRowLike => ({
  id: 'u-alice',
  matchPoints: 3,
  opponentMatchWinPct: 0.5,
  gameWinPct: 1,
  opponentGameWinPct: 0.5,
  medianGameMs: null,
  rank: 1,
  decidedBy: null,
  ...over,
});

describe('the pod standings', () => {
  it('draws nothing before any round has finished', () => {
    render(createElement(PodStandings, { rows: [], nameOf, myMemberId: null }));
    expect(screen.queryByTestId('pod-standings')).toBeNull();
  });

  it('draws one row per standing, in rank order, with resolved names and rounded percentages', () => {
    const rows = [row({ id: 'u-alice', rank: 1, matchPoints: 3 }), row({ id: 'u-bob', rank: 2, matchPoints: 0, gameWinPct: 0.333, decidedBy: 'matchPoints' })];
    render(createElement(PodStandings, { rows, nameOf, myMemberId: null }));

    const r1 = screen.getByTestId('pod-standings-row-1');
    expect(r1.textContent).toContain('Alice');
    expect(r1.textContent).toContain('3');
    const r2 = screen.getByTestId('pod-standings-row-2');
    expect(r2.textContent).toContain('Bob');
    expect(r2.textContent).toContain('33%');
  });

  // The operator, 2026-10-23: "how many tie-breakers do we have? also that does need to be visible somewhere",
  // then a fifth, the fastest median game. Spelled out, never acronyms (2026-10-19: "i hate the 3 letter acroynms").
  it('shows every ranking key in its order, spelled out, the median game as m:ss', () => {
    const rows = [
      row({ id: 'u-alice', rank: 1, matchPoints: 6, opponentMatchWinPct: 0.5, gameWinPct: 2 / 3, opponentGameWinPct: 0.4, medianGameMs: 754_000 }),
      row({ id: 'ai', rank: 2, matchPoints: 0, opponentMatchWinPct: 1, gameWinPct: 1 / 3, opponentGameWinPct: 1, medianGameMs: null, decidedBy: 'matchPoints' }),
    ];
    render(createElement(PodStandings, { rows, nameOf, myMemberId: null }));

    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      '#',
      'Player',
      'Points',
      'Opponent Match Winrate%',
      'Game Winrate%',
      'Opponent Game Winrate%',
      'Median Game',
    ]);
    expect(screen.getByTestId('pod-standings-row-1').textContent).toBe('1Alice650%67%40%12:34');
    expect(screen.getByTestId('pod-standings-row-2').textContent).toBe('2AI0100%33%100%—');
  });

  it('marks, on rows level on points, the cell of the tiebreaker that put each below the one above — on both rows of the pair', () => {
    const rows = [
      row({ id: 'u-alice', rank: 1, matchPoints: 6, opponentMatchWinPct: 0.6 }),
      row({ id: 'u-bob', rank: 2, matchPoints: 6, opponentMatchWinPct: 0.5, decidedBy: 'opponentMatchWinPct' }),
      row({ id: 'u-carol', rank: 3, matchPoints: 6, opponentMatchWinPct: 0.5, medianGameMs: 1_000, decidedBy: 'medianGameMs' }),
      row({ id: 'ai', rank: 4, matchPoints: 3, decidedBy: 'matchPoints' }),
    ];
    render(createElement(PodStandings, { rows, nameOf, myMemberId: null }));
    const decided = (rank: number) =>
      [...screen.getByTestId(`pod-standings-row-${rank}`).querySelectorAll('td[data-decided]')].map((td) => td.getAttribute('data-key'));

    expect(decided(1)).toEqual(['opponentMatchWinPct']);
    expect(decided(2)).toEqual(['opponentMatchWinPct', 'medianGameMs']);
    expect(decided(3)).toEqual(['medianGameMs']);
    // Separated by points: nothing to explain.
    expect(decided(4)).toEqual([]);
  });

  it('shares a rank across a full tie', () => {
    const rows = [row({ id: 'u-alice', rank: 1 }), row({ id: 'u-bob', rank: 1 })];
    render(createElement(PodStandings, { rows, nameOf, myMemberId: null }));
    expect(screen.getAllByTestId('pod-standings-row-1')).toHaveLength(2);
  });

  // The operator, 2026-10-22: "'Hadoku (you)' i dont need you written next to my name".
  it('marks my own row, with no "(you)" beside my name', () => {
    const rows = [row({ id: 'u-alice', rank: 1 }), row({ id: 'u-bob', rank: 2, decidedBy: 'matchPoints' })];
    render(createElement(PodStandings, { rows, nameOf, myMemberId: 'u-bob' }));

    expect(screen.getByTestId('pod-standings-row-1').hasAttribute('data-mine')).toBe(false);
    expect(screen.getByTestId('pod-standings-row-2').hasAttribute('data-mine')).toBe(true);
    expect(screen.getByTestId('pod-standings-row-2').textContent).not.toContain('(you)');
  });

  it('keeps a dropped entrant ranked on their record, marked Dropped', () => {
    const rows = [row({ id: 'u-alice', rank: 1 }), row({ id: 'u-bob', rank: 2, matchPoints: 0, decidedBy: 'matchPoints' })];
    render(createElement(PodStandings, { rows, nameOf, myMemberId: null, dropped: ['u-bob'] }));

    expect(screen.getByTestId('pod-standings-row-1').hasAttribute('data-dropped')).toBe(false);
    expect(screen.getByTestId('pod-standings-row-2').hasAttribute('data-dropped')).toBe(true);
    expect(screen.getByTestId('pod-standings-row-2').textContent).toContain('Dropped');
  });
});

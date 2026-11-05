// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';

import type { PodMatchResult } from '@hadoku/shared';

import { PodStandings, type PodStandingsRowLike } from './PodStandings.tsx';

afterEach(cleanup);

const names: Record<string, string> = { 'u-alice': 'Alice', 'u-bob': 'Bob', 'u-carol': 'Carol', ai: 'AI' };
const nameOf = (id: string) => names[id] ?? id;
const avatarOf = () => ({ id: null });
const base = { nameOf, avatarOf, results: [] as PodMatchResult[], myMemberId: null };

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
    render(createElement(PodStandings, { ...base, rows: [] }));
    expect(screen.queryByTestId('pod-standings')).toBeNull();
  });

  // The operator, 2026-11-02: "why does the score standings view have all this useless tiebreaker info in it?"
  it('draws rank, the player, their record and points: no tie-breaker columns', () => {
    const rows = [row({ id: 'u-alice', rank: 1, matchPoints: 6 }), row({ id: 'u-bob', rank: 2, matchPoints: 3, decidedBy: 'matchPoints' })];
    const results: PodMatchResult[] = [
      { round: 1, playerA: 'u-alice', playerB: 'u-bob', gamesA: 2, gamesB: 1 },
      { round: 2, playerA: 'u-alice', playerB: null, gamesA: 2, gamesB: 0 },
      { round: 2, playerA: 'u-bob', playerB: 'u-carol', gamesA: 1, gamesB: 1 },
    ];
    render(createElement(PodStandings, { ...base, rows, results }));
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['#', 'Player', 'Record', 'Points']);
    expect(screen.getByTestId('pod-standings-row-1').textContent).toBe('1A' + 'Alice2–06');
    expect(screen.getByTestId('pod-standings-row-2').textContent).toBe('2BBob0–1–13');
  });

  // 2026-10-23: "how many tie-breakers do we have? also that does need to be visible somewhere"; one press away, the operator's pick (2026-11-02).
  it('opens the tie-breakers on a press, spelled out, and marks on rows level on points the key that separated them — on both rows of the pair', () => {
    const rows = [
      row({ id: 'u-alice', rank: 1, matchPoints: 6, opponentMatchWinPct: 0.6, medianGameMs: 754_000 }),
      row({ id: 'u-bob', rank: 2, matchPoints: 6, opponentMatchWinPct: 0.5, decidedBy: 'opponentMatchWinPct' }),
      row({ id: 'u-carol', rank: 3, matchPoints: 6, opponentMatchWinPct: 0.5, medianGameMs: 1_000, decidedBy: 'medianGameMs' }),
      row({ id: 'ai', rank: 4, matchPoints: 3, decidedBy: 'matchPoints' }),
    ];
    render(createElement(PodStandings, { ...base, rows }));
    const more = screen.getByTestId('pod-standings-tiebreaks');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getAllByRole('columnheader')).toHaveLength(4);
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['#', 'Player', 'Record', 'Points', 'Opponents’ match wins', 'Game wins', 'Opponents’ game wins', 'Median game']);
    expect(screen.getByTestId('pod-standings-row-1').textContent).toContain('60%100%50%12:34');
    const decided = (rank: number) => [...screen.getByTestId(`pod-standings-row-${rank}`).querySelectorAll('td[data-decided]')].map((td) => td.getAttribute('data-key'));
    expect(decided(1)).toEqual(['opponentMatchWinPct']);
    expect(decided(2)).toEqual(['opponentMatchWinPct', 'medianGameMs']);
    expect(decided(3)).toEqual(['medianGameMs']);
    // Separated by points: nothing to mark.
    expect(decided(4)).toEqual([]);
    fireEvent.click(more);
    expect(screen.getAllByRole('columnheader')).toHaveLength(4);
  });

  it('shares a rank across a full tie', () => {
    const rows = [row({ id: 'u-alice', rank: 1 }), row({ id: 'u-bob', rank: 1 })];
    render(createElement(PodStandings, { ...base, rows }));
    expect(screen.getAllByTestId('pod-standings-row-1')).toHaveLength(2);
  });

  // The operator, 2026-10-22: "'Hadoku (you)' i dont need you written next to my name".
  it('marks my own row, with no "(you)" beside my name', () => {
    const rows = [row({ id: 'u-alice', rank: 1 }), row({ id: 'u-bob', rank: 2, decidedBy: 'matchPoints' })];
    render(createElement(PodStandings, { ...base, rows, myMemberId: 'u-bob' }));
    expect(screen.getByTestId('pod-standings-row-1').hasAttribute('data-mine')).toBe(false);
    expect(screen.getByTestId('pod-standings-row-2').hasAttribute('data-mine')).toBe(true);
    expect(screen.getByTestId('pod-standings-row-2').textContent).not.toContain('(you)');
  });

  it('keeps a dropped entrant ranked on their record, marked Dropped', () => {
    const rows = [row({ id: 'u-alice', rank: 1 }), row({ id: 'u-bob', rank: 2, matchPoints: 0, decidedBy: 'matchPoints' })];
    render(createElement(PodStandings, { ...base, rows, dropped: ['u-bob'] }));
    expect(screen.getByTestId('pod-standings-row-1').hasAttribute('data-dropped')).toBe(false);
    expect(screen.getByTestId('pod-standings-row-2').hasAttribute('data-dropped')).toBe(true);
    expect(screen.getByTestId('pod-standings-row-2').textContent).toContain('Dropped');
  });
});

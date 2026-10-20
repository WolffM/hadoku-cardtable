// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { RoomTable } from '@hadoku/shared';

import { bracketRounds, PodBracket } from './PodBracket.tsx';
import { POD_SEATS, type PodView } from './wire.ts';

afterEach(cleanup);

const NAMES: Record<string, string> = { 'u-alice': 'Alice', 'u-bob': 'Bob', 'u-carol': 'Carol', 'u-dave': 'Dave', ai: 'Knight' };
const nameOf = (id: string) => NAMES[id] ?? id;
const AVATARS: Record<string, string> = { 'u-alice': 'sage', ai: 'knight' };
const avatarOf = (id: string) => AVATARS[id] ?? null;

const player = (memberId: string) => ({ memberId, name: nameOf(memberId) });
const table = (id: string, ids: string[], over: Partial<RoomTable> = {}): RoomTable => ({
  id,
  players: ids.map(player),
  matchId: null,
  series: { length: 3, wins: [0, 0], games: [], phase: 'seating' },
  ...over,
});

function pod(over: Partial<PodView>): PodView {
  return { phase: 'rounds', seats: Array.from({ length: POD_SEATS }, () => null), round: 1, rounds: 2, results: [], standings: [], pairings: [], bye: null, drafters: [], built: [], ...over };
}

/** Five players, round 2 of 3 under way: round 1 finished with Carol's bye, round 2 has a live table and a finished one. */
const t1 = table('t-1', ['u-alice', 'u-dave'], { series: { length: 3, wins: [2, 1], games: [], phase: 'done' } });
const t2 = table('t-2', ['u-bob', 'u-eve']);
const t3 = table('t-3', ['u-alice', 'u-carol'], { matchId: 'm-000000000003', series: { length: 3, wins: [1, 0], games: [], phase: 'playing' } });
const t4 = table('t-4', ['u-bob', 'u-dave'], { series: { length: 3, wins: [0, 2], games: [], phase: 'done' } });
const midPod = pod({
  round: 2,
  rounds: 3,
  results: [
    { round: 1, playerA: 'u-alice', playerB: 'u-dave', gamesA: 2, gamesB: 1 },
    { round: 1, playerA: 'u-carol', playerB: null, gamesA: 2, gamesB: 0 },
    { round: 1, playerA: 'u-bob', playerB: 'u-eve', gamesA: 2, gamesB: 0 },
    { round: 2, playerA: 'u-bob', playerB: 'u-dave', gamesA: 0, gamesB: 2 },
  ],
  pairings: [
    { tableId: 't-3', players: ['u-alice', 'u-carol'] },
    { tableId: 't-4', players: ['u-bob', 'u-dave'] },
  ],
  bye: 'u-eve',
});
const midTables = [table('t-0', []), t1, t2, t3, t4];

describe('bracketRounds', () => {
  it('lays out every round: finished ones from the results, the one in play from its pairings, the rest unpaired', () => {
    const rounds = bracketRounds(midPod, midTables);
    expect(rounds.map((r) => r.state)).toEqual(['past', 'now', 'next']);
    const [r1, r2] = rounds;
    if (r1?.state === 'next' || r2?.state === 'next') throw new Error('unpaired');
    expect(r1!.matches.map((m) => [m.table?.id, m.wins, m.phase])).toEqual([
      ['t-1', [2, 1], 'done'],
      ['t-2', [2, 0], 'done'],
    ]);
    expect(r1!.bye).toBe('u-carol');
    expect(r2!.matches.map((m) => [m.table?.id, m.wins, m.phase])).toEqual([
      ['t-3', [1, 0], 'playing'],
      ['t-4', [0, 2], 'done'],
    ]);
    expect(r2!.bye).toBe('u-eve');
  });

  it('matches a game against the AI to the table its one player sat at', () => {
    const solo = pod({ phase: 'done', round: 2, rounds: 1, results: [{ round: 1, playerA: 'u-alice', playerB: 'ai', gamesA: 0, gamesB: 2 }] });
    const [r1] = bracketRounds(solo, [table('t-0', []), table('t-1', ['u-alice'], { series: { length: 3, wins: [0, 2], games: [], phase: 'done' } })]);
    expect(r1).toMatchObject({ state: 'past', matches: [{ players: ['u-alice', 'ai'], wins: [0, 2], phase: 'done' }] });
    if (r1?.state !== 'next') expect(r1!.matches[0]!.table?.id).toBe('t-1');
  });

  it('gives a repeated pairing each of its tables in turn, oldest first', () => {
    const again = pod({
      phase: 'done',
      round: 3,
      rounds: 2,
      results: [
        { round: 1, playerA: 'u-alice', playerB: 'u-bob', gamesA: 2, gamesB: 0 },
        { round: 2, playerA: 'u-alice', playerB: 'u-bob', gamesA: 0, gamesB: 2 },
      ],
    });
    const rounds = bracketRounds(again, [table('t-1', ['u-alice', 'u-bob']), table('t-2', ['u-alice', 'u-bob'])]);
    expect(rounds.map((r) => (r.state === 'next' ? null : r.matches[0]!.table?.id))).toEqual(['t-1', 't-2']);
  });
});

describe('PodBracket', () => {
  it('draws past rounds greyed, the round in play live, and an unpaired one empty', () => {
    render(createElement(PodBracket, { pod: midPod, tables: midTables, myMemberId: 'u-alice', nameOf, avatarOf }));
    expect(screen.getAllByTestId('pod-bracket-round').map((r) => r.dataset.state)).toEqual(['past', 'now', 'next']);
    expect(screen.queryAllByRole('heading'), 'the room keeps its one heading').toHaveLength(0);
    expect(screen.getAllByTestId('pod-tables-row').map((r) => [r.dataset.tableId, r.dataset.phase])).toEqual([
      ['t-1', 'done'],
      ['t-2', 'done'],
      ['t-3', 'playing'],
      ['t-4', 'done'],
    ]);
  });

  it('makes my live table the way in, Play, and somebody else’s Watch; a finished one goes nowhere', () => {
    const { rerender } = render(createElement(PodBracket, { pod: midPod, tables: midTables, myMemberId: 'u-alice', nameOf, avatarOf }));
    expect(screen.getByTestId('pod-tables-play').getAttribute('href')).toBe('#/match/m-000000000003');
    expect(screen.queryByTestId('pod-tables-watch')).toBeNull();
    const mine = screen.getAllByTestId('pod-tables-row').find((r) => r.dataset.tableId === 't-3')!;
    expect(mine.dataset.mine).toBe('');
    rerender(createElement(PodBracket, { pod: midPod, tables: midTables, myMemberId: 'u-bob', nameOf, avatarOf }));
    expect(screen.getByTestId('pod-tables-watch').getAttribute('href')).toBe('#/match/m-000000000003');
    expect(screen.queryByTestId('pod-tables-play')).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('offers my own unstarted table a Play button only as the retry after a refused start', () => {
    const waiting = pod({ pairings: [{ tableId: 't-1', players: ['u-alice', 'u-bob'] }] });
    const tables = [table('t-1', ['u-alice', 'u-bob'])];
    const { rerender } = render(createElement(PodBracket, { pod: waiting, tables, myMemberId: 'u-alice', nameOf, avatarOf }));
    expect(screen.queryByTestId('pod-tables-play')).toBeNull();
    const onPlay = vi.fn();
    rerender(createElement(PodBracket, { pod: waiting, tables, myMemberId: 'u-alice', nameOf, avatarOf, onPlay }));
    const play = screen.getByTestId('pod-tables-play');
    expect(play.tagName).toBe('BUTTON');
    fireEvent.click(play);
    expect(onPlay).toHaveBeenCalledWith('t-1');
    rerender(createElement(PodBracket, { pod: waiting, tables, myMemberId: 'u-carol', nameOf, avatarOf, onPlay }));
    expect(screen.queryByTestId('pod-tables-play')).toBeNull();
  });

  it('draws each player’s character, or their initial without one', () => {
    render(createElement(PodBracket, { pod: midPod, tables: midTables, myMemberId: 'u-alice', nameOf, avatarOf }));
    const live = screen.getAllByTestId('pod-tables-row').find((r) => r.dataset.tableId === 't-3')!;
    expect(live.querySelector('img')?.getAttribute('src')).toMatch(/square_sage\.png$/);
    expect(live.querySelector('.pod-bracket__face--none')?.textContent).toBe('C');
  });

  it('names each round’s bye, marking my own', () => {
    render(createElement(PodBracket, { pod: midPod, tables: midTables, myMemberId: 'u-eve', nameOf, avatarOf }));
    expect(screen.getAllByTestId('pod-tables-bye').map((b) => b.querySelector('.pod-bracket__name')?.textContent)).toEqual(['Carol', 'u-eve (you)']);
  });
});

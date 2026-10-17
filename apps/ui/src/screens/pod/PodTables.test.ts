// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';

import type { RoomTable } from '@hadoku/shared';

import { PodTables } from './PodTables.tsx';

afterEach(cleanup);

const series = (wins: [number, number] = [0, 0]): RoomTable['series'] => ({ length: 3, wins, games: [], phase: 'playing' });

const table = (over: Partial<RoomTable>): RoomTable => ({
  id: 't-aaaaaaaa',
  players: [
    { memberId: 'u-alice', name: 'Alice' },
    { memberId: 'u-bob', name: 'Bob' },
  ],
  matchId: 'm-aaaaaaaaaaaa',
  series: series(),
  ...over,
});

const names: Record<string, string> = { 'u-alice': 'Alice', 'u-bob': 'Bob', 'u-carol': 'Carol' };
const nameOf = (id: string) => names[id] ?? id;

describe('the pod’s current-round tables', () => {
  it('draws one row per table, naming the players and the series score', () => {
    const t1 = table({ id: 't-aaaaaaaa', series: series([1, 0]) });
    const t2 = table({
      id: 't-bbbbbbbb',
      matchId: 'm-bbbbbbbbbbbb',
      players: [
        { memberId: 'u-carol', name: 'Carol' },
        { memberId: 'u-dave', name: 'Dave' },
      ],
    });
    render(createElement(PodTables, { tables: [t1, t2], myMemberId: null, byeId: null, nameOf }));

    const rows = screen.getAllByTestId('pod-tables-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Alice');
    expect(rows[0]?.textContent).toContain('1–0');
    expect(rows[1]?.textContent).toContain('Carol');
  });

  it('highlights my own table with a Play link; everyone else gets Watch', () => {
    const mine = table({ id: 't-aaaaaaaa' });
    const other = table({
      id: 't-bbbbbbbb',
      matchId: 'm-bbbbbbbbbbbb',
      players: [
        { memberId: 'u-carol', name: 'Carol' },
        { memberId: 'u-dave', name: 'Dave' },
      ],
    });
    render(createElement(PodTables, { tables: [mine, other], myMemberId: 'u-alice', byeId: null, nameOf }));

    const myRow = screen.getAllByTestId('pod-tables-row')[0]!;
    expect(myRow.getAttribute('data-mine')).toBe('');
    expect(myRow.querySelector('[data-testid="pod-tables-play"]')).toBeTruthy();
    const otherRow = screen.getAllByTestId('pod-tables-row')[1]!;
    expect(otherRow.getAttribute('data-mine')).toBeNull();
    expect(otherRow.querySelector('[data-testid="pod-tables-watch"]')).toBeTruthy();
  });

  it('draws no link for a table with no live match yet, and no "Play" for someone else’s unstarted table', () => {
    render(createElement(PodTables, { tables: [table({ matchId: null })], myMemberId: null, byeId: null, nameOf }));
    expect(screen.queryByTestId('pod-tables-watch')).toBeNull();
    expect(screen.queryByTestId('pod-tables-play')).toBeNull();
  });

  it('offers my own unstarted table a "Play" button, not a link, that starts the game', () => {
    const onPlay = vi.fn();
    render(createElement(PodTables, { tables: [table({ id: 't-aaaaaaaa', matchId: null, series: { length: 3, wins: [0, 0], games: [], phase: 'seating' } })], myMemberId: 'u-alice', byeId: null, nameOf, onPlay }));
    const play = screen.getByTestId('pod-tables-play');
    expect(play.tagName).toBe('BUTTON');
    play.click();
    expect(onPlay).toHaveBeenCalledWith('t-aaaaaaaa');
  });

  it('disables "Play" while a start is already in flight', () => {
    render(createElement(PodTables, { tables: [table({ matchId: null })], myMemberId: 'u-alice', byeId: null, nameOf, onPlay: () => undefined, starting: true }));
    expect((screen.getByTestId('pod-tables-play') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers no "Play" at all without an onPlay handler — a read-only view', () => {
    render(createElement(PodTables, { tables: [table({ matchId: null })], myMemberId: 'u-alice', byeId: null, nameOf }));
    expect(screen.queryByTestId('pod-tables-play')).toBeNull();
  });

  it('names the bye, marking my own', () => {
    render(createElement(PodTables, { tables: [], myMemberId: 'u-carol', byeId: 'u-carol', nameOf }));
    const bye = screen.getByTestId('pod-tables-bye');
    expect(bye.textContent).toContain('Carol (you)');
    expect(bye.textContent).toContain('bye');
  });

  it('names someone else’s bye plainly, with no "(you)"', () => {
    render(createElement(PodTables, { tables: [], myMemberId: 'u-alice', byeId: 'u-carol', nameOf }));
    expect(screen.getByTestId('pod-tables-bye').textContent).not.toContain('(you)');
  });

  it('draws nothing for the bye when there is none', () => {
    render(createElement(PodTables, { tables: [], myMemberId: null, byeId: null, nameOf }));
    expect(screen.queryByTestId('pod-tables-bye')).toBeNull();
  });
});

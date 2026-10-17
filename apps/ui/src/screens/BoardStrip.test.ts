// @vitest-environment jsdom
/*
 * The board strip's own rules: nothing with one live table, one pill per
 * live table with two or more, the viewer's own board marked and still
 * clickable, and a picked pill's link is `#/match/<id>` and nothing else.
 *
 * `.test.ts`, not `.test.tsx`, and `createElement` instead of JSX — see
 * `RoomShell.test.ts`'s own header: the root vitest config globs
 * `apps/*\/src/**\/*.test.ts` and a `.tsx` test is not collected.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';

import type { RoomTable } from '@hadoku/shared';

import { BoardStrip } from './BoardStrip.tsx';

afterEach(cleanup);

const series = (wins: [number, number] = [0, 0]): RoomTable['series'] => ({ length: 1, wins, games: [], phase: 'playing' });

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

describe('the board strip', () => {
  it('draws nothing at all for zero or one live table', () => {
    render(createElement(BoardStrip, { tables: [], currentMatchId: 'm-aaaaaaaaaaaa' }));
    expect(screen.queryByTestId('board-strip')).toBeNull();

    render(createElement(BoardStrip, { tables: [table({})], currentMatchId: 'm-aaaaaaaaaaaa' }));
    expect(screen.queryByTestId('board-strip')).toBeNull();
  });

  it('draws nothing for a second table that has no live match yet', () => {
    render(
      createElement(BoardStrip, {
        tables: [table({}), table({ id: 't-bbbbbbbb', matchId: null })],
        currentMatchId: 'm-aaaaaaaaaaaa',
      }),
    );
    expect(screen.queryByTestId('board-strip')).toBeNull();
  });

  it('one entry per live table once there are two or more, each naming its two players and the series score', () => {
    const t1 = table({ id: 't-aaaaaaaa', matchId: 'm-aaaaaaaaaaaa', series: series([1, 0]) });
    const t2 = table({
      id: 't-bbbbbbbb',
      matchId: 'm-bbbbbbbbbbbb',
      players: [
        { memberId: 'u-carol', name: 'Carol' },
        { memberId: 'u-dave', name: 'Dave' },
      ],
      series: series([0, 0]),
    });
    render(createElement(BoardStrip, { tables: [t1, t2], currentMatchId: 'm-aaaaaaaaaaaa' }));

    const entries = screen.getAllByTestId('board-strip-entry');
    expect(entries).toHaveLength(2);
    expect(entries[0]?.textContent).toContain('Alice');
    expect(entries[0]?.textContent).toContain('Bob');
    expect(entries[0]?.textContent).toContain('1–0');
    expect(entries[1]?.textContent).toContain('Carol');
    expect(entries[1]?.textContent).toContain('Dave');
  });

  it('marks the viewer’s own table without excluding it — it is a pill, not a gap', () => {
    const t1 = table({ id: 't-aaaaaaaa', matchId: 'm-aaaaaaaaaaaa' });
    const t2 = table({ id: 't-bbbbbbbb', matchId: 'm-bbbbbbbbbbbb' });
    render(createElement(BoardStrip, { tables: [t1, t2], currentMatchId: 'm-aaaaaaaaaaaa' }));

    const [mine, other] = screen.getAllByTestId('board-strip-entry');
    expect(mine?.className).toContain('board-strip__entry--active');
    expect(other?.className).not.toContain('board-strip__entry--active');
    // Still a real link to the same match — picking your own board is a no-op
    // navigation, never a disabled or missing pill.
    expect(mine?.getAttribute('href')).toBe('#/match/m-aaaaaaaaaaaa');
  });

  it('a pill links straight to #/match/<id> and nothing else — no concede, no leave, just the route', () => {
    const t1 = table({ id: 't-aaaaaaaa', matchId: 'm-aaaaaaaaaaaa' });
    const t2 = table({ id: 't-bbbbbbbb', matchId: 'm-bbbbbbbbbbbb' });
    render(createElement(BoardStrip, { tables: [t1, t2], currentMatchId: 'm-aaaaaaaaaaaa' }));

    const byTable = (id: string) => screen.getAllByTestId('board-strip-entry').find((e) => e.getAttribute('data-table-id') === id);
    expect(byTable('t-aaaaaaaa')?.getAttribute('href')).toBe('#/match/m-aaaaaaaaaaaa');
    expect(byTable('t-bbbbbbbb')?.getAttribute('href')).toBe('#/match/m-bbbbbbbbbbbb');
    expect(byTable('t-aaaaaaaa')?.tagName).toBe('A');
  });

  it('draws no explanatory text — only names and the score, no hint or label', () => {
    const t1 = table({ id: 't-aaaaaaaa', matchId: 'm-aaaaaaaaaaaa' });
    const t2 = table({ id: 't-bbbbbbbb', matchId: 'm-bbbbbbbbbbbb' });
    render(createElement(BoardStrip, { tables: [t1, t2], currentMatchId: 'm-aaaaaaaaaaaa' }));

    for (const text of ['click', 'switch', 'watch', 'spectat']) {
      expect(screen.queryByText(new RegExp(text, 'i'))).toBeNull();
    }
  });
});

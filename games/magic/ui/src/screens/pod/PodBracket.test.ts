// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { RoomTable } from '@hadoku/shared';

import { PodBracket } from './PodBracket.tsx';
import { POD_SEATS, type PodView } from './wire.ts';

afterEach(cleanup);

const NAMES: Record<string, string> = { 'u-alice': 'Alice', 'u-bob': 'Bob', 'u-carol': 'Carol', 'u-dave': 'Dave', ai: 'Knight' };
const nameOf = (id: string) => NAMES[id] ?? id;
const AVATARS: Record<string, string> = { 'u-alice': 'sage', ai: 'knight' };
const avatarOf = (id: string) => ({ id: AVATARS[id] ?? null });

const player = (memberId: string) => ({ memberId, name: nameOf(memberId) });
const table = (id: string, ids: string[], over: Partial<RoomTable> = {}): RoomTable => ({
  id,
  players: ids.map(player),
  matchId: null,
  series: { length: 3, wins: [0, 0], games: [], phase: 'seating' },
  ...over,
});

function pod(over: Partial<PodView>): PodView {
  return {
    phase: 'rounds',
    seats: Array.from({ length: POD_SEATS }, () => null),
    round: 1,
    rounds: 2,
    results: [],
    standings: [],
    pairings: [],
    bye: null,
    drafters: [],
    built: [],
    personas: {},
    // wave 73 §A: PodView gains these three; this file (the bracket) is not a reader of any of them.
    plan: { rounds: [{ kind: 'cube', cubeId: 'default' }, { kind: 'cube', cubeId: 'default' }, { kind: 'cube', cubeId: 'default' }] },
    roundNames: ['Test Cube', 'Test Cube', 'Test Cube'],
    verdict: null,
    ...over,
  };
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
  standings: ['u-alice', 'u-bob', 'u-carol', 'u-dave', 'u-eve'].map((id, i) => ({ id, matchPoints: 0, opponentMatchWinPct: 0, gameWinPct: 0, opponentGameWinPct: 0, medianGameMs: null, rank: i + 1, decidedBy: null })),
});
const midTables = [table('t-0', []), t1, t2, t3, t4];

const bracket = (over: Partial<Parameters<typeof PodBracket>[0]> = {}) =>
  render(createElement(PodBracket, { roomId: 'r-1', pod: midPod, tables: midTables, myMemberId: 'u-alice', nameOf, avatarOf, ...over }));

describe('PodBracket', () => {
  it('draws a column per round, past, in play and not yet paired, and a card per match', () => {
    bracket();
    expect(screen.getAllByTestId('pod-bracket-round').map((r) => r.dataset.state)).toEqual(['past', 'now', 'next']);
    expect(screen.queryAllByRole('heading'), 'the room keeps its one heading').toHaveLength(0);
    expect(screen.getAllByTestId('pod-tables-row').map((r) => [r.dataset.tableId, r.dataset.phase]).sort()).toEqual([
      ['t-1', 'done'],
      ['t-2', 'done'],
      ['t-3', 'playing'],
      ['t-4', 'done'],
    ]);
  });

  it('makes every live table the way in: mine by its one door (Enter game, then Return to game), somebody else’s Watch straight at its game; a finished one goes nowhere', () => {
    const at = (entered: [boolean, boolean]) => ({ 't-3': { decks: [null, null] as [null, null], live: null, entered } });
    const { rerender } = bracket({ games: at([false, false]) });
    const matchHref = `#/match/${midTables.find((t) => t.id === 't-3')!.matchId}`;
    expect(screen.getByTestId('pod-tables-play').textContent).toBe('Enter game');
    expect(screen.getByTestId('pod-tables-play').getAttribute('href')).toBe(matchHref);
    rerender(createElement(PodBracket, { roomId: 'r-1', pod: midPod, tables: midTables, myMemberId: 'u-alice', nameOf, avatarOf, games: at([true, true]) }));
    expect(screen.getByTestId('pod-tables-play').textContent).toBe('Return to game');
    expect(screen.getByTestId('pod-tables-play').getAttribute('href')).toBe(matchHref);
    expect(screen.queryByTestId('pod-tables-watch')).toBeNull();
    const mine = screen.getAllByTestId('pod-tables-row').find((r) => r.dataset.tableId === 't-3')!;
    expect(mine.dataset.mine).toBe('');
    expect(mine.firstElementChild?.className, 'the way in heads the card, beside the game in play').toBe('swiss__bar');
    expect(mine.querySelector('.swiss__bar .swiss__game')?.textContent).toMatch(/^Game \d$/);
    expect(document.querySelector('.swiss__chip'), 'no record over a group: the rows carry the score').toBeNull();
    rerender(createElement(PodBracket, { roomId: 'r-1', pod: midPod, tables: midTables, myMemberId: 'u-bob', nameOf, avatarOf }));
    expect(screen.getByTestId('pod-tables-watch').getAttribute('href')).toBe(matchHref);
    expect(screen.queryByTestId('pod-tables-play')).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('reads my door by my seat at the table, not my place in the pairing: against an AI named first I am still seat 0', () => {
    const vsAi = pod({ pairings: [{ tableId: 't-1', players: ['ai:3', 'u-alice'] }] });
    const up = table('t-1', ['u-alice'], { matchId: 'm-000000000001', series: { length: 3, wins: [0, 0], games: [], phase: 'playing' } });
    // The AI's seat (1) has always been at the game; mine (0) has not.
    bracket({ pod: vsAi, tables: [up], games: { 't-1': { decks: [null, null], live: null, entered: [false, true] } } });
    expect(screen.getByTestId('pod-tables-play').textContent).toBe('Enter game');
  });

  it('links a table with no game yet too: its page is where the game starts', () => {
    const waiting = pod({ pairings: [{ tableId: 't-1', players: ['u-alice', 'u-bob'] }] });
    bracket({ pod: waiting, tables: [table('t-1', ['u-alice', 'u-bob'])] });
    expect(screen.getByTestId('pod-tables-play').getAttribute('href')).toBe('#/room/r-1/table/t-1');
  });

  it('draws each player’s character, or their initial without one', () => {
    bracket();
    const live = screen.getAllByTestId('pod-tables-row').find((r) => r.dataset.tableId === 't-3')!;
    expect(live.querySelector('img')?.getAttribute('src')).toMatch(/square_sage\.png$/);
    expect(live.querySelector('.swiss__face--none')?.textContent).toBe('C');
  });

  it('names each round’s bye', () => {
    bracket({ myMemberId: 'u-eve' });
    expect(screen.getAllByTestId('pod-tables-bye').map((b) => b.querySelector('.swiss__name')?.textContent)).toEqual(['Carol', 'u-eve']);
  });

  it('a press on a player lights their path and dims the rest; a second press lets it go', () => {
    bracket({ myMemberId: null });
    const daveRow = screen.getAllByRole('button', { pressed: false }).find((b) => b.querySelector('.swiss__name')?.textContent === 'Dave')!;
    // A pointer press focuses the row before its click: the focus alone must not pick, or the click would let go again.
    fireEvent.focus(daveRow);
    fireEvent.click(daveRow);
    expect(daveRow.getAttribute('aria-pressed')).toBe('true');
    const cards = screen.getAllByTestId('pod-tables-row');
    expect(cards.filter((c) => c.dataset.dim === undefined).map((c) => c.dataset.tableId).sort(), 'only Dave’s matches stay lit').toEqual(['t-1', 't-4']);
    expect(document.querySelectorAll('.swiss__edge[data-on]').length).toBeGreaterThan(0);
    fireEvent.click(daveRow);
    expect(screen.getAllByTestId('pod-tables-row').filter((c) => c.dataset.dim !== undefined)).toHaveLength(0);
  });

  it('keeps a live match’s ways to resolve behind one ⋯: mine Drop and Concede, the leader’s Reset and DQ', async () => {
    const posted: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      posted.push(String(url));
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    bracket({ leader: true });
    expect(screen.queryByTestId('pod-tables-row-drop'), 'none drawn until asked for').toBeNull();
    const more = screen.getByTestId('pod-tables-row-more');
    expect(more.closest('a'), 'never inside the way in').toBeNull();
    fireEvent.click(more);
    expect(screen.getByRole('dialog').getAttribute('data-testid'), 'in a modal, not inside the card').toBe('pod-tables-row-tools');
    expect(more.closest('[data-testid="pod-tables-row"]')!.contains(screen.getByRole('dialog'))).toBe(false);
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual([
      'Concede game',
      'Drop match',
      'Reset game',
      'Restart turn',
      'Replay match',
      'Game to Alice',
      'Game to Carol',
      'Match to Alice',
      'Match to Carol',
      'DQ Alice',
      'DQ Carol',
    ]);
    fireEvent.click(screen.getByTestId('pod-tables-row-drop'));
    expect(screen.queryByRole('menu'), 'choosing one closes the menu').toBeNull();
    expect(screen.getByTestId('pod-tables-row-drop-confirm').querySelector('.table-card__change')?.textContent).toBe('1–0→1–2');
    await act(async () => {
      fireEvent.click(screen.getByTestId('pod-tables-row-drop-yes'));
    });
    expect(posted.some((u) => u.endsWith('rooms/r-1/tables/t-3/drop'))).toBe(true);
    vi.unstubAllGlobals();
  });

  it('the leader’s modal opens on how the game stands, and awards a game or the match by the player’s table seat', async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
      if (String(url).endsWith('/admin/live')) {
        const seat = (over: object) => ({ seat: 0, ai: false, here: true, away: false, asks: [], waitingOn: null, clock: null, ...over });
        return Promise.resolve(
          Response.json({
            now: 600_000,
            tables: [
              {
                tableId: 't-3',
                matchId: 'm-000000000003',
                epochs: ['m-000000000003-e1'],
                // Carol sits at table seat 0 here, Alice at 1: the pairing's order is not the table's.
                match: { status: 'running', turn: 9, active: 0, restoreTurn: 9, lastActivityAt: 300_000, seats: [seat({ waitingOn: 'declareBlockers', asks: [{ method: 'declareBlockers', ageMs: 245_000 }] }), seat({ seat: 1, away: true, clock: { ms: 754_000, running: false } })] },
              },
            ],
          }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    const swapped = midTables.map((t) => (t.id === 't-3' ? { ...t, players: [player('u-carol'), player('u-alice')] } : t));
    bracket({ leader: true, myMemberId: 'u-bob', tables: swapped });
    await act(async () => {
      fireEvent.click(screen.getByTestId('pod-tables-row-more'));
    });
    const state = screen.getByTestId('pod-tables-row-state');
    const rows = [...state.querySelectorAll('.table-card__state-seat')];
    expect(rows.map((r) => r.textContent)).toEqual(['Alice⏱ 12:34', 'CaroldeclareBlockers4:05']);
    expect(rows[0]!.hasAttribute('data-away'), 'Alice has left').toBe(true);
    expect(rows[1]!.hasAttribute('data-active'), 'Carol’s turn').toBe(true);
    expect(state.querySelector('.table-card__state-idle')?.textContent).toBe('↻ 5:00');
    expect(state.querySelector('a')?.getAttribute('href')).toContain('replay/m-000000000003-e1');
    fireEvent.click(screen.getByTestId('pod-tables-row-game0'));
    expect(screen.getByTestId('pod-tables-row-game0-confirm').querySelector('.table-card__change')?.textContent).toBe('1–0→2–0');
    await act(async () => {
      fireEvent.click(screen.getByTestId('pod-tables-row-game0-yes'));
    });
    expect(calls.find((c) => c.url.endsWith('tables/t-3/award'))?.body, 'Alice is table seat 1').toEqual({ seat: 1, match: false });
    vi.unstubAllGlobals();
  });

  it('the final column has everyone by place', () => {
    const finished = pod({
      phase: 'done',
      round: 2,
      rounds: 1,
      results: [{ round: 1, playerA: 'u-alice', playerB: 'u-bob', gamesA: 2, gamesB: 1 }, { round: 1, playerA: 'u-carol', playerB: 'u-dave', gamesA: 2, gamesB: 0 }],
      standings: ['u-alice', 'u-carol', 'u-bob', 'u-dave'].map((id, i) => ({ id, matchPoints: 0, opponentMatchWinPct: 0, gameWinPct: 0, opponentGameWinPct: 0, medianGameMs: null, rank: i + 1, decidedBy: null })),
    });
    bracket({ pod: finished, tables: [] });
    expect(screen.getAllByTestId('pod-final-row').map((r) => [r.dataset.place, r.textContent])).toEqual([
      ['1', '#1Alice0 pts'],
      ['2', '#2CCarol0 pts'],
      ['3', '#3BBob0 pts'],
      ['4', '#4DDave0 pts'],
    ]);
  });
});

describe('PodBracket.css', () => {
  it('lights a live card only while it is pressed or keyboard-focused, never under a passing pointer', () => {
    const css = readFileSync('games/magic/ui/src/screens/pod/PodBracket.css', 'utf8');
    expect(css).not.toMatch(/:hover/);
    expect(css).toMatch(/swiss__go:active/);
    expect(css).toMatch(/swiss__go:focus-visible\)/);
  });
});

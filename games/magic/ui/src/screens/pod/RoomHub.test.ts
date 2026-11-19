// @vitest-environment jsdom
/*
 * A room's rounds: the hub (the round, the bracket, the standings) and one
 * table's page (its seats, my step before the game, the start, the match).
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RoomTable, TableGame } from '@hadoku/shared';

import { forgetMatchesFollowed } from '../../play/live/matchStart.ts';
import { currentRoute, navigate } from '@hadoku/game-ui/screens/route.ts';
import { RoomHub } from './RoomHub.tsx';
import { forgetOpponentsRevealed, REVEAL_MS } from './FaceOff.tsx';
import { TablePage, type TableReady } from './TablePage.tsx';
import { POD_SEATS, type PodView } from './wire.ts';

afterEach(() => {
  forgetMatchesFollowed();
  cleanup();
  vi.restoreAllMocks();
  globalThis.location.hash = '';
});

const ROOM = 'r-hub';
const nameOf = (id: string) => ({ 'u-alice': 'Alice', 'u-bob': 'Bob', 'ai:3': 'Rogue' })[id] ?? id;
const avatarOf = () => ({ id: null });
const route = () => currentRoute();

function pod(over: Partial<PodView> = {}): PodView {
  return {
    phase: 'rounds',
    seats: Array.from({ length: POD_SEATS }, () => null),
    round: 1,
    rounds: 2,
    results: [],
    pairings: [{ tableId: 't-1', players: ['u-alice', 'u-bob'] }],
    standings: [{ id: 'u-alice', matchPoints: 3, opponentMatchWinPct: 0.5, gameWinPct: 1, opponentGameWinPct: 0.5, medianGameMs: null, rank: 1, decidedBy: null }],
    bye: null,
    drafters: ['u-alice', 'u-bob'],
    built: ['u-alice', 'u-bob'],
    personas: {},
    plan: { rounds: [{ kind: 'cube', cubeId: 'default' }, { kind: 'cube', cubeId: 'default' }, { kind: 'cube', cubeId: 'default' }] },
    roundNames: ['Test Cube', 'Test Cube', 'Test Cube'],
    verdict: null,
    ...over,
  };
}

function table(over: Partial<RoomTable> = {}): RoomTable {
  return {
    id: 't-1',
    players: [
      { memberId: 'u-alice', name: 'Alice' },
      { memberId: 'u-bob', name: 'Bob' },
    ],
    matchId: null,
    series: { length: 3, wins: [1, 0], games: [{ matchId: 'm-000000000001', winner: 0 }], phase: 'seating' },
    ...over,
  };
}

const hub = (p: PodView) => render(createElement(RoomHub, { roomId: ROOM, pod: p, tables: [table()], myMemberId: 'u-alice', nameOf, avatarOf, leaderId: '' }));

describe('RoomHub', () => {
  it('heads with the round, and draws the bracket and the standings', () => {
    hub(pod());
    expect(screen.getByTestId('pod-round').textContent).toBe('Round 1 of 2');
    expect(screen.getByTestId('pod-tables')).not.toBeNull();
    expect(screen.getByTestId('pod-standings')).not.toBeNull();
  });

  it('heads with Standings once the pod is done, not a round number, under the podium', () => {
    const standing = (id: string, rank: number) => ({ id, matchPoints: 9 - 3 * rank, opponentMatchWinPct: 0.5, gameWinPct: 0.5, opponentGameWinPct: 0.5, medianGameMs: null, rank, decidedBy: null });
    hub(pod({ phase: 'done', standings: [standing('u-alice', 1), standing('u-bob', 2)] }));
    expect(screen.queryByTestId('pod-round')).toBeNull();
    expect(screen.getByText('Standings')).not.toBeNull();
    expect(screen.getByTestId('pod-podium-1').textContent).toContain('Alice');
  });

  it('names nobody watching under the bracket: the chat says who is in the room', () => {
    hub(pod());
    expect(screen.queryByTestId('pod-spectators')).toBeNull();
  });
});

/** The viewer's motion preference, as `prefersReducedMotion` reads it. */
const motion = (reduced: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduced && q.includes('reduce') }));

/** A round's table before its first game. */
const FRESH = { length: 3, wins: [0, 0], games: [], phase: 'seating' } as const satisfies RoomTable['series'];
const gameWith = (entered: [boolean, boolean]): TableGame => ({ decks: [null, null], live: null, entered });

describe('TablePage', () => {
  // The round's opponent reveal draws its end state, so each case below reads the page it settles on.
  beforeEach(() => motion(true));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    forgetOpponentsRevealed();
  });
  const page = (over: { pod?: PodView; table?: RoomTable | undefined; me?: string; canStart?: boolean; slot?: boolean; ready?: TableReady; game?: TableGame } = {}) =>
    render(
      createElement(
        TablePage,
        {
          roomId: ROOM,
          pod: over.pod ?? pod(),
          table: 'table' in over ? over.table : table(),
          myMemberId: over.me ?? 'u-alice',
          nameOf,
          avatarOf,
          canStart: over.canStart,
          ready: over.ready,
          game: over.game,
        },
        over.slot === false ? undefined : createElement('div', { 'data-testid': 'stand-in-step' }),
      ),
    );
  const posts = () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (init?.method === 'POST') urls.push(String(input));
      return new Promise(() => {});
    });
    return urls;
  };

  it('draws both seats with their games won, and the way back to the hub', () => {
    posts();
    page();
    expect(screen.getAllByTestId(/^table-seat-\d$/).map((s) => [s.querySelector('.face-off__name')?.textContent, screen.getByTestId(`${s.dataset.testid}-wins`).textContent])).toEqual([
      ['Alice', '1'],
      ['Bob', '0'],
    ]);
    expect(screen.getByTestId('table-hub').getAttribute('href')).toBe(`#/room/${ROOM}`);
  });

  it('heads the page with its round, and the way back to the lobby is the site’s back arrow on its left', () => {
    posts();
    page();
    expect(screen.getByTestId('table-round').textContent).toBe('Round 1 of 2');
    expect(screen.getByTestId('table-hub').textContent).toBe('←');
    expect(screen.getByTestId('table-hub').getAttribute('aria-label')).toBe('Lobby');
    expect(screen.getByTestId('table-hub').className).toBe('back-link');
    expect(screen.getByTestId('table-hub').nextElementSibling).toBe(screen.getByTestId('table-round'));
  });

  it('draws an AI entrant in its table seat, the last, by its own name, whichever side the pairing names it', () => {
    posts();
    page({ pod: pod({ pairings: [{ tableId: 't-1', players: ['ai:3', 'u-alice'] }] }), table: table({ players: [{ memberId: 'u-alice', name: 'Alice' }] }) });
    expect(screen.getAllByTestId(/^table-seat-\d$/).map((s) => [s.querySelector('.face-off__name')?.textContent, screen.getByTestId(`${s.dataset.testid}-wins`).textContent])).toEqual([
      ['Alice', '1'],
      ['Rogue', '0'],
    ]);
  });

  it('a start that waits on both seats’ Ready: each seat says whether it is, and mine is the lobby’s Ready', () => {
    posts();
    const onReady = vi.fn();
    page({ ready: { seats: [false, true], disabled: false, onReady } });
    expect(screen.getByTestId('table-seat-0-ready').textContent).toContain('not ready');
    expect(screen.getByTestId('table-seat-1-ready').textContent).not.toContain('not');
    fireEvent.click(screen.getByTestId('ready-toggle'));
    expect(onReady).toHaveBeenCalledWith(true);
  });

  it('draws my step before the game, and starts my table by itself', () => {
    const urls = posts();
    page();
    expect(screen.getByTestId('stand-in-step')).not.toBeNull();
    // Asked in the render's own effect, so a case that asks nothing can say so at once.
    expect(urls.some((u) => u.endsWith('/ready'))).toBe(true);
  });

  it('holds the start while the mode says no', () => {
    const urls = posts();
    page({ canStart: false });
    expect(urls).toEqual([]);
  });

  it('starts nothing and draws no step for somebody who does not play at it', () => {
    const urls = posts();
    page({ me: 'u-carol' });
    expect(urls).toEqual([]);
    expect(screen.queryByTestId('stand-in-step')).toBeNull();
  });

  it('starts nothing at an earlier round’s table of mine', () => {
    const urls = posts();
    page({ pod: pod({ round: 2, pairings: [{ tableId: 't-2', players: ['u-alice', 'u-bob'] }] }), table: table({ series: { length: 3, wins: [2, 0], games: [], phase: 'done' } }) });
    expect(urls).toEqual([]);
    expect(screen.queryByTestId('stand-in-step')).toBeNull();
  });

  it('shows a refused start, and Try again asks again', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ error: 'the table is locked' }), { status: 409 })));
    page();
    await vi.waitFor(() => expect(screen.getByTestId('pod-table-start-error').textContent).toContain('the table is locked'));
    screen.getByTestId('table-start-retry').click();
    await vi.waitFor(() => expect(vi.mocked(globalThis.fetch).mock.calls.length).toBeGreaterThan(1));
  });

  it('walks nobody into the table’s game: one way on, which the room’s record names — Watch, Enter game, then Return to game', () => {
    posts();
    const playing = table({ matchId: 'm-000000000002', series: { length: 3, wins: [1, 0], games: [], phase: 'playing' } });
    navigate({ kind: 'room', roomId: ROOM, tableId: 't-1' });
    page({ me: 'u-carol', table: playing, game: gameWith([true, true]) });
    expect(route()).toEqual({ kind: 'room', roomId: ROOM, tableId: 't-1' });
    expect(screen.getByTestId('table-match-link').textContent).toBe('Watch');
    cleanup();
    // Bob has not been at this game: on any page, however it was reached, it is his press that enters it.
    page({ me: 'u-bob', table: playing, game: gameWith([true, false]) });
    expect(route()).toEqual({ kind: 'room', roomId: ROOM, tableId: 't-1' });
    expect(screen.getByTestId('table-match-link').textContent).toBe('Enter game');
    expect(screen.getAllByTestId('table-match-link')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('table-match-link'));
    expect(route()).toEqual({ kind: 'match', matchId: 'm-000000000002' });
    cleanup();
    navigate({ kind: 'room', roomId: ROOM, tableId: 't-1' });
    page({ me: 'u-bob', table: playing, game: gameWith([true, true]) });
    expect(screen.getByTestId('table-match-link').textContent).toBe('Return to game');
    expect(screen.getByTestId('table-match-link').getAttribute('href')).toBe('#/match/m-000000000002');
  });

  it('between two games it holds no sideboard: one card, whose way on is the sideboard’s own full screen', () => {
    posts();
    page({ table: table({ series: { length: 3, wins: [1, 0], games: [{ matchId: 'm-000000000001', winner: 0 }], phase: 'sideboarding' } }) });
    expect(screen.queryByTestId('table-sideboard')).toBeNull();
    expect(screen.getAllByTestId('table-match-link')).toHaveLength(1);
    expect(screen.getByTestId('table-match-link').textContent).toBe('Sideboard');
    expect(screen.getByTestId('table-match-link').getAttribute('href')).toBe(`#/room/${ROOM}/table/t-1/sideboard`);
  });

  it('sends a table the room does not have back to the hub', () => {
    posts();
    navigate({ kind: 'room', roomId: ROOM, tableId: 't-9' });
    page({ table: undefined });
    expect(route()).toEqual({ kind: 'room', roomId: ROOM });
  });

  it('reveals a round’s opponent: "me vs them", mine on the left, the two at rest with the score, then my Ready and the step under them', () => {
    motion(false);
    posts();
    vi.useFakeTimers();
    const onReady = vi.fn();
    page({ me: 'u-bob', table: table({ series: FRESH }), ready: { seats: [false, false], disabled: false, onReady } });
    expect(screen.getByTestId('table-page').hasAttribute('data-revealing')).toBe(true);
    expect(screen.getByTestId('table-seats').hasAttribute('data-revealing')).toBe(true);
    expect(screen.getByTestId('face-off-title').textContent).toBe('BobvsAlice');
    expect(screen.getByTestId('table-seat-1').dataset.side).toBe('left');
    expect(screen.getByTestId('table-seat-0').dataset.side).toBe('right');
    expect(screen.queryByTestId('ready-toggle')).toBeNull();
    expect(screen.queryByTestId('stand-in-step')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(REVEAL_MS);
    });
    // The same two, at rest: nothing is swapped in for them.
    expect(screen.getByTestId('table-seats').hasAttribute('data-revealing')).toBe(false);
    expect(screen.getByTestId('table-seat-1').dataset.side).toBe('left');
    expect(screen.getByTestId('table-seat-1-wins').textContent).toBe('0');
    expect(screen.getByTestId('table-seat-0-wins').textContent).toBe('0');
    expect(screen.getByTestId('table-seat-1-ready').textContent).toContain('not ready');
    expect(screen.getByTestId('ready-toggle')).not.toBeNull();
    expect(screen.getByTestId('stand-in-step')).not.toBeNull();
  });

  it('reveals a table once per page: back on it, the end state', () => {
    motion(false);
    posts();
    vi.useFakeTimers();
    page({ table: table({ series: FRESH }) });
    expect(screen.getByTestId('table-page').hasAttribute('data-revealing')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(REVEAL_MS);
    });
    cleanup();
    page({ table: table({ series: FRESH }) });
    expect(screen.getByTestId('table-page').hasAttribute('data-revealing')).toBe(false);
  });

  it('reveals nothing on a table I come back to mid-series or from its first game, even on a fresh page', () => {
    motion(false);
    posts();
    page();
    expect(screen.getByTestId('table-page').hasAttribute('data-revealing')).toBe(false);
    cleanup();
    page({ table: table({ matchId: 'm-0000000000aa', series: { ...FRESH, phase: 'playing' } }), game: gameWith([true, true]) });
    expect(screen.getByTestId('table-page').hasAttribute('data-revealing')).toBe(false);
  });

  it('reveals nothing to a watcher, nor on a plain room’s one table', () => {
    motion(false);
    posts();
    page({ me: 'u-carol', table: table({ series: FRESH }) });
    expect(screen.getByTestId('table-page').hasAttribute('data-revealing')).toBe(false);
    cleanup();
    render(createElement(TablePage, { roomId: ROOM, pod: null, table: table({ series: FRESH }), myMemberId: 'u-alice', nameOf, avatarOf }));
    expect(screen.getByTestId('table-page').hasAttribute('data-revealing')).toBe(false);
  });

  it('after the reveal the game waits for my press: Enter game, and nothing else walks me in', () => {
    motion(false);
    posts();
    vi.useFakeTimers();
    navigate({ kind: 'room', roomId: ROOM, tableId: 't-1' });
    page({ table: table({ matchId: 'm-0000000000aa', series: { ...FRESH, phase: 'playing' } }), game: gameWith([false, false]) });
    expect(screen.queryByTestId('table-match-link')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(REVEAL_MS);
    });
    expect(currentRoute().kind).toBe('room');
    expect(screen.getByTestId('table-match-link').textContent).toBe('Enter game');
    fireEvent.click(screen.getByTestId('table-match-link'));
    expect(currentRoute()).toEqual({ kind: 'match', matchId: 'm-0000000000aa' });
  });
});

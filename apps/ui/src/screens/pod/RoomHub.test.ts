// @vitest-environment jsdom
/*
 * A room's rounds: the hub (the round, the bracket, the standings) and one
 * table's page (its seats, my step before the game, the start, the match).
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RoomTable } from '@hadoku/shared';

import { forgetMatchesFollowed } from '../../play/live/matchStart.ts';
import { navigate, parseRoute } from '../route.ts';
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
const avatarOf = () => null;
const route = () => parseRoute(globalThis.location.hash);

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
    planName: 'Test Cube',
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

const hub = (p: PodView, children?: unknown) =>
  render(createElement(RoomHub, { roomId: ROOM, pod: p, tables: [table()], myMemberId: 'u-alice', nameOf, avatarOf, members: [], leaderId: '' }, children as never));

describe('RoomHub', () => {
  it('heads with the round, and draws the bracket and the standings', () => {
    hub(pod());
    expect(screen.getByTestId('pod-round').textContent).toBe('Round 1 of 2');
    expect(screen.getByTestId('pod-tables')).not.toBeNull();
    expect(screen.getByTestId('pod-standings')).not.toBeNull();
  });

  it('heads with Standings once the pod is done, not a round number', () => {
    hub(pod({ phase: 'done' }));
    expect(screen.queryByTestId('pod-round')).toBeNull();
    expect(screen.getByText('Standings')).not.toBeNull();
  });

  it('draws the building slot, and no standings, before round 1', () => {
    hub(pod({ phase: 'building', pairings: [] }), createElement('div', { 'data-testid': 'stand-in-building' }));
    expect(screen.getByTestId('pod-round').textContent).toBe('Round 1 of 2');
    expect(screen.getByTestId('stand-in-building')).not.toBeNull();
    expect(screen.queryByTestId('pod-standings')).toBeNull();
  });
});

/** The viewer's motion preference, as `prefersReducedMotion` reads it. */
const motion = (reduced: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduced && q.includes('reduce') }));

describe('TablePage', () => {
  // The round's opponent reveal draws its end state, so each case below reads the page it settles on.
  beforeEach(() => motion(true));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    forgetOpponentsRevealed();
  });
  const page = (over: { pod?: PodView; table?: RoomTable | undefined; me?: string; canStart?: boolean; slot?: boolean; ready?: TableReady } = {}) =>
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
          refresh: null,
          ready: over.ready,
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

  it('heads the page with its round, and the way back to the lobby is the plain ← Lobby link on its right', () => {
    posts();
    page();
    expect(screen.getByTestId('table-round').textContent).toBe('Round 1 of 2');
    expect(screen.getByTestId('table-hub').textContent).toBe('← Lobby');
    expect(screen.getByTestId('table-hub').className).toBe('shell__link');
    expect(screen.getByTestId('table-round').nextElementSibling).toBe(screen.getByTestId('table-hub'));
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

  it('follows the table’s match, for a player and a watcher alike, and links to it', () => {
    posts();
    navigate({ kind: 'room', roomId: ROOM, tableId: 't-1' });
    page({ me: 'u-carol', table: table({ matchId: 'm-000000000002', series: { length: 3, wins: [1, 0], games: [], phase: 'playing' } }) });
    expect(route()).toEqual({ kind: 'match', matchId: 'm-000000000002' });
    expect(screen.getByTestId('table-match-link').textContent).toBe('Watch');
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
    page({ me: 'u-bob', ready: { seats: [false, false], disabled: false, onReady } });
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
    expect(screen.getByTestId('table-seat-0-wins').textContent).toBe('1');
    expect(screen.getByTestId('table-seat-1-ready').textContent).toContain('not ready');
    expect(screen.getByTestId('ready-toggle')).not.toBeNull();
    expect(screen.getByTestId('stand-in-step')).not.toBeNull();
  });

  it('reveals a table once per page: back on it, the end state', () => {
    motion(false);
    posts();
    vi.useFakeTimers();
    page();
    act(() => {
      vi.advanceTimersByTime(REVEAL_MS);
    });
    cleanup();
    page();
    expect(screen.getByTestId('table-page').hasAttribute('data-revealing')).toBe(false);
  });

  it('reveals nothing to a watcher, nor on a plain room’s one table', () => {
    motion(false);
    posts();
    page({ me: 'u-carol' });
    expect(screen.getByTestId('table-page').hasAttribute('data-revealing')).toBe(false);
    cleanup();
    render(createElement(TablePage, { roomId: ROOM, pod: null, table: table(), myMemberId: 'u-alice', nameOf, avatarOf, refresh: null }));
    expect(screen.getByTestId('table-page').hasAttribute('data-revealing')).toBe(false);
  });

  it('follows into the table’s game only once the reveal is over', () => {
    motion(false);
    posts();
    vi.useFakeTimers();
    page({ table: table({ matchId: 'm-0000000000aa' }) });
    expect(parseRoute(location.hash).kind).not.toBe('match');
    act(() => {
      vi.advanceTimersByTime(REVEAL_MS);
    });
    expect(parseRoute(location.hash)).toEqual({ kind: 'match', matchId: 'm-0000000000aa' });
  });
});

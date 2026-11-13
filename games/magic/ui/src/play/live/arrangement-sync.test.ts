/*
 * `arrangement-sync.ts`: an echo lands on the player of the SEAT it is stamped
 * with. The watcher case (2026-10-12) is the point — both seats' echoes, with
 * either side at the bottom — and the seated window's own rules still hold.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARRANGEMENT_EVENT } from '@hadoku/shared';

import type { BoardView } from '../adapter.ts';

const board = vi.hoisted(() => ({
  applyTheirArrangement: vi.fn(),
  onOwnArrangement: vi.fn(() => () => undefined),
}));
vi.mock('../Board.tsx', () => board);

import { forgetHeldArrangements, installArrangementSync, type ArrangementHost } from './arrangement-sync.ts';

const MATCH = 'm-000000000001';
const ALICE = 11;
const BOB = 22;

function view(bottom: number): BoardView {
  const players = [ALICE, BOB].map((id) => ({ id, isViewer: id === bottom, name: id === ALICE ? 'alice' : 'bob' }));
  return { title: 't', players: [...players].sort((a) => (a.isViewer ? -1 : 1)) } as unknown as BoardView;
}

/** A host with a stubbed wire: `fire` is what the server would relay. */
function host(over: Partial<ArrangementHost> & { seats?: Map<number, number> }): { host: ArrangementHost; fire: (payload: unknown) => void; wake: () => void } {
  let onEvent: ((payload: unknown) => void) | null = null;
  let onChange: (() => void) | null = null;
  const seats = over.seats ?? new Map([[0, ALICE], [1, BOB]]);
  const h: ArrangementHost = {
    matchId: MATCH,
    seat: null,
    playerOfSeat: (seat) => seats.get(seat) ?? null,
    transport: {
      on: (event: string, fn: (payload: unknown) => void) => {
        if (event === ARRANGEMENT_EVENT) onEvent = fn;
        return () => undefined;
      },
      emit: () => undefined,
    } as unknown as ArrangementHost['transport'],
    view: () => view(ALICE),
    layout: () => 'single' as never,
    watch: (fn) => {
      onChange = fn;
      return () => undefined;
    },
    ...over,
  };
  return { host: h, fire: (payload) => onEvent?.(payload), wake: () => onChange?.() };
}

const echo = (seat: number, rows: Record<string, number[][]>) => ({ matchId: MATCH, type: 'arrangement', layout: 'single', seat, rows });
const applied = () => board.applyTheirArrangement.mock.calls.map(([, playerId, rows]) => ({ playerId, rows }));

afterEach(() => {
  board.applyTheirArrangement.mockClear();
  forgetHeldArrangements();
});

describe('a watcher (no seat)', () => {
  it('applies each seat’s echo to that seat’s player — the bottom side included', () => {
    const h = host({});
    const handle = installArrangementSync(h.host);
    h.fire(echo(0, { lands: [[1], [2]] }));
    h.fire(echo(1, { lands: [[3, 4]] }));
    expect(applied()).toEqual([
      { playerId: ALICE, rows: { lands: [[1], [2]] } },
      { playerId: BOB, rows: { lands: [[3, 4]] } },
    ]);
    handle.dispose();
  });

  it('routes by seat whichever side is drawn at the bottom', () => {
    let bottom = ALICE;
    const h = host({ view: () => view(bottom) });
    const handle = installArrangementSync(h.host);
    h.fire(echo(1, { lands: [[3]] }));
    bottom = BOB;
    h.fire(echo(1, { lands: [[3], [4]] }));
    h.fire(echo(0, { lands: [[1]] }));
    expect(applied().map((a) => a.playerId)).toEqual([BOB, BOB, ALICE]);
    handle.dispose();
  });

  it('holds both seats’ echoes until the seat table names them, then applies both', () => {
    const seats = new Map<number, number>();
    const h = host({ seats });
    const handle = installArrangementSync(h.host);
    h.fire(echo(0, { lands: [[1]] }));
    h.fire(echo(1, { lands: [[3]] }));
    expect(applied(), 'nothing is guessed for a watcher').toEqual([]);
    seats.set(0, ALICE);
    seats.set(1, BOB);
    h.wake();
    expect(applied()).toEqual([
      { playerId: ALICE, rows: { lands: [[1]] } },
      { playerId: BOB, rows: { lands: [[3]] } },
    ]);
    h.wake();
    expect(applied(), 'applied once each').toHaveLength(2);
    handle.dispose();
  });

  it('an echo held by a disposed handle is applied by the next one — the join’s replay lands before the role re-installs the sync', () => {
    const seats = new Map<number, number>();
    const first = host({ seats });
    const h1 = installArrangementSync(first.host);
    first.fire(echo(0, { lands: [[1]] }));
    first.fire(echo(1, { lands: [[3]] }));
    h1.dispose();
    expect(applied()).toEqual([]);
    seats.set(0, ALICE);
    seats.set(1, BOB);
    const second = host({ seats });
    const h2 = installArrangementSync(second.host);
    second.wake();
    expect(applied()).toEqual([
      { playerId: ALICE, rows: { lands: [[1]] } },
      { playerId: BOB, rows: { lands: [[3]] } },
    ]);
    h2.dispose();
    const third = host({ seats });
    const h3 = installArrangementSync(third.host);
    third.wake();
    expect(applied(), 'applied once, not again by a later handle').toHaveLength(2);
    h3.dispose();
  });

  it('keeps the latest echo per seat while waiting', () => {
    const seats = new Map<number, number>();
    const h = host({ seats });
    const handle = installArrangementSync(h.host);
    h.fire(echo(0, { lands: [[1]] }));
    h.fire(echo(0, { lands: [[1], [2]] }));
    seats.set(0, ALICE);
    h.wake();
    expect(applied()).toEqual([{ playerId: ALICE, rows: { lands: [[1], [2]] } }]);
    handle.dispose();
  });
});

describe('a seated window', () => {
  it('drops its own seat’s echo and applies the other seat’s to its player', () => {
    const h = host({ seat: 0 });
    const handle = installArrangementSync(h.host);
    h.fire(echo(0, { lands: [[1]] }));
    h.fire(echo(1, { lands: [[3]] }));
    expect(applied()).toEqual([{ playerId: BOB, rows: { lands: [[3]] } }]);
    handle.dispose();
  });

  it('holds the other seat’s echo until the seat table names it — no guess at "the other player"', () => {
    const seats = new Map<number, number>();
    const h = host({ seat: 0, seats });
    const handle = installArrangementSync(h.host);
    h.fire(echo(1, { lands: [[3]] }));
    expect(applied()).toEqual([]);
    seats.set(0, ALICE);
    seats.set(1, BOB);
    h.wake();
    expect(applied()).toEqual([{ playerId: BOB, rows: { lands: [[3]] } }]);
    handle.dispose();
  });

  it('ignores another match’s echo', () => {
    const h = host({ seat: 0 });
    const handle = installArrangementSync(h.host);
    h.fire({ ...echo(1, { lands: [[3]] }), matchId: 'm-000000000002' });
    expect(applied()).toEqual([]);
    handle.dispose();
  });
});

// @vitest-environment jsdom
/*
 * A finished draft goes straight to the deck builder, and the builder carries
 * the pod's `building` phase until rounds start.
 *
 * `PodScreen` is driven over a stub draft transport (the same three methods
 * `draft/socket.test.ts` uses) and a stub `PodSource`, so the draft's own
 * payloads and the room's pod phase arrive exactly when a case says. The
 * payloads are the committed fixture `seat0-pack1-pick2.json`; "complete" is
 * that same seat with its pack gone and its pool at `packCount × packSize`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { DRAFT_CHANNEL, stateMessage, type DraftView } from '@hadoku/shared';

import { loadFixtures } from '../draft/fixtures.ts';
import type { DraftTransport } from '../draft/socket.ts';
import type { DeckStoreClient } from '../deck/deckStore.ts';
import { PodScreen } from './PodScreen.tsx';
import { DeckScreen } from './DeckScreen.tsx';
import { navigate, parseRoute } from './route.ts';
import type { PodContext, PodSource } from './pod/client.ts';
import { POD_SEATS, type PodView } from './pod/wire.ts';

const ROOM = 'r-pod';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.location.hash = '';
});

/* ── the draft socket ─────────────────────────────────────────────────── */

function stubTransport() {
  const handlers = new Map<string, ((payload: unknown) => void)[]>();
  const transport: DraftTransport = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    emit() {},
    disconnect() {},
  };
  const send = (view: DraftView) => {
    act(() => {
      for (const h of handlers.get(DRAFT_CHANNEL.serverToClient) ?? []) h(stateMessage(view));
    });
  };
  return { make: () => transport, send };
}

const MID = loadFixtures()[1]!;

/** Seat 0, every pick made: no pack, and a pool as big as the draft. */
function complete(seq = MID.seq + 1): DraftView {
  if (MID.viewer.kind !== 'seat') throw new Error('fixture is not a seat');
  const seatId = MID.viewer.seatId;
  const pool = MID.viewer.pack.slice(0, 3);
  const seats = MID.seats.map((s) => (s.id === seatId ? { ...s, pickedCount: pool.length } : s));
  return { ...MID, seq, packCount: 1, packSize: pool.length, waitingOn: [], seats, viewer: { ...MID.viewer, pack: [], pool } };
}

/* ── the room's pod phase ─────────────────────────────────────────────── */

function stubPodSource() {
  const readers = new Set<(ctx: PodContext) => void>();
  const source: PodSource = {
    follow(_roomId, onRead) {
      readers.add(onRead);
      return () => readers.delete(onRead);
    },
  };
  const read = (ctx: PodContext) => {
    act(() => {
      for (const r of readers) r(ctx);
    });
  };
  return { source, read };
}

function pod(over: Partial<PodView>): PodView {
  return {
    phase: 'building',
    seats: Array.from({ length: POD_SEATS }, () => null),
    round: 0,
    rounds: 2,
    results: [],
    standings: [],
    pairings: [],
    bye: null,
    drafters: [],
    built: [],
    ...over,
  };
}

const ctxOf = (p: PodView | null, tables: PodContext['tables'] = []): PodContext => ({
  pod: p,
  tables,
  names: { 'u-alice': 'Alice', 'u-bob': 'Bob' },
  me: 'u-alice',
  name: 'Cube night',
});

/* ── PodScreen ───────────────────────────────────────────────────────── */

function mountPod() {
  navigate({ kind: 'room', roomId: ROOM });
  const draft = stubTransport();
  const room = stubPodSource();
  render(createElement(PodScreen, { draftId: ROOM, makeTransport: draft.make, podSource: room.source }));
  return { draft, room };
}

const route = () => parseRoute(globalThis.location.hash);
const BUILDER = { kind: 'deck', draftId: ROOM };

describe('a finished draft goes straight to the builder', () => {
  it('on the last pick, with no press and no screen in between', () => {
    const { draft, room } = mountPod();
    room.read(ctxOf(pod({ phase: 'drafting' })));
    draft.send(MID);
    expect(route()).toEqual({ kind: 'room', roomId: ROOM });
    expect(screen.getByTestId('pod')).toBeTruthy();

    draft.send(complete());
    expect(route()).toEqual(BUILDER);
  });

  it('on a reload of a room whose draft is already over for you', () => {
    const { draft, room } = mountPod();
    draft.send(complete());
    room.read(ctxOf(pod({ phase: 'building' })));
    expect(route()).toEqual(BUILDER);
  });

  it('while the other humans are still drafting', () => {
    const { draft, room } = mountPod();
    room.read(ctxOf(pod({ phase: 'drafting' })));
    draft.send(complete());
    expect(route()).toEqual(BUILDER);
  });

  it('when the room has no pod to read', () => {
    const { draft, room } = mountPod();
    draft.send(complete());
    room.read(ctxOf(null));
    expect(route()).toEqual(BUILDER);
  });

  it('replaces the pod in history, so Back from the builder does not bounce', () => {
    const { draft, room } = mountPod();
    const depth = globalThis.history.length;
    room.read(ctxOf(pod({ phase: 'building' })));
    draft.send(complete());
    expect(route()).toEqual(BUILDER);
    expect(globalThis.history.length).toBe(depth);
  });

  it('waits for the room’s first read before deciding', () => {
    const { draft, room } = mountPod();
    draft.send(complete());
    expect(route()).toEqual({ kind: 'room', roomId: ROOM });
    room.read(ctxOf(pod({ phase: 'building' })));
    expect(route()).toEqual(BUILDER);
  });

  it('stays on the pod once it is playing rounds, and shows the tables', () => {
    const { draft, room } = mountPod();
    room.read(ctxOf(pod({ phase: 'rounds', round: 1 })));
    draft.send(complete());
    expect(route()).toEqual({ kind: 'room', roomId: ROOM });
    expect(screen.getByTestId('pod-rounds')).toBeTruthy();
  });

  it('stays on the pod once it is done, and shows the final standings', () => {
    const { draft, room } = mountPod();
    room.read(ctxOf(pod({ phase: 'done', round: 2 })));
    draft.send(complete());
    expect(route()).toEqual({ kind: 'room', roomId: ROOM });
    expect(screen.getByTestId('pod-final')).toBeTruthy();
  });

  it('does not move a drafter who still has picks to make', () => {
    const { draft, room } = mountPod();
    room.read(ctxOf(pod({ phase: 'drafting' })));
    draft.send(MID);
    expect(route()).toEqual({ kind: 'room', roomId: ROOM });
  });
});

/* ── into the game, with nobody pressing anything ───────────────────── */

describe('in rounds, my table starts by itself', () => {
  const myTable = { id: 't-2', players: [{ seat: 0 as const, memberId: 'u-alice', name: 'Alice' }], matchId: null, series: { length: 3 as const, wins: [0, 0] as [number, number], games: [], phase: 'seating' as const } };
  const roomsDefault = { ...myTable, id: 't-1', players: [] };

  /**
   * The server's own `you.id`, not whoami: an admin session's whoami id is
   * not its member id, and on 2026-10-19 (r-25e3eb4baa00) the table was
   * never found and the AI game never started.
   */
  it('finds my table by the room’s own id for me and starts the AI game at it', async () => {
    const posts: { url: string; body: string }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      posts.push({ url: String(input), body: String(init?.body ?? '') });
      return Promise.resolve(new Response(JSON.stringify({ matchId: 'm-000000000001' }), { status: 201 }));
    });
    const { draft, room } = mountPod();
    draft.send(complete());
    room.read(ctxOf(pod({ phase: 'rounds', round: 1, rounds: 1, pairings: [{ tableId: 't-2', players: ['u-alice', 'ai'] }] }), [roomsDefault, myTable]));
    await vi.waitFor(() => expect(posts.some((p) => p.url.endsWith('/play/matches'))).toBe(true));
    expect(JSON.parse(posts.find((p) => p.url.endsWith('/play/matches'))!.body)).toEqual({ room: ROOM, bot: true, table: 't-2' });
  });

  it('lists only the pod’s own tables, not the room’s unused first table', () => {
    const { draft, room } = mountPod();
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    draft.send(complete());
    room.read(ctxOf(pod({ phase: 'rounds', round: 1, rounds: 1, pairings: [{ tableId: 't-2', players: ['u-alice', 'ai'] }] }), [roomsDefault, myTable]));
    expect(screen.getAllByTestId('pod-tables-row').map((r) => r.dataset.tableId)).toEqual(['t-2']);
  });
});

/* ── DeckScreen carries `building` ───────────────────────────────────── */

/** The pool never arrives: these cases are about the pod panel above the editor, not the editor. */
const store: DeckStoreClient = {
  mine: () => new Promise(() => {}),
  save: () => new Promise(() => {}),
};

function mountDeck() {
  navigate({ kind: 'deck', draftId: ROOM });
  const room = stubPodSource();
  render(createElement(DeckScreen, { draftId: ROOM, store, podSource: room.source }));
  return room;
}

describe('the builder carries the pod’s building phase', () => {
  it('shows who has built and who is still building', () => {
    const room = mountDeck();
    room.read(ctxOf(pod({ drafters: ['u-alice', 'u-bob'], built: ['u-alice'] })));
    expect(screen.getByTestId('pod-built-u-alice').dataset.built).toBe('');
    expect(screen.getByTestId('pod-built-u-bob').dataset.built).toBeUndefined();
    expect(screen.getByTestId('pod-built-u-alice-pill').textContent).toContain('Alice — ready');
    expect(screen.getByTestId('pod-built-u-bob-pill').textContent).toContain('Bob — building');
  });

  it('has no Start round 1 for anyone — the last drafter’s Play deals it', () => {
    const room = mountDeck();
    room.read(ctxOf(pod({ drafters: ['u-alice', 'u-bob'], built: ['u-alice', 'u-bob'] })));
    expect(screen.getByTestId('pod-building')).toBeTruthy();
    expect(screen.queryByTestId('pod-start-rounds')).toBeNull();
  });

  it('draws no pod panel outside building', () => {
    const room = mountDeck();
    for (const phase of ['drafting', 'done'] as const) {
      room.read(ctxOf(pod({ phase, drafters: ['u-alice'] })));
      expect(screen.queryByTestId('pod-building')).toBeNull();
      expect(route()).toEqual(BUILDER);
    }
  });

  it('hands the drafter back to the room once rounds start', () => {
    const room = mountDeck();
    room.read(ctxOf(pod({ drafters: ['u-alice'], built: ['u-alice'] })));
    expect(route()).toEqual(BUILDER);
    room.read(ctxOf(pod({ phase: 'rounds', round: 1, drafters: ['u-alice'], built: ['u-alice'] })));
    expect(route()).toEqual({ kind: 'room', roomId: ROOM });
  });
});

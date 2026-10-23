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
import { forgetMatchesFollowed } from '../play/live/matchStart.ts';
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
  forgetMatchesFollowed();
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
    personas: {},
    // wave 73 §A step 6: PodView gains these three. Minimal valid default only
    // — B's own lane fills in the real picker/verdict fixtures on rebase.
    plan: { rounds: [{ kind: 'cube', cubeId: 'default' }, { kind: 'cube', cubeId: 'default' }, { kind: 'cube', cubeId: 'default' }] },
    planName: 'Test Cube',
    verdict: null,
    ...over,
  };
}

const ctxOf = (p: PodView | null, tables: PodContext['tables'] = []): PodContext => ({
  pod: p,
  tables,
  names: { 'u-alice': 'Alice', 'u-bob': 'Bob' },
  members: [],
  leaderId: '',
  avatars: {},
  me: 'u-alice',
  name: 'Cube night',
  leader: false,
  gone: false,
});

/* ── PodScreen ───────────────────────────────────────────────────────── */

/** The hub, or with `tableId` that table's page (`Screen.tsx` passes the route's). */
function mountPod(tableId?: string) {
  navigate({ kind: 'room', roomId: ROOM, tableId });
  const draft = stubTransport();
  const room = stubPodSource();
  render(createElement(PodScreen, { draftId: ROOM, tableId, makeTransport: draft.make, podSource: room.source }));
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

  // The operator, 2026-10-20: "ideally it brings me to the game lobby until my opponent is ready".
  it('keeps a drafter who has pressed Play on the pod — who is ready, the bracket, the way back to the deck — until round 1 is dealt', () => {
    const { draft, room } = mountPod();
    draft.send(complete());
    room.read(ctxOf(pod({ phase: 'building', drafters: ['u-alice', 'u-bob'], built: ['u-alice'] })));
    expect(route()).toEqual({ kind: 'room', roomId: ROOM });
    expect(screen.getByTestId('pod-ready')).toBeTruthy();
    expect(screen.getByTestId('pod-built-u-alice').hasAttribute('data-built')).toBe(true);
    expect(screen.getByTestId('pod-built-u-bob').hasAttribute('data-built')).toBe(false);
    expect(screen.getAllByTestId('pod-bracket-round').every((r) => r.dataset.state === 'next')).toBe(true);
    expect(screen.getByTestId('pod-edit-deck').getAttribute('href')).toBe('#/deck/' + ROOM);

    // Bob's Play deals round 1: the same screen becomes the rounds.
    room.read(ctxOf(pod({ phase: 'rounds', round: 1, drafters: ['u-alice', 'u-bob'], built: ['u-alice', 'u-bob'] })));
    expect(route()).toEqual({ kind: 'room', roomId: ROOM });
    expect(screen.getByTestId('pod-rounds')).toBeTruthy();
  });

  it('does not move a drafter who still has picks to make', () => {
    const { draft, room } = mountPod();
    room.read(ctxOf(pod({ phase: 'drafting' })));
    draft.send(MID);
    expect(route()).toEqual({ kind: 'room', roomId: ROOM });
  });
});

/* ── until the table arrives (the operator, 2026-10-20: "so i dont see the page change so many times") ── */

describe('entering a pod before its table has arrived', () => {
  it('draws the draft’s own layout as a skeleton, the room’s bar already in its side column, and no words', () => {
    const { draft, room } = mountPod();
    room.read(ctxOf(pod({ phase: 'drafting' })));
    const waiting = screen.getByTestId('pod-waiting');
    expect(waiting.textContent).not.toMatch(/joining|waiting/i);
    expect(waiting.querySelector('.skeleton')).not.toBeNull();
    expect(screen.getByTestId('pod-seats').closest('.draft__aside'), 'the bar is where the draft puts it').not.toBeNull();
    expect(document.querySelector('header.pod__bar'), 'nothing on top to move away').toBeNull();

    draft.send(MID);
    expect(screen.queryByTestId('pod-waiting')).toBeNull();
    expect(screen.getByTestId('pod-seats').closest('.draft__aside'), 'the bar has not moved').not.toBeNull();
  });

  // thyeggman, 2026-10-20: a member who never drafted opened the room in rounds and got nothing.
  it('draws the rounds from the room alone — a member with no drafted pool watches them too', () => {
    const { room } = mountPod();
    room.read(ctxOf(pod({ phase: 'rounds', round: 1, rounds: 3 })));
    expect(screen.queryByTestId('pod-waiting')).toBeNull();
    expect(screen.getAllByTestId('pod-bracket-round')).toHaveLength(3);
    expect(document.querySelector('header.pod__bar')).not.toBeNull();
  });
});

/* ── spectators (the operator, 2026-10-21: "i like showing that there are spectators in the draft process") ── */

describe('the pod names its spectators', () => {
  const members = [
    { id: 'u-alice', name: 'Alice' },
    { id: 'u-bob', name: 'Bob' },
    { id: 'u-carol', name: 'Carol' },
  ];
  // Past the lobby the server sends every seat empty and the players as `drafters`.
  const spectated = (phase: PodView['phase']) => ({ ...ctxOf(pod({ phase, round: 1, drafters: ['u-alice', 'u-bob'] })), members, leaderId: 'u-carol' });
  const named = () => screen.getAllByTestId('pod-spectator').map((r) => r.dataset['member']);

  it.each(['drafting', 'rounds'] as const)('while %s: each member who is not a drafter, the owner with the crown', (phase) => {
    const { draft, room } = mountPod();
    room.read(spectated(phase));
    if (phase === 'drafting') draft.send(MID);
    expect(named()).toEqual(['u-carol']);
    expect(screen.getByTestId('pod-spectator').querySelector('.tables__crown'), 'the room owner wears the crown').not.toBeNull();
  });

  it('draws nothing while nobody is watching', () => {
    const { room } = mountPod();
    room.read({ ...spectated('rounds'), members: members.slice(0, 2) });
    expect(screen.getAllByTestId('pod-bracket-round').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('pod-spectators')).toBeNull();
  });
});

/* ── into the game, with nobody pressing anything ───────────────────── */

describe('in rounds, I am carried to my table page once, and my table starts by itself there', () => {
  const myTable = { id: 't-2', players: [{ seat: 0 as const, memberId: 'u-alice', name: 'Alice' }], matchId: null, series: { length: 3 as const, wins: [0, 0] as [number, number], games: [], phase: 'seating' as const } };
  const roomsDefault = { ...myTable, id: 't-1', players: [] };

  /**
   * The server's own `you.id`, not whoami: an admin session's whoami id is
   * not its member id, and on 2026-10-19 (r-25e3eb4baa00) the table was
   * never found and the AI game never started.
   */
  it('finds my table by the room’s own id for me, and the hub sends me to its page without starting anything', () => {
    const posts: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (init?.method === 'POST') posts.push(String(input));
      return new Promise(() => {});
    });
    const { draft, room } = mountPod();
    draft.send(complete());
    room.read(ctxOf(pod({ phase: 'rounds', round: 1, rounds: 1, pairings: [{ tableId: 't-2', players: ['u-alice', 'ai'] }] }), [roomsDefault, myTable]));
    expect(route()).toEqual({ kind: 'room', roomId: ROOM, tableId: 't-2' });
    expect(posts).toEqual([]);
  });

  it('starts the AI game on my table’s page', async () => {
    const posts: { url: string; body: string }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      posts.push({ url: String(input), body: String(init?.body ?? '') });
      return Promise.resolve(new Response(JSON.stringify({ matchId: 'm-000000000001' }), { status: 201 }));
    });
    const { draft, room } = mountPod('t-2');
    draft.send(complete());
    room.read(ctxOf(pod({ phase: 'rounds', round: 1, rounds: 1, pairings: [{ tableId: 't-2', players: ['u-alice', 'ai'] }] }), [roomsDefault, myTable]));
    expect(screen.getByTestId('table-page').dataset.tableId).toBe('t-2');
    await vi.waitFor(() => expect(posts.some((p) => p.url.endsWith('/play/matches'))).toBe(true));
    expect(JSON.parse(posts.find((p) => p.url.endsWith('/play/matches'))!.body)).toEqual({ room: ROOM, bot: true, table: 't-2' });
  });

  it('sends a page for a table the room does not have back to the hub', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    const { draft, room } = mountPod('t-9');
    draft.send(complete());
    room.read(ctxOf(pod({ phase: 'rounds', round: 1, rounds: 1 }), [myTable]));
    expect(route()).toEqual({ kind: 'room', roomId: ROOM });
  });

  it('lists only the pod’s own tables, not the room’s unused first table', () => {
    const { draft, room } = mountPod();
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    draft.send(complete());
    room.read(ctxOf(pod({ phase: 'rounds', round: 1, rounds: 1, pairings: [{ tableId: 't-2', players: ['u-alice', 'ai'] }] }), [roomsDefault, myTable]));
    expect(screen.getAllByTestId('pod-tables-row').map((r) => r.dataset.tableId)).toEqual(['t-2']);
  });
});

/* ── coming back to the room mid-series (the rejoin audit, 2026-10-19) ── */

describe('my table’s page is where a player comes back to', () => {
  const series = (phase: 'seating' | 'playing' | 'sideboarding' | 'done', games: { matchId: string; winner: 0 | 1 | null }[] = []) => ({
    length: 3 as const,
    wins: [0, games.length] as [number, number],
    games,
    phase,
  });
  const players = [
    { seat: 0 as const, memberId: 'u-alice', name: 'Alice' },
    { seat: 1 as const, memberId: 'u-bob', name: 'Bob' },
  ];
  const rounds = (tableId: string) => pod({ phase: 'rounds', round: 2, rounds: 2, pairings: [{ tableId, players: ['u-alice', 'u-bob'] }] });

  it('opens my sideboard step between games, on my table’s page, and starts game 2 once both have readied', async () => {
    const DCK = '[metadata]\nName=Mine\n[main]\n40 Plains\n';
    let bothReady = false;
    const asked: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      asked.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/tables/rooms/') && (init?.method ?? 'GET') === 'GET') {
        const you = { seat: 0, name: 'Alice', you: true, ready: bothReady, deck: { name: 'Mine', rulesName: 'pool', legal: true, issueCount: 0, choice: { deck: { dck: DCK }, rules: { kind: 'draft', draftId: ROOM } } } };
        const them = { seat: 1, name: 'Bob', you: false, ready: bothReady };
        return Promise.resolve(new Response(JSON.stringify({ room: { id: ROOM, name: 'Cube night', format: `draft:${ROOM}`, matchId: null, locked: false, phase: 'sideboarding' }, players: [you, them] }), { status: 200 }));
      }
      if (url.endsWith(`/drafts/${ROOM}/mine`)) return Promise.resolve(new Response(JSON.stringify({ pool: [], deck: DCK }), { status: 200 }));
      if (url.endsWith('/play/matches')) return Promise.resolve(new Response(JSON.stringify({ matchId: 'm-000000000002' }), { status: 201 }));
      return new Promise(() => {});
    });
    const { draft, room } = mountPod('t-2');
    draft.send(complete());
    const mine = { id: 't-2', players, matchId: null, series: series('sideboarding', [{ matchId: 'm-000000000001', winner: 1 }]) };
    room.read(ctxOf(rounds('t-2'), [mine]));
    await vi.waitFor(() => expect(screen.getByTestId('table-sideboard')).toBeTruthy());
    expect(screen.getByTestId('sideboard-step')).toBeTruthy();
    expect(screen.queryByTestId('pod-standings')).toBeNull();
    expect(asked.some((a) => a.endsWith('/play/matches'))).toBe(false);

    // Both ready (the other on their result screen, me here): the room moves, and asks for game 2.
    bothReady = true;
    room.read(ctxOf(rounds('t-2'), [{ ...mine }]));
    await vi.waitFor(() => expect(asked.filter((a) => a.endsWith('/play/matches'))).toEqual([expect.stringContaining('POST')]));
  });

  it('starts my game again when it died mid-series (`playing`, no match)', async () => {
    const posts: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (init?.method === 'POST') posts.push(url);
      if (url.endsWith('/ready')) return Promise.resolve(new Response(JSON.stringify({ room: { id: ROOM, matchId: null }, players: [] }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ matchId: 'm-000000000003' }), { status: 201 }));
    });
    const { draft, room } = mountPod('t-2');
    draft.send(complete());
    room.read(ctxOf(rounds('t-2'), [{ id: 't-2', players, matchId: null, series: series('playing', [{ matchId: 'm-000000000001', winner: 0 }]) }]));
    await vi.waitFor(() => expect(posts.some((u) => u.endsWith('/play/matches'))).toBe(true));
  });

  it('carries me into my game once; back on the hub, I stay, and my table card is the way back', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    const live = { id: 't-2', players, matchId: 'm-000000000007', series: series('playing') };
    let mounted = mountPod('t-2');
    mounted.draft.send(complete());
    mounted.room.read(ctxOf(rounds('t-2'), [live]));
    expect(route()).toEqual({ kind: 'match', matchId: 'm-000000000007' });
    cleanup();
    mounted = mountPod();
    mounted.draft.send(complete());
    mounted.room.read(ctxOf(rounds('t-2'), [live]));
    expect(route()).toEqual({ kind: 'room', roomId: ROOM });
    expect(screen.getByTestId('pod-tables-play').getAttribute('href')).toBe(`#/room/${ROOM}/table/t-2`);
  });

  it('lets a watcher’s table page follow the match too', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    const others = [
      { seat: 0 as const, memberId: 'u-bob', name: 'Bob' },
      { seat: 1 as const, memberId: 'u-carol', name: 'Carol' },
    ];
    const { room } = mountPod('t-4');
    room.read(ctxOf(pod({ phase: 'rounds', round: 1, rounds: 2, pairings: [{ tableId: 't-4', players: ['u-bob', 'u-carol'] }] }), [{ id: 't-4', players: others, matchId: 'm-000000000008', series: series('playing') }]));
    expect(route()).toEqual({ kind: 'match', matchId: 'm-000000000008' });
  });

  it('keeps every table the pod has played at in its round: earlier ones finished, this round live', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    const { draft, room } = mountPod();
    draft.send(complete());
    const earlier = { id: 't-1', players, matchId: null, series: series('done', [{ matchId: 'm-a', winner: 0 }, { matchId: 'm-b', winner: 0 }]) };
    const now = { id: 't-3', players, matchId: 'm-000000000009', series: series('playing') };
    const results = [{ round: 1, playerA: 'u-alice', playerB: 'u-bob', gamesA: 2, gamesB: 0 }];
    room.read(ctxOf({ ...rounds('t-3'), results }, [{ id: 't-0', players: [], matchId: null, series: series('seating') }, earlier, now]));
    const rows = screen.getAllByTestId('pod-tables-row');
    expect(rows.map((r) => [r.dataset.tableId, r.dataset.phase])).toEqual([
      ['t-1', 'done'],
      ['t-3', 'playing'],
    ]);
    expect(screen.getAllByTestId('pod-bracket-round').map((r) => r.dataset.state)).toEqual(['past', 'now']);
  });

  it('keeps the tables beside the final standings once the pod is done', () => {
    const { draft, room } = mountPod();
    draft.send(complete());
    const earlier = { id: 't-1', players, matchId: null, series: series('done', [{ matchId: 'm-a', winner: 0 }]) };
    room.read(ctxOf(pod({ phase: 'done', round: 3, rounds: 2, results: [{ round: 1, playerA: 'u-alice', playerB: 'u-bob', gamesA: 1, gamesB: 0 }] }), [earlier]));
    expect(screen.getByTestId('pod-final')).toBeTruthy();
    expect(screen.getAllByTestId('pod-tables-row').map((r) => r.dataset.tableId)).toEqual(['t-1']);
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

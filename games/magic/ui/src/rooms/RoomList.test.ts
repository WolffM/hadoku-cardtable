// @vitest-environment jsdom
/*
 * The two things `RoomList.tsx` decides on its own (everything else is `rooms.test.ts`'s, which
 * this file does not duplicate):
 *
 *   - the e2e-only `e2e-toy-relay` entry is never offered by Create room's radio in a real
 *     browser, even with Experimental features on — `window.__cardtableE2eToyGames` is the one
 *     escape, set only by `e2e/external-game-room.spec.ts`'s own `addInitScript`;
 *   - the room list's own scroll telemetry (`./scroll-watch.ts`) is still wired onto the list's
 *     real `<section>` — moved out of this file's own `useEffect` into `onSectionRef`
 *     (`@hadoku/game-ui/front/RoomFront.tsx`'s own escape hatch) during wave 120 §F, and a red
 *     claw run (`e2e/front-scroll-perf.spec.ts`) once caught it dropped entirely.
 */

import { OPEN_ROOM_LOCKS } from '@hadoku/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { RoomList } from './RoomList.tsx';
import { roomsClient, type Fetch, type RoomView } from './api.ts';
import type { RoomFeed } from '@hadoku/game-ui/rooms/feed.ts';
import type { ScrollWatchHost } from './scroll-watch.ts';

afterEach(() => {
  cleanup();
  delete (globalThis as { __cardtableE2eToyGames?: boolean }).__cardtableE2eToyGames;
  savedPrefs.current = {};
  scrollWatch.hosts.length = 0;
  scrollWatch.stops.length = 0;
});

/**
 * `watchScroll` itself is `scroll-watch.test.ts`'s own — a fake host, every burst/idle/drop rule.
 * This file only has to prove `RoomList.tsx` still CALLS it, with a host that finds the real
 * section and stops it on unmount; mocked so a real scroll's timing (`IDLE_MS`, `MIN_SCROLL_MS`)
 * is never this file's problem.
 */
const scrollWatch = vi.hoisted(() => ({ hosts: [] as ScrollWatchHost[], stops: [] as ReturnType<typeof vi.fn>[] }));
vi.mock('./scroll-watch.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./scroll-watch.ts')>()),
  watchScroll: (host: ScrollWatchHost) => {
    scrollWatch.hosts.push(host);
    const stop = vi.fn();
    scrollWatch.stops.push(stop);
    return stop;
  },
}));

const savedPrefs = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@wolffm/prefs-client/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wolffm/prefs-client/react')>()),
  usePrefs: () => ({ prefs: savedPrefs.current, save: () => Promise.resolve(), loading: false, error: null }),
}));
vi.mock('@wolffm/prefs-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wolffm/prefs-client')>()),
  whoami: () => Promise.resolve({ userId: 'u-alice', userType: 'friend' as const, name: 'Alice' }),
}));

const quietFeed: RoomFeed = {
  follow: (_target, refresh) => {
    refresh();
    return () => undefined;
  },
};

function client() {
  const fetchImpl: Fetch = async () => new Response(JSON.stringify({ rooms: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  return roomsClient(fetchImpl, '/cardtable/api/');
}

/** A well-formed `RoomView`, same shape `rooms.test.ts`'s own `room()` builds. */
const room = (over: Partial<RoomView> & { id: string; name: string }): RoomView => ({
  creator: 'http-a',
  leader: 'http-a',
  gameType: 'constructed-1v1',
  settings: { handSmoothing: true, tournament: false, tournamentDecks: 'locked', clock: 'auto' as const, pickTimer: { on: false, speed: 1 }, draftBots: 'model' as const, botsPlay: true },
  locks: { ...OPEN_ROOM_LOCKS },
  you: { id: 'http-a', leader: true, ready: false },
  locked: false,
  members: [{ id: 'http-a', name: 'alice', joinedAt: '2026-09-19T00:00:00.000Z', ready: false }],
  seats: [],
  matchId: null,
  createdAt: '2026-09-19T00:00:00.000Z',
  tables: [],
  testing: false,
  scheduledFor: null,
  game: { format: '2011-02-13', mode: null, modeOptions: null, clientMode: 'builtin', draftStartedAt: null, pod: null },
  ...over,
});

const mount = () => render(createElement(RoomList, { client: client(), feed: quietFeed }));

describe('the e2e-only external-game entry, with Experimental features on', () => {
  it('is never offered without the client-side e2e flag', async () => {
    savedPrefs.current = { experimental: true };
    mount();
    await screen.findByTestId('rooms-empty');
    fireEvent.click(screen.getByTestId('room-create-open'));
    await screen.findByTestId('room-create-type');
    expect(screen.queryByTestId('room-create-type-e2e-toy-relay')).toBeNull();
    // The real external game and Challenge are still offered — this is not the experimental gate itself.
    expect(screen.getByTestId('room-create-type-bomberman')).toBeTruthy();
    expect(screen.getByTestId('room-create-type-challenge')).toBeTruthy();
  });

  it('is offered once the e2e harness sets the flag', async () => {
    savedPrefs.current = { experimental: true };
    (globalThis as { __cardtableE2eToyGames?: boolean }).__cardtableE2eToyGames = true;
    mount();
    await screen.findByTestId('rooms-empty');
    fireEvent.click(screen.getByTestId('room-create-open'));
    await waitFor(() => expect(screen.getByTestId('room-create-type-e2e-toy-relay')).toBeTruthy());
  });
});

describe('the room list’s scroll telemetry', () => {
  it('attaches watchScroll to the real rooms section, and stops it when the list unmounts', async () => {
    const { unmount } = mount();
    await screen.findByTestId('rooms-empty');

    expect(scrollWatch.hosts).toHaveLength(1);
    const host = scrollWatch.hosts[0]!;
    const section = screen.getByTestId('rooms');
    // The host finds a scroll by whether its target is the section itself (or something inside
    // it) — the exact check base `RoomList.tsx` always made, `target.contains(section)`.
    expect(host.scrolls(section)).toBe(true);
    expect(host.scrolls(document.createElement('div'))).toBe(false);
    expect(host.rooms()).toBe(0);
    expect(host.ui).toBe(__HADOKU_UI_VERSION__);

    expect(scrollWatch.stops[0]).not.toHaveBeenCalled();
    unmount();
    expect(scrollWatch.stops[0]).toHaveBeenCalledTimes(1);
  });

  it('reports how many rooms are on screen, the latest read’s count', async () => {
    const fetchImpl: Fetch = async () => new Response(JSON.stringify({ rooms: [room({ id: 'r-a', name: 'A' })] }), { status: 200, headers: { 'content-type': 'application/json' } });
    render(createElement(RoomList, { client: roomsClient(fetchImpl, '/cardtable/api/'), feed: quietFeed }));
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(1));
    expect(scrollWatch.hosts[0]!.rooms()).toBe(1);
  });
});

describe('a card’s colours', () => {
  it('are Magic’s, handed to RoomFront per row: one wash per format family, the same for the same family', async () => {
    const rooms = [room({ id: 'r-d1', name: 'D1', gameType: 'draft' }), room({ id: 'r-d2', name: 'D2', gameType: 'draft' }), room({ id: 'r-c', name: 'C' })];
    const fetchImpl: Fetch = async () => new Response(JSON.stringify({ rooms }), { status: 200, headers: { 'content-type': 'application/json' } });
    render(createElement(RoomList, { client: roomsClient(fetchImpl, '/cardtable/api/'), feed: quietFeed }));
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(3));
    const tint = (id: string): string => document.querySelector<HTMLElement>(`[data-room-id="${id}"]`)!.style.getPropertyValue('--room-front-tint');
    expect(tint('r-d1')).not.toBe('');
    expect(tint('r-c')).not.toBe('');
    expect(tint('r-d1')).toBe(tint('r-d2'));
    expect(tint('r-d1')).not.toBe(tint('r-c'));
  });
});

describe('a card’s player count', () => {
  it('is the members alone for a tournament, which grows past its seats, and members of seats for a duel', async () => {
    const tournament = room({ id: 'r-t', name: 'T', gameType: 'draft', seats: ['http-a', null, null, null, null, null, null, null] });
    const duel = room({ id: 'r-1v1', name: 'Duel', seats: ['http-a', null] });
    const fetchImpl: Fetch = async () => new Response(JSON.stringify({ rooms: [tournament, duel] }), { status: 200, headers: { 'content-type': 'application/json' } });
    render(createElement(RoomList, { client: roomsClient(fetchImpl, '/cardtable/api/'), feed: quietFeed }));
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(2));
    // The count, after the seat icon's own title.
    const seats = (id: string): string => /[\d/]+$/.exec(document.querySelector(`[data-room-id="${id}"] [data-testid="room-seats"]`)!.textContent ?? '')?.[0] ?? '';
    expect(seats('r-t')).toBe('1');
    expect(seats('r-1v1')).toBe('1/2');
  });
});

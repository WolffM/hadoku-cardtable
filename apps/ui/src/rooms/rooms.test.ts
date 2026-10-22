// @vitest-environment jsdom
/*
 * The front page's room list, driven through a stubbed `fetch`.
 *
 * The stub answers the way lane A's `apps/server/src/http/rooms.ts` is
 * specified to: `GET /rooms` → `{ rooms }`, `POST /rooms` → 201 RoomView,
 * `POST /rooms/:id/join` → 200 RoomView, and the SAME 404 for a wrong password
 * as for a missing room. What the real server does is its own test's job; this
 * file proves that what the server says reaches the person, and that what the
 * person does reaches the server.
 *
 * `.test.ts` + `createElement`, and the jsdom pragma on line 1, for the reasons
 * `screens/lobby.test.ts` gives.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { LobbyScreen } from '../screens/LobbyScreen.tsx';
import { parseRoute } from '../screens/route.ts';
import { resetRolePlayerForTests, setRolePlayer } from '../sound/index.ts';
import { MUTE_KEY, resetMutedForTests, setMuted } from '../sound/mute.ts';
import type { SoundEvent } from '../sound/mix.ts';
import {
  clientModeLabel,
  GAME_TYPES,
  parseRoomView,
  roomsClient,
  streamPath,
  streamRoot,
  streamReachable,
  type Fetch,
  type RoomView,
} from './api.ts';
import type { FeedTarget, RoomFeed } from './feed.ts';
import SERVER_BODIES from './room-bodies.fixture.json';

afterEach(() => {
  cleanup();
  globalThis.location.hash = '';
});

const room = (over: Partial<RoomView> & { id: string; name: string }): RoomView => ({
  creator: 'http-a',
  leader: 'http-a',
  gameType: 'constructed-1v1',
  // The table's pool, and what the caller is in this room (w25). Both are
  // always on the wire; `parseRoomView`'s defaults for a body that lost them
  // are asserted in "the pool and the caller" below.
  format: '2011-02-13',
  settings: { handSmoothing: true },
  mode: null,
  modeOptions: null,
  you: { id: 'http-a', leader: true, ready: false },
  clientMode: 'builtin',
  locked: false,
  members: [{ id: 'http-a', name: 'alice', joinedAt: '2026-09-19T00:00:00.000Z', ready: false }],
  matchId: null,
  draftStartedAt: null,
  createdAt: '2026-09-19T00:00:00.000Z',
  tables: [],
  pod: null,
  ...over,
});

const OPEN = room({ id: 'r-open', name: 'Friday night' });
const LOCKED = room({
  id: 'r-locked',
  name: 'Siblings keep out',
  locked: true,
  members: [
    { id: 'http-b', name: 'bob', joinedAt: '', ready: false },
    { id: 'http-c', name: 'carol', joinedAt: '', ready: false },
  ],
});

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A tiny rooms server. `password` is the one the locked room takes. */
function server(rooms: RoomView[], opts: { password?: string; listStatus?: number } = {}) {
  const calls: Call[] = [];
  const fetchImpl: Fetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url, method, body });
    const path = url.replace('/cardtable/api/', '');
    if (method === 'GET' && path === 'rooms') {
      return opts.listStatus !== undefined ? json(opts.listStatus, { error: 'boom' }) : json(200, { rooms });
    }
    if (method === 'POST' && path === 'rooms') {
      const b = body ?? {};
      return json(
        201,
        room({
          id: 'r-new',
          name: String(b.name),
          gameType: String(b.gameType),
          clientMode: b.clientMode === 'streamed' ? 'streamed' : 'builtin',
          locked: 'password' in b,
        }),
      );
    }
    const m = /^rooms\/([^/]+)\/join$/.exec(path);
    if (method === 'POST' && m !== null) {
      const target = rooms.find((r) => r.id === m[1]);
      const given = (body ?? {}).password;
      // One answer for both: a missing room and a wrong password.
      if (target === undefined || (target.locked && given !== opts.password)) return json(404, { error: 'no such room' });
      return json(200, target);
    }
    return json(500, { error: `unexpected ${method} ${url}` });
  };
  return { calls, client: roomsClient(fetchImpl, '/cardtable/api/') };
}

/*
 * No socket in a unit test: the page's own feed reads once and never pings.
 * `manualFeed` is the one a test drives by hand. `./feed.test.ts` tests the real one.
 */
vi.mock('./feed.ts', async (importOriginal) => {
  // One object, as the page's own is: a new feed per render would re-follow on every render.
  const quiet: RoomFeed = {
    follow: (_target, refresh) => {
      refresh();
      return () => undefined;
    },
  };
  return { ...(await importOriginal<typeof import('./feed.ts')>()), roomFeed: () => quiet };
});

function manualFeed(): RoomFeed & { ping(): void; targets(): FeedTarget[] } {
  const following = new Map<() => void, FeedTarget>();
  return {
    follow(target, refresh) {
      refresh();
      following.set(refresh, target);
      return () => following.delete(refresh);
    },
    ping: () => {
      for (const refresh of [...following.keys()]) refresh();
    },
    targets: () => [...following.values()],
  };
}

const mount = (client: ReturnType<typeof roomsClient>) => render(createElement(LobbyScreen, { rooms: client }));

/** Open the create dialog from its button at the foot of the list. */
const openCreate = (): void => {
  fireEvent.click(screen.getByTestId('room-create-open'));
};

const rowFor = (id: string): HTMLElement => {
  const row = screen.getAllByTestId('room-row').find((r) => r.getAttribute('data-room-id') === id);
  if (row === undefined) throw new Error(`no row for ${id}`);
  return row;
};

/* ── the four states ─────────────────────────────────────────────────── */

describe('the list', () => {
  it('renders every room from the server: name, type, who is in it, and whether it is locked', async () => {
    const { client, calls } = server([OPEN, LOCKED]);
    mount(client);

    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(2));
    expect(calls[0]).toEqual({ url: '/cardtable/api/rooms', method: 'GET', body: undefined });

    const open = rowFor('r-open');
    expect(within(open).getByTestId('room-name').textContent).toBe('Friday night');
    expect(within(open).getByTestId('room-type').textContent).toBe('Constructed');
    expect(within(open).getByTestId('room-members').textContent).toBe('alice');
    expect(within(open).queryByTestId('room-locked')).toBeNull();

    const locked = rowFor('r-locked');
    expect(within(locked).getByTestId('room-members').textContent).toBe('bob, carol');
    expect(within(locked).getByTestId('room-locked')).toBeTruthy();
  });

  it('shows a loading state that already offers Create room', () => {
    const never: Fetch = () => new Promise<Response>(() => {});
    mount(roomsClient(never, '/cardtable/api/'));
    expect(screen.getByTestId('rooms-loading')).toBeTruthy();
    openCreate();
    expect(screen.getByTestId('room-create-submit')).toBeTruthy();
  });

  it('keeps Firefox from offering anything in the room name: no form history, and not a login username', () => {
    const never: Fetch = () => new Promise<Response>(() => {});
    mount(roomsClient(never, '/cardtable/api/'));
    openCreate();
    // Form history is skipped when the FORM says off (FormHistoryChild.sys.mjs); the password
    // manager pairs a field with the password below it unless its token is outside this set
    // (LoginManager.shared.sys.mjs `isUsernameFieldType`), and "off" is inside it.
    expect(screen.getByTestId('room-create').getAttribute('autocomplete')).toBe('off');
    const token = screen.getByTestId('room-create-name').getAttribute('autocomplete') ?? '';
    expect(['', 'on', 'off', 'username', 'webauthn', 'email', 'tel', 'tel-national']).not.toContain(token);
  });

  it('shows an empty state with Create room right under it', async () => {
    const { client } = server([]);
    mount(client);
    const empty = await screen.findByTestId('rooms-empty');
    expect(empty.textContent).toContain('No rooms yet');
    expect(screen.queryByTestId('room-row')).toBeNull();
    expect(screen.getByTestId('room-create-open')).toBeTruthy();
  });

  it('shows a failure with a Retry that loads the list', async () => {
    let fail = true;
    const flaky: Fetch = async () => (fail ? json(503, { error: 'restarting' }) : json(200, { rooms: [OPEN] }));
    mount(roomsClient(flaky, '/cardtable/api/'));

    const alert = await screen.findByTestId('rooms-error');
    expect(alert.textContent).toContain('restarting');
    expect(screen.queryByTestId('room-row')).toBeNull();

    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(1));
    expect(screen.queryByTestId('rooms-error')).toBeNull();
  });

  it('reads again when the server says the list changed, and keeps the list when a later read fails', async () => {
    let rooms: RoomView[] = [OPEN];
    let fail = false;
    const fetchImpl: Fetch = async () => (fail ? json(503, {}) : json(200, { rooms }));
    const feed = manualFeed();
    render(createElement(LobbyScreen, { rooms: roomsClient(fetchImpl, '/cardtable/api/'), feed }));
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(1));
    expect(feed.targets(), 'the lobby follows the list').toEqual(['list']);

    rooms = [OPEN, LOCKED];
    await act(async () => {
      feed.ping();
    });
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(2));

    fail = true;
    await act(async () => {
      feed.ping();
    });
    await screen.findByTestId('rooms-stale');
    expect(screen.getAllByTestId('room-row')).toHaveLength(2);

    cleanup();
    expect(feed.targets(), 'leaving the lobby stops following').toEqual([]);
  });

  it('drops a malformed room rather than rendering undefined', () => {
    expect(parseRoomView({ ...OPEN, locked: 'yes' })).toBeNull();
    expect(parseRoomView({ ...OPEN, id: 'Not An Id!' })).toBeNull();
    expect(parseRoomView(OPEN)).toEqual(OPEN);
  });

  // Captured from `apps/server/src/http/rooms.test.ts`'s harness: a constructed
  // room with two members and a mode, and a locked draft room with its pod.
  it('reads the server’s own GET /api/rooms/:id bodies as themselves, less the AI it does not draw', () => {
    for (const [kind, body] of Object.entries(SERVER_BODIES)) {
      const { ai: _ai, ...view } = body;
      expect(parseRoomView(body), kind).toStrictEqual(view);
    }
  });
});

/* ── readiness and the draft's start (w23) ───────────────────────────── */

describe('the room’s readiness', () => {
  it('reads a member’s ready flag only from a boolean true, so an older server is not ready', () => {
    const withReady = { ...OPEN, members: [{ id: 'http-a', name: 'alice', joinedAt: '', ready: true }] };
    expect(parseRoomView(withReady)?.members[0].ready).toBe(true);

    // The shape a server that predates the field sends: no flag at all.
    const older: Record<string, unknown> = { ...OPEN, members: [{ id: 'http-a', name: 'alice', joinedAt: '' }] };
    expect(parseRoomView(older)?.members[0].ready).toBe(false);
    for (const near of ['true', 'yes', 1, {}, null, undefined]) {
      const odd = { ...OPEN, members: [{ id: 'http-a', name: 'alice', joinedAt: '', ready: near }] };
      expect(parseRoomView(odd)?.members[0].ready).toBe(false);
    }
  });

  it('reads draftStartedAt as a string or null, and nothing else — a missing one is the lobby', () => {
    expect(parseRoomView({ ...OPEN, draftStartedAt: '2026-09-26T10:00:00.000Z' })?.draftStartedAt).toBe(
      '2026-09-26T10:00:00.000Z',
    );
    const older: Record<string, unknown> = { ...OPEN };
    delete older.draftStartedAt;
    expect('draftStartedAt' in older).toBe(false);
    expect(parseRoomView(older)?.draftStartedAt).toBeNull();
    for (const near of [0, 1758880000000, true, {}, null]) {
      expect(parseRoomView({ ...OPEN, draftStartedAt: near })?.draftStartedAt).toBeNull();
    }
  });

  it('says which rooms are already drafting, and says nothing about the ones that are not', async () => {
    const dealing = room({
      id: 'r-cube',
      name: 'Cube night',
      gameType: 'draft',
      draftStartedAt: '2026-09-26T10:00:00.000Z',
    });
    const waiting = room({ id: 'r-lobby', name: 'Cube later', gameType: 'draft' });
    const { client } = server([dealing, waiting, OPEN]);
    mount(client);
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(3));

    expect(within(rowFor('r-cube')).getByTestId('room-drafting').textContent).toBe('drafting');
    expect(within(rowFor('r-cube')).getByTestId('room-type').textContent).toBe('Draft');
    // A draft room still in its lobby, and a constructed room, say nothing.
    expect(within(rowFor('r-lobby')).queryByTestId('room-drafting')).toBeNull();
    expect(within(rowFor('r-open')).queryByTestId('room-drafting')).toBeNull();
  });

  it('offers Constructed and Draft, by the names the operator gave them', () => {
    expect(GAME_TYPES).toEqual([
      { value: 'constructed-1v1', label: 'Constructed' },
      { value: 'draft', label: 'Draft' },
    ]);
  });
});

/* ── the two room writes a draft room makes ──────────────────────────── */

describe('the room writes', () => {
  /** Just the two new routes, so the URL and the body are the assertion. */
  function writes(answer: (path: string) => Response) {
    const calls: Call[] = [];
    const fetchImpl: Fetch = async (url, init) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      return answer(url.replace('/cardtable/api/', ''));
    };
    return { calls, client: roomsClient(fetchImpl, '/cardtable/api/') };
  }

  it('sends readiness to the ROOM’s own route, not the table’s, and answers with the room', async () => {
    const readied = room({
      id: 'r-cube',
      name: 'Cube night',
      gameType: 'draft',
      members: [{ id: 'http-a', name: 'alice', joinedAt: '', ready: true }],
    });
    const { calls, client } = writes(() => json(200, readied));

    const outcome = await client.ready('r-cube', true);
    expect(outcome).toEqual({ ok: true, room: readied });
    expect(calls).toEqual([
      { url: '/cardtable/api/rooms/r-cube/ready', method: 'POST', body: { ready: true } },
    ]);
    // Standing down is the same route with the other boolean.
    await client.ready('r-cube', false);
    expect(calls[1].body).toEqual({ ready: false });
    // And it is never the tables API, which 409s for a draft room.
    expect(calls.every((c) => !c.url.includes('/tables/'))).toBe(true);
  });

  it('asks the room to start the draft, with an empty body, and reads back draftStartedAt', async () => {
    const started = room({
      id: 'r-cube',
      name: 'Cube night',
      gameType: 'draft',
      draftStartedAt: '2026-09-26T10:00:00.000Z',
      members: [{ id: 'http-a', name: 'alice', joinedAt: '', ready: true }],
    });
    const { calls, client } = writes(() => json(200, started));

    const outcome = await client.start('r-cube');
    expect(outcome.ok && outcome.room.draftStartedAt).toBe('2026-09-26T10:00:00.000Z');
    expect(calls).toEqual([{ url: '/cardtable/api/rooms/r-cube/start', method: 'POST', body: {} }]);
  });

  it('leaves the room with an empty body, and answers with the room (R16, the result screen’s Main menu)', async () => {
    const emptied = room({ id: 'r-cube', name: 'Cube night', members: [] });
    const { calls, client } = writes(() => json(200, emptied));

    const outcome = await client.leave('r-cube');
    expect(outcome).toEqual({ ok: true, room: emptied });
    expect(calls).toEqual([{ url: '/cardtable/api/rooms/r-cube/leave', method: 'POST', body: {} }]);
  });

  it('hands back the server’s own refusal, in its words, for both writes', async () => {
    const refused = writes(() => json(409, { error: 'somebody in this room is not ready yet' }));
    const start = await refused.client.start('r-cube');
    expect(start).toEqual({ ok: false, message: 'Could not start the draft: somebody in this room is not ready yet.' });

    const missing = writes(() => json(404, { error: 'no room with that id and password' }));
    expect(await missing.client.ready('r-gone', true)).toEqual({
      ok: false,
      message: 'Could not change your readiness: no room with that id and password.',
    });

    // A status with no readable body still says something a person can act on.
    const mute = writes(() => new Response('', { status: 403 }));
    expect(await mute.client.start('r-cube')).toEqual({
      ok: false,
      message: 'Could not start the draft: the server answered HTTP 403.',
    });

    // A 200 that is not a room is a failure, not a room-shaped guess.
    const nonsense = writes(() => json(200, { fine: true }));
    expect(await nonsense.client.ready('r-cube', true)).toEqual({
      ok: false,
      message: 'The server answered with something that is not a room.',
    });

    // And an unreachable server is said in words rather than thrown.
    const offline = roomsClient(() => Promise.reject(new Error('offline')), '/cardtable/api/');
    expect(await offline.start('r-cube')).toEqual({ ok: false, message: 'Could not reach the server.' });
  });

  /* ── the leader's setter (w25 §B) ──────────────────────────────────── */

  it('sets the table’s pool with a PATCH on the room, carrying `format` and nothing else', async () => {
    const moved = room({ id: 'r-open', name: 'Friday night', format: '2011-07-01' });
    const { calls, client } = writes(() => json(200, moved));

    const outcome = await client.setFormat('r-open', '2011-07-01');
    expect(outcome.ok && outcome.room.format).toBe('2011-07-01');
    // PATCH, not POST, and on the room itself — the same route and allow-list
    // that already carries `{ gameType }`.
    expect(calls).toEqual([
      { url: '/cardtable/api/rooms/r-open', method: 'PATCH', body: { format: '2011-07-01' } },
    ]);
  });

  it('changes a room setting with the same PATCH, carrying `settings` and nothing else', async () => {
    const moved = room({ id: 'r-open', name: 'Friday night', settings: { handSmoothing: false } });
    const { calls, client } = writes(() => json(200, moved));
    const outcome = await client.setSettings('r-open', { handSmoothing: false });
    expect(outcome.ok && outcome.room.settings).toEqual({ handSmoothing: false });
    expect(calls).toEqual([{ url: '/cardtable/api/rooms/r-open', method: 'PATCH', body: { settings: { handSmoothing: false } } }]);
  });

  it('chooses the room mode with the same PATCH, carrying `mode` and its options and nothing else', async () => {
    const moved = room({ id: 'r-open', name: 'Friday night', mode: 'random', modeOptions: { pool: 'modern' } });
    const { calls, client } = writes(() => json(200, moved));
    const outcome = await client.setRoomMode('r-open', { mode: 'random', modeOptions: { pool: 'modern' } });
    expect(outcome.ok && [outcome.room.mode, outcome.room.modeOptions]).toEqual(['random', { pool: 'modern' }]);
    expect(calls).toEqual([
      { url: '/cardtable/api/rooms/r-open', method: 'PATCH', body: { mode: 'random', modeOptions: { pool: 'modern' } } },
    ]);
  });

  it('hands back the leader refusal in the server’s own words', async () => {
    const refused = writes(() => json(403, { error: 'only the room leader can change the game type' }));
    expect(await refused.client.setFormat('r-open', '2011-07-01')).toEqual({
      ok: false,
      message: 'Could not change the pool: only the room leader can change the game type.',
    });
  });
});

/* ── the pool and the caller (w25 §B) ────────────────────────────────── */

describe('the room settings', () => {
  it('reads hand smoothing off only when the body says so, and on when it is absent', () => {
    expect(parseRoomView({ ...OPEN, settings: { handSmoothing: false } })?.settings.handSmoothing).toBe(false);
    expect(parseRoomView({ ...OPEN, settings: { handSmoothing: true } })?.settings.handSmoothing).toBe(true);
    const { settings: _gone, ...older } = OPEN;
    expect(parseRoomView(older)?.settings.handSmoothing).toBe(true);
  });

  it('reads no match length: a body still carrying the retired settings reads as hand smoothing alone', () => {
    expect(parseRoomView({ ...OPEN, settings: { handSmoothing: false, matchLength: 'bo3', sideboarding: true } })?.settings).toEqual({ handSmoothing: false });
  });
});

/* ── wave 72 §Q: the room's tables and pod ──────────────────────────────── */

describe('RoomView.tables and RoomView.pod', () => {
  const TABLE = {
    id: 't-aaaa1111',
    players: [],
    matchId: null,
    series: { length: 1 as const, wins: [0, 0] as [number, number], games: [], phase: 'seating' as const },
  };

  it('parses a well-formed tables array, through @hadoku/shared’s own schema', () => {
    expect(parseRoomView({ ...OPEN, tables: [TABLE] })?.tables).toEqual([TABLE]);
  });

  it('reads no tables rather than throwing when the body is absent or malformed', () => {
    const { tables: _gone, ...older } = OPEN;
    expect(parseRoomView(older)?.tables).toEqual([]);
    expect(parseRoomView({ ...OPEN, tables: 'not an array' })?.tables).toEqual([]);
    expect(parseRoomView({ ...OPEN, tables: [{ id: 't-1' }] })?.tables).toEqual([]);
  });

  it('parses a well-formed pod, through @hadoku/shared’s own RoomPodSchema', () => {
    const POD = {
      phase: 'lobby' as const,
      seats: Array(8).fill(null) as null[],
      round: 0,
      rounds: 0,
      results: [],
      standings: [],
      pairings: [],
      bye: null,
      drafters: [],
      built: [],
      // wave 73 §A: PodView gains these three.
      plan: { rounds: [{ kind: 'cube' as const, cubeId: 'default' }, { kind: 'cube' as const, cubeId: 'default' }, { kind: 'cube' as const, cubeId: 'default' }] },
      planName: 'Test Cube',
      verdict: null,
    };
    expect(parseRoomView({ ...OPEN, pod: POD })?.pod).toEqual(POD);
  });

  it('reads no pod rather than throwing when the body is absent, null, or malformed', () => {
    const { pod: _gone, ...older } = OPEN;
    expect(parseRoomView(older)?.pod).toBeNull();
    expect(parseRoomView({ ...OPEN, pod: null })?.pod).toBeNull();
    expect(parseRoomView({ ...OPEN, pod: { phase: 'lobby' } })?.pod).toBeNull();
  });
});

describe('the pool and the caller', () => {
  it('reads the room’s pool as a string, and an absent one as empty rather than a guess', () => {
    expect(parseRoomView({ ...OPEN, format: '2011-07-01' })?.format).toBe('2011-07-01');
    // The shape a server that predates the field sends: none at all. Empty is
    // the honest answer, and the room screen's fallback is the newest pool —
    // it is not this parser's job to invent one.
    const older: Record<string, unknown> = { ...OPEN };
    delete older.format;
    expect(parseRoomView(older)?.format).toBe('');
    for (const near of [0, true, {}, null, ['2011-07-01']]) {
      expect(parseRoomView({ ...OPEN, format: near })?.format).toBe('');
    }
  });

  it('reads `you` from booleans only, so an older server leaves nobody in charge', () => {
    expect(parseRoomView({ ...OPEN, you: { id: 'http-a', leader: true, ready: true } })?.you).toEqual({ id: 'http-a', leader: true, ready: true });

    const older: Record<string, unknown> = { ...OPEN };
    delete older.you;
    expect(parseRoomView(older)?.you).toEqual({ id: '', leader: false, ready: false });
    // Anything that is not a boolean `true` is false: the only way a browser
    // draws the leader's control is for the server to have said so.
    for (const near of ['true', 'yes', 1, {}, null, undefined]) {
      expect(parseRoomView({ ...OPEN, you: { leader: near, ready: near } })?.you).toEqual({
        id: '',
        leader: false,
        ready: false,
      });
    }
    for (const near of ['x', 3, null, []]) {
      expect(parseRoomView({ ...OPEN, you: near })?.you).toEqual({ id: '', leader: false, ready: false });
    }
  });
});

/* ── which client the room runs (D19a) ───────────────────────────────── */

describe('the client mode', () => {
  it('defaults a missing field to builtin, so an older server cannot render as streamed', () => {
    const noMode: Record<string, unknown> = { ...OPEN };
    delete noMode.clientMode;
    expect('clientMode' in noMode).toBe(false);
    expect(parseRoomView(noMode)?.clientMode).toBe('builtin');
    expect(parseRoomView({ ...OPEN, clientMode: undefined })?.clientMode).toBe('builtin');
    expect(parseRoomView({ ...OPEN, clientMode: null })?.clientMode).toBe('builtin');
  });

  it('takes only the exact string "streamed" as streamed — never a near miss', () => {
    expect(parseRoomView({ ...OPEN, clientMode: 'streamed' })?.clientMode).toBe('streamed');
    for (const near of ['Streamed', 'STREAMED', ' streamed', 'stream', 1, true, {}, ['streamed']]) {
      expect(parseRoomView({ ...OPEN, clientMode: near })?.clientMode).toBe('builtin');
    }
  });

  it('labels a streamed room in the list, and says nothing on our own tables', async () => {
    const streamedRoom = room({ id: 'r-forge', name: 'Full client', clientMode: 'streamed' });
    const { client } = server([OPEN, streamedRoom]);
    mount(client);
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(2));

    expect(within(rowFor('r-open')).queryByTestId('room-mode')).toBeNull();
    expect(within(rowFor('r-forge')).getByTestId('room-mode').textContent).toBe('streamed Forge');
    expect(clientModeLabel('builtin')).toBe('our table');
    expect(clientModeLabel('streamed')).toBe('streamed Forge');
  });
});

/* ── the seat's stream path, and whether it is really there ──────────── */

describe('a seat\u2019s stream', () => {
  it('is same-origin under the app\u2019s own prefix, keyed by room and seat', () => {
    expect(streamRoot('r-forge', 0, '/cardtable/')).toBe('/cardtable/stream/r-forge/0/');
    expect(streamRoot('r-forge', 1, '/cardtable')).toBe('/cardtable/stream/r-forge/1/');
    expect(streamRoot('r-forge', 0, '/')).toBe('/stream/r-forge/0/');
    expect(streamRoot('r-forge', 0, '')).toBe('/stream/r-forge/0/');

    // The page a seat shows is vnc.html, NOT the root: websockify answers the
    // root with a directory listing, which framed a file index and probed as
    // unreachable forever. See `streamPath`.
    expect(streamPath('r-forge', 0, '/cardtable/')).toBe(
      '/cardtable/stream/r-forge/0/vnc.html?path=cardtable%2Fstream%2Fr-forge%2F0%2Fwebsockify&autoconnect=true&resize=scale',
    );
    // The websocket path is relative to the ORIGIN and carries no leading
    // slash — noVNC appends it to the origin itself.
    expect(streamPath('r-forge', 0, '/cardtable/')).not.toContain('path=%2F');
    // No host, ever: the frame is this origin's or it is nothing.
    expect(streamPath('r-forge', 0, '/cardtable/')).not.toContain('//');
  });

  it('believes a stream only on positive evidence, never on a 200', async () => {
    const novnc = '<!DOCTYPE html><title>noVNC</title><canvas id="noVNC_canvas"></canvas>';
    // What the server ACTUALLY answers with no containers: its SPA fallback,
    // HTTP 200, our own page. `res.ok` is true and the stream does not exist.
    const spa = '<!DOCTYPE html><html><head><title>Cardtable</title></head><body><div id="root"></div></body></html>';

    const answered = (status: number, body: string): Fetch => async () => new Response(body, { status });
    expect(await streamReachable('/cardtable/stream/r/0/', answered(200, novnc))).toBe(true);
    expect(await streamReachable('/cardtable/stream/r/0/', answered(200, spa))).toBe(false);
    expect(await streamReachable('/cardtable/stream/r/0/', answered(404, 'not found'))).toBe(false);
    expect(
      await streamReachable('/cardtable/stream/r/0/', () => Promise.reject(new Error('offline'))),
    ).toBe(false);
  });
});

/* ── create ──────────────────────────────────────────────────────────── */

describe('creating a room', () => {
  it('sends the name, the chosen game type and mode and the password, then enters the room', async () => {
    const { client, calls } = server([]);
    mount(client);
    await screen.findByTestId('rooms-empty');
    openCreate();

    fireEvent.change(screen.getByTestId('room-create-name'), { target: { value: '  Friday night  ' } });
    fireEvent.click(screen.getByTestId('room-create-type-constructed-1v1'));
    fireEvent.click(screen.getByTestId('room-create-constructed-mode-classic'));
    fireEvent.change(screen.getByTestId('room-create-password'), { target: { value: 'hunter2' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('room-create-submit'));
    });

    const post = calls.find((c) => c.method === 'POST');
    expect(post).toEqual({
      url: '/cardtable/api/rooms',
      method: 'POST',
      body: { name: 'Friday night', gameType: 'constructed-1v1', clientMode: 'builtin', password: 'hunter2', mode: 'classic', modeOptions: {} },
    });
    await waitFor(() => expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'room', roomId: 'r-new' }));
  });

  it('omits an empty password and an unchosen mode: the type is two radios, Constructed first and chosen, and no mode is', async () => {
    const { client, calls } = server([]);
    mount(client);
    await screen.findByTestId('rooms-empty');
    openCreate();

    const types = within(screen.getByTestId('room-create-type')).getAllByRole('radio') as HTMLInputElement[];
    expect(types.map((r) => [r.value, r.checked, r.disabled])).toEqual([
      ['constructed-1v1', true, false],
      ['draft', false, false],
    ]);
    expect(screen.getByRole('radiogroup', { name: 'Game type' }).textContent).toBe('ConstructedDraft');
    const modes = within(screen.getByTestId('room-create-constructed-mode')).getAllByRole('radio') as HTMLInputElement[];
    expect(modes.map((r) => [r.value, r.checked])).toEqual([
      ['classic', false],
      ['gauntlet', false],
      ['random', false],
    ]);
    expect(screen.getByTestId('room-create-constructed-mode').textContent).toBe('ClassicGauntletAll Random');
    expect(screen.queryByRole('combobox')).toBeNull();

    fireEvent.change(screen.getByTestId('room-create-name'), { target: { value: 'Open table' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('room-create-submit'));
    });
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'Open table',
      gameType: 'constructed-1v1',
      clientMode: 'builtin',
    });
  });

  it('creates a draft room through the form — Draft is pickable, not just the API', async () => {
    const { client, calls } = server([]);
    mount(client);
    await screen.findByTestId('rooms-empty');
    openCreate();

    fireEvent.change(screen.getByTestId('room-create-name'), { target: { value: 'Cube night' } });
    // A mode picked for Constructed is not sent with a draft: a draft room has none.
    fireEvent.click(screen.getByTestId('room-create-constructed-mode-gauntlet'));
    fireEvent.click(screen.getByTestId('room-create-type-draft'));
    expect((screen.getByTestId('room-create-type-draft') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId('room-create-constructed-mode')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('room-create-submit'));
    });

    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'Cube night',
      gameType: 'draft',
      clientMode: 'builtin',
    });
    await waitFor(() => expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'room', roomId: 'r-new' }));
  });

  it('sends a mode chosen at create with its options, and none when none was chosen', async () => {
    const { client, calls } = server([]);
    await client.create({ name: 'Gauntlet', gameType: 'constructed-1v1', clientMode: 'builtin', mode: { mode: 'gauntlet', modeOptions: { family: 'legacy' } } });
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'Gauntlet',
      gameType: 'constructed-1v1',
      clientMode: 'builtin',
      mode: 'gauntlet',
      modeOptions: { family: 'legacy' },
    });
  });

  it('reads a room’s mode and options, and an unknown pair as unchosen', () => {
    expect(parseRoomView({ ...OPEN, mode: 'gauntlet', modeOptions: { era: '2022-07-08' } })).toMatchObject({ mode: 'gauntlet', modeOptions: { era: '2022-07-08' } });
    expect(parseRoomView({ ...OPEN, mode: 'sealed', modeOptions: {} })).toMatchObject({ mode: null, modeOptions: null });
    expect(parseRoomView({ ...OPEN, mode: 'random', modeOptions: { pool: 'vintage' } })).toMatchObject({ mode: null, modeOptions: null });
    const { mode: _m, modeOptions: _o, ...older } = OPEN;
    expect(parseRoomView(older)).toMatchObject({ mode: null, modeOptions: null });
  });

  it('All Random is created on the whole library, and Gauntlet with no options (a random era)', async () => {
    for (const [mode, modeOptions] of [
      ['random', { pool: 'full' }],
      ['gauntlet', {}],
    ] as const) {
      const { client, calls } = server([]);
      mount(client);
      await screen.findByTestId('rooms-empty');
      openCreate();
      fireEvent.change(screen.getByTestId('room-create-name'), { target: { value: 'Shuffle' } });
      fireEvent.click(screen.getByTestId(`room-create-constructed-mode-${mode}`));
      await act(async () => {
        fireEvent.click(screen.getByTestId('room-create-submit'));
      });
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'Shuffle', gameType: 'constructed-1v1', clientMode: 'builtin', mode, modeOptions });
      cleanup();
    }
  });

  it('a draft room made through the API still lands as a room, not a pod route', async () => {
    const { client, calls } = server([]);
    const made = await client.create({ name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
    expect(made.ok && made.room.gameType).toBe('draft');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
  });

  it('is a dialog behind Create room at the foot of the list, and asks no client question', async () => {
    // The operator, 2026-10-10: "let's have it just show the rooms … the 'Which Client' question should not exist for now".
    const { client, calls } = server([OPEN]);
    mount(client);
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(1));
    expect(screen.queryByTestId('room-create')).toBeNull();
    const button = screen.getByTestId('room-create-open');
    expect(button.compareDocumentPosition(screen.getByTestId('room-list')) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();

    fireEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: 'Create a room' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('room-create-name'));
    expect(screen.queryByTestId('room-create-mode')).toBeNull();
    expect(dialog.textContent).not.toContain('Forge’s full client');

    fireEvent.change(screen.getByTestId('room-create-name'), { target: { value: 'Ours' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('room-create-submit'));
    });
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'Ours', gameType: 'constructed-1v1', clientMode: 'builtin' });
  });

  it('closes on Escape, on its close button and on a press of the backdrop, and not on a press inside it', async () => {
    const { client } = server([]);
    mount(client);
    await screen.findByTestId('rooms-empty');

    openCreate();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('room-create')).toBeNull();

    openCreate();
    fireEvent.click(screen.getByTestId('room-create-close'));
    expect(screen.queryByTestId('room-create')).toBeNull();

    openCreate();
    fireEvent.pointerDown(screen.getByTestId('room-create-name'));
    expect(screen.getByTestId('room-create')).toBeTruthy();
    fireEvent.pointerDown(screen.getByTestId('room-create-backdrop'));
    expect(screen.queryByTestId('room-create')).toBeNull();
  });

  it('carries the mode through to the room it lands you in', async () => {
    const { client } = server([]);
    const created = await client.create({ name: 'Full client night', gameType: 'draft', clientMode: 'streamed' });
    expect(created.ok && created.room.clientMode).toBe('streamed');
    const plain = await client.create({ name: 'Ours', gameType: 'constructed-1v1', clientMode: 'builtin' });
    expect(plain.ok && plain.room.clientMode).toBe('builtin');
  });

  it('refuses a nameless room without calling the server', async () => {
    const { client, calls } = server([]);
    mount(client);
    await screen.findByTestId('rooms-empty');
    openCreate();
    await act(async () => {
      fireEvent.click(screen.getByTestId('room-create-submit'));
    });
    expect(screen.getByTestId('room-create-error')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

/* ── entering ────────────────────────────────────────────────────────── */

describe('entering a room', () => {
  it('joins an open room and navigates to it', async () => {
    const { client, calls } = server([OPEN]);
    mount(client);
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(1));

    await act(async () => {
      fireEvent.click(within(rowFor('r-open')).getByTestId('room-enter'));
    });

    expect(calls.find((c) => c.method === 'POST')).toEqual({ url: '/cardtable/api/rooms/r-open/join', method: 'POST', body: {} });
    await waitFor(() => expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'room', roomId: 'r-open' }));
  });

  it('asks a locked room for its password, refuses a wrong one without saying whether the room exists, and enters with the right one', async () => {
    const { client, calls } = server([LOCKED], { password: 'hunter2' });
    mount(client);
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(1));

    // Enter on a locked room asks; it does not call the server.
    fireEvent.click(within(rowFor('r-locked')).getByTestId('room-enter'));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    const input = within(rowFor('r-locked')).getByTestId('room-password');

    fireEvent.change(input, { target: { value: 'wrong' } });
    await act(async () => {
      fireEvent.click(within(rowFor('r-locked')).getByTestId('room-password-submit'));
    });
    const refusal = await screen.findByTestId('room-join-error');
    expect(refusal.textContent).toBe('No room with that name and password.');
    expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'lobby' });

    fireEvent.change(within(rowFor('r-locked')).getByTestId('room-password'), { target: { value: 'hunter2' } });
    await act(async () => {
      fireEvent.click(within(rowFor('r-locked')).getByTestId('room-password-submit'));
    });
    const joins = calls.filter((c) => c.method === 'POST');
    expect(joins.map((c) => c.body)).toEqual([{ password: 'wrong' }, { password: 'hunter2' }]);
    await waitFor(() => expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'room', roomId: 'r-locked' }));
  });

  // The rejoin audit, 2026-10-19: a member coming back from the front page had
  // to find their room by name, and was asked a password the server waives.
  it('lists my own rooms first, marked, and enters a locked one I am in without asking its password', async () => {
    const MINE = room({ id: 'r-mine', name: 'Our pod', locked: true });
    const posts: { url: string; body: unknown }[] = [];
    const fetchImpl: Fetch = async (url, init) => {
      if (init?.method === 'POST') {
        posts.push({ url: String(url), body: JSON.parse(String(init.body ?? '{}')) });
        return json(200, MINE);
      }
      return json(200, { rooms: [{ ...OPEN, you: { id: 'http-z', leader: false, ready: false } }, MINE] });
    };
    mount(roomsClient(fetchImpl, '/cardtable/api/'));
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(2));
    expect(screen.getAllByTestId('room-row').map((r) => [r.dataset.roomId, r.dataset.mine])).toEqual([
      ['r-mine', ''],
      ['r-open', undefined],
    ]);

    await act(async () => {
      fireEvent.click(within(rowFor('r-mine')).getByTestId('room-enter'));
    });
    expect(screen.queryByTestId('room-password')).toBeNull();
    expect(posts).toEqual([{ url: '/cardtable/api/rooms/r-mine/join', body: {} }]);
    await waitFor(() => expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'room', roomId: 'r-mine' }));
  });

  it('says so when the server is rate-limiting password attempts', async () => {
    const fetchImpl: Fetch = async (_url, init) => (init?.method === 'POST' ? json(429, {}) : json(200, { rooms: [LOCKED] }));
    mount(roomsClient(fetchImpl, '/cardtable/api/'));
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(1));
    fireEvent.click(within(rowFor('r-locked')).getByTestId('room-enter'));
    fireEvent.change(within(rowFor('r-locked')).getByTestId('room-password'), { target: { value: 'x' } });
    await act(async () => {
      fireEvent.click(within(rowFor('r-locked')).getByTestId('room-password-submit'));
    });
    expect((await screen.findByTestId('room-join-error')).textContent).toContain('Too many attempts');
    expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'lobby' });
  });
});

/* ── the front page makes a sound (w27 §F) ───────────────────────────── */

/*
 * The other half of `../sound/sound.test.ts`: that file proves the module, this
 * one proves the wiring on the surface a player lands on first.
 *
 * Every case below injects a RECORDING PLAYER. jsdom has no WebAudio, so with no
 * player injected `playRole` is already a no-op here — which means these assertions
 * would pass vacuously if they asserted on silence alone. They assert on the
 * requests instead, and the muted case asserts on silence only after the
 * unmuted case has shown the same click is loud.
 */
describe('the front page’s cues', () => {
  beforeEach(() => {
    resetRolePlayerForTests();
    unmute();
  });

  afterEach(() => {
    setRolePlayer(null);
    // The muted case CLICKS the button, which persists `true`. Leaving it there
    // would silence every case that ran afterwards — and they would pass, since
    // most of what they assert is a cue arriving, so the failure would have read
    // as a product bug. Clearing the store as well as the memo is the fix.
    unmute();
  });

  /** Forget the mute, in memory and in the store. */
  const unmute = (): void => {
    resetMutedForTests();
    try {
      globalThis.localStorage.removeItem(MUTE_KEY);
    } catch {
      // jsdom always has a store; this only guards a hostile one.
    }
  };

  const recorder = () => {
    const requests: SoundEvent[] = [];
    setRolePlayer({ play: (r: SoundEvent) => void requests.push(r) });
    return requests;
  };

  it('cues select on Enter, once, for the press itself', async () => {
    const { client } = server([OPEN]);
    mount(client);
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(1));

    const requests = recorder();
    await act(async () => {
      fireEvent.click(within(rowFor('r-open')).getByTestId('room-enter'));
    });
    expect(requests.map((r) => r.role)).toEqual(['ui.select']);
  });

  it('cues deny when a room refuses the join', async () => {
    const refusing: Fetch = async (_url, init) =>
      init?.method === 'POST' ? json(404, { error: 'no such room' }) : json(200, { rooms: [OPEN] });
    mount(roomsClient(refusing, '/cardtable/api/'));
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(1));

    const requests = recorder();
    await act(async () => {
      fireEvent.click(within(rowFor('r-open')).getByTestId('room-enter'));
    });
    await screen.findByTestId('room-join-error');
    expect(requests.map((r) => r.role)).toEqual(['ui.select', 'ui.deny']);
  });

  it('cues deny when the create form refuses an empty name, and select when it does not', async () => {
    const { client } = server([]);
    mount(client);
    await screen.findByTestId('rooms-empty');

    const requests = recorder();
    openCreate();
    expect(requests.map((r) => r.role)).toEqual(['ui.select']);
    requests.length = 0;
    await act(async () => {
      fireEvent.click(screen.getByTestId('room-create-submit'));
    });
    expect(requests.map((r) => r.role)).toEqual(['ui.deny']);

    fireEvent.change(screen.getByTestId('room-create-name'), { target: { value: 'Friday night' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('room-create-submit'));
    });
    expect(requests.map((r) => r.role)).toEqual(['ui.deny', 'ui.select']);
  });

  it('says nothing at all once the player has muted — and the room still opens', async () => {
    const { client } = server([OPEN]);
    mount(client);
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(1));

    const requests = recorder();
    setMuted(true);

    await act(async () => {
      fireEvent.click(within(rowFor('r-open')).getByTestId('room-enter'));
    });
    expect(requests).toEqual([]);
    // Muting sound mutes sound and nothing else.
    await waitFor(() => expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'room', roomId: 'r-open' }));
  });
});

/* ── the avatar a friend picked in watchparty's room (item 4) ─────────── */

/*
 * `RoomMember.avatarId` is the field the server carries from a room member to
 * the table's players, and the operator's *"why not?"* was about this last hop.
 *
 * The parse is the interesting half: the server already answers with two states
 * (a non-blank string, or no key), so the only way a third reaches a face is if
 * this file invents one. `avatarId: normalizeAvatarId(v) ?? undefined` would put
 * the key on EVERY member, which is why the parser assigns conditionally and why
 * these use `toHaveProperty`.
 */
describe('a member’s avatar', () => {
  const memberOf = (v: unknown): Record<string, unknown> =>
    (parseRoomView(v)?.members[0] ?? {}) as unknown as Record<string, unknown>;

  it('reads a real id through, and leaves the key off for every other shape', () => {
    const withAvatar = { ...OPEN, members: [{ id: 'http-a', name: 'alice', joinedAt: '', ready: false, avatarId: 'wanderer' }] };
    expect(parseRoomView(withAvatar)?.members[0]?.avatarId).toBe('wanderer');

    // The server never sends these. The parser still folds them, because the
    // browser is the last place that can stop `""` becoming `square_.png`.
    for (const nothing of ['', '   ', null, 7, {}, 'x'.repeat(33)]) {
      const member = memberOf({ ...OPEN, members: [{ id: 'http-a', name: 'alice', joinedAt: '', ready: false, avatarId: nothing }] });
      expect(member, JSON.stringify(nothing)).not.toHaveProperty('avatarId');
    }
    // And a member from a server that predates the field: absent, not present.
    expect(memberOf(OPEN)).not.toHaveProperty('avatarId');
  });

  it('asserts the caller’s own avatar to the room’s identity route, and clears with null', async () => {
    const answered = room({
      id: 'r-cube',
      name: 'Cube night',
      members: [{ id: 'http-a', name: 'alice', joinedAt: '', ready: false, avatarId: 'wanderer' }],
    });
    const calls: Call[] = [];
    const fetchImpl: Fetch = async (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      return json(200, answered);
    };
    const client = roomsClient(fetchImpl, '/cardtable/api/');

    expect(await client.setAvatar('r-cube', 'wanderer')).toEqual({ ok: true, room: answered });
    // The body names a VALUE and never a member: the server resolves who is
    // asking from the edge's headers, exactly as `ready` does.
    expect(calls).toEqual([
      { url: '/cardtable/api/rooms/r-cube/identity', method: 'POST', body: { avatarId: 'wanderer' } },
    ]);
    await client.setAvatar('r-cube', null);
    expect(calls[1].body).toEqual({ avatarId: null });
  });

  it('draws a face for each member who has one, and nothing for a member who has not', async () => {
    const roster = room({
      id: 'r-open',
      name: 'Friday night',
      members: [
        { id: 'http-a', name: 'alice', joinedAt: '', ready: false, avatarId: 'wanderer' },
        { id: 'http-b', name: 'bob', joinedAt: '', ready: false },
        { id: 'http-c', name: 'carol', joinedAt: '', ready: false, avatarId: 'knight' },
      ],
    });
    const { client } = server([roster]);
    mount(client);

    const members = await waitFor(() => within(rowFor('r-open')).getByTestId('room-members'));
    // The names are still the roster; the faces are beside them, not instead.
    expect(members.textContent).toContain('alice, bob, carol');

    const faces = within(members).getAllByTestId('room-face');
    // TWO faces for three members. A placeholder for bob would be a row of
    // identical squares saying less than the names already do.
    expect(faces.map((f) => f.getAttribute('data-avatar-id'))).toEqual(['wanderer', 'knight']);
    expect(faces[0].getAttribute('src')).toContain('/watchparty/media/sprites/square_wanderer.png');
    // Decorative: the names are in the same element, so an announced character
    // would read the roster twice.
    expect(faces.every((f) => f.getAttribute('alt') === '')).toBe(true);
    expect(faces.map((f) => f.getAttribute('title'))).toEqual(['alice', 'carol']);
  });

  it('reads the server’s 404 for a match id as a plain refusal, with its own words', async () => {
    // What `RoomShell` gets on `#/match/<id>`: the id is not a room, so the
    // server answers its single 404 and the shell ignores it.
    const client = roomsClient(async () => json(404, { error: 'no room with that id and password' }), '/cardtable/api/');
    expect(await client.setAvatar('m-090bf01ba811', 'wanderer')).toEqual({
      ok: false,
      message: 'Could not set your avatar: no room with that id and password.',
    });
  });
});

describe('the room list on mount', () => {
  it('opens to the plain list, with no dialog, when nothing is pending', async () => {
    const { client } = server([]);
    mount(client);
    await screen.findByTestId('rooms-empty');
    expect(screen.queryByTestId('room-create')).toBeNull();
  });
});

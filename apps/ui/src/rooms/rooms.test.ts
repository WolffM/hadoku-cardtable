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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { LobbyScreen } from '../screens/LobbyScreen.tsx';
import { parseRoute } from '../screens/route.ts';
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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  globalThis.location.hash = '';
});

const room = (over: Partial<RoomView> & { id: string; name: string }): RoomView => ({
  creator: 'http-a',
  leader: 'http-a',
  gameType: 'constructed-1v1',
  clientMode: 'builtin',
  locked: false,
  members: [{ id: 'http-a', name: 'alice', joinedAt: '2026-09-19T00:00:00.000Z', ready: false }],
  matchId: null,
  draftStartedAt: null,
  createdAt: '2026-09-19T00:00:00.000Z',
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

const mount = (client: ReturnType<typeof roomsClient>) => render(createElement(LobbyScreen, { rooms: client }));

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
    expect(within(open).getByTestId('room-type').textContent).toBe('Constructed 1v1');
    expect(within(open).getByTestId('room-members').textContent).toBe('alice');
    expect(within(open).queryByTestId('room-locked')).toBeNull();

    const locked = rowFor('r-locked');
    expect(within(locked).getByTestId('room-members').textContent).toBe('bob, carol');
    expect(within(locked).getByTestId('room-locked')).toBeTruthy();
  });

  it('shows a loading state that already offers the create form', () => {
    const never: Fetch = () => new Promise<Response>(() => {});
    mount(roomsClient(never, '/cardtable/api/'));
    expect(screen.getByTestId('rooms-loading')).toBeTruthy();
    expect(screen.getByTestId('room-create-submit')).toBeTruthy();
  });

  it('shows an empty state that points at the create form, which is right there', async () => {
    const { client } = server([]);
    mount(client);
    const empty = await screen.findByTestId('rooms-empty');
    expect(empty.textContent).toContain('No rooms yet');
    expect(screen.queryByTestId('room-row')).toBeNull();
    expect(screen.getByTestId('room-create-name')).toBeTruthy();
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

  it('polls, and keeps the list when a later poll fails', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let rooms: RoomView[] = [OPEN];
    let fail = false;
    const fetchImpl: Fetch = async () => (fail ? json(503, {}) : json(200, { rooms }));
    mount(roomsClient(fetchImpl, '/cardtable/api/'));
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(1));

    rooms = [OPEN, LOCKED];
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(2));

    fail = true;
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await screen.findByTestId('rooms-stale');
    expect(screen.getAllByTestId('room-row')).toHaveLength(2);
  });

  it('drops a malformed room rather than rendering undefined', () => {
    expect(parseRoomView({ ...OPEN, locked: 'yes' })).toBeNull();
    expect(parseRoomView({ ...OPEN, id: 'Not An Id!' })).toBeNull();
    expect(parseRoomView(OPEN)).toEqual(OPEN);
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

  it('offers draft as a game type a person can actually pick', () => {
    // It used to be `Draft (coming soon)` and disabled, which is what made the
    // deleted "Start a pod" button the only way to draft.
    const draft = GAME_TYPES.find((t) => t.value === 'draft');
    expect(draft).toEqual({ value: 'draft', label: 'Draft', ready: true });
    expect(GAME_TYPES.every((t) => t.ready)).toBe(true);
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

  it('shows every room its mode in the list, not just the streamed ones', async () => {
    const streamedRoom = room({ id: 'r-forge', name: 'Full client', clientMode: 'streamed' });
    const { client } = server([OPEN, streamedRoom]);
    mount(client);
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(2));

    expect(within(rowFor('r-open')).getByTestId('room-mode').textContent).toBe('our table');
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
  it('sends the name, the chosen game type and the password, then enters the room', async () => {
    const { client, calls } = server([]);
    mount(client);
    await screen.findByTestId('rooms-empty');

    fireEvent.change(screen.getByTestId('room-create-name'), { target: { value: '  Friday night  ' } });
    fireEvent.change(screen.getByTestId('room-create-type'), { target: { value: 'constructed-1v1' } });
    fireEvent.change(screen.getByTestId('room-create-password'), { target: { value: 'hunter2' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('room-create-submit'));
    });

    const post = calls.find((c) => c.method === 'POST');
    expect(post).toEqual({
      url: '/cardtable/api/rooms',
      method: 'POST',
      body: { name: 'Friday night', gameType: 'constructed-1v1', clientMode: 'builtin', password: 'hunter2' },
    });
    await waitFor(() => expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'room', roomId: 'r-new' }));
  });

  it('omits an empty password, and offers draft as a type that can be chosen', async () => {
    const { client, calls } = server([]);
    mount(client);
    await screen.findByTestId('rooms-empty');

    // This option used to be disabled and labelled "coming soon", so the only
    // way to draft was the pod button w23 deletes. It is a room now.
    const draft = within(screen.getByTestId('room-create-type')).getByRole('option', { name: 'Draft' }) as HTMLOptionElement;
    expect(draft.disabled).toBe(false);
    expect(draft.value).toBe('draft');

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

  it('makes a DRAFT room from the same form, and lands in it — the only door there is', async () => {
    const { client, calls } = server([]);
    mount(client);
    await screen.findByTestId('rooms-empty');

    fireEvent.change(screen.getByTestId('room-create-name'), { target: { value: 'Cube night' } });
    fireEvent.change(screen.getByTestId('room-create-type'), { target: { value: 'draft' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('room-create-submit'));
    });

    expect(calls.find((c) => c.method === 'POST')).toEqual({
      url: '/cardtable/api/rooms',
      method: 'POST',
      body: { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' },
    });
    // `#/room/<id>`, not `#/draft/<id>`: the room is the pod.
    await waitFor(() => expect(parseRoute(globalThis.location.hash)).toEqual({ kind: 'room', roomId: 'r-new' }));
  });

  it('offers the two clients before the room is made, with our table preselected, and sends the pick', async () => {
    const { client, calls } = server([]);
    mount(client);
    await screen.findByTestId('rooms-empty');

    // Visible before create, both of them. Labels only — the UI states the
    // choice, it does not explain it.
    const pick = screen.getByTestId('room-create-mode');
    expect(pick.textContent).toContain('Our table');
    expect(pick.textContent).toContain('Forge’s full client');
    const builtin = screen.getByTestId('room-create-mode-builtin') as HTMLInputElement;
    const streamed = screen.getByTestId('room-create-mode-streamed') as HTMLInputElement;
    expect(builtin.checked).toBe(true);
    expect(streamed.checked).toBe(false);
    // And it says the choice is the room's, for the room's whole life.

    fireEvent.change(screen.getByTestId('room-create-name'), { target: { value: 'Full client night' } });
    fireEvent.click(streamed);
    expect((screen.getByTestId('room-create-mode-streamed') as HTMLInputElement).checked).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId('room-create-submit'));
    });

    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'Full client night',
      gameType: 'constructed-1v1',
      clientMode: 'streamed',
    });
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

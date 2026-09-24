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
  parseRoomView,
  roomsClient,
  streamPath,
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
  members: [{ id: 'http-a', name: 'alice', joinedAt: '2026-09-19T00:00:00.000Z' }],
  matchId: null,
  createdAt: '2026-09-19T00:00:00.000Z',
  ...over,
});

const OPEN = room({ id: 'r-open', name: 'Friday night' });
const LOCKED = room({
  id: 'r-locked',
  name: 'Siblings keep out',
  locked: true,
  members: [
    { id: 'http-b', name: 'bob', joinedAt: '' },
    { id: 'http-c', name: 'carol', joinedAt: '' },
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

  it('does not give a room button the accessible name the draft join box uses', async () => {
    const { client } = server([OPEN, LOCKED]);
    mount(client);
    await waitFor(() => expect(screen.getAllByTestId('room-row')).toHaveLength(2));
    // `e2e/draft.spec.ts` clicks getByRole('button', { name: 'Join', exact: true }).
    expect(screen.getAllByRole('button', { name: 'Join' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Enter Friday night' })).toBeTruthy();
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
    expect(streamPath('r-forge', 0, '/cardtable/')).toBe('/cardtable/stream/r-forge/0/');
    expect(streamPath('r-forge', 1, '/cardtable')).toBe('/cardtable/stream/r-forge/1/');
    expect(streamPath('r-forge', 0, '/')).toBe('/stream/r-forge/0/');
    expect(streamPath('r-forge', 0, '')).toBe('/stream/r-forge/0/');
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

  it('omits an empty password, and offers draft only as not-yet-available', async () => {
    const { client, calls } = server([]);
    mount(client);
    await screen.findByTestId('rooms-empty');

    const draft = within(screen.getByTestId('room-create-type')).getByRole('option', { name: /Draft/ }) as HTMLOptionElement;
    expect(draft.disabled).toBe(true);

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

  it('offers the two clients before the room is made, with our table preselected, and sends the pick', async () => {
    const { client, calls } = server([]);
    mount(client);
    await screen.findByTestId('rooms-empty');

    // Visible before create, both of them, with what each one costs you.
    const pick = screen.getByTestId('room-create-mode');
    expect(pick.textContent).toContain('Our table');
    expect(pick.textContent).toContain('Streams your screen from the server');
    const builtin = screen.getByTestId('room-create-mode-builtin') as HTMLInputElement;
    const streamed = screen.getByTestId('room-create-mode-streamed') as HTMLInputElement;
    expect(builtin.checked).toBe(true);
    expect(streamed.checked).toBe(false);
    // And it says the choice is the room's, for the room's whole life.
    expect(screen.getByTestId('room-create-mode-hint').textContent).toContain('fixed when the room is made');

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

/*
 * The room-core client against a fake fetch: the paths and bodies it sends, the refusals it reads,
 * and a game's parser deciding what a room is.
 */

import { describe, expect, it } from 'vitest';

import type { Fetch } from '../http.ts';
import type { RoomFrontRoom } from '../front/RoomFront.tsx';
import { roomCoreClient, roomFrontClient } from './room-core-client.ts';

interface ToyRoom {
  id: string;
  name: string;
  start: number | null;
}

const parse = (v: unknown): ToyRoom | null => {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.name !== 'string') return null;
  return { id: r.id, name: r.name, start: typeof r.start === 'number' ? r.start : null };
};

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

/** A fetch that answers every request with `status` and `body`, and records what was sent. */
function fake(status: number, body: unknown): Fetch & { sent: Sent[] } {
  const sent: Sent[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as Fetch & { sent: Sent[] };
  f.sent = sent;
  return f;
}

const unreachable: Fetch = () => Promise.reject(new TypeError('Failed to fetch'));
const client = (f: Fetch) => roomCoreClient({ parse, fetch: f, base: '/game/api/' });

describe('roomCoreClient', () => {
  it('lists through the game’s parser, dropping what is not a room, and hands back the whole body', async () => {
    const f = fake(200, { rooms: [{ id: 'r-1', name: 'One', start: 3 }, { nope: true }], featured: { x: 1 } });
    const { rooms, body } = await client(f).list();
    expect(rooms).toEqual([{ id: 'r-1', name: 'One', start: 3 }]);
    expect(body.featured).toEqual({ x: 1 });
    expect(f.sent[0]).toMatchObject({ url: '/game/api/rooms', method: 'GET' });
  });

  it('throws a sentence for a list it cannot read', async () => {
    await expect(client(fake(500, { error: 'boom' })).list()).rejects.toThrow('Could not load the rooms: boom.');
    await expect(client(fake(200, { rooms: 'no' })).list()).rejects.toThrow('the server sent something that is not a room list');
    await expect(client(unreachable).list()).rejects.toThrow('Could not reach the server.');
  });

  it('reads one room, null on a 404', async () => {
    expect(await client(fake(200, { id: 'r-1', name: 'One' })).get('r 1')).toEqual({ id: 'r-1', name: 'One', start: null });
    expect(await client(fake(404, { error: 'no' })).get('r-1')).toBeNull();
    await expect(client(fake(200, { junk: 1 })).get('r-1')).rejects.toThrow('not a room');
  });

  it('creates with the body as given, and words a refusal', async () => {
    const f = fake(200, { id: 'r-2', name: 'Two' });
    expect(await client(f).create({ name: 'Two', gameType: 'toy' })).toEqual({ ok: true, room: { id: 'r-2', name: 'Two', start: null } });
    expect(f.sent[0]).toEqual({ url: '/game/api/rooms', method: 'POST', body: { name: 'Two', gameType: 'toy' } });
    expect(await client(fake(400, { error: 'name too long' })).create({ name: 'x' })).toEqual({ ok: false, message: 'Could not create the room: name too long.' });
    expect(await client(fake(200, { junk: 1 })).create({ name: 'x' })).toEqual({ ok: false, message: 'The server answered with something that is not a room.' });
  });

  it('answers a wrong password and a missing room alike, and keeps a rate limit apart', async () => {
    expect(await client(fake(403, { error: 'no such room' })).join('r-1', 'pw')).toEqual({ ok: false, reason: 'refused' });
    expect(await client(fake(404, { error: 'no such room' })).join('r-1')).toEqual({ ok: false, reason: 'refused' });
    expect(await client(fake(429, { error: 'slow down' })).join('r-1')).toEqual({ ok: false, reason: 'rate-limited' });
    expect(await client(unreachable).join('r-1')).toEqual({ ok: false, reason: 'error', message: 'Could not reach the server.' });
  });

  it('sends a password only when there is one', async () => {
    const f = fake(200, { id: 'r-1', name: 'One' });
    await client(f).join('r-1', '');
    await client(f).join('r-1', 'pw');
    expect(f.sent.map((s) => s.body)).toEqual([{}, { password: 'pw' }]);
    expect(f.sent[0]!.url).toBe('/game/api/rooms/r-1/join');
  });

  it('posts every seat op to room-core’s own route, and shows its refusal as the server said it', async () => {
    const f = fake(200, { id: 'r-1', name: 'One' });
    const c = client(f);
    await c.sit('r-1');
    await c.sit('r-1', 2);
    await c.stand('r-1');
    await c.setSeatClosed('r-1', 3, true);
    await c.bot('r-1', 1);
    await c.botOff('r-1', 1);
    await c.removeFromSeat('r-1', 'm-2');
    await c.lowerSeatCapacity('r-1', 4);
    await c.makeLeader('r-1', 'm-2');
    expect(f.sent.map((s) => [s.url.replace('/game/api/rooms/r-1/', ''), s.body])).toEqual([
      ['seats/sit', {}],
      ['seats/sit', { seat: 2 }],
      ['seats/stand', {}],
      ['seats/close', { seat: 3, closed: true }],
      ['seats/bot', { seat: 1 }],
      ['seats/bot-off', { seat: 1 }],
      ['seats/remove', { memberId: 'm-2' }],
      ['seats/capacity', { count: 4 }],
      ['leader', { memberId: 'm-2' }],
    ]);
    expect(await client(fake(403, { error: 'only the room leader can do that' })).bot('r-1', 1)).toEqual({ ok: false, message: 'only the room leader can do that' });
    expect(await client(fake(409, null)).sit('r-1')).toEqual({ ok: false, message: 'the server answered HTTP 409' });
  });

  it('ends a room with no room in the answer', async () => {
    const f = fake(204, undefined);
    expect(await client(f).close('r-1')).toEqual({ ok: true });
    expect(f.sent[0]!.url).toBe('/game/api/rooms/r-1/close');
    expect(await client(fake(403, { error: 'not yours' })).reset('r-1')).toEqual({ ok: false, message: 'Could not reset the room: not yours.' });
  });

  it('binds a host’s room to one of this game’s, through room-core’s own route', async () => {
    const f = fake(200, { id: 'r-9', name: 'Nine' });
    expect(await client(f).bindWatchparty('wp-room')).toEqual({ ok: true, room: { id: 'r-9', name: 'Nine', start: null } });
    expect(f.sent[0]).toEqual({ url: '/game/api/rooms/watchparty', method: 'POST', body: { room: 'wp-room' } });
    expect(await client(fake(403, { error: 'no' })).bindWatchparty('wp-room')).toEqual({ ok: false, message: 'Could not open this room’s table: no.' });
  });

  it('carries a game’s own route with the same refusals', async () => {
    const f = fake(400, { error: 'not now' });
    expect(await client(f).write('/r-1/start', {}, 'Could not start')).toEqual({ ok: false, message: 'Could not start: not now.' });
    expect(f.sent[0]).toMatchObject({ url: '/game/api/rooms/r-1/start', method: 'POST' });
  });
});

describe('roomFrontClient', () => {
  const toFront = (r: ToyRoom): RoomFrontRoom => ({
    id: r.id,
    name: r.name,
    gameType: 'toy',
    locked: false,
    members: [],
    you: { id: 'me' },
    view: { seatsFilled: 0, seatsCapacity: 2, state: { key: 'lobby', label: 'Open', detail: null }, primaryAction: 'Join', extraWatch: false },
  });

  it('projects every room the list, a create and a join answer with', async () => {
    const front = roomFrontClient(client(fake(200, { rooms: [{ id: 'r-1', name: 'One' }] })), toFront);
    expect((await front.list()).rooms.map((r) => r.view.state.label)).toEqual(['Open']);
    const joined = await roomFrontClient(client(fake(200, { id: 'r-1', name: 'One' })), toFront).join('r-1');
    expect(joined.ok && joined.room.gameType).toBe('toy');
  });

  it('offers Reset only when asked', () => {
    expect(roomFrontClient(client(fake(200, {})), toFront).reset).toBeUndefined();
    expect(roomFrontClient(client(fake(200, {})), toFront, { reset: true }).reset).toBeTypeOf('function');
  });
});

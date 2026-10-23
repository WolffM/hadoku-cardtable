/*
 * The table id every `TablesClient` call now takes (wave 72 §Q, "the UI
 * clients don't speak tables"): `routes.ts`'s wire contract is `?table=` on
 * the GET and a `table` body field everywhere else, absent meaning the room's
 * first table. This file only proves the plumbing — that a given id reaches
 * the request exactly that way, and an omitted one leaves the request
 * byte-for-byte what a pre-wave-72 caller always sent. The table views
 * themselves are already covered end to end by `constructed.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import type { Fetch } from '../http.ts';
import { tablesClient } from './tables.ts';

interface Call {
  url: string;
  body: unknown;
}

function stub(calls: Call[]): Fetch {
  return async (url, init) => {
    calls.push({ url: String(url), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ room: { id: 'r-1', name: 'x', gameType: 'constructed-1v1', matchId: null, seats: 2 }, you: { player: false, leader: false }, players: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('TablesClient — the table id every call takes', () => {
  it('table(): an id is a `?table=` query param; omitted leaves the URL as it always was', async () => {
    const calls: Call[] = [];
    const client = tablesClient(stub(calls), '/api/');
    await client.table('r-1');
    expect(calls[0]!.url).toBe('/api/tables/rooms/r-1');
    await client.table('r-1', 't-abc12345');
    expect(calls[1]!.url).toBe('/api/tables/rooms/r-1?table=t-abc12345');
  });

  it.each([
    ['loadDeck', (c: ReturnType<typeof tablesClient>, id?: string) => c.loadDeck('r-1', { library: 'd-1' }, id), { deck: { library: 'd-1' } }],
    ['ready', (c: ReturnType<typeof tablesClient>, id?: string) => c.ready('r-1', true, id), { ready: true }],
    ['ready, pressed as a Rematch', (c: ReturnType<typeof tablesClient>, id?: string) => c.ready('r-1', true, id, { rematch: true }), { ready: true, rematch: true }],
    ['sit', (c: ReturnType<typeof tablesClient>, id?: string) => c.sit('r-1', id), {}],
    ['stand', (c: ReturnType<typeof tablesClient>, id?: string) => c.stand('r-1', id), {}],
  ] as const)('%s: a given id is a `table` body field; omitted sends no such key at all', async (_name, call, baseBody) => {
    const calls: Call[] = [];
    const client = tablesClient(stub(calls), '/api/');
    await call(client, undefined);
    expect(calls[0]!.body).toEqual(baseBody);
    expect(Object.keys(calls[0]!.body as object)).not.toContain('table');
    await call(client, 't-abc12345');
    expect(calls[1]!.body).toEqual({ ...baseBody, table: 't-abc12345' });
  });

  it('startRoom and startVsBot: the same `table` body field on `POST /api/play/matches`', async () => {
    const calls: Call[] = [];
    const matchStub: Fetch = async (url, init) => {
      calls.push({ url: String(url), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ matchId: 'm-1' }), { status: 201, headers: { 'content-type': 'application/json' } });
    };
    const client = tablesClient(matchStub, '/api/');
    await client.startRoom('r-1');
    expect(calls[0]!.body).toEqual({ room: 'r-1' });
    await client.startRoom('r-1', 't-abc12345');
    expect(calls[1]!.body).toEqual({ room: 'r-1', table: 't-abc12345' });
    await client.startVsBot('r-1', 't-abc12345');
    expect(calls[2]!.body).toEqual({ room: 'r-1', bot: true, table: 't-abc12345' });
    await client.startVsBot('r-1', undefined, { rematch: true });
    expect(calls[3]!.body, 'a Rematch says so').toEqual({ room: 'r-1', bot: true, rematch: true });
  });
});

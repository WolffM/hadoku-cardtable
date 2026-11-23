/*
 * The built-deck client against wave 125's `/api/me/*` contract: one person's document on our
 * server, read whole by `GET /api/me/library`, one built deck written by `PUT /api/me/built/:id` and
 * removed by `DELETE`. The stand-in server below keeps the document exactly as the contract shapes
 * it (`built: { [builtId]: { name, format, dck, createdAt, updatedAt } }`), so a client that sent a
 * different path, method or body, or read a different shape back, fails here.
 */
import { describe, expect, it } from 'vitest';

import { BUILT_PREFIX, builtDecksClient, builtDecksOf, isBuiltDeckId, type BuiltDecksClient } from './builtDecks.ts';

interface Entry {
  name: string;
  format: string;
  dck: string;
  createdAt: number;
  updatedAt: number;
}

/** `/api/me/*` as the contract states it, over one document. */
function standIn(): { client: BuiltDecksClient; doc: { built: Record<string, Entry> }; calls: string[]; down: { on: boolean } } {
  const doc = { favourites: {}, decks: {}, built: {} as Record<string, Entry> };
  const calls: string[] = [];
  const down = { on: false };
  let clock = 1_000;
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    if (down.on) throw new TypeError('fetch failed');
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${input}`);
    if (method === 'GET' && input === '/api/me/library') return json(200, doc);
    const m = /^\/api\/me\/built\/([^/]+)$/.exec(input);
    if (m === null) return json(404, { error: 'not found' });
    const id = decodeURIComponent(m[1]!);
    if (method === 'DELETE') {
      if (!(id in doc.built)) return json(404, { error: 'no such deck' });
      delete doc.built[id];
      return json(200, { ok: true });
    }
    if (method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as { name: string; format: string; dck: string };
      if (Object.keys(body).sort().join() !== 'dck,format,name') return json(400, { error: 'body is { name, format, dck }' });
      if (body.dck.length > 16 * 1024) return json(413, { error: 'a deck is at most 16 KB' });
      clock += 1;
      const had = doc.built[id];
      const entry = { ...body, createdAt: had?.createdAt ?? clock, updatedAt: clock };
      doc.built[id] = entry;
      return json(200, { deck: entry });
    }
    return json(405, { error: 'method' });
  };
  return { client: builtDecksClient(fetchImpl, '/api/'), doc, calls, down };
}

const DCK = '[metadata]\nName=Burn\n[Main]\n4 Lightning Bolt\n20 Mountain\n';

describe('builtDecks', () => {
  it('saves a new deck under a fresh built: id, lists it, and deletes it', async () => {
    const { client, doc, calls } = standIn();
    expect(await client.list()).toEqual([]);

    const saved = await client.save({ name: 'Burn', format: '2010-07-16', dck: DCK });
    if (!saved.ok) throw new Error(saved.message);
    expect(isBuiltDeckId(saved.deck.id)).toBe(true);
    expect(saved.deck).toMatchObject({ name: 'Burn', format: '2010-07-16', dck: DCK });
    expect(calls.at(-1)).toBe(`PUT /api/me/built/${encodeURIComponent(saved.deck.id)}`);
    expect(Object.keys(doc.built)).toEqual([saved.deck.id]);

    expect(await client.list()).toEqual([saved.deck]);

    expect(await client.remove(saved.deck.id)).toEqual({ ok: true });
    expect(await client.list()).toEqual([]);
  });

  it('a save with an id rewrites that deck, keeping when it was made', async () => {
    const { client } = standIn();
    const first = await client.save({ name: 'Burn', format: 'free', dck: DCK });
    if (!first.ok) throw new Error(first.message);
    const again = await client.save({ id: first.deck.id, name: 'Burn 2', format: 'free', dck: DCK });
    if (!again.ok) throw new Error(again.message);
    expect(again.deck.id).toBe(first.deck.id);
    expect(again.deck.createdAt).toBe(first.deck.createdAt);
    expect(again.deck.updatedAt).toBeGreaterThan(first.deck.updatedAt);
    expect((await client.list()).map((d) => d.name)).toEqual(['Burn 2']);
  });

  it('lists newest change first', async () => {
    const { client } = standIn();
    const a = await client.save({ name: 'A', format: 'free', dck: DCK });
    await client.save({ name: 'B', format: 'free', dck: DCK });
    if (!a.ok) throw new Error(a.message);
    await client.save({ id: a.deck.id, name: 'A again', format: 'free', dck: DCK });
    expect((await client.list()).map((d) => d.name)).toEqual(['A again', 'B']);
  });

  it("says the server's refusal in its own words", async () => {
    const { client } = standIn();
    const big = await client.save({ name: 'Big', format: 'free', dck: 'x'.repeat(17 * 1024) });
    expect(big).toEqual({ ok: false, message: 'a deck is at most 16 KB' });
    expect(await client.remove(`${BUILT_PREFIX}nope`)).toEqual({ ok: false, message: 'no such deck' });
  });

  it('refuses an id that is not a built deck without asking the server', async () => {
    const { client, calls } = standIn();
    const out = await client.save({ id: 'pod-1', name: 'X', format: 'free', dck: DCK });
    expect(out.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('an unreachable server is a refusal for writes and a throw for the list', async () => {
    const { client, down } = standIn();
    down.on = true;
    await expect(client.list()).rejects.toThrow('Could not reach the server.');
    expect(await client.save({ name: 'X', format: 'free', dck: DCK })).toEqual({ ok: false, message: 'Could not reach the server.' });
    expect(await client.remove(`${BUILT_PREFIX}x`)).toEqual({ ok: false, message: 'Could not reach the server.' });
  });

  it('skips an entry it cannot read and a key that is not a built id', () => {
    const good = { name: 'G', format: 'free', dck: DCK, createdAt: 1, updatedAt: 2 };
    expect(builtDecksOf({ [`${BUILT_PREFIX}a`]: good, [`${BUILT_PREFIX}b`]: { name: 'no dates' }, 'pod-1': good })).toEqual([{ id: `${BUILT_PREFIX}a`, ...good }]);
    expect(builtDecksOf(null)).toEqual([]);
  });
});

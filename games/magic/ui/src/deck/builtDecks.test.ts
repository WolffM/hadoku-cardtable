/*
 * The built-deck client against the server's `/api/me/*` routes (`server/src/http/me.ts`). This
 * package cannot import the server (no express, and the server's carddata barrel breaks the DOM
 * typecheck), so `standIn` below answers exactly as `attachMe` does: `built` a list newest first,
 * `PUT` answering `{ built }`, `DELETE` answering 204 or 404 `no such built deck`, each `:builtId`
 * being the `built:<uuid>` id or its bare uuid, and a document per `X-User-Id`. The same cases ran
 * green against the real `attachMe` on a listening server when this client was written.
 */
import { describe, expect, it } from 'vitest';

import { BUILT_PREFIX, builtDecksClient, builtDecksOf, isBuiltDeckId, type BuiltDeck, type BuiltDecksClient } from './builtDecks.ts';

type Doc = Record<string, Omit<BuiltDeck, 'id'>>;
const docs = new Map<string, Doc>();
let clock = 1_000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** `attachMe`'s built-deck routes, over one document per person. */
async function standIn(userId: string, input: string, init?: RequestInit): Promise<Response> {
  const doc = docs.get(userId) ?? {};
  docs.set(userId, doc);
  const method = init?.method ?? 'GET';
  if (method === 'GET' && input === '/api/me/library') {
    const built = Object.entries(doc)
      .map(([id, b]) => ({ id, ...b }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return json(200, { favourites: {}, decks: {}, built });
  }
  const m = /^\/api\/me\/built\/([^/]+)$/.exec(input);
  if (m === null) return json(404, { error: 'not found' });
  const raw = decodeURIComponent(m[1]!);
  const uuid = raw.startsWith(BUILT_PREFIX) ? raw.slice(BUILT_PREFIX.length) : raw;
  const id = /^[A-Za-z0-9-]{1,64}$/.test(uuid) ? `${BUILT_PREFIX}${uuid}` : null;
  if (method === 'DELETE') {
    if (id === null || doc[id] === undefined) return json(404, { error: 'no such built deck' });
    delete doc[id];
    return new Response(null, { status: 204 });
  }
  if (method === 'PUT') {
    if (id === null) return json(400, { error: 'not a built deck id' });
    const body = JSON.parse(String(init?.body)) as { name: string; format: string; dck: string };
    if (Object.keys(body).sort().join() !== 'dck,format,name') return json(400, { error: 'body is { name, format, dck }' });
    if (new TextEncoder().encode(body.dck).length > 16 * 1024) return json(400, { error: 'a deck is at most 16384 bytes' });
    clock += 1;
    doc[id] = { ...body, createdAt: doc[id]?.createdAt ?? clock, updatedAt: clock };
    return json(200, { built: { id, ...doc[id] } });
  }
  return json(404, { error: 'not found' });
}

let people = 0;
/** A client for a fresh person: the edge's `X-User-Id` on every request. */
function person(): BuiltDecksClient {
  const userId = `user-${(people += 1)}`;
  return builtDecksClient((input, init) => standIn(userId, input, init), '/api/');
}

const base = '/api/';

const DCK = '[metadata]\nName=Burn\n[Main]\n4 Lightning Bolt\n20 Mountain\n';

describe('builtDecks over /api/me', () => {
  it('saves a new deck under a fresh built: id, lists it, and deletes it', async () => {
    const client = person();
    expect(await client.list()).toEqual([]);

    const saved = await client.save({ name: 'Burn', format: '2010-07-16', dck: DCK });
    if (!saved.ok) throw new Error(saved.message);
    expect(isBuiltDeckId(saved.deck.id)).toBe(true);
    expect(saved.deck).toMatchObject({ name: 'Burn', format: '2010-07-16', dck: DCK });

    expect(await client.list()).toEqual([saved.deck]);

    expect(await client.remove(saved.deck.id)).toEqual({ ok: true });
    expect(await client.list()).toEqual([]);
  });

  it('a save with an id rewrites that deck, keeping when it was made', async () => {
    const client = person();
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
    const client = person();
    const a = await client.save({ name: 'A', format: 'free', dck: DCK });
    await client.save({ name: 'B', format: 'free', dck: DCK });
    if (!a.ok) throw new Error(a.message);
    await client.save({ id: a.deck.id, name: 'A again', format: 'free', dck: DCK });
    expect((await client.list()).map((d) => d.name)).toEqual(['A again', 'B']);
  });

  it("one person's decks are not another's", async () => {
    const mine = person();
    const saved = await mine.save({ name: 'Mine', format: 'free', dck: DCK });
    if (!saved.ok) throw new Error(saved.message);
    const theirs = person();
    expect(await theirs.list()).toEqual([]);
    expect((await theirs.remove(saved.deck.id)).ok).toBe(false);
    expect(await mine.list()).toHaveLength(1);
  });

  it("says the server's refusal in its own words", async () => {
    const client = person();
    const big = await client.save({ name: 'Big', format: 'free', dck: 'x'.repeat(17 * 1024) });
    expect(big.ok).toBe(false);
    expect(!big.ok && big.message).toMatch(/at most/);
    expect(await client.remove(`${BUILT_PREFIX}nope`)).toEqual({ ok: false, message: 'no such built deck' });
  });

  it('refuses an id that is not a built deck without asking the server', async () => {
    let asked = 0;
    const client = builtDecksClient(async () => {
      asked += 1;
      return new Response(null, { status: 500 });
    }, base);
    expect((await client.save({ id: 'pod-1', name: 'X', format: 'free', dck: DCK })).ok).toBe(false);
    expect(asked).toBe(0);
  });

  it('an unreachable server is a refusal for writes and a throw for the list', async () => {
    const client = builtDecksClient(() => Promise.reject(new TypeError('fetch failed')), base);
    await expect(client.list()).rejects.toThrow('Could not reach the server.');
    expect(await client.save({ name: 'X', format: 'free', dck: DCK })).toEqual({ ok: false, message: 'Could not reach the server.' });
    expect(await client.remove(`${BUILT_PREFIX}x`)).toEqual({ ok: false, message: 'Could not reach the server.' });
  });

  it('skips an entry it cannot read', () => {
    const good = { id: `${BUILT_PREFIX}a`, name: 'G', format: 'free', dck: DCK, createdAt: 1, updatedAt: 2 };
    expect(builtDecksOf([good, { id: `${BUILT_PREFIX}b`, name: 'no dates' }, { ...good, id: 'pod-1' }])).toEqual([good]);
    expect(builtDecksOf(null)).toEqual([]);
  });
});

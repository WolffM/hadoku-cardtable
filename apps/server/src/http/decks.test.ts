/**
 * `/api/decks` against a real express app: a finished draft is the drafter's
 * deck, the pod builder's save is what the list shows, and rename/delete wait
 * for the tournament — mounted the way `index.ts` mounts it, beside
 * `attachDrafts`, whose `PUT …/deck` is the one save path both screens use.
 */

import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DraftCard, PodView } from '@hadoku/shared';

import { deckFromPool, dckTextOf } from '../../../ui/src/draft/deckFromPool.ts';

import { loadPool, type CubePool } from '../room/pool.ts';
import { createDraftRooms, joinDraftRoom, stateOf, type DraftRooms } from '../room/draftRooms.ts';
import { identityFromHeaders } from '../room/identity.ts';

const EDGE_SECRET = 'test-edge-auth-secret';
const POOL_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../ui/src/draft/pool.json');

let decksMod: typeof import('./decks.ts');
let draftsMod: typeof import('./drafts.ts');
let edgeMod: typeof import('../edge-auth.ts');
let cube: CubePool;

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	decksMod = await import('./decks.ts');
	draftsMod = await import('./drafts.ts');
	edgeMod = await import('../edge-auth.ts');
	const load = loadPool(POOL_FILE);
	if (!load.ok) throw new Error(`the bundled cube pool did not load: ${load.detail}`);
	cube = load.pool;
});

const edgeHeaders = (user: string): Record<string, string> => ({
	'x-edge-auth': EDGE_SECRET,
	'x-hadoku-tier': 'friend',
	'x-user-id': `user-${user}`,
	'x-user-key': `friend-key-${user}`,
});

const dirs: string[] = [];
const servers: HttpServer[] = [];

afterAll(async () => {
	for (const server of servers) await new Promise<void>((done) => server.close(() => done()));
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

type Lobby = Map<string, { name: string; pod: PodView | null }>;

async function openApp(draftRooms: DraftRooms, lobby: Lobby): Promise<string> {
	const app = express();
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	const api = express.Router();
	draftsMod.attachDrafts(api, { draftRooms, log: () => undefined });
	decksMod.attachDecks(api, { draftRooms, room: (id) => lobby.get(id), log: () => undefined });
	app.use('/api', api);
	const server = createServer(app);
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	servers.push(server);
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function call(base: string, method: string, path: string, as = 'alice', body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await fetch(`${base}${path}`, {
		method,
		headers: { ...edgeHeaders(as), 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	return { status: res.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

/** Seat `who` and hand them a pool, finished or not — no picks played. */
function seatIn(draftRooms: DraftRooms, draftId: string, who: string, complete: boolean): void {
	const room = draftRooms.open(draftId);
	const seat = joinDraftRoom(room, `c-${who}-${draftId}`, identityFromHeaders(edgeHeaders(who), 'x'), 'friend').seat;
	if (seat === null) throw new Error(`${who} was not seated`);
	const state = stateOf(room);
	state.pools[seat] = state.packs.flat().slice(0, 45);
	if (complete) state.status = 'complete';
}

const pod = (phase: PodView['phase']): PodView => ({ phase }) as PodView;
const decksOf = (json: Record<string, unknown>) => json.decks as { id: string; name: string; deck: string | null; concluded: boolean; pool: unknown[] }[];

describe('/api/decks', () => {
	it('lists only the caller’s finished drafts, named after the room, with the build the pod saved', async () => {
		const storeDir = await mkdtemp(join(tmpdir(), 'cardtable-decks-test-'));
		dirs.push(storeDir);
		const draftRooms = createDraftRooms({ pool: cube.cards, cube: cube.meta, storeDir });
		const lobby: Lobby = new Map([
			['pod-done', { name: 'Friday cube', pod: pod('rounds') }],
			['pod-drafting', { name: 'Still picking', pod: null }],
		]);
		seatIn(draftRooms, 'pod-done', 'alice', true);
		seatIn(draftRooms, 'pod-drafting', 'alice', false);
		seatIn(draftRooms, 'pod-bob', 'bob', true);
		const base = await openApp(draftRooms, lobby);

		const before = await call(base, 'GET', '/api/decks');
		expect(before.status).toBe(200);
		expect(decksOf(before.json).map((d) => [d.id, d.name, d.deck, d.concluded])).toEqual([['pod-done', 'Friday cube', null, false]]);
		expect(decksOf(before.json)[0]?.pool).toHaveLength(45);

		const mine = await call(base, 'GET', '/api/drafts/pod-done/mine');
		const dck = dckTextOf(deckFromPool('pod-done', mine.json.pool as DraftCard[]));
		const saved = await call(base, "PUT", "/api/drafts/pod-done/deck", "alice", { dck });
	expect(saved.json).toEqual({ deck: dck });
		expect(decksOf((await call(base, 'GET', '/api/decks')).json)[0]?.deck).toBe(dck);
		expect(decksOf((await call(base, 'GET', '/api/decks', 'bob')).json).map((d) => d.id)).toEqual(['pod-bob']);
	});

	it('refuses a rename or a delete while the tournament is on, and allows both once it is done — and they survive a restart', async () => {
		const storeDir = await mkdtemp(join(tmpdir(), 'cardtable-decks-test-'));
		dirs.push(storeDir);
		const draftRooms = createDraftRooms({ pool: cube.cards, cube: cube.meta, storeDir });
		const lobby: Lobby = new Map([['pod-a', { name: 'Pod A', pod: pod('rounds') }]]);
		seatIn(draftRooms, 'pod-a', 'alice', true);
		seatIn(draftRooms, 'pod-gone', 'alice', true);
		draftRooms.find('pod-a')?.app.persist(draftRooms.find('pod-a')!);
		draftRooms.find('pod-gone')?.app.persist(draftRooms.find('pod-gone')!);
		const base = await openApp(draftRooms, lobby);

		expect((await call(base, 'PATCH', '/api/decks/pod-a', 'alice', { name: 'Blue tempo' })).status).toBe(409);
		expect((await call(base, 'DELETE', '/api/decks/pod-a')).status).toBe(409);
		expect((await call(base, 'PATCH', '/api/decks/pod-a', 'bob', { name: 'Mine now' })).status).toBe(404);
		expect((await call(base, 'PATCH', '/api/decks/pod-a', 'alice', { name: '   ' })).status).toBe(400);

		lobby.set('pod-a', { name: 'Pod A', pod: pod('done') });
		const renamed = await call(base, 'PATCH', '/api/decks/pod-a', 'alice', { name: '  Blue tempo ' });
		expect(renamed.status).toBe(200);
		expect((renamed.json.deck as { name: string }).name).toBe('Blue tempo');
		// A pod whose room is gone has concluded too.
		expect((await call(base, 'DELETE', '/api/decks/pod-gone')).status).toBe(204);

		const restarted = createDraftRooms({ pool: cube.cards, cube: cube.meta, storeDir });
		const again = await openApp(restarted, lobby);
		expect(decksOf((await call(again, 'GET', '/api/decks')).json).map((d) => [d.id, d.name, d.concluded])).toEqual([['pod-a', 'Blue tempo', true]]);
	});
});

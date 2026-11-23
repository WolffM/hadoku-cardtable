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
import { MyDecksSchema, type DraftCard, type DraftPlan, type PodView } from '@hadoku/shared';

import { deckFromPool, dckTextOf } from '../../../ui/src/draft/deckFromPool.ts';

import { loadPool, type CubePool } from '../room/pool.ts';
import { createDraftRooms, joinDraftRoom, singlePoolResolver, stateOf, type DraftRooms } from '../room/draftRooms.ts';
import { identityFromHeaders } from '@hadoku/game-server/room/identity';
import { createSeatPresence, SEAT_RELEASE_MS } from '../room/socket.js';
import { createMagicUserStore, type MagicUserStore } from '../users/index.ts';

/** A throwaway presence tracker — this file never exercises a disconnect grace (`disconnectGraceMs` stays 0 everywhere here), so one instance shared by every `createDraftRooms` call in this file is inert, never a second REAL tracker. */
const testPresence = createSeatPresence({ seatReleaseMs: SEAT_RELEASE_MS, draftGraceOf: () => 0 });

const EDGE_SECRET = 'test-edge-auth-secret';
const BUNDLED_POOL_FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../games/magic/ui/src/draft/pool.json');

let decksMod: typeof import('./decks.ts');
let draftsMod: typeof import('./drafts.ts');
let edgeMod: typeof import('@hadoku/game-server/edge-auth');
let cube: CubePool;

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	decksMod = await import('./decks.ts');
	draftsMod = await import('./drafts.ts');
	edgeMod = await import('@hadoku/game-server/edge-auth');
	const load = loadPool(BUNDLED_POOL_FIXTURE);
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

type Lobby = Map<string, { name: string; game: { pod: (PodView & { endedAt?: number }) | null; plan?: DraftPlan } }>;

type LibraryDeps = Pick<import('./decks.ts').DecksDeps, 'users' | 'tournamentEnds'>;

async function openApp(draftRooms: DraftRooms, lobby: Lobby, cubeCover?: (cubeId: string) => string | null, library: LibraryDeps = {}): Promise<string> {
	const app = express();
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	const api = express.Router();
	draftsMod.attachDrafts(api, { draftRooms, log: () => undefined });
	decksMod.attachDecks(api, { draftRooms, room: (id) => lobby.get(id), ...(cubeCover === undefined ? {} : { cubeCover }), ...library, log: () => undefined });
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
	state.pools[seat] = state.queues.flat(2).slice(0, 45);
	if (complete) state.status = 'complete';
}

const pod = (phase: PodView['phase']): PodView => ({ phase }) as PodView;
const decksOf = (json: Record<string, unknown>) => json.decks as { id: string; name: string; deck: string | null; concluded: boolean; pool: unknown[] }[];

describe('/api/decks', () => {
	it('lists only the caller’s finished drafts, named after the room, with the build the pod saved', async () => {
		const storeDir = await mkdtemp(join(tmpdir(), 'cardtable-decks-test-'));
		dirs.push(storeDir);
		const draftRooms = createDraftRooms({ presence: testPresence, ...singlePoolResolver(cube), storeDir });
		const lobby: Lobby = new Map([
			['pod-done', { name: 'Friday cube', game: { pod: pod('rounds') } }],
			['pod-drafting', { name: 'Still picking', game: { pod: null } }],
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
		const draftRooms = createDraftRooms({ presence: testPresence, ...singlePoolResolver(cube), storeDir });
		const lobby: Lobby = new Map([['pod-a', { name: 'Pod A', game: { pod: pod('rounds') } }]]);
		seatIn(draftRooms, 'pod-a', 'alice', true);
		seatIn(draftRooms, 'pod-gone', 'alice', true);
		draftRooms.find('pod-a')?.app.persist(draftRooms.find('pod-a')!);
		draftRooms.find('pod-gone')?.app.persist(draftRooms.find('pod-gone')!);
		const base = await openApp(draftRooms, lobby);

		expect((await call(base, 'PATCH', '/api/decks/pod-a', 'alice', { name: 'Blue tempo' })).status).toBe(409);
		expect((await call(base, 'DELETE', '/api/decks/pod-a')).status).toBe(409);
		expect((await call(base, 'PATCH', '/api/decks/pod-a', 'bob', { name: 'Mine now' })).status).toBe(404);
		expect((await call(base, 'PATCH', '/api/decks/pod-a', 'alice', { name: '   ' })).status).toBe(400);

		lobby.set('pod-a', { name: 'Pod A', game: { pod: pod('done') } });
		const renamed = await call(base, 'PATCH', '/api/decks/pod-a', 'alice', { name: '  Blue tempo ' });
		expect(renamed.status).toBe(200);
		expect((renamed.json.deck as { name: string }).name).toBe('Blue tempo');
		// A pod whose room is gone has concluded too.
		expect((await call(base, 'DELETE', '/api/decks/pod-gone')).status).toBe(204);

		const restarted = createDraftRooms({ presence: testPresence, ...singlePoolResolver(cube), storeDir });
		const again = await openApp(restarted, lobby);
		expect(decksOf((await call(again, 'GET', '/api/decks')).json).map((d) => [d.id, d.name, d.concluded])).toEqual([['pod-a', 'Blue tempo', true]]);
	});

	it('sends the cover of the cube a deck was drafted from, and none for a set or a cube without one', async () => {
		const storeDir = await mkdtemp(join(tmpdir(), 'cardtable-decks-test-'));
		dirs.push(storeDir);
		const draftRooms = createDraftRooms({ presence: testPresence, ...singlePoolResolver(cube), storeDir });
		const cubeRounds = (cubeId: string): DraftPlan => ({ rounds: [0, 1, 2].map(() => ({ kind: 'cube', cubeId })) as DraftPlan['rounds'] });
		const lobby: Lobby = new Map([
			['pod-cube', { name: 'Covered', game: { pod: pod('done'), plan: cubeRounds('vintage') } }],
			['pod-bare', { name: 'Bare', game: { pod: pod('done'), plan: cubeRounds('pasted') } }],
			['pod-set', { name: 'Set', game: { pod: pod('done'), plan: { rounds: [0, 1, 2].map(() => ({ kind: 'set', code: 'HOB', style: 'realistic' })) as DraftPlan['rounds'] } } }],
		]);
		for (const id of lobby.keys()) seatIn(draftRooms, id, 'alice', true);
		const base = await openApp(draftRooms, lobby, (cubeId) => (cubeId === 'vintage' ? 'cover-of-vintage' : null));

		const listed = await call(base, 'GET', '/api/decks');
		const covers = Object.fromEntries(MyDecksSchema.parse(listed.json).decks.map((d) => [d.id, d.coverArtId]));
		expect(covers).toEqual({ 'pod-cube': 'cover-of-vintage', 'pod-bare': undefined, 'pod-set': undefined });
	});

	it('says whether each deck is yours yet: renamed, starred, or played after its tournament ended, and only once it has', async () => {
		const storeDir = await mkdtemp(join(tmpdir(), 'cardtable-decks-test-'));
		dirs.push(storeDir);
		const draftRooms = createDraftRooms({ presence: testPresence, ...singlePoolResolver(cube), storeDir });
		const users: MagicUserStore = createMagicUserStore(join(storeDir, 'users'), () => undefined);
		const ended = (endedAt?: number) => ({ ...pod('done'), ...(endedAt === undefined ? {} : { endedAt }) });
		const lobby: Lobby = new Map([
			['pod-live', { name: 'Live', game: { pod: pod('rounds') } }],
			['pod-fresh', { name: 'Fresh', game: { pod: ended(1_000) } }],
			['pod-renamed', { name: 'Renamed', game: { pod: ended(1_000) } }],
			['pod-starred', { name: 'Starred', game: { pod: ended(1_000) } }],
			['pod-after', { name: 'Played after', game: { pod: ended(1_000) } }],
			['pod-during', { name: 'Played during', game: { pod: ended(3_000) } }],
			// Finished before pods kept `endedAt`: its tournament record knows when.
			['pod-old', { name: 'Old', game: { pod: ended() } }],
		]);
		for (const id of [...lobby.keys(), 'pod-gone']) seatIn(draftRooms, id, 'alice', true);
		const createdAt = (id: string) => draftRooms.find(id)!.createdAt;
		const oldEnd = createdAt('pod-old') + 60_000;
		const tournamentEnds = async () => [
			{ id: `pod-old-${createdAt('pod-old')}`, endedAt: oldEnd },
			// Another pod's record, and one that ended before this pod was dealt (the room's earlier draft).
			{ id: `pod-older-${createdAt('pod-old')}`, endedAt: 1 },
			{ id: 'pod-old-5', endedAt: 5 },
		];
		const far = Date.now() + 3_600_000;
		await users.update('user-alice', (d) => {
			d.favourites['draft:pod-starred'] = 1;
			d.decks['draft:pod-live'] = { lastPlayedAt: far };
			d.decks['draft:pod-after'] = { lastPlayedAt: 2_000 };
			d.decks['draft:pod-during'] = { lastPlayedAt: 2_000 };
			d.decks['draft:pod-old'] = { lastPlayedAt: far };
			d.decks['draft:pod-gone'] = { lastPlayedAt: far };
		});
		const base = await openApp(draftRooms, lobby, undefined, { users, tournamentEnds });
		expect((await call(base, 'PATCH', '/api/decks/pod-renamed', 'alice', { name: 'Mine' })).json.deck).toMatchObject({ touched: true });

		const listed = MyDecksSchema.parse((await call(base, 'GET', '/api/decks')).json).decks;
		const facts = Object.fromEntries(listed.map((d) => [d.id, [d.touched, d.inTournament, d.concludedAt]]));
		expect(facts).toEqual({
			'pod-live': [false, true, null],
			'pod-fresh': [false, false, 1_000],
			'pod-renamed': [true, false, 1_000],
			'pod-starred': [true, false, 1_000],
			'pod-after': [true, false, 1_000],
			'pod-during': [false, false, 3_000],
			'pod-old': [true, false, oldEnd],
			// Its room is gone and no record kept the end: no game counts as after it.
			'pod-gone': [false, false, null],
		});
		// Another caller reads their own document, not alice's.
		seatIn(draftRooms, 'pod-starred', 'bob', true);
		expect(MyDecksSchema.parse((await call(base, 'GET', '/api/decks', 'bob')).json).decks.map((d) => [d.id, d.touched])).toEqual([['pod-starred', false]]);
	});

	it('still lists the decks when the caller’s document or the tournament records cannot be read', async () => {
		const storeDir = await mkdtemp(join(tmpdir(), 'cardtable-decks-test-'));
		dirs.push(storeDir);
		const draftRooms = createDraftRooms({ presence: testPresence, ...singlePoolResolver(cube), storeDir });
		seatIn(draftRooms, 'pod-a', 'alice', true);
		const broken = { get: () => Promise.reject(new Error('disk gone')) } as unknown as MagicUserStore;
		const base = await openApp(draftRooms, new Map([['pod-a', { name: 'A', game: { pod: pod('done') } }]]), undefined, {
			users: broken,
			tournamentEnds: () => Promise.reject(new Error('disk gone')),
		});
		const listed = await call(base, 'GET', '/api/decks');
		expect(listed.status).toBe(200);
		expect(MyDecksSchema.parse(listed.json).decks.map((d) => [d.id, d.touched, d.concludedAt])).toEqual([['pod-a', false, null]]);
	});

	it('answers a malformed JSON body without echoing it', async () => {
		const storeDir = await mkdtemp(join(tmpdir(), 'cardtable-decks-test-'));
		dirs.push(storeDir);
		const base = await openApp(createDraftRooms({ presence: testPresence, ...singlePoolResolver(cube), storeDir }), new Map());
		const res = await fetch(`${base}/api/decks/pod-a`, {
			method: 'PATCH',
			headers: { ...edgeHeaders('alice'), 'content-type': 'application/json' },
			body: '{"name": "Blue tem',
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'body is not valid JSON' });
	});
});

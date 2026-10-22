/**
 * `/api/drafts` end to end, against a REAL express app — plus the proof that
 * a finished pod's drafter keeps their pool through a leave, the seat hold
 * expiring, and a restart, read BOTH through this file's own routes and
 * through `attachTables`'s `POST /check` (`draftPoolForMember`,
 * `routes.ts:319`), which this file does not edit and must keep working
 * unchanged.
 *
 * Mounted the way `index.ts` mounts it: `edgeProvenance`, `requireMinTier`,
 * an `/api` router with `express.json()`, then `attachDrafts` and
 * `attachTables`. No socket, no JVM: a pick is driven directly against the
 * engine (`joinDraftRoom`, direct `state.pools`/`state.status` writes), the
 * same way `tables.test.ts`'s own `draftedPool` helper hands a seat its 45
 * cards without playing out a real draft.
 */

import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { reservationFor, seatOf, type SeatId } from '@wolffm/rooms-protocol';
import { moveToMain } from '@hadoku/deck';
import { pick, runBots } from '@hadoku/draft';
import type { DraftCard } from '@hadoku/shared';

import { deckFromPool, dckTextOf } from '../../../ui/src/draft/deckFromPool.ts';
import { loadPool, type CubePool } from '../room/pool.ts';
import { createDraftRooms, joinDraftRoom, releaseSeat, singlePoolResolver, stateOf, type DraftRoom, type DraftRooms } from '../room/draftRooms.ts';
import { identityFromHeaders } from '../room/identity.ts';
import { loadTablesLibrary } from './library.ts';

const EDGE_SECRET = 'test-edge-auth-secret';
const BUNDLED_POOL_FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../ui/src/draft/pool.json');
const library = loadTablesLibrary(resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'));

// `draftRooms.ts`/`identity.ts` read no env at import time, so they are
// imported statically above — same split `tables.test.ts` uses. `drafts.ts`,
// `routes.ts` and `edge-auth.ts` transitively read `config.ts`'s
// `EDGE_AUTH_SECRET` at module-evaluation time, so they need the
// reset-then-dynamic-import dance below.
let draftsMod: typeof import('./drafts.ts');
let routesMod: typeof import('./routes.ts');
let edgeMod: typeof import('../edge-auth.ts');

let cube: CubePool;

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	draftsMod = await import('./drafts.ts');
	routesMod = await import('./routes.ts');
	edgeMod = await import('../edge-auth.ts');

	const load = loadPool(BUNDLED_POOL_FIXTURE);
	if (!load.ok) throw new Error(`the bundled cube pool did not load: ${load.detail}`);
	cube = load.pool;
});

function edgeHeaders(user: string, tier = 'friend'): Record<string, string> {
	return {
		'x-edge-auth': EDGE_SECRET,
		'x-hadoku-tier': tier,
		'x-user-id': `user-${user}`,
		'x-user-key': `friend-key-${user}`,
	};
}

const dirs: string[] = [];
const servers: HttpServer[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-drafts-test-'));
	dirs.push(dir);
	return dir;
}

interface Harness {
	base: string;
	draftRooms: DraftRooms;
}

async function openApp(draftRooms: DraftRooms): Promise<Harness> {
	const app = express();
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	const api = express.Router();
	api.use(express.json({ limit: '1mb' }));
	draftsMod.attachDrafts(api, { draftRooms });
	// The proof below reads `draftPoolForMember` through this route —
	// `POST /api/tables/check` — without this file editing `routes.ts`.
	routesMod.attachTables(api, { library, draftRooms });
	app.use('/api', api);

	const server = createServer(app);
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	servers.push(server);
	const { port } = server.address() as AddressInfo;
	return { base: `http://127.0.0.1:${port}`, draftRooms };
}

async function call(
	h: Harness,
	method: 'GET' | 'PUT' | 'POST',
	path: string,
	opts: { as?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await fetch(`${h.base}${path}`, {
		method,
		headers: { ...edgeHeaders(opts.as ?? 'alice'), 'content-type': 'application/json' },
		body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
	});
	const text = await res.text();
	return { status: res.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	for (const server of servers) await new Promise<void>((done) => server.close(() => done()));
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** Seat `who` in `draftId` and hand them a finished 45-card pool — no picks played. */
function finishPodFor(
	draftRooms: DraftRooms,
	draftId: string,
	who: string,
	clientId: string,
): { room: DraftRoom; seat: SeatId; pool: DraftCard[] } {
	const room = draftRooms.open(draftId);
	const participantId = identityFromHeaders(edgeHeaders(who), clientId);
	const seat = joinDraftRoom(room, clientId, participantId, 'friend').seat;
	if (seat === null) throw new Error(`${who} was not seated`);
	const state = stateOf(room);
	const pool = state.packs.flat().slice(0, 45);
	state.pools[seat] = pool;
	state.status = 'complete';
	return { room, seat, pool };
}

/** The deck the browser would write: everything the pool offers, into main, plus basics. */
function legalDeckFor(draftId: string, pool: DraftCard[]): string {
	let deck = deckFromPool(draftId, pool);
	for (const card of pool) {
		const entry = deck.sideboard.find((e) => e.card.name === card.name && e.card.set === (card.setCode || null));
		if (entry !== undefined) deck = moveToMain(deck, entry.card, 1);
	}
	return dckTextOf(deck);
}

describe('GET /api/drafts/:podId/mine', () => {
	it('404s a caller who drafted no seat in that pod', async () => {
		const draftRooms = createDraftRooms({ ...singlePoolResolver(cube), storeDir: null });
		const h = await openApp(draftRooms);
		const res = await call(h, 'GET', '/api/drafts/no-such-pod/mine', { as: 'alice' });
		expect(res.status).toBe(404);
	});

	it("answers the seated drafter's own pool, deck null before the first save", async () => {
		const draftRooms = createDraftRooms({ ...singlePoolResolver(cube), storeDir: null });
		finishPodFor(draftRooms, 'pod-a', 'alice', 'sock-a');
		const h = await openApp(draftRooms);
		const res = await call(h, 'GET', '/api/drafts/pod-a/mine', { as: 'alice' });
		expect(res.status).toBe(200);
		expect((res.json.pool as unknown[]).length).toBe(45);
		expect(res.json.deck).toBeNull();
	});

	it('mid-draft, an unseated participant is still a spectator — rule 1 only applies once the pod is DONE', async () => {
		const draftRooms = createDraftRooms({ ...singlePoolResolver(cube), storeDir: null });
		const room = draftRooms.open('pod-b');
		const alice = identityFromHeaders(edgeHeaders('alice'), 'sock-a');
		joinDraftRoom(room, 'sock-a', alice, 'friend');
		releaseSeat(room, alice);
		// `state.status` is still 'drafting' — nothing in rule 1 should fire.
		expect(stateOf(room).status).toBe('drafting');
		const h = await openApp(draftRooms);
		const res = await call(h, 'GET', '/api/drafts/pod-b/mine', { as: 'alice' });
		expect(res.status).toBe(404);
	});
});

describe('PUT /api/drafts/:podId/deck', () => {
	it('saves a legal build and echoes the .dck text back', async () => {
		const draftRooms = createDraftRooms({ ...singlePoolResolver(cube), storeDir: null });
		const { pool } = finishPodFor(draftRooms, 'pod-c', 'alice', 'sock-a');
		const h = await openApp(draftRooms);
		const dck = legalDeckFor('pod-c', pool);
		const put = await call(h, 'PUT', '/api/drafts/pod-c/deck', { as: 'alice', body: { dck } });
		expect(put.status).toBe(200);
		expect(put.json.deck).toBe(dck);

		const mine = await call(h, 'GET', '/api/drafts/pod-c/mine', { as: 'alice' });
		expect(mine.json.deck).toBe(dck);
	});

	it('saves an unfinished build — 24 cards of the pool — and GET …/mine reads it back', async () => {
		const draftRooms = createDraftRooms({ ...singlePoolResolver(cube), storeDir: null });
		const { pool } = finishPodFor(draftRooms, 'pod-h', 'alice', 'sock-a');
		const h = await openApp(draftRooms);
		let deck = deckFromPool('pod-h', pool);
		for (const card of pool.slice(0, 24)) {
			const entry = deck.sideboard.find((e) => e.card.name === card.name && e.card.set === (card.setCode || null));
			if (entry !== undefined) deck = moveToMain(deck, entry.card, 1);
		}
		expect(deck.main.reduce((n, e) => n + e.count, 0)).toBe(24);
		const dck = dckTextOf(deck);
		const put = await call(h, 'PUT', '/api/drafts/pod-h/deck', { as: 'alice', body: { dck } });
		expect(put.status).toBe(200);
		expect(put.json.deck).toBe(dck);
		expect((await call(h, 'GET', '/api/drafts/pod-h/mine', { as: 'alice' })).json.deck).toBe(dck);
	});

	it('400s with issues — never saves — a build that plays a card outside the pool', async () => {
		const draftRooms = createDraftRooms({ ...singlePoolResolver(cube), storeDir: null });
		finishPodFor(draftRooms, 'pod-d', 'alice', 'sock-a');
		const h = await openApp(draftRooms);
		const dck = '[metadata]\nName=Not drafted\n[main]\n40 Plains\n4 Black Lotus\n';
		const put = await call(h, 'PUT', '/api/drafts/pod-d/deck', { as: 'alice', body: { dck } });
		expect(put.status).toBe(400);
		expect(put.json.issues).toEqual(expect.arrayContaining([expect.stringContaining('Black Lotus')]));
		expect((await call(h, 'GET', '/api/drafts/pod-d/mine', { as: 'alice' })).json.deck).toBeNull();
	});

	it('404s a caller with no seat, same as GET', async () => {
		const draftRooms = createDraftRooms({ ...singlePoolResolver(cube), storeDir: null });
		const h = await openApp(draftRooms);
		const put = await call(h, 'PUT', '/api/drafts/no-such-pod/deck', { as: 'alice', body: { dck: '[metadata]\n' } });
		expect(put.status).toBe(404);
	});
});

/*
 * ── ownership survives a leave, the hold, and a restart ──────────────────
 *
 * Leave, let the 120 s-style hold lapse, restart the store, and confirm BOTH
 * `GET …/mine` (this file's own route) and the table gate's draft check
 * (`POST /api/tables/check`, through `attachTables`, which this file does
 * not edit) still find the pool.
 *
 * `reservationTtlMs` is 20 ms rather than 120 000 so the test waits
 * milliseconds, not minutes, for the SAME lapse — `unseatParticipant`'s hold
 * is wall-clock real time (`releaseSeat` passes no injectable `now`), so there
 * is no clock to fast-forward instead of waiting.
 */
describe('a finished pod survives leave, hold-expiry and a restart', () => {
	it('GET …/mine and the table gate both still find the pool', async () => {
		const dir = await tempDir();
		const draftRoomsA = createDraftRooms({
			...singlePoolResolver(cube),
			params: { reservationTtlMs: 20 },
			storeDir: dir,
		});
		const { seat, pool } = finishPodFor(draftRoomsA, 'pod-e', 'alice', 'sock-a');
		const alice = identityFromHeaders(edgeHeaders('alice'), 'sock-a');
		const roomA = draftRoomsA.open('pod-e');

		// Leave.
		expect(releaseSeat(roomA, alice)).toBe(true);
		expect(seatOf(roomA.seats, alice)).toBeNull();

		// The hold expires. `reservationTtlMs: 20` is wall-clock real time
		// (`releaseSeat` passes no injectable `now`), so this polls for it
		// rather than sleeping a guessed duration.
		await vi.waitFor(() => expect(reservationFor(roomA.seats, seat, Date.now())).toBeNull());

		// The store restarts: a brand new `DraftRooms` over the SAME directory,
		// never told about `pod-e` except by what it finds on disk.
		const draftRoomsB = createDraftRooms({ ...singlePoolResolver(cube), storeDir: dir });
		expect(draftRoomsB.find('pod-e')).toBeDefined();
		expect(draftRoomsB.find('pod-e')).not.toBe(roomA);

		const h = await openApp(draftRoomsB);

		const mine = await call(h, 'GET', '/api/drafts/pod-e/mine', { as: 'alice' });
		expect(mine.status).toBe(200);
		expect((mine.json.pool as unknown[]).length).toBe(pool.length);

		// The blast-radius proof: `POST /api/tables/check`'s `draftPool` lookup
		// is `routes.ts`'s own, untouched `draftPoolForMember`. A 400 "no seat"
		// here is exactly what reverting `finishedSeatOf` reproduces.
		const check = await call(h, 'POST', '/api/tables/check', {
			as: 'alice',
			body: { deck: { dck: legalDeckFor('pod-e', pool) }, rules: { kind: 'draft', draftId: 'pod-e' } },
		});
		expect(check.status).toBe(200);
		expect(check.json).toMatchObject({ legal: true });

		// And the deck store, write-through on the RESTORED room too.
		const dck = legalDeckFor('pod-e', pool);
		const put = await call(h, 'PUT', '/api/drafts/pod-e/deck', { as: 'alice', body: { dck } });
		expect(put.status).toBe(200);
	});

	it('a seat whose picks are all made is owned before the rest of the pod finishes', async () => {
		const draftRooms = createDraftRooms({ ...singlePoolResolver(cube), params: { reservationTtlMs: 20 }, storeDir: null });
		const { room, seat, pool } = finishPodFor(draftRooms, 'pod-h', 'alice', 'sock-a');
		const state = stateOf(room);
		state.status = 'drafting';
		const alice = identityFromHeaders(edgeHeaders('alice'), 'sock-a');
		const h = await openApp(draftRooms);

		// Alice's last pick sends her to the builder, which leaves the pod
		// while the others are still picking.
		expect(releaseSeat(room, alice)).toBe(true);
		const mine = await call(h, 'GET', '/api/drafts/pod-h/mine', { as: 'alice' });
		expect(mine.status).toBe(200);
		expect((mine.json.pool as unknown[]).length).toBe(pool.length);

		// One pick short is not finished: she is a spectator until she comes back.
		state.pools[seat] = pool.slice(0, -1);
		expect((await call(h, 'GET', '/api/drafts/pod-h/mine', { as: 'alice' })).status).toBe(404);

		// A finished seat someone else now sits in is theirs, not hers.
		state.pools[seat] = pool;
		await vi.waitFor(() => expect(reservationFor(room.seats, seat, Date.now())).toBeNull());
		const bob = identityFromHeaders(edgeHeaders('bob'), 'sock-b');
		expect(joinDraftRoom(room, 'sock-b', bob, 'friend').seat).toBe(seat);
		expect((await call(h, 'GET', '/api/drafts/pod-h/mine', { as: 'alice' })).status).toBe(404);
	});

	it('a seat nobody drafted stays unowned — bob was never seated in pod-e', async () => {
		const dir = await tempDir();
		const draftRoomsA = createDraftRooms({ ...singlePoolResolver(cube), storeDir: dir });
		finishPodFor(draftRoomsA, 'pod-f', 'alice', 'sock-a');

		const draftRoomsB = createDraftRooms({ ...singlePoolResolver(cube), storeDir: dir });
		const h = await openApp(draftRoomsB);
		const res = await call(h, 'GET', '/api/drafts/pod-f/mine', { as: 'bob' });
		expect(res.status).toBe(404);
	});
});

/*
 * ── the completing pick itself is persisted, with no leave or save after it ──
 *
 * `room/socket.ts` advances a pick with `room.app.state = advanced.state` — a
 * plain assignment, not a call to anything this file's mutators own. Driven
 * here the same way: real `pick`/`runBots` from `@hadoku/draft`, assigned to
 * `room.app.state` exactly as that file does, never through `releaseSeat` or
 * `saveBuiltDeck` (the only other calls that persist). If the LAST of those
 * assignments — the one that turns `status` to `'complete'` — is not written
 * through, a restart right after it would restore the pod one state behind:
 * dealt, maybe mid-pick, never finished, and nobody's pool answers at all.
 */
describe('the pick that completes a pod is persisted by itself', () => {
	it('GET …/mine finds the pool right after the completing pick — no leave, no save', async () => {
		const dir = await tempDir();
		const draftRoomsA = createDraftRooms({
			...singlePoolResolver(cube),
			// `packCount` is gone from `DraftParams`: a plan's own `rounds.length`
			// (always 3, Settled) decides it now. The loop below drives picks
			// until `status` flips regardless of how many rounds that takes.
			params: { seatCount: 2, packSize: 3 },
			storeDir: dir,
		});
		const room = draftRoomsA.open('pod-g');
		const alice = identityFromHeaders(edgeHeaders('alice'), 'sock-a');
		const seat = joinDraftRoom(room, 'sock-a', alice, 'friend').seat;
		if (seat === null) throw new Error('alice was not seated');

		let guard = 0;
		while (stateOf(room).status === 'drafting' && guard < 50) {
			const state = stateOf(room);
			const pack = state.packs[seat] as DraftCard[];
			let next = state;
			if (pack.length > 0 && !state.picked.includes(seat)) {
				const result = pick(state, seat, (pack[0] as DraftCard).cardId);
				if (!result.ok) throw new Error(`pick rejected: ${result.reason}`);
				next = result.state;
			}
			// The exact shape `room/socket.ts` assigns after a pick.
			room.app.state = runBots(next).state;
			guard += 1;
		}
		const finishedPool = stateOf(room).pools[seat] as DraftCard[];
		expect(stateOf(room).status).toBe('complete');
		expect(finishedPool.length).toBeGreaterThan(0);

		// Nothing else touches `pod-g` after the completing pick: no
		// `releaseSeat`, no `saveBuiltDeck` — persistence has to come from the
		// `state` assignment above, or not at all.
		const draftRoomsB = createDraftRooms({ ...singlePoolResolver(cube), storeDir: dir });
		const h = await openApp(draftRoomsB);
		const mine = await call(h, 'GET', '/api/drafts/pod-g/mine', { as: 'alice' });
		expect(mine.status).toBe(200);
		expect((mine.json.pool as unknown[]).length).toBe(finishedPool.length);
	});
});

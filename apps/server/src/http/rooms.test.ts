/**
 * The room list, end to end through a REAL express app.
 *
 * Mounted exactly the way `index.ts` mounts it — `edgeProvenance`, then
 * `requireMinTier`, then an `/api` router with `express.json()` on it, then
 * `attachRooms` — because two of the properties under test are properties of
 * that stack rather than of a handler: a malformed body is rejected by
 * `express.json()` BEFORE any handler runs, and the tier floor is what makes
 * "every friend sees every room" a bounded statement.
 *
 * Every request goes over a real socket (`fetch` against a listening server),
 * so "byte-identical" is asserted on the bytes a client receives, not on an
 * object a handler passed to `res.json`.
 *
 * The password used throughout is a distinctive string, and one test greps
 * EVERYTHING the process emitted — the injected log and every `console.*`
 * channel — for it, for its stored hash and for its salt.
 */

import express from 'express';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RoomBodySchema, type DraftPlan, type PoolVerdict } from '@hadoku/shared';

import { loadTablesLibrary } from './library.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/**
 * The frozen pools, read the way production reads them, so what a room's default
 * format is asserted AGAINST is the real list rather than a date copied here.
 */
const LIBRARY_FORMATS = loadTablesLibrary(REPO_ROOT).formats;
const POOLS = LIBRARY_FORMATS.map((f) => f.id);
/**
 * The newest STANDARD era, never just "the last element" — wave 48 put
 * Modern and Legacy eras in the same catalog, so `POOLS[POOLS.length - 1]`
 * is no longer necessarily Standard (`room/lobby.ts`'s `newestFormat`).
 */
const NEWEST_POOL = LIBRARY_FORMATS.filter((f) => f.family === 'standard').map((f) => f.id).at(-1);
const OLDEST_POOL = POOLS[0];

const EDGE_SECRET = 'test-edge-auth-secret';
const PASSWORD = 'correct-horse-battery-staple-9137';

let roomsMod: typeof import('./rooms.ts');
let lobbyMod: typeof import('../room/lobby.ts');
let edgeMod: typeof import('../edge-auth.ts');

beforeAll(async () => {
	// config.ts reads the environment once, at load — same dance as tables.test.ts.
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	roomsMod = await import('./rooms.ts');
	lobbyMod = await import('../room/lobby.ts');
	edgeMod = await import('../edge-auth.ts');
});

/* ── harness ─────────────────────────────────────────────────────────── */

const dirs: string[] = [];
const servers: HttpServer[] = [];
/** Every structured line the lobby and the router emitted, in order. */
let logged: Record<string, unknown>[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-rooms-test-'));
	dirs.push(dir);
	return dir;
}

interface Harness {
	base: string;
	lobby: import('../room/lobby.ts').Lobby;
}

async function openApp(
	dir: string,
	opts: {
		joinRateLimit?: { capacity: number; refillAmount: number; refillIntervalMs: number };
		now?: () => number;
		/** A new room's format is drawn with this; without it every new room opens on `NEWEST_POOL`. */
		random?: () => number;
		closed?: (roomId: string, matches: readonly string[]) => void;
		/** Wave 73 §A: `PUT …/pod/plan`'s verdict. Defaults to always-ok — the plan tests that need a refusal pass their own. */
		checkPlan?: (plan: DraftPlan) => Promise<PoolVerdict>;
		/** Wave 74 §E step 2: `/start`'s realistic-round pre-fetch. Omitted everywhere a test never plans a realistic round. */
		realistic?: import('./rooms.ts').RoomsDeps['realistic'];
	} = {},
): Promise<Harness> {
	const log = (entry: Record<string, unknown>): void => {
		logged.push(entry);
	};
	const lobby = await lobbyMod.openLobby({
		dir,
		log,
		...(opts.now === undefined ? {} : { now: opts.now }),
		...(opts.random === undefined ? { defaultFormat: NEWEST_POOL } : { random: opts.random, formats: LIBRARY_FORMATS }),
	});
	const app = express();
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	const api = express.Router();
	api.use(express.json({ limit: '1mb' }));
	roomsMod.attachRooms(api, {
		lobby,
		log,
		joinRateLimit: opts.joinRateLimit,
		closed: opts.closed,
		checkPlan: opts.checkPlan ?? (async (plan) => ({ ok: true, cards: plan.rounds.length * 10 })),
		...(opts.realistic === undefined ? {} : { realistic: opts.realistic }),
	});
	app.use('/api', api);

	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	const { port } = server.address() as AddressInfo;
	return { base: `http://127.0.0.1:${port}`, lobby };
}

function headersFor(user: string, tier = 'friend'): Record<string, string> {
	return {
		'x-edge-auth': EDGE_SECRET,
		'x-hadoku-tier': tier,
		'x-user-id': `user-${user}`,
		// What the edge injects beside the id, since the roster shows names.
		'x-user-name': `user-${user}`,
		'x-user-key': `friend-key-${user}`,
	};
}

/** Friend tier, but the edge named nobody: an `eph:` identity. */
/**
 * Vouched by the edge, friend tier, but NOBODY NAMED — the identity headers
 * are present and empty so the merge in `call` cannot resurrect them from the
 * default set. "The edge could not name this caller" is the case under test.
 */
function anonymousHeaders(): Record<string, string> {
	return { 'x-edge-auth': EDGE_SECRET, 'x-hadoku-tier': 'friend', 'x-user-id': '', 'x-user-name': '', 'x-user-key': '' };
}

interface Reply {
	status: number;
	text: string;
	json: () => unknown;
}

async function call(
	h: Harness,
	method: string,
	path: string,
	opts: { as?: string; headers?: Record<string, string>; body?: unknown; raw?: string } = {},
): Promise<Reply> {
	// Merged, not replaced: a test can override one header (the display
	// name) without dropping the auth the request still needs.
	const headers: Record<string, string> = { ...headersFor(opts.as ?? 'alice'), ...opts.headers };
	let body: string | undefined;
	if (opts.raw !== undefined) {
		body = opts.raw;
		headers['content-type'] = 'application/json';
	} else if (opts.body !== undefined) {
		body = JSON.stringify(opts.body);
		headers['content-type'] = 'application/json';
	}
	const res = await fetch(`${h.base}${path}`, { method, headers, body });
	const text = await res.text();
	return { status: res.status, text, json: () => JSON.parse(text) };
}

/** A plan whose rounds are one cube — content does not matter here, only that `PUT …/pod/plan` accepts it (`openApp`'s default `checkPlan` is always-ok). */
const APPROVABLE_PLAN = { rounds: [{ kind: 'cube', cubeId: 'approve' }, { kind: 'cube', cubeId: 'approve' }, { kind: 'cube', cubeId: 'approve' }] };

/**
 * `startDraft`'s own gate (wave 73 §A follow-up — "it shouldn't even get to
 * the drafting stage" is a server rule, not just B's disabled Start button)
 * refuses until the room's plan has an OK verdict. `openLobby` is never
 * given a `checkPlan` in this harness, so nothing auto-checks one — every
 * test that starts a draft for real approves it through the real route
 * first, the same way a leader would.
 */
async function approvePlan(h: Harness, roomId: string, as = 'alice'): Promise<void> {
	const res = await call(h, 'PUT', `/api/rooms/${roomId}/pod/plan`, { as, body: { plan: APPROVABLE_PLAN } });
	if (res.status !== 200) throw new Error(`approvePlan failed: ${res.status} ${res.text}`);
}

/** The stored salt and hash of the one locked room in `dir`, read the way a human would. */
function storedSecret(dir: string): { salt: string; hash: string } {
	const secrets = readdirSync(dir)
		.filter((f) => f.endsWith('.json'))
		.map(
			(f) =>
				(
					JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
						app: { secret: { salt: string; hash: string } | null };
					}
				).app.secret,
		)
		.filter((s): s is { salt: string; hash: string } => s !== null);
	expect(secrets).toHaveLength(1);
	expect(secrets[0].hash).toMatch(/^[0-9a-f]{64}$/);
	expect(secrets[0].salt).toMatch(/^[0-9a-f]{32}$/);
	return secrets[0];
}

afterEach(() => {
	logged = [];
	vi.restoreAllMocks();
});

afterAll(async () => {
	for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/* ── the shape ───────────────────────────────────────────────────────── */

describe('a member is named by their display name, never their id', () => {
	it('carries X-User-Name into the roster, and falls back to a word when the edge sent none', async () => {
		const h = await openApp(await tempDir());
		const named = (
			await call(h, 'POST', '/api/rooms', {
				as: 'alice',
				headers: { 'x-user-name': 'Carol' },
				body: { name: 'Named' },
			})
		).json() as import('../room/lobby.ts').RoomView;
		expect(named.members.map((m) => m.name)).toEqual(['Carol']);

		// The regression this pins: the name used to be `userIdOf(req)`, so the
		// roster showed the opaque registry identifier — a GUID-looking string
		// the operator rightly refused to read.
		const unnamed = (
			await call(h, 'POST', '/api/rooms', {
				as: 'bob',
				headers: { 'x-user-name': '' },
				body: { name: 'Unnamed' },
			})
		).json() as import('../room/lobby.ts').RoomView;
		expect(unnamed.members.map((m) => m.name)).toEqual(['friend']);
		expect(unnamed.members.map((m) => m.name).join()).not.toContain('user-bob');
	});
});

describe('POST /api/rooms', () => {
	it('creates a room whose creator is its leader and its only member', async () => {
		const h = await openApp(await tempDir(), { random: () => 0.999999 });
		const res = await call(h, 'POST', '/api/rooms', { body: { name: 'Kitchen table' } });
		expect(res.status).toBe(201);
		const room = res.json() as import('../room/lobby.ts').RoomView;
		expect(room.id).toMatch(/^r-[0-9a-f]{12}$/);
		expect(room.id).toMatch(/^[a-z0-9-]{1,40}$/);
		expect(room.name).toBe('Kitchen table');
		expect(room.gameType).toBe('constructed-1v1');
		// No mode asked for: the default is our own table, stated not implied.
		expect(room.clientMode).toBe('builtin');
		expect(room.locked).toBe(false);
		expect(room.matchId).toBeNull();
		// A new room is in its lobby phase and nobody has readied.
		expect(room.draftStartedAt).toBeNull();
		expect(room.members.map((m) => m.ready)).toEqual([false]);
		expect(room.leader).toBe(room.creator);
		// A drawn era (`room/lobby.ts`'s `randomFormat`): the top of [0, 1) is the
		// newest era of the catalog's last family, never the oldest pool.
		const lastFamily = [...new Set(LIBRARY_FORMATS.map((f) => f.family))].at(-1);
		expect(room.format).toBe(LIBRARY_FORMATS.filter((f) => f.family === lastFamily).at(-1)!.id);
		expect(room.format).not.toBe(OLDEST_POOL);
		expect(POOLS.length).toBeGreaterThan(1);
		// And the creator is told, in their own row, that the room is theirs to set.
		expect(res.json()).toMatchObject({ you: { leader: true, ready: false } });
		expect(room.members).toHaveLength(1);
		expect(room.members[0].id).toBe(room.creator);
		expect(room.members[0].name).toBe('user-alice');
		expect(Date.parse(room.members[0].joinedAt)).not.toBeNaN();
		expect(Date.parse(room.createdAt)).not.toBeNaN();
		// The whole public shape, so a field added without a decision fails here.
		expect(Object.keys(room).sort()).toEqual([
			'ai',
			'clientMode',
			'createdAt',
			'creator',
			'draftStartedAt',
			'format',
			'gameType',
			'id',
			'leader',
			'locked',
			'matchId',
			'members',
			'mode',
			'modeOptions',
			'name',
			'pod',
			'settings',
			'tables',
			'you',
		]);
		expect(Object.keys(room.members[0]).sort()).toEqual(['avatarId', 'id', 'joinedAt', 'name', 'ready']);

		// The verbatim body, for the lanes coding against it.
		if (process.env.CARDTABLE_ROOMVIEW_OUT) {
			const { writeFileSync } = await import('node:fs');
			writeFileSync(process.env.CARDTABLE_ROOMVIEW_OUT, res.text);
		}
	});

	it('takes the game type at creation, including draft', async () => {
		const h = await openApp(await tempDir());
		const res = await call(h, 'POST', '/api/rooms', {
			body: { name: 'Cube night', gameType: 'draft' },
		});
		expect(res.status).toBe(201);
		expect((res.json() as { gameType: string }).gameType).toBe('draft');
	});

	it('takes the client mode at creation, and it survives a restart', async () => {
		const dir = await tempDir();
		const h = await openApp(dir);
		const res = await call(h, 'POST', '/api/rooms', {
			body: { name: 'Forge night', gameType: 'draft', clientMode: 'streamed' },
		});
		expect(res.status).toBe(201);
		const created = res.json() as import('../room/lobby.ts').RoomView;
		expect(created.clientMode).toBe('streamed');

		// The list and the single-room read agree, before anyone joins.
		const listed = ((await call(h, 'GET', '/api/rooms', { as: 'bob' })).json() as {
			rooms: import('../room/lobby.ts').RoomView[];
		}).rooms;
		expect(listed.map((r) => r.clientMode)).toEqual(['streamed']);
		expect(
			((await call(h, 'GET', `/api/rooms/${created.id}`, { as: 'bob' })).json() as { clientMode: string })
				.clientMode,
		).toBe('streamed');

		const second = await openApp(dir);
		expect(
			((await call(second, 'GET', `/api/rooms/${created.id}`, { as: 'bob' })).json() as { clientMode: string })
				.clientMode,
		).toBe('streamed');
	});

	it('refuses a body that is not a room', async () => {
		const h = await openApp(await tempDir());
		const cases: Array<[unknown, string]> = [
			[{}, 'name must be a string'],
			[{ name: '   ' }, 'name must be 1–60 characters'],
			[{ name: 'x'.repeat(61) }, 'name must be 1–60 characters'],
			[{ name: 'bad\u0007name' }, 'name must not contain control characters'],
			[{ name: 'ok', gameType: 'chess' }, 'gameType must be one of: constructed-1v1, draft'],
			// An unknown mode is a stated refusal, NOT a silent fall back to builtin:
			// a creator who asked for a streamed room must not quietly get our table.
			[{ name: 'ok', clientMode: 'telepathy' }, 'clientMode must be one of: builtin, streamed'],
			[{ name: 'ok', clientMode: 'Streamed' }, 'clientMode must be one of: builtin, streamed'],
			[{ name: 'ok', clientMode: '' }, 'clientMode must be one of: builtin, streamed'],
			[{ name: 'ok', clientMode: null }, 'clientMode must be one of: builtin, streamed'],
			[{ name: 'ok', clientMode: 1 }, 'clientMode must be one of: builtin, streamed'],
			[{ name: 'ok', password: 42 }, 'password must be a string'],
			[{ name: 'ok', sneaky: true }, 'unknown field(s): sneaky'],
			[[], 'body must be a JSON object'],
		];
		for (const [body, error] of cases) {
			const res = await call(h, 'POST', '/api/rooms', { body });
			expect(res.status, JSON.stringify(body)).toBe(400);
			expect(res.json()).toEqual({ error });
		}
		// A refusal is a refusal: none of those made a room.
		expect(((await call(h, 'GET', '/api/rooms')).json() as { rooms: unknown[] }).rooms).toEqual([]);
	});

	it('refuses a caller the edge could not name', async () => {
		const h = await openApp(await tempDir());
		const res = await call(h, 'POST', '/api/rooms', {
			headers: anonymousHeaders(),
			body: { name: 'ghost room' },
		});
		expect(res.status).toBe(403);
		expect((res.json() as { error: string }).error).toContain('cannot create or join');
	});

	it('is not reachable below the tier floor', async () => {
		const h = await openApp(await tempDir());
		// A claimed tier with NO edge secret — the empty string is the point:
		// the merge would otherwise resurrect the vouched set this test is
		// refusing to send.
		const res = await call(h, 'GET', '/api/rooms', { headers: { 'x-hadoku-tier': 'admin', 'x-edge-auth': '' } });
		// No edge secret: provenance degrades the caller to `public`.
		expect(res.status).toBe(404);
	});
});

/* ── the list ────────────────────────────────────────────────────────── */

describe('GET /api/rooms', () => {
	it('shows every room to every friend, locked or not, and never a secret', async () => {
		const dir = await tempDir();
		const h = await openApp(dir);
		await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Open' } });
		await call(h, 'POST', '/api/rooms', {
			as: 'alice',
			body: { name: 'Locked', password: PASSWORD },
		});
		const res = await call(h, 'GET', '/api/rooms', { as: 'bob' });
		expect(res.status).toBe(200);
		const { rooms } = res.json() as { rooms: import('../room/lobby.ts').RoomView[] };
		expect(rooms.map((r) => r.name)).toEqual(['Open', 'Locked']);
		expect(rooms.map((r) => r.locked)).toEqual([false, true]);
		// The listing says WHETHER a room is locked and nothing more.
		const secret = storedSecret(dir);
		expect(res.text).not.toContain(PASSWORD);
		expect(res.text).not.toContain(secret.hash);
		expect(res.text).not.toContain(secret.salt);
		for (const key of ['password', 'hash', 'salt', 'secret']) {
			expect(res.text.toLowerCase()).not.toContain(key);
		}
	});

	it('lists the rooms a PREVIOUS process created, from the same directory', async () => {
		const dir = await tempDir();
		const first = await openApp(dir);
		const created = (
			await call(first, 'POST', '/api/rooms', {
				as: 'alice',
				body: { name: 'Survivor', gameType: 'draft', password: PASSWORD },
			})
		).json() as import('../room/lobby.ts').RoomView;
		await call(first, 'POST', `/api/rooms/${created.id}/join`, {
			as: 'bob',
			body: { password: PASSWORD },
		});
		first.lobby.setPlayerState(created.id, created.creator, { deck: 'mono-red', ready: true });
		first.lobby.setTableMatch(created.id, created.tables[0]!.id, 'match-42');

		// A second lobby over the same directory — the restart, in one process.
		const second = await openApp(dir);
		const { rooms } = (await call(second, 'GET', '/api/rooms', { as: 'carol' })).json() as {
			rooms: import('../room/lobby.ts').RoomView[];
		};
		expect(rooms).toHaveLength(1);
		expect(rooms[0].id).toBe(created.id);
		expect(rooms[0].name).toBe('Survivor');
		expect(rooms[0].gameType).toBe('draft');
		expect(rooms[0].locked).toBe(true);
		// The room's match comes back with it: play adopts the JVM, and a match that
		// did not come back is let go of by `releaseGoneMatches` once adoption is
		// done (`avatarRelay.test.ts`, "a room and its match across a restart").
		expect(rooms[0].matchId).toBe('match-42');
		expect(rooms[0].leader).toBe(created.creator);
		expect(rooms[0].members.map((m) => m.name).sort()).toEqual(['user-alice', 'user-bob']);
		expect(second.lobby.playerState(created.id, created.creator)).toEqual({
			deck: 'mono-red',
			ready: true,
		});
		// And the password came back with it: the restored room still refuses a
		// wrong one and still admits the right one.
		expect(
			(await call(second, 'POST', `/api/rooms/${created.id}/join`, { as: 'dave', body: { password: 'nope' } }))
				.status,
		).toBe(404);
		expect(
			(await call(second, 'POST', `/api/rooms/${created.id}/join`, { as: 'dave', body: { password: PASSWORD } }))
				.status,
		).toBe(200);
	});

	it('answers a room the browser reads as itself: every body parses through RoomBodySchema to the same room, less its AI', async () => {
		const h = await openApp(await tempDir());
		const constructed = (await call(h, 'POST', '/api/rooms', { body: { name: 'Kitchen table', mode: 'classic' } })).json() as { id: string };
		await call(h, 'POST', `/api/rooms/${constructed.id}/join`, { as: 'bob', body: {} });
		const draft = (await call(h, 'POST', '/api/rooms', { body: { name: 'Cube night', gameType: 'draft', password: PASSWORD } })).json() as { id: string };
		for (const id of [constructed.id, draft.id]) {
			const body = (await call(h, 'GET', `/api/rooms/${id}`)).json() as Record<string, unknown>;
			const { ai, ...view } = body;
			expect(ai).toEqual({ name: expect.any(String), avatarId: expect.any(String) });
			expect(RoomBodySchema.parse(body), id).toStrictEqual(view);
		}
	});
});

/* ── join ────────────────────────────────────────────────────────────── */

describe('POST /api/rooms/:id/join', () => {
	it('joins an open room and is idempotent for a member', async () => {
		const h = await openApp(await tempDir());
		const created = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Open' } }))
			.json() as import('../room/lobby.ts').RoomView;
		const first = await call(h, 'POST', `/api/rooms/${created.id}/join`, { as: 'bob' });
		expect(first.status).toBe(200);
		expect((first.json() as { members: unknown[] }).members).toHaveLength(2);
		const again = await call(h, 'POST', `/api/rooms/${created.id}/join`, { as: 'bob' });
		expect(again.status).toBe(200);
		expect(again.text).toBe(first.text);
	});

	it('lets a member back in with no password at all', async () => {
		const h = await openApp(await tempDir());
		const created = (
			await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Locked', password: PASSWORD } })
		).json() as import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${created.id}/join`, { as: 'bob', body: { password: PASSWORD } });
		const back = await call(h, 'POST', `/api/rooms/${created.id}/join`, { as: 'bob' });
		expect(back.status).toBe(200);
		expect((back.json() as { members: unknown[] }).members).toHaveLength(2);
	});

	it('answers a wrong password and a missing room with the SAME bytes', async () => {
		const h = await openApp(await tempDir());
		const created = (
			await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Locked', password: PASSWORD } })
		).json() as import('../room/lobby.ts').RoomView;

		const wrong = await call(h, 'POST', `/api/rooms/${created.id}/join`, {
			as: 'bob',
			body: { password: 'not-the-password' },
		});
		const missing = await call(h, 'POST', '/api/rooms/r-000000000000/join', {
			as: 'bob',
			body: { password: 'not-the-password' },
		});
		const noPassword = await call(h, 'POST', `/api/rooms/${created.id}/join`, { as: 'bob' });
		const malformedId = await call(h, 'POST', '/api/rooms/NOT_AN_ID/join', { as: 'bob' });

		expect(wrong.status).toBe(404);
		expect(missing.status).toBe(wrong.status);
		expect(missing.text).toBe(wrong.text);
		expect(noPassword.status).toBe(wrong.status);
		expect(noPassword.text).toBe(wrong.text);
		expect(malformedId.status).toBe(wrong.status);
		expect(malformedId.text).toBe(wrong.text);
		// The refusal did not make bob a member.
		const room = (await call(h, 'GET', `/api/rooms/${created.id}`, { as: 'bob' })).json() as {
			members: unknown[];
		};
		expect(room.members).toHaveLength(1);
	});

	it('rate-limits attempts per caller, and the limit does not depend on the room', async () => {
		const h = await openApp(await tempDir());
		const created = (
			await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Locked', password: PASSWORD } })
		).json() as import('../room/lobby.ts').RoomView;

		const statuses: number[] = [];
		for (let i = 0; i < roomsMod.JOIN_RATE_LIMIT.capacity + 2; i++) {
			statuses.push(
				(
					await call(h, 'POST', `/api/rooms/${created.id}/join`, {
						as: 'mallory',
						body: { password: `guess-${i}` },
					})
				).status,
			);
		}
		expect(statuses.slice(0, roomsMod.JOIN_RATE_LIMIT.capacity)).toEqual(
			Array.from({ length: roomsMod.JOIN_RATE_LIMIT.capacity }, () => 404),
		);
		expect(statuses.slice(roomsMod.JOIN_RATE_LIMIT.capacity)).toEqual([429, 429]);

		// Rate-limited on the guesser, not on the room or the server: another
		// friend is unaffected, and the right password still works for them.
		const bob = await call(h, 'POST', `/api/rooms/${created.id}/join`, {
			as: 'bob',
			body: { password: PASSWORD },
		});
		expect(bob.status).toBe(200);

		// And once limited, even the RIGHT password is refused — with the 429,
		// which is the one status that differs from NO_MATCH, and says nothing
		// about the room.
		const limited = await call(h, 'POST', `/api/rooms/${created.id}/join`, {
			as: 'mallory',
			body: { password: PASSWORD },
		});
		expect(limited.status).toBe(429);
	});
});

/* ── the leader ──────────────────────────────────────────────────────── */

describe('PATCH /api/rooms/:id', () => {
	it('lets the leader change the game type and nobody else', async () => {
		const h = await openApp(await tempDir());
		const created = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Open' } }))
			.json() as import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${created.id}/join`, { as: 'bob' });

		const byMember = await call(h, 'PATCH', `/api/rooms/${created.id}`, {
			as: 'bob',
			body: { gameType: 'draft' },
		});
		expect(byMember.status).toBe(403);
		expect((byMember.json() as { error: string }).error).toContain('leader');
		expect(((await call(h, 'GET', `/api/rooms/${created.id}`)).json() as { gameType: string }).gameType).toBe(
			'constructed-1v1',
		);

		const byLeader = await call(h, 'PATCH', `/api/rooms/${created.id}`, {
			as: 'alice',
			body: { gameType: 'draft' },
		});
		expect(byLeader.status).toBe(200);
		expect((byLeader.json() as { gameType: string }).gameType).toBe('draft');

		const stranger = await call(h, 'PATCH', '/api/rooms/r-000000000000', {
			as: 'carol',
			body: { gameType: 'draft' },
		});
		expect(stranger.status).toBe(404);
		expect(stranger.json()).toEqual(roomsMod.NO_MATCH);

		const bad = await call(h, 'PATCH', `/api/rooms/${created.id}`, {
			as: 'alice',
			body: { gameType: 'chess' },
		});
		expect(bad.status).toBe(400);
	});
});

/* ── the room's pool, and who may move it (wave 25 §A) ───────────────── */

describe('PATCH /api/rooms/:id { settings }', () => {
	type View = import('../room/lobby.ts').RoomView;

	it('lets the leader turn hand smoothing off, refuses anyone else, and keeps it across a restart', async () => {
		const dir = await tempDir();
		const h = await openApp(dir);
		const created = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Open' } })).json() as View;
		expect(created.settings).toEqual({ handSmoothing: true });
		await call(h, 'POST', `/api/rooms/${created.id}/join`, { as: 'bob' });
		await call(h, 'POST', `/api/rooms/${created.id}/ready`, { as: 'bob', body: { ready: true } });

		const byMember = await call(h, 'PATCH', `/api/rooms/${created.id}`, { as: 'bob', body: { settings: { handSmoothing: false } } });
		expect(byMember.status).toBe(403);
		expect(byMember.json()).toEqual({ error: 'only the room leader can change the settings' });

		const byLeader = await call(h, 'PATCH', `/api/rooms/${created.id}`, { as: 'alice', body: { settings: { handSmoothing: false } } });
		expect(byLeader.status).toBe(200);
		const after = byLeader.json() as View;
		expect(after.settings).toEqual({ handSmoothing: false });
		// Not a deck question, so bob is still ready.
		expect(after.members.map((m) => m.ready)).toEqual([false, true]);

		const restored = (await call(await openApp(dir), 'GET', `/api/rooms/${created.id}`)).json() as View;
		expect(restored.settings).toEqual({ handSmoothing: false });
	});

	it('refuses a setting it does not know, a value that is not a boolean, and an empty or mixed body', async () => {
		const h = await openApp(await tempDir());
		const created = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Open' } })).json() as View;
		const cases: Array<[unknown, string]> = [
			[{ settings: { psychic: true } }, 'unknown setting(s): psychic'],
			[{ settings: { handSmoothing: 'off' } }, 'settings.handSmoothing must be a boolean'],
			[{ settings: { matchLength: 'bo3' } }, 'unknown setting(s): matchLength'],
			[{ settings: { sideboarding: true } }, 'unknown setting(s): sideboarding'],
			[{ settings: {} }, 'settings names no setting'],
			[{ settings: null }, 'settings must be an object'],
			[{ settings: { handSmoothing: false }, format: OLDEST_POOL }, 'patch one field at a time: gameType, format, settings or mode'],
		];
		for (const [body, error] of cases) {
			const res = await call(h, 'PATCH', `/api/rooms/${created.id}`, { as: 'alice', body });
			expect(res.status, JSON.stringify(body)).toBe(400);
			expect(res.json()).toEqual({ error });
		}
		const after = (await call(h, 'GET', `/api/rooms/${created.id}`)).json() as View;
		expect([after.settings, after.format]).toEqual([{ handSmoothing: true }, NEWEST_POOL]);
	});

	it('sizes a Constructed room’s series Bo1 and a draft room’s Bo3', async () => {
		const h = await openApp(await tempDir());
		const constructed = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Open' } })).json() as View;
		expect(constructed.tables[0]?.series).toMatchObject({ length: 1, phase: 'seating' });
		const draft = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Draft room', gameType: 'draft' } })).json() as View;
		expect(draft.settings).toEqual({ handSmoothing: true });
		expect(draft.tables[0]?.series).toMatchObject({ length: 3 });
	});
});

describe('a room always has at least one table', () => {
	type View = import('../room/lobby.ts').RoomView;

	it("gives a new room one table, empty, 'seating', with the first table's id stable across a restart", async () => {
		const dir = await tempDir();
		const h = await openApp(dir);
		const created = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Open' } })).json() as View;
		expect(created.tables).toHaveLength(1);
		expect(created.tables[0]).toMatchObject({
			players: [],
			matchId: null,
			series: { length: 1, wins: [0, 0], games: [], phase: 'seating' },
		});
		expect(created.matchId).toBeNull();
		const restored = (await call(await openApp(dir), 'GET', `/api/rooms/${created.id}`)).json() as View;
		expect(restored.tables[0]?.id).toBe(created.tables[0]?.id);
	});
});

describe('PATCH /api/rooms/:id { format }', () => {
	it('refuses a non-leader with not-leader and changes nothing', async () => {
		const h = await openApp(await tempDir());
		const created = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Open' } }))
			.json() as import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${created.id}/join`, { as: 'bob' });

		const byMember = await call(h, 'PATCH', `/api/rooms/${created.id}`, { as: 'bob', body: { format: OLDEST_POOL } });
		expect(byMember.status).toBe(403);
		expect((byMember.json() as { error: string }).error).toBe('only the room leader can change the format');
		expect(((await call(h, 'GET', `/api/rooms/${created.id}`)).json() as { format: string }).format).toBe(NEWEST_POOL);

		// A friend who is not even in the room gets the same 403 for a room that
		// exists, and the shared 404 for one that does not.
		expect((await call(h, 'PATCH', `/api/rooms/${created.id}`, { as: 'carol', body: { format: OLDEST_POOL } })).status).toBe(403);
		const missing = await call(h, 'PATCH', '/api/rooms/r-000000000000', { as: 'carol', body: { format: OLDEST_POOL } });
		expect(missing.status).toBe(404);
		expect(missing.json()).toEqual(roomsMod.NO_MATCH);

		const byLeader = await call(h, 'PATCH', `/api/rooms/${created.id}`, { as: 'alice', body: { format: OLDEST_POOL } });
		expect(byLeader.status).toBe(200);
		expect((byLeader.json() as { format: string }).format).toBe(OLDEST_POOL);
	});

	it('clears both readiness flags and every deck hold when the pool changes', async () => {
		const dir = await tempDir();
		const h = await openApp(dir);
		const created = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Open' } }))
			.json() as import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${created.id}/join`, { as: 'bob' });
		const bob = ((await call(h, 'GET', `/api/rooms/${created.id}`)).json() as import('../room/lobby.ts').RoomView)
			.members[1].id;
		await call(h, 'POST', `/api/rooms/${created.id}/ready`, { as: 'alice', body: { ready: true } });
		await call(h, 'POST', `/api/rooms/${created.id}/ready`, { as: 'bob', body: { ready: true } });
		// The TABLE's ready flag and deck verdict live in the per-member blob
		// `http/routes.ts` owns. The lobby does not read its shape; it drops it.
		h.lobby.setPlayerState(created.id, created.creator, { v: 1, ready: true, verdict: { legal: true } });
		h.lobby.setPlayerState(created.id, bob, { v: 1, ready: true, verdict: { legal: true } });

		const patched = await call(h, 'PATCH', `/api/rooms/${created.id}`, { as: 'alice', body: { format: OLDEST_POOL } });
		expect(patched.status).toBe(200);
		const after = patched.json() as import('../room/lobby.ts').RoomView;
		expect(after.format).toBe(OLDEST_POOL);
		// The room's flag, for everybody including the leader who changed it.
		expect(after.members.map((m) => m.ready)).toEqual([false, false]);
		// And the table's, which is the whole hold: a verdict is a verdict in one
		// pool, and this one was taken in the pool that just went away.
		expect(h.lobby.playerState(created.id, created.creator)).toBeUndefined();
		expect(h.lobby.playerState(created.id, bob)).toBeUndefined();
		// Cleared on disk too, and the new pool came back with the room.
		const second = await openApp(dir);
		const restored = (await call(second, 'GET', `/api/rooms/${created.id}`)).json() as import('../room/lobby.ts').RoomView;
		expect(restored.format).toBe(OLDEST_POOL);
		expect(restored.members.map((m) => m.ready)).toEqual([false, false]);
		expect(second.lobby.playerState(created.id, created.creator)).toBeUndefined();
	});

	it('changes nothing when the pool it is set to is the one it is on', async () => {
		const h = await openApp(await tempDir());
		const created = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Open' } }))
			.json() as import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${created.id}/ready`, { as: 'alice', body: { ready: true } });
		// Selecting the option that is already selected must not un-ready the table.
		const same = await call(h, 'PATCH', `/api/rooms/${created.id}`, { as: 'alice', body: { format: NEWEST_POOL } });
		expect(same.status).toBe(200);
		expect((same.json() as import('../room/lobby.ts').RoomView).members.map((m) => m.ready)).toEqual([true]);
	});

	it('refuses both fields in one body, a blank format, and lands neither half', async () => {
		const h = await openApp(await tempDir());
		const created = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Open' } }))
			.json() as import('../room/lobby.ts').RoomView;
		const cases: Array<[unknown, string]> = [
			[{ gameType: 'draft', format: OLDEST_POOL }, 'patch one field at a time: gameType, format, settings or mode'],
			[{ format: '' }, 'format must be a format id'],
			[{ format: '   ' }, 'format must be a format id'],
			[{ format: null }, 'format must be a format id'],
			[{ format: 7 }, 'format must be a format id'],
			[{ format: OLDEST_POOL, sneaky: true }, 'unknown field(s): sneaky'],
		];
		for (const [body, error] of cases) {
			const res = await call(h, 'PATCH', `/api/rooms/${created.id}`, { as: 'alice', body });
			expect(res.status, JSON.stringify(body)).toBe(400);
			expect(res.json()).toEqual({ error });
		}
		// Neither half of the two-field body landed.
		const after = (await call(h, 'GET', `/api/rooms/${created.id}`)).json() as import('../room/lobby.ts').RoomView;
		expect([after.gameType, after.format]).toEqual(['constructed-1v1', NEWEST_POOL]);
	});

	/**
	 * A room is never put on a pod (operator, 2026-10-20). A room on
	 * `draft:<podId>` tied its table to the pod's socket, which answers nobody
	 * once the pod's room has closed, so no deck ever loaded. A drafted deck is
	 * played on Free pick, from "My decks".
	 */
	it('refuses every draft: format, a real pod id included', async () => {
		const h = await openApp(await tempDir());
		const created = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Open' } }))
			.json() as import('../room/lobby.ts').RoomView;

		for (const format of ['draft:amber-lantern-k7q4', 'draft:', 'draft:../../etc/passwd', 'draft:Amber-Lantern']) {
			const res = await call(h, 'PATCH', `/api/rooms/${created.id}`, { as: 'alice', body: { format } });
			expect(res.status, format).toBe(400);
			expect((res.json() as { error: string }).error).toBe('format must be a format id: a drafted deck is played on Free pick');
		}
		const after = (await call(h, 'GET', `/api/rooms/${created.id}`)).json() as import('../room/lobby.ts').RoomView;
		expect(after.format).toBe(created.format);
		expect(after.format.startsWith('draft:')).toBe(false);
	});

	it('refuses to move the pool while a draft is running', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Cube night', gameType: 'draft' } }))
			.json() as import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${room.id}/ready`, { as: 'alice', body: { ready: true } });
		for (let seat = 1; seat < 8; seat++) await call(h, 'POST', `/api/rooms/${room.id}/pod/ai`, { as: 'alice', body: { seat, on: true } });
		await approvePlan(h, room.id);
		expect((await call(h, 'POST', `/api/rooms/${room.id}/start`, { as: 'alice' })).status).toBe(200);

		const patched = await call(h, 'PATCH', `/api/rooms/${room.id}`, { as: 'alice', body: { format: OLDEST_POOL } });
		expect(patched.status).toBe(409);
		expect((patched.json() as { error: string }).error).toBe('this room is drafting; the format cannot change now');
		const after = (await call(h, 'GET', `/api/rooms/${room.id}`)).json() as import('../room/lobby.ts').RoomView;
		expect(after.format).toBe(NEWEST_POOL);
		expect(after.members.map((m) => m.ready)).toEqual([true]);
	});
});

/* ── the pool choice (wave 73 §A) ─────────────────────────────────────── */

describe('PUT /api/rooms/:id/pod/plan', () => {
	const PLAN: DraftPlan = {
		rounds: [
			{ kind: 'cube', cubeId: 'legacy' },
			{ kind: 'cube', cubeId: 'legacy' },
			{ kind: 'cube', cubeId: 'legacy' },
		],
	};

	it('is the leader\'s, lobby phase only: a non-leader gets 403, a stranger 404, and the leader\'s choice reads back', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Cube night', gameType: 'draft' } }))
			.json() as import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${room.id}/join`, { as: 'bob' });

		expect((await call(h, 'PUT', `/api/rooms/${room.id}/pod/plan`, { as: 'carol', body: { plan: PLAN } })).status).toBe(404);
		expect((await call(h, 'PUT', `/api/rooms/${room.id}/pod/plan`, { as: 'bob', body: { plan: PLAN } })).status).toBe(403);

		const ok = await call(h, 'PUT', `/api/rooms/${room.id}/pod/plan`, { as: 'alice', body: { plan: PLAN } });
		expect(ok.status).toBe(200);
		expect((ok.json() as import('../room/lobby.ts').RoomView).pod?.plan).toEqual(PLAN);
		expect((ok.json() as import('../room/lobby.ts').RoomView).pod?.planName).toBe('legacy');

		const after = (await call(h, 'GET', `/api/rooms/${room.id}`)).json() as import('../room/lobby.ts').RoomView;
		expect(after.pod?.plan).toEqual(PLAN);
	});

	/*
	 * Wave 74 §E: "PUT /api/rooms/:id/pod/plan stops refusing kind: 'set'" —
	 * the blast-radius table's own words. `openApp`'s default `checkPlan` is
	 * always-ok regardless of source kind, so this is purely the ROUTE no
	 * longer 400ing a set source before `checkPlan` ever runs; set verdicts
	 * for real are `room/plan.test.ts`'s job.
	 */
	it('accepts a kind: \'set\' source — the 400 refusal this wave removes — and a mixed plan\'s planName joins the round names', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Set night', gameType: 'draft' } }))
			.json() as import('../room/lobby.ts').RoomView;

		const allSetCube = { rounds: [{ kind: 'set', code: 'ISD', style: 'set-cube' }, { kind: 'set', code: 'ISD', style: 'set-cube' }, { kind: 'set', code: 'ISD', style: 'set-cube' }] };
		const allRes = await call(h, 'PUT', `/api/rooms/${room.id}/pod/plan`, { as: 'alice', body: { plan: allSetCube } });
		expect(allRes.status).toBe(200);
		expect((allRes.json() as import('../room/lobby.ts').RoomView).pod?.plan).toEqual(allSetCube);

		const mixed = { rounds: [{ kind: 'set', code: 'ALA', style: 'realistic' }, { kind: 'set', code: 'ALA', style: 'realistic' }, { kind: 'set', code: 'ARB', style: 'realistic' }] };
		const mixedRes = await call(h, 'PUT', `/api/rooms/${room.id}/pod/plan`, { as: 'alice', body: { plan: mixed } });
		expect(mixedRes.status).toBe(200);
		const planName = (mixedRes.json() as import('../room/lobby.ts').RoomView).pod?.planName;
		expect(planName).toBe(['ALA · Realistic', 'ALA · Realistic', 'ARB · Realistic'].join(' / '));
	});

	it('a refused verdict is 409 { verdict } and leaves the room\'s plan unchanged', async () => {
		const refusal: PoolVerdict = { ok: false, unplayable: ['Not A Real Card'], missingText: [] };
		const h = await openApp(await tempDir(), { checkPlan: async () => refusal });
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Cube night', gameType: 'draft' } }))
			.json() as import('../room/lobby.ts').RoomView;
		const before = room.pod?.plan;

		const res = await call(h, 'PUT', `/api/rooms/${room.id}/pod/plan`, { as: 'alice', body: { plan: PLAN } });
		expect(res.status).toBe(409);
		expect(res.json()).toEqual({ verdict: refusal });

		const after = (await call(h, 'GET', `/api/rooms/${room.id}`)).json() as import('../room/lobby.ts').RoomView;
		expect(after.pod?.plan).toEqual(before);
	});

	it('refuses once the draft has started — the pool is fixed', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Cube night', gameType: 'draft' } }))
			.json() as import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${room.id}/ready`, { as: 'alice', body: { ready: true } });
		for (let seat = 1; seat < 8; seat++) await call(h, 'POST', `/api/rooms/${room.id}/pod/ai`, { as: 'alice', body: { seat, on: true } });
		await approvePlan(h, room.id);
		expect((await call(h, 'POST', `/api/rooms/${room.id}/start`, { as: 'alice' })).status).toBe(200);

		const res = await call(h, 'PUT', `/api/rooms/${room.id}/pod/plan`, { as: 'alice', body: { plan: PLAN } });
		expect(res.status).toBe(409);
	});
});

/* ── closed pod seats ───────────────────────────────────────────────── */

describe('POST /api/rooms/:id/pod/close', () => {
	it('is the owner’s, before the draft: a member who is not gets 403, a stranger 404, a bad body 400, and the seat reads closed', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Cube night', gameType: 'draft' } }))
			.json() as import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${room.id}/join`, { as: 'bob' });
		const close = (as: string, body: unknown) => call(h, 'POST', `/api/rooms/${room.id}/pod/close`, { as, body });

		expect((await close('carol', { seat: 7, closed: true })).status).toBe(404);
		expect((await close('bob', { seat: 7, closed: true })).status).toBe(403);
		expect((await close('alice', { seat: 8, closed: true })).status).toBe(400);
		expect((await close('alice', { seat: 7, closed: 'yes' })).status).toBe(400);
		const ok = await close('alice', { seat: 7, closed: true });
		expect(ok.status).toBe(200);
		expect((ok.json() as import('../room/lobby.ts').RoomView).pod?.seats[7]).toEqual({ memberId: 'closed', name: '' });
		expect((await close('alice', { seat: 7, closed: false })).status).toBe(200);
	});
});

/* ── close ───────────────────────────────────────────────────────────── */

describe('POST /api/rooms/:id/close', () => {
	it('is the owner’s: a member who is not gets 403, a stranger 404, and the owner’s close forgets the room', async () => {
		const closed: string[] = [];
		const h = await openApp(await tempDir(), { closed: (id) => void closed.push(id) });
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Cube night', gameType: 'draft' } }))
			.json() as import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${room.id}/join`, { as: 'bob' });

		expect((await call(h, 'POST', `/api/rooms/${room.id}/close`, { as: 'carol' })).status).toBe(404);
		const bob = await call(h, 'POST', `/api/rooms/${room.id}/close`, { as: 'bob' });
		expect(bob.status).toBe(403);
		expect((bob.json() as { error: string }).error).toBe('only the room owner can close it');
		expect((await call(h, 'POST', `/api/rooms/${room.id}/close`, { as: 'alice', body: { now: true } })).status).toBe(400);
		expect(closed).toEqual([]);

		expect((await call(h, 'POST', `/api/rooms/${room.id}/close`, { as: 'alice' })).status).toBe(200);
		expect(closed).toEqual([room.id]);
		expect((await call(h, 'GET', `/api/rooms/${room.id}`, { as: 'alice' })).status).toBe(404);
	});
});

/* ── the caller's own row ────────────────────────────────────────────── */

describe('you', () => {
	it('is true for exactly one member, in the list and in the room', async () => {
		const h = await openApp(await tempDir());
		const created = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Open' } }))
			.json() as import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${created.id}/join`, { as: 'bob' });

		type Body = import('../room/lobby.ts').RoomView & { you: { id: string; leader: boolean; ready: boolean } };
		const asUser = async (who: string): Promise<Body> =>
			(await call(h, 'GET', `/api/rooms/${created.id}`, { as: who })).json() as Body;

		expect((await asUser('alice')).you).toMatchObject({ leader: true, ready: false });
		expect((await asUser('bob')).you).toMatchObject({ leader: false, ready: false });
		// A friend who is not in the room at all is neither.
		expect((await asUser('carol')).you).toMatchObject({ leader: false, ready: false });
		// And each is told their own member id, the one the room's tables name them by.
		const room = await asUser('alice');
		expect(room.you.id).toBe(room.leader);
		expect((await asUser('bob')).you.id).toBe(room.members.find((m) => m.id !== room.leader)?.id);
		// Exactly one, counted rather than asserted twice.
		const leaders = ['alice', 'bob', 'carol'].map(async (who) => (await asUser(who)).you.leader);
		expect((await Promise.all(leaders)).filter(Boolean)).toHaveLength(1);

		// The list carries it too, so the front page needs no second request.
		const listed = ((await call(h, 'GET', '/api/rooms', { as: 'bob' })).json() as { rooms: Body[] }).rooms;
		expect(listed.map((r) => r.you)).toMatchObject([{ leader: false, ready: false }]);
	});

	it('follows your OWN ready flag, which is what a reload could not tell', async () => {
		// Wave 23's gap: after a reload the room screen knew somebody was ready and
		// not whether it was you, so the button relabelled itself and could not
		// stand down in one click.
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Cube night', gameType: 'draft' } }))
			.json() as import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${room.id}/join`, { as: 'bob' });

		type You = { leader: boolean; ready: boolean };
		const readied = await call(h, 'POST', `/api/rooms/${room.id}/ready`, { as: 'bob', body: { ready: true } });
		// The answer to the ready call is bob's own row.
		expect((readied.json() as { you: You }).you).toMatchObject({ leader: false, ready: true });
		// Alice sees a ready member and is not ready herself — the distinction the
		// screen could not draw.
		const alice = (await call(h, 'GET', `/api/rooms/${room.id}`, { as: 'alice' })).json() as {
			you: You;
			members: { ready: boolean }[];
		};
		expect(alice.you).toMatchObject({ leader: true, ready: false });
		expect(alice.members.map((m) => m.ready)).toEqual([false, true]);
		// And standing down is one click, with the flag to prove it.
		const down = await call(h, 'POST', `/api/rooms/${room.id}/ready`, { as: 'bob', body: { ready: false } });
		expect((down.json() as { you: You }).you).toMatchObject({ leader: false, ready: false });
	});
});

/* ── clientMode has no update path ───────────────────────────────────── */

describe('a room’s clientMode', () => {
	it('is refused by every route but create, and survives every one of them unchanged', async () => {
		const dir = await tempDir();
		const h = await openApp(dir);
		const created = (
			await call(h, 'POST', '/api/rooms', {
				as: 'alice',
				body: { name: 'Forge night', clientMode: 'streamed' },
			})
		).json() as import('../room/lobby.ts').RoomView;
		expect(created.clientMode).toBe('streamed');

		// No route other than POST /api/rooms takes the field. Each of these
		// allow-lists its own body keys, so the answer is a stated 400 rather
		// than a write that silently lands or silently does not.
		const refusals: Array<[string, string]> = [
			['PATCH', `/api/rooms/${created.id}`],
			['POST', `/api/rooms/${created.id}/join`],
		];
		for (const [method, path] of refusals) {
			const res = await call(h, method, path, { as: 'alice', body: { clientMode: 'builtin' } });
			expect(res.status, `${method} ${path}`).toBe(400);
			expect(res.json()).toEqual({ error: 'unknown field(s): clientMode' });
		}
		// …including a PATCH that smuggles it alongside a field that IS allowed.
		const smuggled = await call(h, 'PATCH', `/api/rooms/${created.id}`, {
			as: 'alice',
			body: { gameType: 'draft', clientMode: 'builtin' },
		});
		expect(smuggled.status).toBe(400);
		expect(smuggled.json()).toEqual({ error: 'unknown field(s): clientMode' });
		// And it was refused WHOLE: the allowed half did not land either.
		expect(((await call(h, 'GET', `/api/rooms/${created.id}`)).json() as { gameType: string }).gameType).toBe(
			'constructed-1v1',
		);

		// Now every mutating route that DOES exist, run for real. None of them
		// may move the mode.
		await call(h, 'POST', `/api/rooms/${created.id}/join`, { as: 'bob' });
		await call(h, 'PATCH', `/api/rooms/${created.id}`, { as: 'alice', body: { gameType: 'draft' } });
		h.lobby.setPlayerState(created.id, created.creator, { deck: 'mono-red' });
		h.lobby.setTableMatch(created.id, created.tables[0]!.id, 'match-9');

		const after = (await call(h, 'GET', `/api/rooms/${created.id}`)).json() as { clientMode: string };
		expect(after.clientMode).toBe('streamed');
		// Across a restart too, so nothing above persisted a room that lost it.
		const second = await openApp(dir);
		expect(
			((await call(second, 'GET', `/api/rooms/${created.id}`)).json() as { clientMode: string }).clientMode,
		).toBe('streamed');
	});
});

/* ── the password never escapes ──────────────────────────────────────── */

describe('the password', () => {
	it('never appears in a response body or a log line, and neither do its hash and salt', async () => {
		const dir = await tempDir();
		const spies = {
			log: vi.spyOn(console, 'log').mockImplementation(() => {}),
			info: vi.spyOn(console, 'info').mockImplementation(() => {}),
			warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
			error: vi.spyOn(console, 'error').mockImplementation(() => {}),
			debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
		};
		const h = await openApp(dir);
		const bodies: string[] = [];
		const record = (r: Reply): Reply => {
			bodies.push(r.text);
			return r;
		};

		const created = record(
			await call(h, 'POST', '/api/rooms', {
				as: 'alice',
				body: { name: 'Locked', password: PASSWORD },
			}),
		).json() as import('../room/lobby.ts').RoomView;
		record(await call(h, 'GET', '/api/rooms', { as: 'bob' }));
		record(await call(h, 'GET', `/api/rooms/${created.id}`, { as: 'bob' }));
		record(
			await call(h, 'POST', `/api/rooms/${created.id}/join`, { as: 'bob', body: { password: 'wrong' } }),
		);
		record(
			await call(h, 'POST', `/api/rooms/${created.id}/join`, { as: 'bob', body: { password: PASSWORD } }),
		);
		record(await call(h, 'PATCH', `/api/rooms/${created.id}`, { as: 'alice', body: { gameType: 'draft' } }));
		// A malformed body carrying the password: `JSON.parse`'s own message
		// quotes the input, and express's default error handler prints it.
		record(
			await call(h, 'POST', '/api/rooms', {
				as: 'alice',
				raw: `{"name": "x", "password": "${PASSWORD}"`,
			}),
		);
		// …and a room re-read from disk by a second lobby, whose restore path
		// touches the stored hash.
		const second = await openApp(dir);
		record(await call(second, 'GET', '/api/rooms', { as: 'bob' }));

		const secret = storedSecret(dir);
		const consoleText = Object.values(spies)
			.flatMap((spy) => spy.mock.calls)
			.map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
			.join('\n');
		const captured = [...bodies, JSON.stringify(logged), consoleText].join('\n');

		// The lobby and the router DID speak — otherwise this test proves nothing.
		expect(logged.length).toBeGreaterThan(0);
		expect(logged.some((e) => e.event === 'room-created')).toBe(true);

		for (const needle of [PASSWORD, secret.hash, secret.salt]) {
			expect(captured).not.toContain(needle);
		}
		// Not even a fragment: the first 16 characters of the hash would be
		// plenty for an offline attempt.
		expect(captured).not.toContain(secret.hash.slice(0, 16));
		expect(captured).not.toContain(secret.salt.slice(0, 16));
		// The plaintext is not on disk either, under any of its forms.
		const stored = readdirSync(dir)
			.filter((f) => f.endsWith('.json'))
			.map((f) => readFileSync(join(dir, f), 'utf8'))
			.join('\n');
		expect(stored).not.toContain(PASSWORD);
		expect(stored).toContain(secret.hash);
	});

	it('answers a malformed JSON body without echoing it', async () => {
		const h = await openApp(await tempDir());
		const res = await call(h, 'POST', '/api/rooms', {
			as: 'alice',
			raw: `{"name": "x", "password": "${PASSWORD}"`,
		});
		expect(res.status).toBe(400);
		expect(res.json()).toEqual({ error: 'body is not valid JSON' });
		expect(res.text).not.toContain(PASSWORD);
	});
});

/* ── the lobby itself ────────────────────────────────────────────────── */

describe('the lobby', () => {
	it('holds per-member state for lane C, and refuses it for a non-member', async () => {
		const dir = await tempDir();
		const h = await openApp(dir);
		const created = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Open' } }))
			.json() as import('../room/lobby.ts').RoomView;

		expect(h.lobby.playerState(created.id, created.creator)).toBeUndefined();
		expect(h.lobby.setPlayerState(created.id, 'fk:nobody', { deck: 'x' })).toBe(false);
		expect(h.lobby.setPlayerState('r-000000000000', created.creator, { deck: 'x' })).toBe(false);
		expect(h.lobby.setPlayerState(created.id, created.creator, { deck: 'x', ready: false })).toBe(true);
		expect(h.lobby.playerState(created.id, created.creator)).toEqual({ deck: 'x', ready: false });
		// A clone, not the stored object.
		const state = h.lobby.playerState(created.id, created.creator) as { deck: string };
		state.deck = 'mutated';
		expect(h.lobby.playerState(created.id, created.creator)).toEqual({ deck: 'x', ready: false });

		const firstTable = created.tables[0]!.id;
		expect(h.lobby.setTableMatch('r-000000000000', firstTable, 'm1')).toBe(false);
		expect(h.lobby.setTableMatch(created.id, firstTable, 'm1')).toBe(true);
		expect(h.lobby.get(created.id)?.matchId).toBe('m1');
		expect(h.lobby.releaseTableMatch(created.id, firstTable)).toBe(true);
		expect(h.lobby.get(created.id)?.matchId).toBeNull();

		expect(h.lobby.isMember(created.id, created.creator)).toBe(true);
		expect(h.lobby.isMember(created.id, 'fk:nobody')).toBe(false);
		expect(h.lobby.isMember('r-000000000000', created.creator)).toBe(false);
		expect(h.lobby.get('r-000000000000')).toBeUndefined();
	});

	it('lists in creation order even for rooms made in the same millisecond, across a restart', async () => {
		// A frozen clock is the worst case, and it is not hypothetical: two
		// rooms created in one click tied on `createdAt`, and the tie-break is
		// the random room id, so the front page's order flipped run to run.
		const dir = await tempDir();
		const caller = { id: 'fk:1111111111111111', name: 'user-alice' };
		const first = await lobbyMod.openLobby({ dir, now: () => 1_000 });
		for (const name of ['one', 'two', 'three']) {
			const made = first.create(caller, { name, gameType: 'constructed-1v1', clientMode: 'builtin' });
			expect(made.ok).toBe(true);
		}
		expect(first.list().map((r) => r.name)).toEqual(['one', 'two', 'three']);
		expect(new Set(first.list().map((r) => r.createdAt)).size).toBe(3);

		const second = await lobbyMod.openLobby({ dir, now: () => 1_000 });
		expect(second.list().map((r) => r.name)).toEqual(['one', 'two', 'three']);
		// A room created AFTER the restart still sorts last.
		expect(second.create(caller, { name: 'four', gameType: 'draft', clientMode: 'builtin' }).ok).toBe(true);
		expect(second.list().map((r) => r.name)).toEqual(['one', 'two', 'three', 'four']);
	});

	it('quarantines a record it cannot read instead of dropping or half-applying it', async () => {
		const dir = await tempDir();
		const h = await openApp(dir);
		await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Doomed', password: PASSWORD } });
		const secret = storedSecret(dir);
		const file = readdirSync(dir).filter((f) => f.endsWith('.json'))[0];
		const { writeFileSync } = await import('node:fs');
		// Truncated mid-write, inside the stored hash: it parses as far as looking
		// plausible and then does not, and the parser's message quotes what it saw.
		writeFileSync(join(dir, file), readFileSync(join(dir, file), 'utf8').slice(0, -20));

		const after = await openApp(dir);
		expect(((await call(after, 'GET', '/api/rooms')).json() as { rooms: unknown[] }).rooms).toEqual([]);
		const quarantined = logged.filter((e) => e.event === 'room-quarantined');
		expect(quarantined).toHaveLength(1);
		// The reason names what was wrong, never the bytes — which held the hash.
		expect(JSON.stringify(quarantined)).not.toContain(secret.hash.slice(0, 16));
		expect(readdirSync(join(dir, 'quarantine')).some((f) => f.endsWith('.json'))).toBe(true);
	});
});

/* ── readiness and the start, over the wire ──────────────────────────── */

describe('POST /api/rooms/:id/ready', () => {
	it('sets a member’s flag and returns the whole room', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Cube night', gameType: 'draft' } }))
			.json() as import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${room.id}/join`, { as: 'bob' });

		const res = await call(h, 'POST', `/api/rooms/${room.id}/ready`, { as: 'bob', body: { ready: true } });
		expect(res.status).toBe(200);
		const after = res.json() as import('../room/lobby.ts').RoomView;
		expect(after.members.map((m) => [m.name, m.ready])).toEqual([
			['user-alice', false],
			['user-bob', true],
		]);
		// Standing down again is the same route.
		const down = await call(h, 'POST', `/api/rooms/${room.id}/ready`, { as: 'bob', body: { ready: false } });
		expect((down.json() as import('../room/lobby.ts').RoomView).members.map((m) => m.ready)).toEqual([false, false]);
	});

	it('answers a non-member with the SAME 404 as a missing room and a malformed id', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Cube night', gameType: 'draft' } }))
			.json() as import('../room/lobby.ts').RoomView;

		// carol is friend tier and can SEE the room in the list. She is not a
		// member of it, and the answer must not tell her the difference between
		// that and a room that does not exist — a 403 here would be an oracle.
		const nonMember = await call(h, 'POST', `/api/rooms/${room.id}/ready`, { as: 'carol', body: { ready: true } });
		const missing = await call(h, 'POST', '/api/rooms/r-000000000000/ready', { as: 'carol', body: { ready: true } });
		const malformed = await call(h, 'POST', '/api/rooms/NOT_AN_ID/ready', { as: 'carol', body: { ready: true } });
		expect([nonMember.status, missing.status, malformed.status]).toEqual([404, 404, 404]);
		// Byte-identical, not merely equal-looking.
		expect(nonMember.text).toBe(missing.text);
		expect(nonMember.text).toBe(malformed.text);
		expect(nonMember.json()).toEqual(roomsMod.NO_MATCH);
		// And nothing was written: alice is still the only member, still not ready.
		expect(
			((await call(h, 'GET', `/api/rooms/${room.id}`)).json() as import('../room/lobby.ts').RoomView).members,
		).toHaveLength(1);
	});

	it('allow-lists its body, and refuses a caller the edge could not name', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Cube night', gameType: 'draft' } }))
			.json() as import('../room/lobby.ts').RoomView;
		const cases: Array<[unknown, string]> = [
			[{}, 'ready must be a boolean'],
			[{ ready: 'yes' }, 'ready must be a boolean'],
			[{ ready: 1 }, 'ready must be a boolean'],
			[{ ready: true, sneaky: 1 }, 'unknown field(s): sneaky'],
			[{ ready: true, clientMode: 'streamed' }, 'unknown field(s): clientMode'],
			[[], 'body must be a JSON object'],
		];
		for (const [body, error] of cases) {
			const res = await call(h, 'POST', `/api/rooms/${room.id}/ready`, { as: 'alice', body });
			expect(res.status, JSON.stringify(body)).toBe(400);
			expect(res.json()).toEqual({ error });
		}
		expect(((await call(h, 'GET', `/api/rooms/${room.id}`)).json() as import('../room/lobby.ts').RoomView).members[0].ready).toBe(false);

		const ghost = await call(h, 'POST', `/api/rooms/${room.id}/ready`, {
			headers: anonymousHeaders(),
			body: { ready: true },
		});
		expect(ghost.status).toBe(403);
		expect((ghost.json() as { error: string }).error).toContain('the edge did not name you');
	});
});

/* ── R16: leave, and the leader handoff ─────────────────────────────────── */

describe('POST /api/rooms/:id/leave', () => {
	it('removes the member and answers the room, with no body required', async () => {
		const dir = await tempDir();
		const h = await openApp(dir);
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Cube night', gameType: 'draft' } }))
			.json() as import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${room.id}/join`, { as: 'bob' });

		const res = await call(h, 'POST', `/api/rooms/${room.id}/leave`, { as: 'bob' });
		expect(res.status).toBe(200);
		const after = res.json() as import('../room/lobby.ts').RoomView;
		expect(after.members.map((m) => m.name)).toEqual(['user-alice']);
		// Bob's own row says he is no longer the leader and no longer ready —
		// true either way, since he is not a member any more.
		const asBob = (await call(h, 'GET', `/api/rooms/${room.id}`, { as: 'bob' })).json() as {
			you: { leader: boolean; ready: boolean };
		};
		expect(asBob.you).toMatchObject({ leader: false, ready: false });

		// And it is persisted: still gone after a restart, over the SAME dir.
		const reopened = await openApp(dir);
		expect(
			(reopened.lobby.get(room.id) as import('../room/lobby.ts').RoomView | undefined)?.members.map((m) => m.name),
		).toEqual(['user-alice']);
	});

	it('hands leadership to whoever remains and joined earliest when the leader leaves', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Cube night' } })).json() as
			import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${room.id}/join`, { as: 'carol' });
		await call(h, 'POST', `/api/rooms/${room.id}/join`, { as: 'bob' });

		const left = await call(h, 'POST', `/api/rooms/${room.id}/leave`, { as: 'alice' });
		expect(left.status).toBe(200);
		const after = left.json() as import('../room/lobby.ts').RoomView;
		// Carol joined before Bob, so Carol leads.
		expect(after.leader).toBe(after.members.find((m) => m.name === 'user-carol')?.id);
		expect(after.members.map((m) => m.name)).toEqual(['user-carol', 'user-bob']);

		const asCarol = (await call(h, 'GET', `/api/rooms/${room.id}`, { as: 'carol' })).json() as {
			you: { leader: boolean };
		};
		expect(asCarol.you.leader).toBe(true);
	});

	it('answers a non-member with the SAME 404 as a missing room and a malformed id', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Cube night' } })).json() as
			import('../room/lobby.ts').RoomView;

		const nonMember = await call(h, 'POST', `/api/rooms/${room.id}/leave`, { as: 'carol' });
		const missing = await call(h, 'POST', '/api/rooms/r-000000000000/leave', { as: 'carol' });
		const malformed = await call(h, 'POST', '/api/rooms/NOT_AN_ID/leave', { as: 'carol' });
		expect([nonMember.status, missing.status, malformed.status]).toEqual([404, 404, 404]);
		expect(nonMember.text).toBe(missing.text);
		expect(nonMember.text).toBe(malformed.text);
		expect(nonMember.json()).toEqual(roomsMod.NO_MATCH);
		// Nothing was written: alice is still the only member.
		expect(
			((await call(h, 'GET', `/api/rooms/${room.id}`)).json() as import('../room/lobby.ts').RoomView).members,
		).toHaveLength(1);
	});

	it('refuses an unexpected body field, and a caller the edge could not name', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Cube night' } })).json() as
			import('../room/lobby.ts').RoomView;

		const sneaky = await call(h, 'POST', `/api/rooms/${room.id}/leave`, { as: 'alice', body: { sneaky: 1 } });
		expect(sneaky.status).toBe(400);
		expect(sneaky.json()).toEqual({ error: 'unknown field(s): sneaky' });

		const ghost = await call(h, 'POST', `/api/rooms/${room.id}/leave`, { headers: anonymousHeaders() });
		expect(ghost.status).toBe(403);
		expect((ghost.json() as { error: string }).error).toContain('the edge did not name you');
		// Neither refusal removed alice.
		expect(
			((await call(h, 'GET', `/api/rooms/${room.id}`)).json() as import('../room/lobby.ts').RoomView).members,
		).toHaveLength(1);
	});

	it('hides a room from the list the instant its last member leaves — no stale wait', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Cube night' } })).json() as
			import('../room/lobby.ts').RoomView;
		expect(
			((await call(h, 'GET', '/api/rooms', { as: 'bob' })).json() as { rooms: { id: string }[] }).rooms.map((r) => r.id),
		).toEqual([room.id]);

		const left = await call(h, 'POST', `/api/rooms/${room.id}/leave`, { as: 'alice' });
		expect(left.status).toBe(200);

		expect(
			((await call(h, 'GET', '/api/rooms', { as: 'bob' })).json() as { rooms: { id: string }[] }).rooms,
		).toEqual([]);
		// Still there for a direct GET — a listing rule, not a deletion.
		expect((await call(h, 'GET', `/api/rooms/${room.id}`)).status).toBe(200);
	});
});

describe('POST /api/rooms/:id/start', () => {
	it('starts the draft once no seat is open and every seated player is ready, for either of them, idempotently', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Cube night', gameType: 'draft' } }))
			.json() as import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${room.id}/join`, { as: 'bob' });
		await call(h, 'POST', `/api/rooms/${room.id}/ready`, { as: 'alice', body: { ready: true } });
		await call(h, 'POST', `/api/rooms/${room.id}/ready`, { as: 'bob', body: { ready: true } });

		// Both ready, six seats open: 409 with a sentence, not a 4xx a screen has to guess at.
		const early = await call(h, 'POST', `/api/rooms/${room.id}/start`, { as: 'alice' });
		expect(early.status).toBe(409);
		expect((early.json() as { error: string }).error).toContain('the AI');
		expect(((await call(h, 'GET', `/api/rooms/${room.id}`)).json() as import('../room/lobby.ts').RoomView).draftStartedAt).toBeNull();

		// The AI button, on every open seat.
		for (let seat = 2; seat < 8; seat++) expect((await call(h, 'POST', `/api/rooms/${room.id}/pod/ai`, { as: 'bob', body: { seat, on: true } })).status).toBe(200);
		expect((await call(h, 'POST', `/api/rooms/${room.id}/pod/ai`, { as: 'bob', body: { seat: 2, on: 'yes' } })).status).toBe(400);
		expect((await call(h, 'POST', `/api/rooms/${room.id}/pod/ai`, { as: 'bob', body: { seat: 0, on: true } })).status).toBe(409);
		await approvePlan(h, room.id);
		// Bob is not the leader, and starts it anyway: any member may ask.
		const started = await call(h, 'POST', `/api/rooms/${room.id}/start`, { as: 'bob' });
		expect(started.status).toBe(200);
		const at = (started.json() as import('../room/lobby.ts').RoomView).draftStartedAt;
		expect(typeof at).toBe('string');

		// Both browsers ask; the server answers one draft to both.
		const again = await call(h, 'POST', `/api/rooms/${room.id}/start`, { as: 'alice' });
		expect(again.status).toBe(200);
		expect((again.json() as import('../room/lobby.ts').RoomView).draftStartedAt).toBe(at);
	});

	it('refuses a constructed room with 409, a non-member with 404, and a body it did not ask for', async () => {
		const h = await openApp(await tempDir());
		const table = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Kitchen table' } }))
			.json() as import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${table.id}/ready`, { as: 'alice', body: { ready: true } });

		const wrongGame = await call(h, 'POST', `/api/rooms/${table.id}/start`, { as: 'alice' });
		expect(wrongGame.status).toBe(409);
		expect((wrongGame.json() as { error: string }).error).toContain('not playing a draft');

		const nonMember = await call(h, 'POST', `/api/rooms/${table.id}/start`, { as: 'carol' });
		expect(nonMember.status).toBe(404);
		expect(nonMember.json()).toEqual(roomsMod.NO_MATCH);
		expect((await call(h, 'POST', '/api/rooms/r-000000000000/start', { as: 'carol' })).text).toBe(nonMember.text);

		const withBody = await call(h, 'POST', `/api/rooms/${table.id}/start`, { as: 'alice', body: { gameType: 'draft' } });
		expect(withBody.status).toBe(400);
		expect(withBody.json()).toEqual({ error: 'unknown field(s): gameType' });
	});

	/*
	 * Wave 74 §E step 2: "realistic boosters are fetched before `deal` and
	 * passed in" — fetched HERE, in this route, before `lobby.startDraft`
	 * ever runs. These drive the fetch+cache end to end with fakes; the deal
	 * itself (that `draftRooms.open()` reads the cached packs back) is
	 * `draftRooms.test.ts`'s own coverage.
	 */
	describe('a realistic round', () => {
		const REALISTIC_PLAN = {
			rounds: [{ kind: 'set', code: 'ISD', style: 'realistic' }, { kind: 'set', code: 'ISD', style: 'realistic' }, { kind: 'cube', cubeId: 'legacy' }],
		};

		async function fullPod(h: Harness, plan: unknown): Promise<string> {
			const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Realistic night', gameType: 'draft' } }))
				.json() as import('../room/lobby.ts').RoomView;
			await call(h, 'POST', `/api/rooms/${room.id}/ready`, { as: 'alice', body: { ready: true } });
			for (let seat = 1; seat < 8; seat++) await call(h, 'POST', `/api/rooms/${room.id}/pod/ai`, { as: 'alice', body: { seat, on: true } });
			expect((await call(h, 'PUT', `/api/rooms/${room.id}/pod/plan`, { as: 'alice', body: { plan } })).status).toBe(200);
			return room.id;
		}

		it('without a jar (`realistic` undefined), /start refuses a realistic plan rather than dealing it blind', async () => {
			const h = await openApp(await tempDir());
			const id = await fullPod(h, REALISTIC_PLAN);
			const res = await call(h, 'POST', `/api/rooms/${id}/start`, { as: 'alice' });
			expect(res.status).toBe(409);
			expect((res.json() as { error: string }).error).toContain('pool service is not available');
		});

		it('fetches one booster call per realistic round, maps it through the catalog, caches it, and only THEN starts', async () => {
			const cached: { draftId: string; round: number; packs: unknown }[] = [];
			const boostersCalls: { code: string; count: number; seed: string }[] = [];
			const h = await openApp(await tempDir(), {
				realistic: {
					forge: {
						boosters: async (code, count, seed) => {
							boostersCalls.push({ code, count, seed });
							return Array.from({ length: count }, () => [{ name: 'Mystery Card', set: code, collectorNumber: '1' }]);
						},
					},
					catalog: { byName: () => null, byPrinting: () => null }, // nothing resolves — proves the honest missingText fallback still lets the deal happen
					draftRooms: { cacheRealisticRound: (draftId, round, packs) => cached.push({ draftId, round, packs }) },
				},
			});
			const id = await fullPod(h, REALISTIC_PLAN);

			const res = await call(h, 'POST', `/api/rooms/${id}/start`, { as: 'alice' });
			expect(res.status).toBe(200);
			// Two realistic rounds (0 and 1), the cube round (2) untouched.
			expect(boostersCalls.map((c) => c.code)).toEqual(['ISD', 'ISD']);
			expect(boostersCalls[0]?.seed).toBe(`${id}:0`);
			expect(boostersCalls[1]?.seed).toBe(`${id}:1`);
			expect(cached.map((c) => c.round)).toEqual([0, 1]);
			expect(cached.every((c) => c.draftId === id)).toBe(true);
			const firstPackCard = (cached[0]?.packs as { name: string }[][])[0]?.[0];
			expect(firstPackCard?.name).toBe('Mystery Card');
		});

		it('a failed booster fetch refuses /start with 409 and never calls startDraft', async () => {
			const h = await openApp(await tempDir(), {
				realistic: {
					forge: {
						boosters: async () => {
							throw new Error('the pool JVM is gone');
						},
					},
					catalog: { byName: () => null, byPrinting: () => null },
					draftRooms: { cacheRealisticRound: () => undefined },
				},
			});
			const id = await fullPod(h, REALISTIC_PLAN);
			const res = await call(h, 'POST', `/api/rooms/${id}/start`, { as: 'alice' });
			expect(res.status).toBe(409);
			expect((res.json() as { error: string }).error).toContain('the pool JVM is gone');
			const after = (await call(h, 'GET', `/api/rooms/${id}`)).json() as import('../room/lobby.ts').RoomView;
			expect(after.draftStartedAt).toBeNull();
		});

		it('a second /start (idempotent) never re-fetches — the pod is already past its lobby', async () => {
			let calls = 0;
			const h = await openApp(await tempDir(), {
				realistic: {
					forge: {
						boosters: async (code, count) => {
							calls++;
							return Array.from({ length: count }, () => [{ name: 'Mystery Card', set: code, collectorNumber: '1' }]);
						},
					},
					catalog: { byName: () => null, byPrinting: () => null },
					draftRooms: { cacheRealisticRound: () => undefined },
				},
			});
			const id = await fullPod(h, REALISTIC_PLAN);
			expect((await call(h, 'POST', `/api/rooms/${id}/start`, { as: 'alice' })).status).toBe(200);
			expect(calls).toBe(2); // the two realistic rounds, once each
			expect((await call(h, 'POST', `/api/rooms/${id}/start`, { as: 'alice' })).status).toBe(200);
			expect(calls).toBe(2); // unchanged — the second, redundant /start never re-fetched
		});
	});
});

describe('PATCH /api/rooms/:id while a draft is running', () => {
	it('answers 409 and changes nothing — the pod is dealt against this room’s id', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Cube night', gameType: 'draft' } }))
			.json() as import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${room.id}/ready`, { as: 'alice', body: { ready: true } });
		for (let seat = 1; seat < 8; seat++) await call(h, 'POST', `/api/rooms/${room.id}/pod/ai`, { as: 'alice', body: { seat, on: true } });
		await approvePlan(h, room.id);
		expect((await call(h, 'POST', `/api/rooms/${room.id}/start`, { as: 'alice' })).status).toBe(200);

		const patched = await call(h, 'PATCH', `/api/rooms/${room.id}`, {
			as: 'alice',
			body: { gameType: 'constructed-1v1' },
		});
		expect(patched.status).toBe(409);
		expect((patched.json() as { error: string }).error).toContain('drafting');
		const after = (await call(h, 'GET', `/api/rooms/${room.id}`)).json() as import('../room/lobby.ts').RoomView;
		expect(after.gameType).toBe('draft');
		expect(after.draftStartedAt).not.toBeNull();
	});

	it('clears every ready flag when the game type does change', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Cube night', gameType: 'draft' } }))
			.json() as import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${room.id}/join`, { as: 'bob' });
		await call(h, 'POST', `/api/rooms/${room.id}/ready`, { as: 'alice', body: { ready: true } });
		await call(h, 'POST', `/api/rooms/${room.id}/ready`, { as: 'bob', body: { ready: true } });

		const patched = await call(h, 'PATCH', `/api/rooms/${room.id}`, {
			as: 'alice',
			body: { gameType: 'constructed-1v1' },
		});
		expect(patched.status).toBe(200);
		expect((patched.json() as import('../room/lobby.ts').RoomView).members.map((m) => m.ready)).toEqual([false, false]);
	});
});

/*
 * `POST /api/rooms/:id/identity` — the one door onto a member's avatar, and the
 * one identity field this app ACCEPTS rather than derives.
 *
 * `name` arrives edge-injected and the participant id is hashed from the edge's
 * headers, so neither is ever read off a body (`room/identity.ts`, "Derived,
 * never accepted"). There is no `X-User-Avatar` and there never will be: the
 * choice is made inside watchparty's chrome and saved in watchparty's prefs row,
 * which the edge has never seen. What makes accepting it safe is that the ROW is
 * still derived — `callerOf(req)` — so the tests that matter most here are the
 * ones about whose member row moves.
 */
describe('POST /api/rooms/:id/identity', () => {
	const memberAvatars = (room: import('../room/lobby.ts').RoomView): Record<string, unknown>[] =>
		room.members as unknown as Record<string, unknown>[];

	it('sets the caller\'s own avatar and carries it on every body that names the room', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Kitchen table' } })).json() as
			import('../room/lobby.ts').RoomView;
		// The character the room handed her, until she says which is hers.
		expect(room.members[0]?.avatarId).toBe('sage');

		const set = await call(h, 'POST', `/api/rooms/${room.id}/identity`, { as: 'alice', body: { avatarId: 'wanderer' } });
		expect(set.status).toBe(200);
		expect((set.json() as import('../room/lobby.ts').RoomView).members[0]?.avatarId).toBe('wanderer');

		// The list and the single-room read are separate builders of the view.
		const listed = (await call(h, 'GET', '/api/rooms')).json() as { rooms: import('../room/lobby.ts').RoomView[] };
		expect(listed.rooms[0]?.members[0]?.avatarId).toBe('wanderer');
		const got = (await call(h, 'GET', `/api/rooms/${room.id}`)).json() as import('../room/lobby.ts').RoomView;
		expect(got.members[0]?.avatarId).toBe('wanderer');
	});

	it('moves only the caller\'s row, whatever the body says', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Two of us' } })).json() as
			import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${room.id}/join`, { as: 'bob' });

		const set = await call(h, 'POST', `/api/rooms/${room.id}/identity`, { as: 'bob', body: { avatarId: 'rogue' } });
		expect(set.status).toBe(200);
		const after = (set.json() as import('../room/lobby.ts').RoomView).members;
		expect(after.find((m) => m.name === 'user-bob')?.avatarId).toBe('rogue');
		// Alice is untouched: she still wears the character the room handed her.
		// There is no field in the body that could have named her.
		expect(after.find((m) => m.name === 'user-alice')?.avatarId).toBe('sage');
	});

	it('leaves the key OFF the wire for a member with no avatar, never sending "" or null', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Two of us' } })).json() as
			import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${room.id}/join`, { as: 'bob' });
		await call(h, 'POST', `/api/rooms/${room.id}/identity`, { as: 'alice', body: { avatarId: 'mage' } });
		// Bob clears the character he was handed: a member with none.
		await call(h, 'POST', `/api/rooms/${room.id}/identity`, { as: 'bob', body: { avatarId: null } });

		// On the BYTES, because this is the property a browser depends on: an
		// empty string survives a `!== undefined` check and then resolves to a
		// sprite URL ending `square_.png`.
		const got = await call(h, 'GET', `/api/rooms/${room.id}`);
		expect(got.text).toContain('"avatarId":"mage"');
		expect(got.text).not.toContain('"avatarId":""');
		expect(got.text).not.toContain('"avatarId":null');
		expect(memberAvatars(got.json() as import('../room/lobby.ts').RoomView).find((m) => m.name === 'user-bob')).not.toHaveProperty(
			'avatarId',
		);
	});

	it('clears it with null, and refuses every other way of saying nothing', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Kitchen table' } })).json() as
			import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${room.id}/identity`, { as: 'alice', body: { avatarId: 'mage' } });

		const cleared = await call(h, 'POST', `/api/rooms/${room.id}/identity`, { as: 'alice', body: { avatarId: null } });
		expect(cleared.status).toBe(200);
		expect(memberAvatars(cleared.json() as import('../room/lobby.ts').RoomView)[0]).not.toHaveProperty('avatarId');

		// An ABSENT field is a 400, not a 200 that changed nothing: a body that
		// means neither "this is my character" nor "I have none" is not a request.
		// Same discipline as `/ready`, which will not accept a body that forgot
		// to say which way.
		const empty = await call(h, 'POST', `/api/rooms/${room.id}/identity`, { as: 'alice', body: {} });
		expect(empty.status).toBe(400);
		expect(empty.json()).toEqual({ error: 'avatarId must be a string or null' });

		// `''` is a client bug, and it is told so rather than quietly folded — the
		// lobby folds it anyway, so the two layers cannot store different things.
		const blank = await call(h, 'POST', `/api/rooms/${room.id}/identity`, { as: 'alice', body: { avatarId: '' } });
		expect(blank.status).toBe(400);
		expect((blank.json() as { error: string }).error).toContain('or null to clear it');

		const long = await call(h, 'POST', `/api/rooms/${room.id}/identity`, {
			as: 'alice',
			body: { avatarId: 'x'.repeat(33) },
		});
		expect(long.status).toBe(400);
		const wrongType = await call(h, 'POST', `/api/rooms/${room.id}/identity`, { as: 'alice', body: { avatarId: 7 } });
		expect(wrongType.status).toBe(400);
		expect(wrongType.json()).toEqual({ error: 'avatarId must be a string or null' });
		// The same allow-list discipline every other route here has: a field that
		// is not on the list is a refusal, never an accepted-and-ignored write.
		const extra = await call(h, 'POST', `/api/rooms/${room.id}/identity`, {
			as: 'alice',
			body: { avatarId: 'mage', name: 'Somebody Else' },
		});
		expect(extra.status).toBe(400);
		expect(extra.json()).toEqual({ error: 'unknown field(s): name' });
	});

	it('answers the single 404 for a non-member, an unknown room and a malformed id', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Kitchen table' } })).json() as
			import('../room/lobby.ts').RoomView;

		// Not a member. Deliberately the same answer as "no such room": a
		// 404-vs-403 split would tell an enumerator which ids exist, and this
		// route must not be the one that leaks it.
		const outsider = await call(h, 'POST', `/api/rooms/${room.id}/identity`, { as: 'bob', body: { avatarId: 'mage' } });
		expect(outsider.status).toBe(404);
		expect(outsider.json()).toEqual(roomsMod.NO_MATCH);
		// There is no join-by-asserting: bob is still not in the room.
		expect(
			((await call(h, 'GET', `/api/rooms/${room.id}`)).json() as import('../room/lobby.ts').RoomView).members,
		).toHaveLength(1);

		// A match id NO room holds: nothing to resolve it to, so the same 404. (A
		// match id a room DOES hold resolves; see the next test.)
		const match = await call(h, 'POST', '/api/rooms/m-090bf01ba811/identity', { as: 'alice', body: { avatarId: 'mage' } });
		expect(match.status).toBe(404);
		expect(match.json()).toEqual(roomsMod.NO_MATCH);

		const malformed = await call(h, 'POST', '/api/rooms/NOT_AN_ID/identity', { as: 'alice', body: { avatarId: 'mage' } });
		expect(malformed.status).toBe(404);
		expect(malformed.json()).toEqual(roomsMod.NO_MATCH);
	});

	/*
	 * Wave 31 P3b. `RoomShell` asserts against the route's id, which on
	 * `#/match/<id>` is a MATCH id; the prod log shows `POST /<id>/identity` 404
	 * for both players at every match start. The server resolves the match to the
	 * lobby room that started it.
	 */
	it('resolves a match id to the room that holds it, and sets the avatar there', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Kitchen table' } })).json() as
			import('../room/lobby.ts').RoomView;
		// A real match id's shape: it fits `ROOM_ID_RE`, which is why the lookup
		// has to come before the room-id test rather than after it.
		h.lobby.setTableMatch(room.id, room.tables[0]!.id, 'a1b2c3d4-0000-4000-8000-000000000001');

		const set = await call(h, 'POST', '/api/rooms/a1b2c3d4-0000-4000-8000-000000000001/identity', {
			as: 'alice',
			body: { avatarId: 'wanderer' },
		});
		expect(set.status).toBe(200);
		expect(h.lobby.get(room.id)?.members[0]?.avatarId).toBe('wanderer');

		// Still the caller's own row: bob is not in the room that holds the match.
		const outsider = await call(h, 'POST', '/api/rooms/a1b2c3d4-0000-4000-8000-000000000001/identity', {
			as: 'bob',
			body: { avatarId: 'rogue' },
		});
		expect(outsider.status).toBe(404);
	});

	it('refuses a caller the edge could not name, like every other write here', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Kitchen table' } })).json() as
			import('../room/lobby.ts').RoomView;
		const anon = await call(h, 'POST', `/api/rooms/${room.id}/identity`, {
			headers: anonymousHeaders(),
			body: { avatarId: 'mage' },
		});
		expect(anon.status).toBe(403);
		expect((anon.json() as { error: string }).error).toContain('take part in');
	});
});

/*
 * Wave 31, stale rooms. The operator: *"why are 'hi there' and 'hi there2' still
 * showing up?"* A room nobody has touched or polled for `ROOM_STALE_MS` (30
 * minutes) is not offered on the front page.
 */
describe('GET /api/rooms and stale rooms', () => {
	const ids = async (h: Harness, as: string): Promise<string[]> =>
		((await call(h, 'GET', '/api/rooms', { as })).json() as { rooms: { id: string }[] }).rooms.map((r) => r.id);

	it('stops offering a room after ROOM_STALE_MS with no touch, and offers it again when a member polls', async () => {
		let clock = 5_000_000_000_000;
		const h = await openApp(await tempDir(), { now: () => clock });
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'hi there' } })).json() as
			import('../room/lobby.ts').RoomView;
		expect(await ids(h, 'bob')).toEqual([room.id]);

		clock += lobbyMod.ROOM_STALE_MS - 1;
		expect(await ids(h, 'bob')).toEqual([room.id]);

		clock += 2;
		expect(await ids(h, 'bob')).toEqual([]);
		// Hidden, not deleted: `get` and a direct join still find it.
		expect(h.lobby.get(room.id)).toBeDefined();

		// A non-member's read is not a poll and revives nothing.
		await call(h, 'GET', `/api/rooms/${room.id}`, { as: 'bob' });
		expect(await ids(h, 'bob')).toEqual([]);

		// A member's poll is: the room screen reads this every 1.5 s.
		await call(h, 'GET', `/api/rooms/${room.id}`, { as: 'alice' });
		expect(await ids(h, 'bob')).toEqual([room.id]);
	});

	it('keeps offering a room that holds a match', async () => {
		let clock = 6_000_000_000_000;
		const h = await openApp(await tempDir(), { now: () => clock });
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'playing' } })).json() as
			import('../room/lobby.ts').RoomView;
		h.lobby.setTableMatch(room.id, room.tables[0]!.id, 'a1b2c3d4-0000-4000-8000-000000000002');
		clock += lobbyMod.ROOM_STALE_MS * 3;
		expect(await ids(h, 'bob')).toEqual([room.id]);
	});
});

describe('POST /api/rooms/watchparty', () => {
	it('binds everyone in one watchparty room to one table, made by whoever came first', async () => {
		const h = await openApp(await tempDir());
		const first = await call(h, 'POST', '/api/rooms/watchparty', { as: 'alice', body: { room: 'movie-night' } });
		expect(first.status).toBe(200);
		const made = first.json() as import('../room/lobby.ts').RoomView & { you: { leader: boolean } };
		expect(made.id).toBe(lobbyMod.watchpartyRoomId('movie-night'));
		expect(made.id).toMatch(/^wp-[0-9a-f]{20}$/);
		expect(made.you.leader).toBe(true);
		expect(made.locked).toBe(false);

		const second = (await call(h, 'POST', '/api/rooms/watchparty', { as: 'bob', body: { room: 'movie-night' } })).json() as {
			id: string;
			members: { name: string }[];
			you: { leader: boolean };
		};
		expect(second.id).toBe(made.id);
		expect(second.members.map((m) => m.name)).toEqual(['user-alice', 'user-bob']);
		expect(second.you.leader).toBe(false);

		const elsewhere = (await call(h, 'POST', '/api/rooms/watchparty', { as: 'bob', body: { room: 'other-room' } })).json() as { id: string };
		expect(elsewhere.id).not.toBe(made.id);

		// The watchparty id is opaque: any shape still makes a valid table id.
		const opaque = (await call(h, 'POST', '/api/rooms/watchparty', { as: 'bob', body: { room: 'F3E1C0DE-UUID_Like.Room 9' } })).json() as { id: string };
		expect(opaque.id).toMatch(/^wp-[0-9a-f]{20}$/);
	});

	it('never prints the watchparty name, even a leader key passed by mistake', async () => {
		const h = await openApp(await tempDir());
		const leaderKey = 'movie-night-0123456789abcdef';
		const bound = (await call(h, 'POST', '/api/rooms/watchparty', { as: 'alice', body: { room: leaderKey } })).json() as { id: string; name: string };
		expect(bound.id).not.toContain('movie');
		expect(bound.name).not.toContain('movie');
		expect(JSON.stringify(logged)).not.toContain(leaderKey);
	});

	it('refuses a body that names no room, and a caller the edge could not name', async () => {
		const h = await openApp(await tempDir());
		expect((await call(h, 'POST', '/api/rooms/watchparty', { body: {} })).status).toBe(400);
		expect((await call(h, 'POST', '/api/rooms/watchparty', { body: { room: '' } })).status).toBe(400);
		expect((await call(h, 'POST', '/api/rooms/watchparty', { body: { room: 'x', extra: 1 } })).status).toBe(400);
		expect((await call(h, 'POST', '/api/rooms/watchparty', { headers: anonymousHeaders(), body: { room: 'x' } })).status).toBe(403);
	});

	it('spends a join token for a newcomer and none for a member', async () => {
		const h = await openApp(await tempDir(), { joinRateLimit: { capacity: 1, refillAmount: 1, refillIntervalMs: 60_000 } });
		expect((await call(h, 'POST', '/api/rooms/watchparty', { as: 'alice', body: { room: 'a' } })).status).toBe(200);
		expect((await call(h, 'POST', '/api/rooms/watchparty', { as: 'alice', body: { room: 'a' } })).status).toBe(200);
		expect((await call(h, 'POST', '/api/rooms/watchparty', { as: 'alice', body: { room: 'b' } })).status).toBe(429);
	});
});

/*
 * A match screen's way to its room. The route carries only the match, and the
 * result screen readies at the room's table for a Rematch: the operator's
 * r-cae3103a30ac rematch stranded one screen whose room lookup (the room list)
 * no longer listed the finished match.
 */
describe('GET /api/rooms/of-match/:matchId', () => {
	it("answers the room a match was started from — to its members, during and after the match — and 404 to anyone else", async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Kitchen table' } })).json() as
			import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${room.id}/join`, { as: 'bob', body: {} });
		h.lobby.setTableMatch(room.id, room.tables[0]!.id, 'm-3f3db8ae2945');

		const during = await call(h, 'GET', '/api/rooms/of-match/m-3f3db8ae2945', { as: 'bob' });
		expect(during.status).toBe(200);
		expect((during.json() as { id: string }).id).toBe(room.id);

		h.lobby.releaseTableMatch(room.id, room.tables[0]!.id);
		const after = await call(h, 'GET', '/api/rooms/of-match/m-3f3db8ae2945', { as: 'alice' });
		expect(after.status, 'the match is over and the room let go of it').toBe(200);
		expect((after.json() as { id: string }).id).toBe(room.id);

		const outsider = await call(h, 'GET', '/api/rooms/of-match/m-3f3db8ae2945', { as: 'carol' });
		expect(outsider.status).toBe(404);
		expect(outsider.json()).toEqual(roomsMod.NO_MATCH);
		expect((await call(h, 'GET', '/api/rooms/of-match/m-000000000000', { as: 'alice' })).status).toBe(404);
		expect((await call(h, 'GET', '/api/rooms/of-match/NOT_AN_ID', { as: 'alice' })).status).toBe(404);
	});
});

describe('a constructed room’s mode over HTTP', () => {
	it('POST takes an optional mode with its options, and refuses an unknown one', async () => {
		const h = await openApp(await tempDir());
		const plain = await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Open' } });
		expect(plain.status).toBe(201);
		expect(plain.json()).toMatchObject({ mode: null, modeOptions: null });

		const chosen = await call(h, 'POST', '/api/rooms', {
			as: 'alice',
			body: { name: 'Random', mode: 'random', modeOptions: { pool: 'modern' } },
		});
		expect(chosen.status).toBe(201);
		expect(chosen.json()).toMatchObject({ mode: 'random', modeOptions: { pool: 'modern' } });

		const classic = await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Classic', mode: 'classic' } });
		expect(classic.json()).toMatchObject({ mode: 'classic', modeOptions: {} });

		for (const body of [
			{ name: 'x', mode: 'sealed' },
			{ name: 'x', mode: 'random' },
			{ name: 'x', mode: 'random', modeOptions: { pool: 'vintage' } },
			{ name: 'x', mode: 'gauntlet', modeOptions: { pool: 'full' } },
			{ name: 'x', modeOptions: { pool: 'full' } },
			{ name: 'x', gameType: 'draft', mode: 'classic' },
		]) {
			const res = await call(h, 'POST', '/api/rooms', { as: 'alice', body });
			expect(res.status, JSON.stringify(body)).toBe(400);
		}
	});

	it('PATCH { mode, modeOptions } is the leader’s, and refuses an unknown mode', async () => {
		const h = await openApp(await tempDir());
		const created = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Open' } })).json() as { id: string };
		await call(h, 'POST', `/api/rooms/${created.id}/join`, { as: 'bob' });

		const byMember = await call(h, 'PATCH', `/api/rooms/${created.id}`, { as: 'bob', body: { mode: 'classic' } });
		expect(byMember.status).toBe(403);
		expect((byMember.json() as { error: string }).error).toBe('only the room leader can change the mode');

		const unknown = await call(h, 'PATCH', `/api/rooms/${created.id}`, { as: 'alice', body: { mode: 'sealed' } });
		expect(unknown.status).toBe(400);
		const mixed = await call(h, 'PATCH', `/api/rooms/${created.id}`, { as: 'alice', body: { mode: 'classic', format: OLDEST_POOL } });
		expect(mixed.status).toBe(400);

		const byLeader = await call(h, 'PATCH', `/api/rooms/${created.id}`, {
			as: 'alice',
			body: { mode: 'gauntlet', modeOptions: { family: 'legacy' } },
		});
		expect(byLeader.status).toBe(200);
		expect(byLeader.json()).toMatchObject({ mode: 'gauntlet', modeOptions: { family: 'legacy' } });
	});

	it('PATCH refuses a mode change with 409 mode-locked once a seated player is ready', async () => {
		const h = await openApp(await tempDir());
		const created = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Open', mode: 'classic' } })).json() as {
			id: string;
			tables: { id: string }[];
		};
		const tableId = created.tables[0]!.id;
		const alice = (created as unknown as { you: { id: string } }).you.id;
		h.lobby.sit(created.id, tableId, alice);
		h.lobby.setSeatReady(created.id, tableId, alice, true);

		const locked = await call(h, 'PATCH', `/api/rooms/${created.id}`, { as: 'alice', body: { mode: 'random', modeOptions: { pool: 'full' } } });
		expect(locked.status).toBe(409);
		expect(locked.json()).toMatchObject({ reason: 'mode-locked' });
		expect(((await call(h, 'GET', `/api/rooms/${created.id}`)).json() as { mode: string }).mode).toBe('classic');
	});

	it('PATCH refuses a game type change with 409 mode-locked once a seated player is ready, naming the game type', async () => {
		const h = await openApp(await tempDir());
		const created = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Open', mode: 'classic' } })).json() as {
			id: string;
			tables: { id: string }[];
			you: { id: string };
		};
		const tableId = created.tables[0]!.id;
		h.lobby.sit(created.id, tableId, created.you.id);
		h.lobby.setSeatReady(created.id, tableId, created.you.id, true);

		const locked = await call(h, 'PATCH', `/api/rooms/${created.id}`, { as: 'alice', body: { gameType: 'draft' } });
		expect(locked.status).toBe(409);
		expect(locked.json()).toEqual({ error: 'a seated player is ready; the game type cannot change now', reason: 'mode-locked' });
		expect(((await call(h, 'GET', `/api/rooms/${created.id}`)).json() as { gameType: string }).gameType).toBe('constructed-1v1');
	});
});

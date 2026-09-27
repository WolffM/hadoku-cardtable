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
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
	opts: { joinRateLimit?: { capacity: number; refillAmount: number; refillIntervalMs: number } } = {},
): Promise<Harness> {
	const log = (entry: Record<string, unknown>): void => {
		logged.push(entry);
	};
	const lobby = await lobbyMod.openLobby({ dir, log });
	const app = express();
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	const api = express.Router();
	api.use(express.json({ limit: '1mb' }));
	roomsMod.attachRooms(api, { lobby, log, joinRateLimit: opts.joinRateLimit });
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
				headers: { 'x-user-name': 'Matthaus' },
				body: { name: 'Named' },
			})
		).json() as import('../room/lobby.ts').RoomView;
		expect(named.members.map((m) => m.name)).toEqual(['Matthaus']);

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
		const h = await openApp(await tempDir());
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
		expect(room.members).toHaveLength(1);
		expect(room.members[0].id).toBe(room.creator);
		expect(room.members[0].name).toBe('user-alice');
		expect(Date.parse(room.members[0].joinedAt)).not.toBeNaN();
		expect(Date.parse(room.createdAt)).not.toBeNaN();
		// The whole public shape, so a field added without a decision fails here.
		expect(Object.keys(room).sort()).toEqual([
			'clientMode',
			'createdAt',
			'creator',
			'draftStartedAt',
			'gameType',
			'id',
			'leader',
			'locked',
			'matchId',
			'members',
			'name',
		]);
		expect(Object.keys(room.members[0]).sort()).toEqual(['id', 'joinedAt', 'name', 'ready']);

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
		first.lobby.setMatch(created.id, 'match-42');

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
		// The match does NOT come back, and must not: it was a child JVM of the
		// process that died. A room that kept its match id sat on the front page
		// advertising "playing" about a game that no longer existed.
		expect(rooms[0].matchId).toBeNull();
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
		h.lobby.setMatch(created.id, 'match-9');

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

		expect(h.lobby.setMatch('r-000000000000', 'm1')).toBe(false);
		expect(h.lobby.setMatch(created.id, 'm1')).toBe(true);
		expect(h.lobby.get(created.id)?.matchId).toBe('m1');
		expect(h.lobby.setMatch(created.id, null)).toBe(true);
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

describe('POST /api/rooms/:id/start', () => {
	it('starts the draft once every member is ready, for either member, idempotently', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Cube night', gameType: 'draft' } }))
			.json() as import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${room.id}/join`, { as: 'bob' });
		await call(h, 'POST', `/api/rooms/${room.id}/ready`, { as: 'alice', body: { ready: true } });

		// Bob has not readied: 409 with a sentence, not a 4xx a screen has to guess at.
		const early = await call(h, 'POST', `/api/rooms/${room.id}/start`, { as: 'alice' });
		expect(early.status).toBe(409);
		expect((early.json() as { error: string }).error).toContain('ready');
		expect(((await call(h, 'GET', `/api/rooms/${room.id}`)).json() as import('../room/lobby.ts').RoomView).draftStartedAt).toBeNull();

		await call(h, 'POST', `/api/rooms/${room.id}/ready`, { as: 'bob', body: { ready: true } });
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
});

describe('PATCH /api/rooms/:id while a draft is running', () => {
	it('answers 409 and changes nothing — the pod is dealt against this room’s id', async () => {
		const h = await openApp(await tempDir());
		const room = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Cube night', gameType: 'draft' } }))
			.json() as import('../room/lobby.ts').RoomView;
		await call(h, 'POST', `/api/rooms/${room.id}/ready`, { as: 'alice', body: { ready: true } });
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

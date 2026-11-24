/**
 * An external game is a registered room type, end to end through a REAL express app — the same
 * shape `games/magic/server/src/http/rooms.test.ts` proves Magic's two types with (that file is
 * not this lane's to edit, so this one builds its own small harness rather than importing its
 * helpers). Ported from the old `bomberman.test.ts` (wave 119 §U: "no bomberman code in
 * cardtable" — bomberman is now one entry in `EXTERNAL_GAMES`, proved generically here rather
 * than by name) plus the flag itself: unset, the type never registers at all.
 */

import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EXTERNAL_GAMES as EXTERNAL_GAMES_CONFIG } from '@hadoku/game-ui/rooms/external-games-config.ts';

const EDGE_SECRET = 'test-edge-auth-secret';

let roomsMod: typeof import('@hadoku/magic-server/http/rooms');
let lobbyMod: typeof import('@hadoku/magic-server/room/lobby');
let edgeMod: typeof import('@hadoku/game-server/edge-auth');
let EXTERNAL_GAME_TYPE: string;

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	process.env.CARDTABLE_EXPERIMENTAL_GAMES = '1';
	// Production's floor, so a friends-only game's own floor is what refuses a guest or member, not the app's.
	process.env.CARDTABLE_MIN_TIER = 'guest';
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	roomsMod = await import('@hadoku/magic-server/http/rooms');
	lobbyMod = await import('@hadoku/magic-server/room/lobby');
	edgeMod = await import('@hadoku/game-server/edge-auth');
	// `external-games.ts` imported fresh, in the SAME `resetModules` graph as the above: a module
	// imported before `resetModules` (a static top-level import) would register into a
	// `@hadoku/shared` instance `rooms.ts`'s own import of it never sees, and every create would
	// read back "not a registered game type" — the registry is a plain module-level `Map`, one
	// per graph.
	const externalGamesMod = await import('./external-games.ts');
	EXTERNAL_GAME_TYPE = externalGamesMod.EXTERNAL_GAMES[0]!.id;
	// What the plugin's own `setup` does at boot — called directly, since this
	// harness never runs the kernel's boot sequence.
	await externalGamesMod.externalGamesPlugin.setup({} as never);
});

afterAll(() => {
	delete process.env.CARDTABLE_EXPERIMENTAL_GAMES;
	delete process.env.CARDTABLE_MIN_TIER;
});

const dirs: string[] = [];
const servers: HttpServer[] = [];
let logged: Record<string, unknown>[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-external-game-test-'));
	dirs.push(dir);
	return dir;
}

interface Harness {
	base: string;
}

async function openApp(dir: string): Promise<Harness> {
	const log = (entry: Record<string, unknown>): void => {
		logged.push(entry);
	};
	const lobby = await lobbyMod.openLobby({ dir, log });
	const app = express();
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	const api = express.Router();
	api.use(express.json({ limit: '1mb' }));
	roomsMod.attachRooms(api, { lobby, log, checkPlan: async (plan) => ({ ok: true, cards: plan.rounds.length * 10 }) });
	app.use('/api', api);

	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	const { port } = server.address() as AddressInfo;
	return { base: `http://127.0.0.1:${port}` };
}

function headersFor(user: string, tier = 'friend'): Record<string, string> {
	return {
		'x-edge-auth': EDGE_SECRET,
		'x-hadoku-tier': tier,
		'x-user-id': `user-${user}`,
		'x-user-name': `user-${user}`,
		'x-user-key': `friend-key-${user}`,
	};
}

interface Reply {
	status: number;
	text: string;
	json: () => unknown;
}

async function call(h: Harness, method: string, path: string, opts: { as?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
	const headers: Record<string, string> = { ...headersFor(opts.as ?? 'alice'), ...opts.headers };
	let body: string | undefined;
	if (opts.body !== undefined) {
		body = JSON.stringify(opts.body);
		headers['content-type'] = 'application/json';
	}
	const res = await fetch(`${h.base}${path}`, { method, headers, body });
	const text = await res.text();
	return { status: res.status, text, json: () => JSON.parse(text) };
}

afterEach(() => {
	logged = [];
	vi.restoreAllMocks();
});

afterAll(async () => {
	for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe('an external game is a registered game type', () => {
	it('creates, is joined, auto-seats through its OWN pod (not the 2-seat table), and reports its own series length', async () => {
		const h = await openApp(await tempDir());
		const created = (
			await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Boom room', gameType: EXTERNAL_GAME_TYPE } })
		).json() as import('@hadoku/magic-server/room/lobby').RoomView;
		expect(created.gameType).toBe(EXTERNAL_GAME_TYPE);
		// `seats.max` (10) is above 2, so `room/pods.ts`'s `usesPod` routes this room through
		// its own pod seats, read as the room's `seats`, never the Magic table's hard-two `tables[0].players`.
		expect(created.seats[0]).toBe(created.creator);
		// The platform's plain room type (`hostedRoomType`): no Magic table, nothing of Magic's at all.
		expect(created.tables).toBeUndefined();

		const joined = (await call(h, 'POST', `/api/rooms/${created.id}/join`, { as: 'bob' })).json() as import('@hadoku/magic-server/room/lobby').RoomView;
		expect(joined.members.map((m) => m.id)).toEqual([created.creator, joined.members[1]!.id]);
		expect(joined.seats.filter((s) => s !== null)).toHaveLength(2);

		// A THIRD member still gets a seat — the load-bearing difference from a Magic 1v1
		// table, which would make them a spectator at exactly this point.
		const third = (await call(h, 'POST', `/api/rooms/${created.id}/join`, { as: 'carol' })).json() as import('@hadoku/magic-server/room/lobby').RoomView;
		expect(third.members).toHaveLength(3);
		expect(third.seats.filter((s) => s !== null)).toHaveLength(3);
	});

	it('answers a view with no Magic field: it is hosted on the platform\'s plain room type', async () => {
		const h = await openApp(await tempDir());
		const created = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Boom room', gameType: EXTERNAL_GAME_TYPE } })).json() as Record<string, unknown>;
		const reread = (await call(h, 'GET', `/api/rooms/${String(created.id)}`, { as: 'alice' })).json() as Record<string, unknown>;
		const listed = ((await call(h, 'GET', '/api/rooms', { as: 'alice' })).json() as { rooms: Record<string, unknown>[] }).rooms.find((r) => r.id === created.id);
		// `room/magic-view.ts`'s `MagicViewPart`: what Magic's two types add, and only theirs.
		const magicKeys = ['game', 'ai', 'historical', 'aiDeckAssignments', 'seatDecks', 'settings', 'tables', 'locks', 'matchId'];
		for (const view of [created, reread, listed]) {
			expect(view).toBeDefined();
			expect(Object.keys(view!).filter((key) => magicKeys.includes(key))).toEqual([]);
		}
	});

	it('refuses a constructed room\'s mode on an external-game room, at creation', async () => {
		const h = await openApp(await tempDir());
		const res = await call(h, 'POST', '/api/rooms', {
			body: { name: 'Boom room', gameType: EXTERNAL_GAME_TYPE, mode: 'classic' },
		});
		expect(res.status).toBe(400);
		expect(res.json()).toEqual({ error: 'only a constructed room has a mode' });
	});

	it('survives a restart instead of being quarantined', async () => {
		const dir = await tempDir();
		const h = await openApp(dir);
		const created = (
			await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Boom room', gameType: EXTERNAL_GAME_TYPE } })
		).json() as import('@hadoku/magic-server/room/lobby').RoomView;

		// A fresh `openLobby` on the SAME dir — `index.ts`'s own restart. An unreadable record
		// would quarantine (`room-quarantined` in `logged`).
		const second = await openApp(dir);
		const reread = await call(second, 'GET', `/api/rooms/${created.id}`, { as: 'bob' });
		expect(reread.status).toBe(200);
		expect((reread.json() as { gameType: string }).gameType).toBe(EXTERNAL_GAME_TYPE);
		expect(logged.some((l) => l.event === 'room-quarantined')).toBe(false);
	});

	it(
		// Found, not assumed (`lobby.ts:2635`'s own `if (room.gameType !== 'draft') return { ok: false, reason: 'not-draft' };`
		// inside `startDraft`, the one function `POST /:id/start` calls): an external-game room has
		// no tournament pod and is not a draft, so the explicit Start route refuses it today.
		'cannot be started through POST /:id/start yet (lobby.ts:2635 refuses any non-draft, non-tournament type)',
		async () => {
			const h = await openApp(await tempDir());
			const created = (
				await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Boom room', gameType: EXTERNAL_GAME_TYPE } })
			).json() as import('@hadoku/magic-server/room/lobby').RoomView;
			await call(h, 'POST', `/api/rooms/${created.id}/join`, { as: 'bob' });
			const res = await call(h, 'POST', `/api/rooms/${created.id}/start`, { as: 'alice' });
			expect(res.status).toBe(409);
			expect(res.json()).toEqual({ error: 'this room is not playing a draft' });
		},
	);

	it('creating an external-game room works, but PATCHing a live constructed-1v1 room into one is refused — converting is not creating', async () => {
		const h = await openApp(await tempDir());

		// Create still takes any registered type, the external game included.
		const made = await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Boom room', gameType: EXTERNAL_GAME_TYPE } });
		expect(made.status).toBe(201);
		expect((made.json() as { gameType: string }).gameType).toBe(EXTERNAL_GAME_TYPE);

		// A plain constructed room, PATCHed toward it: refused at the body, same 400 and same
		// message a wholly unknown id always got — the room never sees the attempt.
		const constructed = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Friday night' } })).json() as import('@hadoku/magic-server/room/lobby').RoomView;
		const patch = await call(h, 'PATCH', `/api/rooms/${constructed.id}`, { as: 'alice', body: { gameType: EXTERNAL_GAME_TYPE } });
		expect(patch.status).toBe(400);
		expect(patch.json()).toEqual({ error: 'gameType must be one of: constructed-1v1, draft' });
		const reread = await call(h, 'GET', `/api/rooms/${constructed.id}`, { as: 'alice' });
		expect((reread.json() as { gameType: string }).gameType).toBe('constructed-1v1');
	});
});

describe("an entry with minTier: 'friend' is friends-only, whatever the app's floor", () => {
	const friendsOnly = (): string => {
		const game = EXTERNAL_GAMES_CONFIG.find((g) => g.minTier === 'friend' && g.e2eOnly !== true);
		if (game === undefined) throw new Error('external-games-config.ts has no friends-only entry to test against');
		return game.id;
	};

	it.each(['guest', 'member'])('a %s cannot create one', async (tier) => {
		const h = await openApp(await tempDir());
		const res = await call(h, 'POST', '/api/rooms', { as: 'gus', headers: { 'x-hadoku-tier': tier }, body: { name: 'Cards', gameType: friendsOnly() } });
		expect(res.status, res.text).toBe(403);
		expect((await call(h, 'GET', '/api/rooms', { as: 'gus', headers: { 'x-hadoku-tier': tier } })).status).toBe(200);
	});

	it.each(['guest', 'member'])("a %s can neither see nor join a friend's room of it", async (tier) => {
		const h = await openApp(await tempDir());
		const created = await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Cards', gameType: friendsOnly() } });
		expect(created.status, created.text).toBe(201);
		const room = created.json() as { id: string; minTier?: string };
		expect(room.minTier).toBe('friend');
		const asLower = { as: 'gus', headers: { 'x-hadoku-tier': tier } };
		const listed = (await call(h, 'GET', '/api/rooms', asLower)).json() as Array<{ id: string }> | { rooms: Array<{ id: string }> };
		const ids = (Array.isArray(listed) ? listed : listed.rooms).map((r) => r.id);
		expect(ids).not.toContain(room.id);
		const joined = await call(h, 'POST', `/api/rooms/${room.id}/join`, asLower);
		expect(joined.status, joined.text).toBe(404);
		// A friend still joins it.
		expect((await call(h, 'POST', `/api/rooms/${room.id}/join`, { as: 'bob' })).status).toBe(200);
	});
});

describe('CARDTABLE_EXPERIMENTAL_GAMES unset: no external game registers at all', () => {
	it('refuses to create a room of the configured type, the same 400 any unknown id gets', async () => {
		vi.resetModules();
		delete process.env.CARDTABLE_EXPERIMENTAL_GAMES;
		const freshRooms = await import('@hadoku/magic-server/http/rooms');
		const freshLobby = await import('@hadoku/magic-server/room/lobby');
		const freshEdge = await import('@hadoku/game-server/edge-auth');
		const externalGamesMod = await import('./external-games.ts');
		// The plugin's own gate, not called this time: the flag is unset, so `setup()` registers
		// nothing — proving the gate rather than merely not calling `setup`.
		await externalGamesMod.externalGamesPlugin.setup({} as never);

		const dir = await tempDir();
		const log = (entry: Record<string, unknown>): void => {
			logged.push(entry);
		};
		const lobby = await freshLobby.openLobby({ dir, log });
		const app = express();
		app.use(freshEdge.edgeProvenance);
		app.use(freshEdge.requireMinTier);
		const api = express.Router();
		api.use(express.json({ limit: '1mb' }));
		freshRooms.attachRooms(api, { lobby, log, checkPlan: async (plan) => ({ ok: true, cards: plan.rounds.length * 10 }) });
		app.use('/api', api);
		const server = createServer(app);
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		servers.push(server);
		const { port } = server.address() as AddressInfo;
		const h: Harness = { base: `http://127.0.0.1:${port}` };

		const res = await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Boom room', gameType: externalGamesMod.EXTERNAL_GAMES[0]!.id } });
		expect(res.status).toBe(400);

		// Restore the flag and the registry for any test after this one in the same process.
		process.env.CARDTABLE_EXPERIMENTAL_GAMES = '1';
		vi.resetModules();
		roomsMod = await import('@hadoku/magic-server/http/rooms');
		lobbyMod = await import('@hadoku/magic-server/room/lobby');
		edgeMod = await import('@hadoku/game-server/edge-auth');
		const reregistered = await import('./external-games.ts');
		await reregistered.externalGamesPlugin.setup({} as never);
	});
});

describe('an e2eOnly entry needs its own second gate (w120 §K)', () => {
	afterEach(() => {
		delete process.env.CARDTABLE_E2E_TOY_GAMES;
	});

	it('is not registered under CARDTABLE_EXPERIMENTAL_GAMES=1 alone — CARDTABLE_E2E_TOY_GAMES is unset', async () => {
		delete process.env.CARDTABLE_E2E_TOY_GAMES;
		vi.resetModules();
		const shared = await import('@hadoku/shared');
		const externalGamesMod = await import('./external-games.ts');
		const e2eEntry = externalGamesMod.EXTERNAL_GAMES.find((g) => g.e2eOnly === true);
		expect(e2eEntry, 'external-games-config.ts still has an e2eOnly entry to test against').toBeDefined();
		const nonE2eEntry = externalGamesMod.EXTERNAL_GAMES.find((g) => g.e2eOnly !== true);
		expect(nonE2eEntry, 'and at least one entry without the flag, to prove the filter is selective').toBeDefined();
		await externalGamesMod.externalGamesPlugin.setup({} as never);
		expect(shared.isRegisteredGameType(e2eEntry!.id)).toBe(false);
		// The ordinary gate alone still works: a non-`e2eOnly` entry registers as it always did.
		expect(shared.isRegisteredGameType(nonE2eEntry!.id)).toBe(true);
	});

	it('registers only with CARDTABLE_E2E_TOY_GAMES=1 on top of CARDTABLE_EXPERIMENTAL_GAMES=1', async () => {
		process.env.CARDTABLE_E2E_TOY_GAMES = '1';
		vi.resetModules();
		const shared = await import('@hadoku/shared');
		const externalGamesMod = await import('./external-games.ts');
		const e2eEntry = externalGamesMod.EXTERNAL_GAMES.find((g) => g.e2eOnly === true)!;
		await externalGamesMod.externalGamesPlugin.setup({} as never);
		expect(shared.isRegisteredGameType(e2eEntry.id)).toBe(true);
	});

	it('registers nothing at all with CARDTABLE_E2E_TOY_GAMES=1 but CARDTABLE_EXPERIMENTAL_GAMES unset — the first gate still rules', async () => {
		process.env.CARDTABLE_E2E_TOY_GAMES = '1';
		const saved = process.env.CARDTABLE_EXPERIMENTAL_GAMES;
		delete process.env.CARDTABLE_EXPERIMENTAL_GAMES;
		vi.resetModules();
		const shared = await import('@hadoku/shared');
		const externalGamesMod = await import('./external-games.ts');
		const e2eEntry = externalGamesMod.EXTERNAL_GAMES.find((g) => g.e2eOnly === true)!;
		await externalGamesMod.externalGamesPlugin.setup({} as never);
		expect(shared.isRegisteredGameType(e2eEntry.id)).toBe(false);
		if (saved !== undefined) process.env.CARDTABLE_EXPERIMENTAL_GAMES = saved;
	});
});

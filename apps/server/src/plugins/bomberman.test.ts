/**
 * Bomberman as a cardtable room type, end to end through a REAL express app — the same shape
 * `apps/server/src/http/rooms.test.ts` proves Magic's two types with (that file is not this
 * lane's to edit, so this one builds its own small harness rather than importing its helpers).
 *
 * Covers the wave's own ask: create, join, auto-seat and a restart round-trip through the room
 * codec, through the real HTTP routes — plus the one thing `registerGameType` buys a game type
 * for free at CREATE, `@hadoku/shared`'s open `gameTypeField` (`room-requests.ts`). `PATCH
 * gameType` stays Magic's own closed pair (`patchGameTypeField`, the same file): converting a
 * LIVE room is not this wave's question (`room/lobby.ts`'s `setGameType` was never built for a
 * table-seated room becoming a pod-seated one), so a leader cannot turn a constructed-1v1 room
 * into bomberman mid-game.
 */

import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const EDGE_SECRET = 'test-edge-auth-secret';

let roomsMod: typeof import('../http/rooms.ts');
let lobbyMod: typeof import('../room/lobby.ts');
let edgeMod: typeof import('../edge-auth.ts');
let BOMBERMAN_GAME_TYPE: string;

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	roomsMod = await import('../http/rooms.ts');
	lobbyMod = await import('../room/lobby.ts');
	edgeMod = await import('../edge-auth.ts');
	// `bomberman.ts` imported fresh, in the SAME `resetModules` graph as the above: a module
	// imported before `resetModules` (a static top-level import) would register into a `@hadoku/shared`
	// instance `rooms.ts`'s own import of it never sees, and every create would read back
	// "not a registered game type" — the registry is a plain module-level `Map`, one per graph.
	const bombermanMod = await import('./bomberman.ts');
	BOMBERMAN_GAME_TYPE = bombermanMod.BOMBERMAN_GAME_TYPE;
	// What the plugin's own `setup` does at boot — called directly, since this
	// harness never runs the kernel's boot sequence.
	await bombermanMod.bombermanPlugin.setup({} as never);
});

const dirs: string[] = [];
const servers: HttpServer[] = [];
let logged: Record<string, unknown>[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-bomberman-test-'));
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

describe('bomberman is a registered game type', () => {
	it('creates, is joined, auto-seats through its OWN pod (not the 2-seat table), and reports its own series length', async () => {
		const h = await openApp(await tempDir());
		const created = (
			await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Boom room', gameType: BOMBERMAN_GAME_TYPE } })
		).json() as import('../room/lobby.ts').RoomView;
		expect(created.gameType).toBe('bomberman');
		// `seats.max` (10) is above 2, so `room/pods.ts`'s `usesPod` routes this room through
		// `podSeats`/`game.pod`, never the Magic table's hard-two `tables[0].players`.
		expect(created.game.pod?.seats.map((s) => s?.memberId ?? null)[0]).toBe(created.creator);
		expect(created.tables[0]?.players).toEqual([]);
		// The registered spec's own series length (`series.ts`'s `seriesFormatOf`), not
		// Magic's `CONSTRUCTED` default — this is the one thing a registered `GameTypeSpec`
		// already wires generically, with no bomberman-specific code in `lobby.ts`.
		expect(created.tables[0]?.series.length).toBe(1);

		const joined = (await call(h, 'POST', `/api/rooms/${created.id}/join`, { as: 'bob' })).json() as import('../room/lobby.ts').RoomView;
		expect(joined.members.map((m) => m.id)).toEqual([created.creator, joined.members[1]!.id]);
		expect(joined.game.pod?.seats.filter((s) => s !== null)).toHaveLength(2);

		// A THIRD member still gets a seat — the load-bearing difference from a Magic 1v1
		// table, which would make them a spectator at exactly this point.
		const third = (await call(h, 'POST', `/api/rooms/${created.id}/join`, { as: 'carol' })).json() as import('../room/lobby.ts').RoomView;
		expect(third.members).toHaveLength(3);
		expect(third.game.pod?.seats.filter((s) => s !== null)).toHaveLength(3);
	});

	it('refuses a constructed room\'s mode on a bomberman room, at creation', async () => {
		const h = await openApp(await tempDir());
		const res = await call(h, 'POST', '/api/rooms', {
			body: { name: 'Boom room', gameType: BOMBERMAN_GAME_TYPE, mode: 'classic' },
		});
		expect(res.status).toBe(400);
		expect(res.json()).toEqual({ error: 'only a constructed room has a mode' });
	});

	it('survives a restart instead of being quarantined', async () => {
		const dir = await tempDir();
		const h = await openApp(dir);
		const created = (
			await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Boom room', gameType: BOMBERMAN_GAME_TYPE } })
		).json() as import('../room/lobby.ts').RoomView;

		// A fresh `openLobby` on the SAME dir — `index.ts`'s own restart. Would quarantine
		// (`room-quarantined` in `logged`) if `seats.max` allocated a `podSeats` array shorter
		// than `POD_SEATS` (`room/pods.ts`'s `initialPodSize`/`isStoredPodSeats` — see this
		// plugin's own doc comment); 10 does not.
		const second = await openApp(dir);
		const reread = await call(second, 'GET', `/api/rooms/${created.id}`, { as: 'bob' });
		expect(reread.status).toBe(200);
		expect((reread.json() as { gameType: string }).gameType).toBe('bomberman');
		expect(logged.some((l) => l.event === 'room-quarantined')).toBe(false);
	});

	it(
		// Found, not assumed (`lobby.ts:2635`'s own `if (room.gameType !== 'draft') return { ok: false, reason: 'not-draft' };`
		// inside `startDraft`, the one function `POST /:id/start` calls): a bomberman room has no
		// tournament pod and is not a draft, so the explicit Start route refuses it today. Pinned here
		// as the exact, current behaviour rather than left to be discovered by a UI that calls it —
		// see this lane's closing note for what a generic "a bomberman room is under way" signal needs.
		'cannot be started through POST /:id/start yet (lobby.ts:2635 refuses any non-draft, non-tournament type)',
		async () => {
			const h = await openApp(await tempDir());
			const created = (
				await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Boom room', gameType: BOMBERMAN_GAME_TYPE } })
			).json() as import('../room/lobby.ts').RoomView;
			await call(h, 'POST', `/api/rooms/${created.id}/join`, { as: 'bob' });
			const res = await call(h, 'POST', `/api/rooms/${created.id}/start`, { as: 'alice' });
			expect(res.status).toBe(409);
			expect(res.json()).toEqual({ error: 'this room is not playing a draft' });
		},
	);

	it('creating a bomberman room works, but PATCHing a live constructed-1v1 room into bomberman is refused — converting is not creating', async () => {
		const h = await openApp(await tempDir());

		// Create still takes any registered type, bomberman included.
		const made = await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Boom room', gameType: BOMBERMAN_GAME_TYPE } });
		expect(made.status).toBe(201);
		expect((made.json() as { gameType: string }).gameType).toBe('bomberman');

		// A plain constructed room, PATCHed toward bomberman: refused at the body, same 400 and
		// same message a wholly unknown id always got — the room never sees the attempt.
		const constructed = (await call(h, 'POST', '/api/rooms', { as: 'alice', body: { name: 'Friday night' } })).json() as import('../room/lobby.ts').RoomView;
		const patch = await call(h, 'PATCH', `/api/rooms/${constructed.id}`, { as: 'alice', body: { gameType: BOMBERMAN_GAME_TYPE } });
		expect(patch.status).toBe(400);
		expect(patch.json()).toEqual({ error: 'gameType must be one of: constructed-1v1, draft' });
		const reread = await call(h, 'GET', `/api/rooms/${constructed.id}`, { as: 'alice' });
		expect((reread.json() as { gameType: string }).gameType).toBe('constructed-1v1');
	});
});

/**
 * Every 400 a `/api/rooms` body can earn, pinned word for word: the room
 * screen shows `error` as it arrives, so a refusal's text is part of the
 * route's contract. The room id is well formed and names no room, because a
 * body is read before the room is looked up.
 */

import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const EDGE_SECRET = 'test-edge-auth-secret';
const ROOM = '/api/rooms/r-000000000000';

let base = '';
let dir = '';
let server: HttpServer;

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	const roomsMod = await import('./rooms.ts');
	const lobbyMod = await import('../room/lobby.ts');
	const edgeMod = await import('../edge-auth.ts');
	dir = await mkdtemp(join(tmpdir(), 'cardtable-rooms-bodies-'));
	const lobby = await lobbyMod.openLobby({ dir, log: () => undefined });
	const app = express();
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	const api = express.Router();
	api.use(express.json({ limit: '1mb' }));
	roomsMod.attachRooms(api, { lobby, log: () => undefined, checkPlan: async () => ({ ok: true, cards: 0 }) });
	app.use('/api', api);
	server = createServer(app);
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((done) => server.close(() => done()));
	await rm(dir, { recursive: true, force: true });
});

const CASES: [method: string, path: string, body: unknown, error: string][] = [
	['POST', '/api/rooms', [], 'body must be a JSON object'],
	['POST', '/api/rooms', { name: 'a', extra: 1, more: 2 }, 'unknown field(s): extra, more'],
	['POST', '/api/rooms', { name: 5, extra: 1 }, 'unknown field(s): extra'],
	['POST', '/api/rooms', {}, 'name must be a string'],
	['POST', '/api/rooms', { name: 5 }, 'name must be a string'],
	['POST', '/api/rooms', { name: '   ' }, 'name must be 1–60 characters'],
	['POST', '/api/rooms', { name: 'a'.repeat(61) }, 'name must be 1–60 characters'],
	['POST', '/api/rooms', { name: 'a\u0001b' }, 'name must not contain control characters'],
	['POST', '/api/rooms', { name: 'a\u007f' }, 'name must not contain control characters'],
	['POST', '/api/rooms', { name: '', gameType: 'chess' }, 'name must be 1–60 characters'],
	['POST', '/api/rooms', { name: 'a', gameType: 'chess' }, 'gameType must be one of: constructed-1v1, draft'],
	['POST', '/api/rooms', { name: 'a', gameType: null }, 'gameType must be one of: constructed-1v1, draft'],
	['POST', '/api/rooms', { name: 'a', clientMode: 'x' }, 'clientMode must be one of: builtin, streamed'],
	['POST', '/api/rooms', { name: 'a', gameType: 'chess', clientMode: 'x' }, 'gameType must be one of: constructed-1v1, draft'],
	['POST', '/api/rooms', { name: 'a', password: 5 }, 'password must be a string'],
	['POST', '/api/rooms', { name: 'a', password: 'p'.repeat(201) }, 'password must be at most 200 characters'],
	['POST', '/api/rooms', { name: 'a', gameType: 'draft', mode: 'classic' }, 'only a constructed room has a mode'],
	['POST', '/api/rooms', { name: 'a', gameType: 'draft', modeOptions: {} }, 'only a constructed room has a mode'],
	['POST', '/api/rooms', { name: 'a', mode: 'nope' }, 'mode must be one of: classic, gauntlet, random'],
	['POST', '/api/rooms', { name: 'a', modeOptions: {} }, 'mode must be one of: classic, gauntlet, random'],
	['POST', '/api/rooms', { name: 'a', mode: 'classic', modeOptions: { x: 1 } }, "modeOptions are not classic's options"],
	['POST', '/api/rooms', { name: 'a', mode: 'random' }, "modeOptions are not random's options"],
	['POST', '/api/rooms', { name: 'a', password: 5, mode: 'nope' }, 'password must be a string'],
	['POST', '/api/rooms/watchparty', [], 'body must be a JSON object'],
	['POST', '/api/rooms/watchparty', {}, 'room must be 1–200 characters'],
	['POST', '/api/rooms/watchparty', { room: '' }, 'room must be 1–200 characters'],
	['POST', '/api/rooms/watchparty', { room: 5 }, 'room must be 1–200 characters'],
	['POST', '/api/rooms/watchparty', { room: 'x'.repeat(201) }, 'room must be 1–200 characters'],
	['POST', '/api/rooms/watchparty', { room: 'a\u0000' }, 'room must not contain control characters'],
	['POST', '/api/rooms/watchparty', { room: 'a', x: 1 }, 'unknown field(s): x'],
	['POST', `${ROOM}/join`, [], 'body must be a JSON object'],
	['POST', `${ROOM}/join`, { x: 1 }, 'unknown field(s): x'],
	['POST', `${ROOM}/join`, { password: 5 }, 'password must be a string'],
	['POST', `${ROOM}/join`, { password: 'p'.repeat(201) }, 'password must be at most 200 characters'],
	['POST', `${ROOM}/ready`, [], 'body must be a JSON object'],
	['POST', `${ROOM}/ready`, {}, 'ready must be a boolean'],
	['POST', `${ROOM}/ready`, { ready: 'yes' }, 'ready must be a boolean'],
	['POST', `${ROOM}/ready`, { ready: null }, 'ready must be a boolean'],
	['POST', `${ROOM}/ready`, { x: 1 }, 'unknown field(s): x'],
	['POST', `${ROOM}/ready`, { ready: 1, x: 1, y: 2 }, 'unknown field(s): x, y'],
	['POST', `${ROOM}/identity`, [], 'body must be a JSON object'],
	['POST', `${ROOM}/identity`, {}, 'avatarId must be a string or null'],
	['POST', `${ROOM}/identity`, { avatarId: 5 }, 'avatarId must be a string or null'],
	['POST', `${ROOM}/identity`, { avatarId: '  ' }, 'avatarId must be 1–32 characters, or null to clear it'],
	['POST', `${ROOM}/identity`, { avatarId: 'a'.repeat(33) }, 'avatarId must be 1–32 characters, or null to clear it'],
	['POST', `${ROOM}/identity`, { avatarId: 'a', name: 'x' }, 'unknown field(s): name'],
	['POST', `${ROOM}/leave`, [], 'body must be a JSON object'],
	['POST', `${ROOM}/leave`, { x: 1 }, 'unknown field(s): x'],
	['POST', `${ROOM}/start`, { x: 1, y: 2 }, 'unknown field(s): x, y'],
	['POST', `${ROOM}/close`, [], 'body must be a JSON object'],
	['POST', `${ROOM}/close`, { x: 1 }, 'unknown field(s): x'],
	['POST', `${ROOM}/pod/stand`, { x: 1 }, 'unknown field(s): x'],
	['POST', `${ROOM}/pod/play`, { x: 1 }, 'unknown field(s): x'],
	['POST', `${ROOM}/pod/sit`, [], 'body must be a JSON object'],
	['POST', `${ROOM}/pod/sit`, { x: 1 }, 'unknown field(s): x'],
	['POST', `${ROOM}/pod/sit`, { seat: -1 }, 'seat must be an integer 0..7'],
	['POST', `${ROOM}/pod/sit`, { seat: 1.5 }, 'seat must be an integer 0..7'],
	['POST', `${ROOM}/pod/sit`, { seat: '0' }, 'seat must be an integer 0..7'],
	['POST', `${ROOM}/pod/sit`, { seat: 8 }, 'seat must be an integer 0..7'],
	['POST', `${ROOM}/pod/ai`, [], 'body must be a JSON object'],
	['POST', `${ROOM}/pod/ai`, { seat: 0, on: true, x: 1 }, 'unknown field(s): x'],
	['POST', `${ROOM}/pod/ai`, { on: true }, 'seat must be an integer 0..7'],
	['POST', `${ROOM}/pod/ai`, { seat: 8, on: true }, 'seat must be an integer 0..7'],
	['POST', `${ROOM}/pod/ai`, { seat: 0 }, 'on must be true or false'],
	['POST', `${ROOM}/pod/ai`, { seat: 0, on: 'yes' }, 'on must be true or false'],
	['POST', `${ROOM}/pod/close`, [], 'body must be a JSON object'],
	['POST', `${ROOM}/pod/close`, { seat: 0, closed: true, x: 1 }, 'unknown field(s): x'],
	['POST', `${ROOM}/pod/close`, { closed: true }, 'seat must be an integer 0..7'],
	['POST', `${ROOM}/pod/close`, { seat: 0 }, 'closed must be true or false'],
	['PUT', `${ROOM}/pod/plan`, {}, 'body is { plan: { rounds: [source, source, source] } }'],
	['PUT', `${ROOM}/pod/plan`, { plan: { rounds: [{ kind: 'set', code: 'abc' }, { kind: 'set', code: 'abc' }, { kind: 'set', code: 'abc' }] } }, 'body is { plan: { rounds: [source, source, source] } }'],
	['PATCH', ROOM, [], 'body must be a JSON object'],
	['PATCH', ROOM, {}, 'gameType must be one of: constructed-1v1, draft'],
	['PATCH', ROOM, { x: 1 }, 'unknown field(s): x'],
	['PATCH', ROOM, { clientMode: 'streamed' }, 'unknown field(s): clientMode'],
	['PATCH', ROOM, { gameType: 'chess' }, 'gameType must be one of: constructed-1v1, draft'],
	['PATCH', ROOM, { gameType: 'draft', format: 'x' }, 'patch one field at a time: gameType, format, settings or mode'],
	['PATCH', ROOM, { settings: { handSmoothing: true }, mode: 'classic' }, 'patch one field at a time: gameType, format, settings or mode'],
	['PATCH', ROOM, { format: '' }, 'format must be a format id'],
	['PATCH', ROOM, { format: '  ' }, 'format must be a format id'],
	['PATCH', ROOM, { format: 5 }, 'format must be a format id'],
	['PATCH', ROOM, { format: 'draft:abc' }, 'format must be a format id: a drafted deck is played on Free pick'],
	['PATCH', ROOM, { settings: 5 }, 'settings must be an object'],
	['PATCH', ROOM, { settings: [] }, 'settings must be an object'],
	['PATCH', ROOM, { settings: {} }, 'settings names no setting'],
	['PATCH', ROOM, { settings: { nope: true, also: 1 } }, 'unknown setting(s): nope, also'],
	['PATCH', ROOM, { settings: { handSmoothing: 'yes' } }, 'settings.handSmoothing must be a boolean'],
	['PATCH', ROOM, { settings: { clock: true } }, 'settings.clock must be one of: auto, on, off'],
	['PATCH', ROOM, { settings: { pickTimer: true } }, 'settings.pickTimer must be { on: boolean, speed: 0.25–4 }'],
	['PATCH', ROOM, { settings: { pickTimer: { on: true, speed: 10 } } }, 'settings.pickTimer must be { on: boolean, speed: 0.25–4 }'],
	['PATCH', ROOM, { settings: { pickTimer: { on: true } } }, 'settings.pickTimer must be { on: boolean, speed: 0.25–4 }'],
	['PATCH', ROOM, { mode: 'nope' }, 'mode must be one of: classic, gauntlet, random'],
	['PATCH', ROOM, { modeOptions: { pool: 'full' } }, 'mode must be one of: classic, gauntlet, random'],
	['PATCH', ROOM, { mode: 'gauntlet', modeOptions: { pool: 'full' } }, "modeOptions are not gauntlet's options"],
	['PATCH', ROOM, { mode: 'random', modeOptions: { pool: 'nope' } }, "modeOptions are not random's options"],
];

describe('/api/rooms bodies', () => {
	it.each(CASES)('%s %s %j is a 400: %s', async (method, path, body, error) => {
		const res = await fetch(`${base}${path}`, {
			method,
			headers: {
				'x-edge-auth': EDGE_SECRET,
				'x-hadoku-tier': 'friend',
				'x-user-id': 'user-alice',
				'x-user-name': 'alice',
				'x-user-key': 'friend-key-alice',
				'content-type': 'application/json',
			},
			body: JSON.stringify(body),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error });
	});
});

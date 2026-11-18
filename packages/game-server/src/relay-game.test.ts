/**
 * `startRelayGame`, booted for real: a toy relay game on a free port with its own temp dirs,
 * driven over HTTP the way a page drives it. What a game gets from the kit and no code of its own.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as ioClient } from 'socket.io-client';

import { startRelayGame, type RelayGameState } from './relay-game.ts';
import type { GameServer } from '@hadoku/service-kernel/server';

let root: string;
let server: GameServer<Record<string, never>, RelayGameState>;
let base: string;

const asMember = (user: string) => ({ 'x-hadoku-tier': 'friend', 'x-user-id': user, 'content-type': 'application/json' });

async function call(method: string, path: string, user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', body?: unknown): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
	const res = await fetch(`${base}${path}`, { method, headers: asMember(user), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	const text = await res.text();
	let json: Record<string, unknown> = {};
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		// Not every answer is JSON (the page, a static file).
	}
	return { status: res.status, json, text };
}

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), 'relay-game-'));
	const web = join(root, 'web');
	mkdirSync(web, { recursive: true });
	writeFileSync(join(web, 'index.html'), '<!doctype html><script type="module" src="/toy/assets/app.js"></script>');
	const game = join(root, 'game');
	mkdirSync(game, { recursive: true });
	writeFileSync(join(game, 'index.html'), 'the game');
	server = await startRelayGame({
		id: 'toy',
		name: 'Toy',
		envPrefix: 'TOYRELAY',
		root,
		repoRoot: root,
		defaults: { BASE_PREFIX: '/toy', WEB_DIR: 'web', ROOMS_DIR: 'rooms', LOG_DIR: 'logs', INSECURE_NO_EDGE_AUTH: '1', MIN_TIER: 'friend' },
		participantDomain: 'hadoku.toy-relay.participant.test',
		gameType: 'toy',
		roomIdRe: /^r-[0-9a-f]{12}$/,
		seats: { seats: 2, max: 4, relaySeats: 4 },
		statics: [
			{ path: '/game', dir: game, missing: 'no game', health: { field: 'game', problem: 'no game bundle' } },
			{ path: '/extra', dir: join(root, 'nowhere'), missing: 'not built yet' },
		],
		results: {
			toReport: (raw, ctx) =>
				raw === 'bad'
					? { ok: false, reason: 'bad-result' }
					: { ok: true, report: { matchId: ctx.matchId, roomId: ctx.roomId, endedAt: ctx.endedAt, attrs: {}, counters: {}, seats: [] } },
		},
		kernel: { port: 0, signals: false, handover: null, exit: () => {} },
	});
	base = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await server.shutdown('test');
	rmSync(root, { recursive: true, force: true });
});

describe('startRelayGame', () => {
	it('answers /health with the game’s own fields, and serves the page and its static directories', async () => {
		const health = await call('GET', '/health');
		expect(health.status).toBe(200);
		expect(health.json).toMatchObject({ status: 'ok', service: 'toy', game: 'built', rooms: 0 });
		expect((await call('GET', '/game/')).text).toBe('the game');
		expect(await call('GET', '/extra/x')).toMatchObject({ status: 503, text: 'not built yet' });
		expect((await call('GET', '/some/client/route')).text).toContain('/toy/assets/app.js');
	});

	it('makes rooms with marked seats that keep one open, and names each bot', async () => {
		const made = await call('POST', '/api/rooms', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { name: 'Toy night', gameType: 'toy' });
		expect(made.status).toBe(201);
		const id = made.json.id as string;
		expect(made.json.seats).toHaveLength(2);
		const bot = await call('POST', `/api/rooms/${id}/seats/bot`, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { seat: 1 });
		expect(bot.status).toBe(200);
		// Every seat taken: a third opens by itself.
		expect(bot.json.seats).toEqual([made.json.you && (made.json.you as { id: string }).id, 'ai', null]);
		const persona = (bot.json.aiSeats as ({ name: string } | null)[])[1];
		expect(typeof persona?.name).toBe('string');
		const off = await call('POST', `/api/rooms/${id}/seats/bot-off`, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { seat: 1 });
		expect(off.json.seats).toHaveLength(2);
		expect((await call('GET', '/health')).json.rooms).toBe(1);
	});

	it('a Start answers the room with the pending countdown; a non-member is told no such room', async () => {
		const made = await call('POST', '/api/rooms', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { name: 'Start', gameType: 'toy' });
		const id = made.json.id as string;
		expect((await call('POST', `/api/rooms/${id}/start`, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', {})).status).toBe(404);
		const started = await call('POST', `/api/rooms/${id}/start`, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', {});
		expect(started.status).toBe(200);
		expect(started.json.start).toMatchObject({ hostId: (made.json.you as { id: string }).id });
		expect((started.json.start as { startsInMs: number }).startsInMs).toBeGreaterThan(0);
	});

	it('a Start pings the room’s watchers: a pending start is no lobby write, so nothing else would', async () => {
		const made = await call('POST', '/api/rooms', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', { name: 'Feed', gameType: 'toy' });
		const id = made.json.id as string;
		const socket = ioClient(base, { transports: ['websocket'], reconnection: false, forceNew: true, extraHeaders: asMember('cccccccc-cccc-4ccc-8ccc-cccccccccccc') });
		try {
			const heard: unknown[] = [];
			socket.on('room-feed:changed', (m: unknown) => heard.push(m));
			await new Promise<void>((resolve, reject) => {
				socket.on('connect', () => resolve());
				socket.on('connect_error', reject);
			});
			await socket.timeout(3000).emitWithAck('room-feed:watch', { rooms: [id], list: false });
			heard.length = 0;
			expect((await call('POST', `/api/rooms/${id}/start`, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', {})).status).toBe(200);
			await expect.poll(() => heard, { timeout: 3000 }).toContainEqual({ room: id });
		} finally {
			socket.close();
		}
	});

	it('takes a seated player’s round result, and refuses one without its round id', async () => {
		const made = await call('POST', '/api/rooms', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', { name: 'Results', gameType: 'toy' });
		const id = made.json.id as string;
		expect((await call('POST', `/api/rooms/${id}/result`, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', { result: {} })).status).toBe(400);
		expect((await call('POST', `/api/rooms/${id}/result`, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', { matchId: 'm-round-0001', result: 'bad' })).status).toBe(400);
		expect((await call('POST', `/api/rooms/${id}/result`, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', { matchId: 'm-round-0002', result: {} })).status).toBe(200);
	});

	it('refuses a caller below the floor', async () => {
		const res = await fetch(`${base}/api/rooms`, { headers: { 'x-hadoku-tier': 'public' } });
		expect(res.status).toBe(404);
	});
});

/**
 * `startRelayGame({ settings })`, booted for real: a relay game that declares bomberman's settings,
 * driven over HTTP the way its page drives them — in every room body, the leader's to PATCH, a
 * `LIVE` field refused from a Start's countdown on, and kept across a restart.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIVE, choice, defineRoomSettings, toggle } from '@hadoku/platform-wire/room-settings';
import type { GameServer } from '@hadoku/service-kernel/server';

import { startRelayGame, type RelayGameState } from './relay-game.ts';

const SETTINGS = defineRoomSettings({
	mode: choice(['classic', 'roguelike', 'sandbox'], 'classic', { label: 'Mode', lock: LIVE }),
	pickTimer: toggle(true, { label: 'Pick timer', lock: LIVE }),
	music: toggle(false, { label: 'Music' }),
});

const LEADER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let root: string;
let server: GameServer<Record<string, never>, RelayGameState>;
let base: string;

async function boot(): Promise<void> {
	server = await startRelayGame({
		id: 'toyset',
		name: 'Toy settings',
		envPrefix: 'TOYSETTINGS',
		root,
		repoRoot: root,
		defaults: { BASE_PREFIX: '/toyset', WEB_DIR: 'web', ROOMS_DIR: 'rooms', LOG_DIR: 'logs', INSECURE_NO_EDGE_AUTH: '1', MIN_TIER: 'friend' },
		participantDomain: 'hadoku.toy-settings.participant.test',
		gameType: 'toyset',
		roomIdRe: /^r-[0-9a-f]{12}$/,
		seats: { seats: 2, max: 4, relaySeats: 4 },
		settings: SETTINGS,
		// Long enough that a Start is still counting down for the rest of its test.
		countdownMs: 60_000,
		kernel: { port: 0, signals: false, handover: null, exit: () => {} },
	});
	base = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
}

async function call(method: string, path: string, user: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await fetch(`${base}${path}`, {
		method,
		headers: { 'x-hadoku-tier': 'friend', 'x-user-id': user, 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function room(): Promise<string> {
	const made = await call('POST', '/api/rooms', LEADER, { name: 'Settings', gameType: 'toyset' });
	expect(made.status).toBe(201);
	const id = made.json.id as string;
	expect((await call('POST', `/api/rooms/${id}/join`, OTHER, {})).status).toBe(200);
	return id;
}

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), 'relay-game-settings-'));
	mkdirSync(join(root, 'web'), { recursive: true });
	writeFileSync(join(root, 'web', 'index.html'), '<!doctype html>');
	await boot();
});

afterAll(async () => {
	await server.shutdown('test');
	rmSync(root, { recursive: true, force: true });
});

describe('a relay game’s settings', () => {
	it('every room body carries them, at their defaults in a new room', async () => {
		const id = await room();
		expect((await call('GET', `/api/rooms/${id}`, OTHER)).json.settings).toEqual({ mode: 'classic', pickTimer: true, music: false });
	});

	it('the leader changes them; anyone else is refused', async () => {
		const id = await room();
		const changed = await call('PATCH', `/api/rooms/${id}`, LEADER, { settings: { mode: 'roguelike', pickTimer: false } });
		expect(changed.status).toBe(200);
		expect(changed.json.settings).toEqual({ mode: 'roguelike', pickTimer: false, music: false });
		expect(await call('PATCH', `/api/rooms/${id}`, OTHER, { settings: { mode: 'sandbox' } })).toEqual({ status: 403, json: { error: 'only the room leader can change the settings' } });
		expect((await call('GET', `/api/rooms/${id}`, OTHER)).json.settings).toMatchObject({ mode: 'roguelike' });
	});

	it.each([
		[{ settings: { mode: 'chess' } }, 'settings.mode must be one of: classic, roguelike, sandbox'],
		[{ settings: { pickTimer: 'on' } }, 'settings.pickTimer must be a boolean'],
		[{ settings: { lives: 3 } }, 'unknown setting(s): lives'],
		[{ settings: {} }, 'settings names no setting'],
		[{ settings: { mode: 'sandbox' }, gameType: 'toyset' }, 'patch one field at a time: gameType or settings'],
	])('a bad PATCH %j is refused, naming what is wrong', async (body, error) => {
		const id = await room();
		const refused = await call('PATCH', `/api/rooms/${id}`, LEADER, body);
		expect(refused.status).toBe(400);
		expect(refused.json.error).toBe(error);
	});

	it('from a Start on, a LIVE field cannot change; a field with no lock still can', async () => {
		const id = await room();
		expect((await call('POST', `/api/rooms/${id}/start`, LEADER, {})).status).toBe(200);
		expect(await call('PATCH', `/api/rooms/${id}`, LEADER, { settings: { mode: 'sandbox' } })).toEqual({
			status: 409,
			json: { error: 'a match is under way; the settings cannot change until it is over', reason: 'match-live' },
		});
		const music = await call('PATCH', `/api/rooms/${id}`, LEADER, { settings: { music: true } });
		expect(music.status).toBe(200);
		expect(music.json.settings).toEqual({ mode: 'classic', pickTimer: true, music: true });
	});

	it('a restart keeps them', async () => {
		const id = await room();
		expect((await call('PATCH', `/api/rooms/${id}`, LEADER, { settings: { mode: 'sandbox' } })).status).toBe(200);
		await server.shutdown('test');
		await boot();
		expect((await call('GET', `/api/rooms/${id}`, LEADER)).json.settings).toEqual({ mode: 'sandbox', pickTimer: true, music: false });
	});

	it('the gameType PATCH still answers as before', async () => {
		const id = await room();
		expect((await call('PATCH', `/api/rooms/${id}`, LEADER, { gameType: 'toyset' })).status).toBe(200);
	});
});

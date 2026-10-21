import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { GAUNTLET_DECKS, GauntletViewSchema, type GauntletPlayer, type GauntletView } from '@hadoku/shared';

import type { GauntletState } from '../room/gauntlet.ts';
import { GAUNTLET_AI_BEAT_MS, GAUNTLET_REVEAL_MS, attachGauntlet, type GauntletHandle, type GauntletRoom } from './gauntlet.ts';
import { loadTablesLibrary } from './library.ts';

// @reads decks/
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const library = loadTablesLibrary(REPO_ROOT);

interface Harness {
	url: string;
	room: GauntletRoom & { format: string };
	stored: () => GauntletState | null;
	/** Run every timer that is due, in order, as often as they re-arm. */
	flush: () => void;
	timers: { ms: number; fn: () => void }[];
	dealt: { decks: [string, string]; players: [GauntletPlayer, GauntletPlayer] }[];
	logs: Record<string, unknown>[];
	handle: GauntletHandle;
	server: Server;
}

let open: Harness | null = null;
afterEach(async () => {
	await new Promise<void>((done) => open?.server.close(() => done()) ?? done());
	open = null;
});

async function boot(seated: string[], modeOptions: unknown = { family: 'modern' }): Promise<Harness> {
	let gauntlet: GauntletState | null = null;
	const room: GauntletRoom & { format: string } = {
		id: 'r-1',
		gameType: 'constructed-1v1',
		mode: 'gauntlet',
		modeOptions,
		format: '2016-07-22',
		members: [
			{ id: 'alice', name: 'Alice' },
			{ id: 'bob', name: 'Bob' },
			{ id: 'carol', name: 'Carol' },
		],
		ai: { name: 'Sage' },
		tables: [{ id: 't-1', matchId: null }],
	};
	const timers: Harness['timers'] = [];
	const dealt: Harness['dealt'] = [];
	const logs: Record<string, unknown>[] = [];
	let n = 0;
	const tables = express.Router();
	const handle = attachGauntlet(tables, {
		rooms: {
			get: (id) => (id === room.id ? room : undefined),
			list: () => [room],
			gauntlet: () => gauntlet,
			setGauntlet: (_id, g, format) => {
				gauntlet = g;
				if (format !== undefined) room.format = format;
				return true;
			},
		},
		library,
		seated: () => seated.map((id) => ({ memberId: id, name: room.members.find((m) => m.id === id)!.name })),
		dealGame: (_room, decks, players) => dealt.push({ decks, players }),
		callerOf: (req) => String(req.headers['x-test-user']),
		// A fixed walk through [0, 1), so a run is the same every time.
		random: () => ((n = (n * 7 + 3) % 11), n / 11),
		log: (entry) => logs.push(entry),
		schedule: (fn, ms) => timers.push({ ms, fn }),
	});
	const app = express();
	app.use('/api/tables', tables);
	const server = createServer(app);
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	const flush = (): void => {
		while (timers.length > 0) timers.shift()!.fn();
	};
	open = {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tables`,
		room,
		stored: () => gauntlet,
		flush,
		timers,
		dealt,
		logs,
		handle,
		server,
	};
	return open;
}

async function call(h: Harness, user: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await fetch(`${h.url}${path}`, {
		method: body === undefined ? 'GET' : 'POST',
		headers: { 'x-test-user': user, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function view(h: Harness, user: string): Promise<GauntletView> {
	const res = await call(h, user, '/rooms/r-1/gauntlet');
	expect(res.status).toBe(200);
	return GauntletViewSchema.parse(res.body);
}

const ME = ['alice', 'bob'] as const;

describe('the Gauntlet routes', () => {
	it('offers only eras with ten decks', async () => {
		const h = await boot([]);
		const { body } = await call(h, 'alice', '/gauntlet/eras');
		const eras = body.eras as { id: string }[];
		expect(eras.length).toBeGreaterThan(0);
		const counts = new Map<string, number>();
		for (const d of library.decks) counts.set(d.era, (counts.get(d.era) ?? 0) + 1);
		expect(eras.every((e) => (counts.get(e.id) ?? 0) >= GAUNTLET_DECKS)).toBe(true);
		expect(eras.map((e) => e.id)).not.toContain('1998-07-01');
	});

	it('draws once both seats are ready, moves the room onto the era, and keeps the draw', async () => {
		const h = await boot([...ME]);
		expect((await call(h, 'alice', '/rooms/r-1/gauntlet/ready', { ready: true })).status).toBe(200);
		expect(h.stored()?.phase).toBe('options');
		await call(h, 'bob', '/rooms/r-1/gauntlet/ready', { ready: true });
		const v = await view(h, 'alice');
		expect(v.phase).toBe('reveal');
		expect(v.era?.family).toBe('modern');
		expect(h.room.format).toBe(v.era!.id);
		expect(v.decks).toHaveLength(GAUNTLET_DECKS);
		expect(v.decks.every((d) => d.main.length > 0 && d.name !== '')).toBe(true);
		// A reconnect reads the same draw.
		expect((await view(h, 'bob')).decks.map((d) => d.id)).toEqual(v.decks.map((d) => d.id));
		expect(h.timers.map((t) => t.ms)).toEqual([GAUNTLET_REVEAL_MS]);
		h.flush();
		expect((await view(h, 'alice')).phase).toBe('banpick');
	});

	it('refuses an act out of turn and a deck already taken', async () => {
		const h = await boot([...ME]);
		await call(h, 'alice', '/rooms/r-1/gauntlet/ready', { ready: true });
		await call(h, 'bob', '/rooms/r-1/gauntlet/ready', { ready: true });
		h.flush();
		const v = await view(h, 'alice');
		const p1 = ME[v.first!];
		const p2 = ME[1 - v.first!]!;
		const deck = v.decks[0]!.id;
		const early = await call(h, p2, '/rooms/r-1/gauntlet/act', { act: 'ban', deck });
		expect(early.status).toBe(409);
		expect(early.body.reason).toBe('not-your-turn');
		expect((await call(h, p1, '/rooms/r-1/gauntlet/act', { act: 'ban', deck })).status).toBe(200);
		const taken = await call(h, p2, '/rooms/r-1/gauntlet/act', { act: 'ban', deck });
		expect(taken.body.reason).toBe('taken');
		// A watcher plays no part.
		expect((await call(h, 'carol', '/rooms/r-1/gauntlet/act', { act: 'ban', deck: v.decks[1]!.id })).status).toBe(409);
	});

	it('vs the AI: the AI bans, picks and chooses a beat after its turn comes, and the game is dealt', async () => {
		const h = await boot(['alice']);
		await call(h, 'alice', '/rooms/r-1/gauntlet/ready', { ready: true, ai: true });
		h.flush();
		let v = await view(h, 'alice');
		expect(v.players).toEqual([
			{ memberId: 'alice', name: 'Alice' },
			{ memberId: null, name: 'Sage' },
		]);
		while (v.phase === 'banpick') {
			if (v.step!.seat === 1) {
				expect(h.timers.map((t) => t.ms)).toEqual([GAUNTLET_AI_BEAT_MS]);
				h.flush();
			} else {
				const deck = v.decks.find((d) => d.status === 'open')!.id;
				expect((await call(h, 'alice', '/rooms/r-1/gauntlet/act', { act: v.step!.act, deck })).status).toBe(200);
			}
			v = await view(h, 'alice');
		}
		h.flush();
		v = await view(h, 'alice');
		expect(v.phase).toBe('choose');
		expect(v.choice).toEqual({ mine: null, chosen: [false, true] });
		expect(v.decks.filter((d) => d.status === 'picked' && d.by === 1)).toHaveLength(3);
		const mine = v.decks.find((d) => d.status === 'picked' && d.by === 0)!.id;
		expect(h.handle.startRefusal(h.room)).not.toBeNull();
		await call(h, 'alice', '/rooms/r-1/gauntlet/choose', { deck: mine });
		v = await view(h, 'alice');
		expect(v.phase).toBe('playing');
		expect(h.dealt).toHaveLength(1);
		expect(h.dealt[0]!.decks[0]).toBe(mine);
		expect(h.handle.startRefusal(h.room)).toBeNull();
		expect(h.handle.aiDeck(h.room)).toBe(library.deck(h.dealt[0]!.decks[1])!.text);
		// The game ends without deciding the series: back to choosing, the played decks struck off.
		h.handle.afterGame('r-1', { seriesOver: false, winner: 1 });
		v = await view(h, 'alice');
		expect(v.phase).toBe('choose');
		expect(v.decks.filter((d) => d.played)).toHaveLength(2);
		const again = await call(h, 'alice', '/rooms/r-1/gauntlet/choose', { deck: mine });
		expect(again.body.reason).toBe('played');
	});

	it('hides a seat’s choice from the other seat and the room until both have chosen', async () => {
		const h = await boot([...ME]);
		await call(h, 'alice', '/rooms/r-1/gauntlet/ready', { ready: true });
		await call(h, 'bob', '/rooms/r-1/gauntlet/ready', { ready: true });
		h.flush();
		let v = await view(h, 'alice');
		while (v.phase === 'banpick') {
			const deck = v.decks.find((d) => d.status === 'open')!.id;
			await call(h, ME[v.step!.seat], '/rooms/r-1/gauntlet/act', { act: v.step!.act, deck });
			v = await view(h, 'alice');
		}
		const mine = v.decks.find((d) => d.by === 0 && d.status === 'picked')!.id;
		await call(h, 'alice', '/rooms/r-1/gauntlet/choose', { deck: mine });
		expect((await view(h, 'alice')).choice?.mine).toBe(mine);
		for (const other of ['bob', 'carol']) {
			const res = await call(h, other, '/rooms/r-1/gauntlet');
			expect(JSON.stringify(res.body)).not.toContain(`"mine":"${mine}"`);
			expect((res.body.choice as { chosen: boolean[] }).chosen).toEqual([true, false]);
		}
		expect(h.logs.filter((l) => l.evt === 'gauntlet-chose')).toEqual([{ evt: 'gauntlet-chose', room: 'r-1', seat: 0 }]);
		expect(h.dealt).toEqual([]);
	});

	it('answers a room that is not playing a Gauntlet with a refusal', async () => {
		const h = await boot([...ME]);
		h.room.mode = 'classic';
		expect((await call(h, 'alice', '/rooms/r-1/gauntlet')).status).toBe(409);
		expect(h.handle.startRefusal(h.room)).toBeNull();
		expect(h.handle.aiDeck(h.room)).toBeNull();
	});
});

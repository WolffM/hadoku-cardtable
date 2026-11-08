import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEdgeAuth, rankOf, tierOf } from '../auth/index.ts';
import { createGate } from '../http/index.ts';
import { createGameServer, type GamePlugin, type GameServer } from './index.ts';

/**
 * A fake two-plugin game, booted for real: a route, a socket, an erase step, the bus between
 * its plugins, and the shutdown that runs them backwards.
 */

const SEAL = 'test-seal';
const RESTART = 'fake-restarting';
const sealed = { 'x-edge-auth': SEAL, 'x-hadoku-tier': 'friend', 'x-user-id': 'u1' };

interface FakeEvents extends Record<string, unknown> {
	'scores-ready': { count: number };
}
interface FakeState {
	heard: string[];
	stopped: string[];
}

const scores: GamePlugin<FakeEvents, FakeState> = {
	name: 'scores',
	phase: 'stores',
	setup(ctx) {
		ctx.bus.on('scores-ready', ({ count }) => ctx.state.heard.push(`scores-ready ${count}`));
		ctx.bus.on('listening', () => ctx.state.heard.push('listening'));
		ctx.bus.on('shutdown', ({ deadlineMs }) => ctx.state.heard.push(`shutdown ${deadlineMs}`));
		ctx.api.get('/scores', (_req, res) => void res.json({ scores: [3, 1] }));
		ctx.gauge('tables', () => 2);
		ctx.busy(() => [{ id: 't1', kind: 'table', label: 'live' }]);
		return {
			erase: [{ what: 'scores', erase: (p) => (p.userId === 'u1' ? 2 : 0) }],
			shutdown: () => {
				ctx.state.stopped.push('scores');
				return { scoresKept: 2 };
			},
			onListen: () => ctx.state.heard.push('scores onListen'),
		};
	},
};

const lobby: GamePlugin<FakeEvents, FakeState> = {
	name: 'lobby',
	phase: 'routes',
	setup(ctx) {
		ctx.bus.emit('scores-ready', { count: 2 });
		ctx.app.get('/lobby', (_req, res) => void res.type('text').send('lobby'));
		ctx.sealed.get('/preview', (_req, res) => void res.type('text').send('preview'));
		return {
			shutdown: () => {
				ctx.state.stopped.push('lobby');
			},
		};
	},
};

let dir: string;
let server: GameServer<FakeEvents, FakeState>;
let base: string;
const lines: Array<Record<string, unknown>> = [];
const exit = vi.fn();

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'kernel-server-'));
	mkdirSync(join(dir, 'web'));
	writeFileSync(join(dir, 'web/index.html'), '<!doctype html><script src="/fake/assets/a.js"></script>');
	const edgeAuth = createEdgeAuth({ edgeAuthSecret: () => SEAL, allowUnverifiedEdge: () => false, devTier: () => 'friend' });
	const gate = createGate({ ...edgeAuth, tierOf, rankOf, reportSealRefused: () => undefined, minTier: () => 'friend' });
	server = await createGameServer<FakeEvents, FakeState>({
		id: 'fake',
		config: {
			host: '127.0.0.1',
			port: 0,
			log: (entry) => void lines.push(entry),
			edgeAuth,
			gate,
			basePrefix: '/fake',
			bundle: { indexHtml: join(dir, 'web/index.html'), webDir: join(dir, 'web'), embedEntries: [] },
			repoRoot: dir,
			restartEvent: RESTART,
			firstSeen: { file: join(dir, 'seen.json'), log: () => undefined },
			erase: { deriveParticipantId: (userId) => `fk:${userId}` },
			signals: false,
			exit,
		},
		state: { heard: [], stopped: [] },
		// Listed out of phase order: the phases, not the array, decide who runs first.
		plugins: [lobby, scores],
	});
	base = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
});

afterAll(() => {
	server.httpServer.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('createGameServer: a fake two-plugin game', () => {
	it('stamps every phase on the boot clock, in order', () => {
		expect(lines.filter((l) => l.evt === 'boot-phase').map((l) => l.phase)).toEqual(['config', 'bundle', 'stores', 'routes', 'sockets', 'listen', 'warm']);
	});

	it('lets a plugin hear what a later-phase plugin emitted, then the kernel listening, then its own onListen', () => {
		expect(server.state.heard).toEqual(['scores-ready 2', 'listening', 'scores onListen']);
	});

	it('serves /health ungated and its routes only above the floor', async () => {
		const health = await fetch(`${base}/health`);
		expect(health.status).toBe(200);
		expect(Object.keys((await health.json()) as Record<string, unknown>)).toEqual(['status', 'service', 'commit', 'commit_error', 'bundle', 'timestamp']);
		expect((await fetch(`${base}/api/scores`)).status).toBe(404);
		const scored = await fetch(`${base}/api/scores`, { headers: sealed });
		expect(await scored.json()).toEqual({ scores: [3, 1] });
		expect(await (await fetch(`${base}/lobby`, { headers: sealed })).text()).toBe('lobby');
		expect(await (await fetch(`${base}/health/busy`)).json()).toEqual({ busy: true, count: 1, runs: [{ id: 't1', kind: 'table', label: 'live' }] });
	});

	it("serves a sealed route to the edge at any tier, and nothing of it to a direct hit", async () => {
		expect(await (await fetch(`${base}/preview`, { headers: { 'x-edge-auth': SEAL, 'x-hadoku-tier': 'public' } })).text()).toBe('preview');
		expect((await fetch(`${base}/preview`)).status).toBe(404);
		expect((await fetch(`${base}/preview`, { headers: { 'x-edge-auth': 'wrong', 'x-hadoku-tier': 'admin' } })).status).toBe(404);
	});

	it("runs every plugin's erase step behind the edge's seal", async () => {
		expect((await fetch(`${base}/api/_account/erase`, { method: 'POST', headers: { 'x-user-id': 'u1' } })).status).toBe(401);
		const erased = await fetch(`${base}/api/_account/erase`, { method: 'POST', headers: sealed });
		expect(await erased.json()).toEqual({ erased: { callersSeen: 1, scores: 2 } });
	});

	it('takes a socket, tells it the restart event, and shuts down in reverse order within the deadline', async () => {
		const open = await (await fetch(`${base}/socket.io/?EIO=4&transport=polling`, { headers: sealed })).text();
		const { sid } = JSON.parse(open.slice(1)) as { sid: string };
		const poll = `${base}/socket.io/?EIO=4&transport=polling&sid=${sid}`;
		await fetch(poll, { method: 'POST', headers: sealed, body: '40' });
		expect(await (await fetch(poll, { headers: sealed })).text()).toMatch(/^40\{"sid":/);
		expect(server.io.engine.clientsCount).toBe(1);

		const notice = fetch(poll, { headers: sealed }).then((r) => r.text());
		const why = await server.shutdown('SIGTERM');
		expect(await notice).toContain(`42["${RESTART}"]`);
		expect(why).toBe('closed');
		expect(server.state.stopped).toEqual(['lobby', 'scores']);
		expect(server.state.heard.at(-1)).toBe('shutdown 1300');
		expect(exit).toHaveBeenCalledWith(0);
		const done = lines.find((l) => l.evt === 'shutdown-done');
		expect(done).toMatchObject({ signal: 'SIGTERM', why: 'closed', scoresKept: 2 });
		expect(done?.ms).toBeLessThan(1_300);
		expect(lines.filter((l) => typeof l.evt === 'string' && l.evt.startsWith('shutdown-')).map((l) => l.evt)).toEqual(['shutdown-begin', 'shutdown-done']);
	});
});

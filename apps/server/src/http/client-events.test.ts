/**
 * `/api/client-events` end to end through a real express app, the same harness shape as `trim.test.ts`:
 * a page's telemetry lands in the log as a `client` event keyed by page and user, a malformed one is
 * refused and named, and a flood is cut at the play socket's per-second limit.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const EDGE_SECRET = 'test-edge-auth-secret';

let eventsMod: typeof import('./client-events.ts');
let edgeMod: typeof import('../edge-auth.ts');

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	eventsMod = await import('./client-events.ts');
	edgeMod = await import('../edge-auth.ts');
});

const servers: HttpServer[] = [];
let logged: Record<string, unknown>[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
	logged = [];
});

async function openApp(now: () => number = Date.now): Promise<string> {
	const app = express();
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	const api = express.Router();
	api.use(express.json({ limit: '1mb' }));
	eventsMod.attachClientEvents(api, { log: (entry) => logged.push(entry), now });
	app.use('/api', api);
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function post(base: string, body: unknown): Promise<number> {
	const res = await fetch(`${base}/api/client-events`, {
		method: 'POST',
		headers: { 'x-edge-auth': EDGE_SECRET, 'x-hadoku-tier': 'friend', 'x-user-id': 'u-1', 'x-user-name': 'u-1', 'x-user-key': 'k', 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	return res.status;
}

const scroll = { page: 'front', kind: 'perf', data: { what: 'scroll', frames: 120, p50: 17, p95: 34, over25: 9, over50: 2 } };

describe('/api/client-events', () => {
	it('logs a page event as a client event, keyed by page and user', async () => {
		const base = await openApp();
		expect(await post(base, scroll)).toBe(204);
		expect(logged).toEqual([{ evt: 'client', page: 'front', userId: 'u-1', kind: 'perf', what: 'scroll', frames: 120, p50: 17, p95: 34, over25: 9, over50: 2 }]);
	});

	it('refuses a body that is not a page event, and says why in the log', async () => {
		const base = await openApp();
		expect(await post(base, { page: 'front', kind: 'perf', data: { nested: { no: 1 } } })).toBe(400);
		expect(await post(base, { matchId: 'm-1', kind: 'perf', data: {} })).toBe(400);
		expect(logged.map((e) => e.evt)).toEqual(['client-malformed', 'client-malformed']);
	});

	it('keeps at most the play socket’s per-second count from one user', async () => {
		let t = 5_000;
		const base = await openApp(() => t);
		for (let i = 0; i < 25; i += 1) expect(await post(base, scroll)).toBe(204);
		expect(logged).toHaveLength(20);
		t += 1_000;
		expect(await post(base, scroll)).toBe(204);
		expect(logged).toHaveLength(21);
	});
});

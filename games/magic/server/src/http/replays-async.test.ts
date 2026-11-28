/**
 * The replay list reads the disk only asynchronously. PPE 2026-11-28 14:04Z: with hokon's btrfs root
 * under IO pressure, a list call's synchronous stats (one per recording, ~1,600) held the event loop
 * 6 s, and every match on the server waited with it (an `ask-answered` took 7.2 s). Here every
 * synchronous `fs` call on the recordings directory throws, so a list that still makes one fails.
 */
import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const MARK = 'cardtable-replays-async-';
const syncRefused = (name: string) => (path: unknown, ...rest: unknown[]) => {
	if (String(path).includes(MARK)) throw new Error(`${name} on the recordings directory: the list must not block the event loop`);
	return (actual as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!(path, ...rest);
};
let actual: typeof import('node:fs');
vi.mock('node:fs', async (importActual) => {
	actual = await importActual<typeof import('node:fs')>();
	return { ...actual, default: actual, statSync: syncRefused('statSync'), readdirSync: syncRefused('readdirSync'), lstatSync: syncRefused('lstatSync'), existsSync: syncRefused('existsSync') };
});

const EDGE_SECRET = 'test-edge-auth-secret';
let base = '';
let dir = '';
let server: HttpServer;

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	const fsp = await import('node:fs/promises');
	dir = await fsp.mkdtemp(join(tmpdir(), MARK));
	const lines = [
		{ t: 'header', v: 2, matchId: 'm-1', roomId: null, players: ['A', 'B'], ai: [false, false], decks: [null, null], startedAt: '2026-01-01T00:00:00.000Z' },
		{ t: 'env', at: 0, env: { matchId: 'm-1', cursor: { epoch: 'e', seq: 1 }, frame: { kind: 'notify', method: 'openView', payload: { myPlayers: [0] } } } },
		{ t: 'end', endedAt: '2026-01-01T00:10:00.000Z', winner: 1 },
	];
	await fsp.writeFile(join(dir, 'm-1.public.jsonl.gz'), gzipSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')));
	const edge = await import('@hadoku/game-server/edge-auth');
	const { attachReplays } = await import('./replays.ts');
	const app = express();
	app.use(edge.edgeProvenance);
	app.use(edge.requireMinTier);
	const api = express.Router();
	attachReplays(api, { dir, isTesting: () => false, log: () => undefined });
	app.use('/api', api);
	server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise((r) => server.close(r));
	const fsp = await import('node:fs/promises');
	await fsp.rm(dir, { recursive: true, force: true });
});

describe('GET /api/replays never touches the disk synchronously', () => {
	it('lists a recording, twice, with every synchronous fs call on its directory refused', async () => {
		const headers = { 'x-edge-auth': EDGE_SECRET, 'x-hadoku-tier': 'friend', 'x-user-id': 'u-1', 'x-user-name': 'u-1', 'x-user-key': 'k' };
		for (let i = 0; i < 2; i++) {
			const res = await fetch(`${base}/api/replays`, { headers });
			const body = (await res.json()) as { replays: { matchId: string; winner: number | null }[] };
			expect(body.replays.map((r) => [r.matchId, r.winner])).toEqual([['m-1', 1]]);
		}
	});
});

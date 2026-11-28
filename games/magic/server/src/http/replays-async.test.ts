/**
 * The replay list does no disk work on a request. PPE 2026-11-28 14:04Z: with hokon's btrfs root
 * under IO pressure, a list call's synchronous stats (one per recording, ~1,600) held the event loop
 * 6 s, and every match on the server waited with it (an `ask-answered` took 7.2 s); made async, each
 * list still walked the directory and stat'ed every file. Here every `fs` call on the recordings
 * directory is counted: once the boot index is built, a list or a replay's people make none, and a
 * synchronous one throws wherever it is made.
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
const touched: string[] = [];
const onDir = (path: unknown): boolean => String(path).includes(MARK);
const syncRefused = (fs: Record<string, (...a: unknown[]) => unknown>, name: string) => (path: unknown, ...rest: unknown[]) => {
	if (onDir(path)) throw new Error(`${name} on the recordings directory: the list must not block the event loop`);
	return fs[name]!(path, ...rest);
};
const counted = (fs: Record<string, (...a: unknown[]) => unknown>, name: string) => (path: unknown, ...rest: unknown[]) => {
	if (onDir(path)) touched.push(`${name} ${String(path)}`);
	return fs[name]!(path, ...rest);
};
vi.mock('node:fs', async (importActual) => {
	const actual = await importActual<Record<string, (...a: unknown[]) => unknown>>();
	const fs = { ...actual, statSync: syncRefused(actual, 'statSync'), readdirSync: syncRefused(actual, 'readdirSync'), lstatSync: syncRefused(actual, 'lstatSync'), existsSync: syncRefused(actual, 'existsSync'), createReadStream: counted(actual, 'createReadStream') };
	return { ...fs, default: fs };
});
vi.mock('node:fs/promises', async (importActual) => {
	const actual = await importActual<Record<string, (...a: unknown[]) => unknown>>();
	const fs = { ...actual, readdir: counted(actual, 'readdir'), stat: counted(actual, 'stat'), readFile: counted(actual, 'readFile'), open: counted(actual, 'open') };
	return { ...fs, default: fs };
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
		{ t: 'end', endedAt: '2026-01-01T00:10:00.000Z', winner: 1, seats: [{ seat: 0, claimed: true, playerId: 0, userId: 'uid-a' }] },
	];
	await fsp.writeFile(join(dir, 'm-1.public.jsonl.gz'), gzipSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')));
	const edge = await import('@hadoku/game-server/edge-auth');
	const { attachReplays } = await import('./replays.ts');
	const app = express();
	app.use(edge.edgeProvenance);
	app.use(edge.requireMinTier);
	const api = express.Router();
	attachReplays(api, { dir, isTesting: () => false, log: () => undefined, people: { resolve: async () => new Map(), peek: () => undefined } as never });
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

describe('GET /api/replays does no disk work on a request', () => {
	it('lists a recording from memory: after the first answer, no list or people request touches its directory', async () => {
		const headers = { 'x-edge-auth': EDGE_SECRET, 'x-hadoku-tier': 'friend', 'x-user-id': 'u-1', 'x-user-name': 'u-1', 'x-user-key': 'k' };
		const list = async (): Promise<unknown> => ((await (await fetch(`${base}/api/replays`, { headers })).json()) as { replays: { matchId: string; winner: number | null }[] }).replays.map((r) => [r.matchId, r.winner]);
		expect(await list()).toEqual([['m-1', 1]]);
		touched.length = 0;
		for (let i = 0; i < 3; i++) expect(await list()).toEqual([['m-1', 1]]);
		expect((await fetch(`${base}/api/replays/m-1/people`, { headers })).status).toBe(200);
		expect(touched).toEqual([]);
	});
});

/**
 * `/api/replays` end to end through a real express app, same harness shape as `trim.test.ts`:
 * fixture `.gz` files written straight to a temp directory, exactly as the recorder would leave them.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const EDGE_SECRET = 'test-edge-auth-secret';

let replaysMod: typeof import('./replays.ts');
let edgeMod: typeof import('../edge-auth.ts');

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	replaysMod = await import('./replays.ts');
	edgeMod = await import('../edge-auth.ts');
});

const dirs: string[] = [];
const servers: HttpServer[] = [];
let logged: Record<string, unknown>[] = [];
let testingRooms = new Set<string>();

afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
	logged = [];
	testingRooms = new Set();
});
afterAll(async () => {
	await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function openApp(dir: string, extra: Partial<Parameters<typeof replaysMod.attachReplays>[1]> = {}): Promise<string> {
	const app = express();
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	const api = express.Router();
	api.use(express.json({ limit: '1mb' }));
	replaysMod.attachReplays(api, { dir, isTesting: (roomId) => roomId !== null && testingRooms.has(roomId), log: (entry) => logged.push(entry), ...extra });
	app.use('/api', api);
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function recordingsDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-replays-test-'));
	dirs.push(dir);
	return dir;
}

function writeGz(path: string, lines: unknown[]): void {
	writeFileSync(path, gzipSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')));
}

function writePublic(dir: string, matchId: string, opts: { roomId?: string | null; winner?: 0 | 1 | null; startedAt?: string; envs?: unknown[]; v?: number } = {}): void {
	writeGz(join(dir, `${matchId}.public.jsonl.gz`), [
		{ t: 'header', v: opts.v ?? 2, matchId, roomId: opts.roomId ?? null, players: ['A', 'B'], ai: [false, false], decks: [null, null], startedAt: opts.startedAt ?? '2026-01-01T00:00:00.000Z' },
		...(opts.envs ?? [{ t: 'env', at: 0, env: { matchId, cursor: { epoch: 'e', seq: 1 }, frame: { kind: 'notify', method: 'openView', payload: { myPlayers: [0] } } } }]),
		{ t: 'end', endedAt: '2026-01-01T00:10:00.000Z', winner: opts.winner ?? null },
	]);
}

function writeActionsOnly(dir: string, matchId: string, opts: { roomId?: string | null; startedAt?: string } = {}): void {
	writeGz(join(dir, `${matchId}.actions.jsonl.gz`), [
		{
			t: 'header',
			v: 1,
			matchId,
			roomId: opts.roomId ?? null,
			pin: 'abc',
			bridge: 'def',
			server: '0.0.0',
			startedAt: opts.startedAt ?? '2026-01-01T00:00:00.000Z',
			spec: { seed: 1, seats: [{ name: 'A', ai: false }, { name: 'B', ai: false }] },
		},
		{ t: 'cmd', seat: 0, board: 'b', prompt: 'p', cmd: { t: 'act', seat: 0, frame: { method: 'selectButtonOk' } } },
		{ t: 'end', endedAt: '2026-01-01T00:05:00.000Z', reason: 'clean' },
	]);
}

async function call(base: string, path: string, tier = 'friend', body?: unknown): Promise<{ status: number; json: Record<string, unknown>; cache: string | null }> {
	const headers: Record<string, string> = { 'x-edge-auth': EDGE_SECRET, 'x-hadoku-tier': tier, 'x-user-id': 'u-1', 'x-user-name': 'u-1', 'x-user-key': 'k' };
	const res = await fetch(`${base}${path}`, body === undefined ? { headers } : { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
	const text = await res.text();
	return { status: res.status, json: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>, cache: res.headers.get('cache-control') };
}

describe('GET /api/replays', () => {
	it('is empty for an empty directory', async () => {
		const base = await openApp(await recordingsDir());
		expect(await call(base, '/api/replays')).toEqual({ status: 200, json: { replays: [] }, cache: 'private, max-age=15' });
	});

	it('lists a finished match whose public stream is on disk, source "stream"', async () => {
		const dir = await recordingsDir();
		writePublic(dir, 'm-1', { roomId: 'r-1', winner: 1 });
		const base = await openApp(dir);
		const { status, json } = await call(base, '/api/replays');
		expect(status).toBe(200);
		expect(json.replays).toEqual([{ matchId: 'm-1', roomId: 'r-1', players: ['A', 'B'], decks: [null, null], startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:10:00.000Z', winner: 1, source: 'stream' }]);
	});

	it('answers "rebuild" when only the action log remains and canRebuild says yes, and does not offer one it says no to', async () => {
		const dir = await recordingsDir();
		writeActionsOnly(dir, 'm-yes');
		writeActionsOnly(dir, 'm-no');
		const base = await openApp(dir, { canRebuild: (header) => header.matchId === 'm-yes' });
		const { json } = await call(base, '/api/replays');
		const byId = Object.fromEntries((json.replays as { matchId: string; source: string }[]).map((r) => [r.matchId, r.source]));
		expect(byId).toEqual({ 'm-yes': 'rebuild' });
	});

	it('does not offer a v:1 stream (it drew no hand): a replay that cannot show both hands is no replay', async () => {
		const dir = await recordingsDir();
		writePublic(dir, 'm-v1', { v: 1 });
		writePublic(dir, 'm-v2');
		const base = await openApp(dir);
		const { json } = await call(base, '/api/replays');
		expect((json.replays as { matchId: string }[]).map((r) => r.matchId)).toEqual(['m-v2']);
		expect((await call(base, '/api/replays/m-v1')).status).toBe(404);
	});

	it('sorts newest first and honours limit', async () => {
		const dir = await recordingsDir();
		writePublic(dir, 'm-old', { startedAt: '2026-01-01T00:00:00.000Z' });
		writePublic(dir, 'm-new', { startedAt: '2026-01-02T00:00:00.000Z' });
		writePublic(dir, 'm-mid', { startedAt: '2026-01-01T12:00:00.000Z' });
		const base = await openApp(dir);
		const all = await call(base, '/api/replays');
		expect((all.json.replays as { matchId: string }[]).map((r) => r.matchId)).toEqual(['m-new', 'm-mid', 'm-old']);
		const limited = await call(base, '/api/replays?limit=1');
		expect((limited.json.replays as { matchId: string }[]).map((r) => r.matchId)).toEqual(['m-new']);
	});

	it('hides a testing room from a friend and shows it to an admin', async () => {
		testingRooms.add('r-testing');
		const dir = await recordingsDir();
		writePublic(dir, 'm-t', { roomId: 'r-testing' });
		const base = await openApp(dir);
		expect((await call(base, '/api/replays')).json.replays).toEqual([]);
		const asAdmin = await call(base, '/api/replays', 'admin');
		expect((asAdmin.json.replays as { matchId: string }[]).map((r) => r.matchId)).toEqual(['m-t']);
	});
});

describe('GET /api/replays/:matchId', () => {
	it('serves the header, every env in order, and the end for a stream on disk', async () => {
		const dir = await recordingsDir();
		writePublic(dir, 'm-1', {
			envs: [
				{ t: 'env', at: 0, env: { matchId: 'm-1', cursor: { epoch: 'e', seq: 1 }, frame: { kind: 'notify', method: 'openView', payload: { myPlayers: [0] } } } },
				{ t: 'env', at: 50, env: { matchId: 'm-1', cursor: { epoch: 'e', seq: 2 }, frame: { kind: 'notify', method: 'openView', payload: { myPlayers: [1] } } } },
			],
		});
		const base = await openApp(dir);
		const { status, json, cache } = await call(base, '/api/replays/m-1');
		expect(status).toBe(200);
		expect(cache, 'a finished replay never changes: the browser keeps it, and no shared cache may').toBe('private, max-age=31536000, immutable');
		expect((json.envs as unknown[]).length).toBe(2);
		expect((json.header as { matchId: string }).matchId).toBe('m-1');
		expect((json.end as { winner: number | null }).winner).toBeNull();
	});

	it('404s for a match with neither file', async () => {
		const base = await openApp(await recordingsDir());
		const missing = await call(base, '/api/replays/m-missing');
		expect(missing.status).toBe(404);
		expect(missing.cache, 'a 404 is never kept').toBeNull();
	});

	it('404s a testing room for a friend even if it finds the files', async () => {
		testingRooms.add('r-t');
		const dir = await recordingsDir();
		writePublic(dir, 'm-t', { roomId: 'r-t' });
		const base = await openApp(dir);
		expect((await call(base, '/api/replays/m-t')).status).toBe(404);
		expect((await call(base, '/api/replays/m-t', 'admin')).status).toBe(200);
	});

	it('404s an id that is not a safe path segment, never touching the filesystem with it', async () => {
		const base = await openApp(await recordingsDir());
		expect((await call(base, `/api/replays/${encodeURIComponent('../../etc/passwd')}`)).status).toBe(404);
	});

	it('404s a rebuildable match when canRebuild/rebuild are not wired, and serves the rebuild result when they are', async () => {
		const dir = await recordingsDir();
		writeActionsOnly(dir, 'm-reb');
		const notWired = await openApp(dir);
		expect((await call(notWired, '/api/replays/m-reb')).status).toBe(404);

		const rebuilt = {
			header: { t: 'header' as const, v: 2, matchId: 'm-reb', roomId: null, players: ['A', 'B'] as [string, string], ai: [false, false] as [boolean, boolean], decks: [null, null], startedAt: '2026-01-01T00:00:00.000Z' },
			envs: [],
			end: { t: 'end' as const, endedAt: '2026-01-01T00:05:00.000Z', winner: 0 as const },
		};
		const wired = await openApp(dir, { canRebuild: () => true, rebuild: async () => rebuilt });
		const { status, json } = await call(wired, '/api/replays/m-reb');
		expect(status).toBe(200);
		expect(json).toEqual(rebuilt);
	});
});

describe('POST /api/replays/report', () => {
	it('logs a known trouble with its match, and refuses an unknown one', async () => {
		const base = await openApp(await recordingsDir());
		expect((await call(base, '/api/replays/report', 'friend', { what: 'player-error', matchId: 'm-1', ui: '0.1.0', detail: { error: 'x' } })).status).toBe(204);
		expect(logged).toContainEqual({ evt: 'replay-report', what: 'player-error', matchId: 'm-1', ui: '0.1.0', detail: { error: 'x' } });
		expect((await call(base, '/api/replays/report', 'friend', { what: 'anything', detail: {} })).status).toBe(400);
	});
});

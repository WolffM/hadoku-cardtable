/**
 * `/api/trim` end to end through a real express app, the same harness shape as `sounds.test.ts`:
 * the site's one trim, read by every friend, written only by an admin, kept across a restart.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const EDGE_SECRET = 'test-edge-auth-secret';

let trimMod: typeof import('./trim.ts');
let edgeMod: typeof import('../edge-auth.ts');

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	trimMod = await import('./trim.ts');
	edgeMod = await import('../edge-auth.ts');
});

const dirs: string[] = [];
const servers: HttpServer[] = [];
let logged: Record<string, unknown>[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
	logged = [];
});
afterAll(async () => {
	await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function openApp(file: string): Promise<string> {
	const app = express();
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	const api = express.Router();
	api.use(express.json({ limit: '1mb' }));
	trimMod.attachTrim(api, { file, log: (entry) => logged.push(entry) });
	app.use('/api', api);
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function trimFile(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-trim-test-'));
	dirs.push(dir);
	return join(dir, 'trim.json');
}

async function call(base: string, method: string, tier: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
	const headers: Record<string, string> = { 'x-edge-auth': EDGE_SECRET, 'x-hadoku-tier': tier, 'x-user-id': 'u-1', 'x-user-name': 'u-1', 'x-user-key': 'k' };
	if (body !== undefined) headers['content-type'] = 'application/json';
	const res = await fetch(`${base}/api/trim`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('/api/trim', () => {
	it('is null until an admin sets it, and says who may edit', async () => {
		const base = await openApp(await trimFile());
		expect(await call(base, 'GET', 'friend')).toEqual({ status: 200, json: { trim: null, canEdit: false } });
		expect((await call(base, 'GET', 'admin')).json.canEdit).toBe(true);
	});

	it('an admin sets the look for everyone, and it survives a restart', async () => {
		const file = await trimFile();
		const base = await openApp(file);
		const trim = { frame: 'scoop', ground: 'triangles', groundCorner: 'gems' };
		expect(await call(base, 'PUT', 'admin', { trim })).toEqual({ status: 200, json: { trim } });
		expect((await call(base, 'GET', 'friend')).json.trim).toEqual(trim);
		expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ trim });
		const again = await openApp(file);
		expect((await call(again, 'GET', 'friend')).json.trim).toEqual(trim);
	});

	it('nobody below admin writes it', async () => {
		const file = await trimFile();
		const base = await openApp(file);
		for (const tier of ['friend', 'service', 'wife']) expect((await call(base, 'PUT', tier, { trim: { frame: 'hud' } })).status).toBe(403);
		expect((await call(base, 'GET', 'friend')).json.trim).toBeNull();
	});

	it('refuses anything that is not a map of names', async () => {
		const base = await openApp(await trimFile());
		for (const trim of [null, [], 'scoop', { frame: 3 }, { 'bad key': 'x' }, { frame: 'Has Caps' }]) {
			expect((await call(base, 'PUT', 'admin', { trim })).status, JSON.stringify(trim)).toBe(400);
		}
	});

	it('a corrupt file reads as never set, and says so in the log', async () => {
		const file = await trimFile();
		await writeFile(file, '{not json');
		const base = await openApp(file);
		expect((await call(base, 'GET', 'friend')).json.trim).toBeNull();
		expect(logged).toContainEqual({ event: 'trim-file-corrupt', reason: 'invalid JSON' });
	});
});

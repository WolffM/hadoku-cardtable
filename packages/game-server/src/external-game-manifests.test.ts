/**
 * The manifest reader against a real HTTP server standing in for the edge: it answers only a
 * caller with the service key, as the edge does for a gated bundle route.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { manifestReader } from './external-game-manifests.ts';

const KEY = 'test-service-key';
/** What the stand-in edge answers per path; a missing path is a 404. */
const files = new Map<string, string>();
const seen: Array<{ path: string; key: string | undefined; agent: string | undefined }> = [];
let server: Server;
let origin: string;
let dirs: string[] = [];
let logged: Record<string, unknown>[] = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		const key = req.headers['x-user-key'] as string | undefined;
		seen.push({ path: req.url ?? '', key, agent: req.headers['user-agent'] });
		if (key !== KEY) return void res.writeHead(401).end('signed out');
		const body = files.get(req.url ?? '');
		if (body === undefined) return void res.writeHead(404).end('no such file');
		res.writeHead(200, { 'content-type': 'application/json' }).end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
	files.clear();
	seen.length = 0;
	logged = [];
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
	dirs = [];
});

async function reader(opts: { serviceKey?: string; origin?: string } = {}): Promise<{ read: ReturnType<typeof manifestReader>; cacheDir: string }> {
	const cacheDir = join(await mkdtemp(join(tmpdir(), 'cardtable-manifests-')), 'external-games');
	dirs.push(join(cacheDir, '..'));
	const read = manifestReader({
		origin: opts.origin ?? origin,
		serviceKey: 'serviceKey' in opts ? opts.serviceKey : KEY,
		cacheDir,
		log: (e) => logged.push(e),
		timeoutMs: 2_000,
	});
	return { read, cacheDir };
}

const GAME = { id: 'crossover-cards', embedSrc: '/games/crossover-cards/embed.js' };
const SOLO = JSON.stringify({ label: 'Crossover Cards', seats: { min: 1, max: 4 } });

describe('manifestReader', () => {
	it('fetches the manifest beside the embed with the service key, and keeps it on disk', async () => {
		files.set('/games/crossover-cards/manifest.json', SOLO);
		const { read, cacheDir } = await reader();
		expect(await read(GAME)).toEqual({ source: 'fetched', manifest: { label: 'Crossover Cards', seats: { min: 1, max: 4 }, seatRejoinGraceMs: 120_000 } });
		expect(seen).toEqual([{ path: '/games/crossover-cards/manifest.json', key: KEY, agent: 'Mozilla/5.0 hadoku-cardtable' }]);
		expect(JSON.parse(await readFile(join(cacheDir, 'crossover-cards.json'), 'utf8'))).toEqual({ label: 'Crossover Cards', seats: { min: 1, max: 4 }, seatRejoinGraceMs: 120_000 });
		expect(logged).toEqual([]);
	});

	it('uses the last good copy when the release has no manifest, and says why', async () => {
		files.set('/games/crossover-cards/manifest.json', SOLO);
		const { read } = await reader();
		await read(GAME);
		files.clear();
		expect(await read(GAME)).toMatchObject({ source: 'cached', manifest: { seats: { min: 1, max: 4 } } });
		expect(logged).toEqual([{ evt: 'external-game-manifest-stale', gameType: 'crossover-cards', reason: `${origin}/games/crossover-cards/manifest.json answered 404` }]);
	});

	it('keeps the last good copy over a manifest it cannot read', async () => {
		files.set('/games/crossover-cards/manifest.json', SOLO);
		const { read, cacheDir } = await reader();
		await read(GAME);
		files.set('/games/crossover-cards/manifest.json', JSON.stringify({ label: 'Crossover Cards', seats: { min: 5, max: 4 } }));
		expect(await read(GAME)).toMatchObject({ source: 'cached', manifest: { seats: { min: 1, max: 4 } } });
		expect(logged[0]).toMatchObject({ evt: 'external-game-manifest-stale', reason: 'seats: seats.min is more than seats.max' });
		expect(JSON.parse(await readFile(join(cacheDir, 'crossover-cards.json'), 'utf8')).seats).toEqual({ min: 1, max: 4 });
	});

	it('takes a changed manifest and replaces the copy', async () => {
		files.set('/games/crossover-cards/manifest.json', JSON.stringify({ label: 'Crossover Cards', seats: { min: 2, max: 4 } }));
		const { read, cacheDir } = await reader();
		await read(GAME);
		files.set('/games/crossover-cards/manifest.json', SOLO);
		expect(await read(GAME)).toMatchObject({ source: 'fetched', manifest: { seats: { min: 1, max: 4 } } });
		expect(JSON.parse(await readFile(join(cacheDir, 'crossover-cards.json'), 'utf8')).seats).toEqual({ min: 1, max: 4 });
	});

	it('has nothing for a game never read, and logs it', async () => {
		const { read } = await reader({ serviceKey: undefined });
		expect(await read(GAME)).toBeNull();
		expect(logged).toEqual([{ evt: 'external-game-manifest-missing', gameType: 'crossover-cards', reason: `${origin}/games/crossover-cards/manifest.json answered 401` }]);
	});

	it('has nothing when the edge cannot be reached at all', async () => {
		const { read } = await reader({ origin: 'http://127.0.0.1:1' });
		expect(await read(GAME)).toBeNull();
		expect(logged[0]).toMatchObject({ evt: 'external-game-manifest-missing', gameType: 'crossover-cards' });
	});

	it('names an unreadable copy on disk rather than trusting it', async () => {
		const { read, cacheDir } = await reader();
		await mkdir(cacheDir, { recursive: true });
		await writeFile(join(cacheDir, 'crossover-cards.json'), '{"label":', 'utf8');
		expect(await read(GAME)).toBeNull();
		expect(logged[0]).toMatchObject({ evt: 'external-game-manifest-missing', cache: expect.stringMatching(/JSON/) });
	});

	it('never fetches an inline fixture manifest', async () => {
		const { read } = await reader();
		expect(await read({ id: 'toy', embedSrc: '/e2e/toy.js', manifest: { label: 'Toy', seats: { min: 2, max: 4 } } })).toMatchObject({ source: 'inline', manifest: { label: 'Toy' } });
		expect(seen).toEqual([]);
	});
});

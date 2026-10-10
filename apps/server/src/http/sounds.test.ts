/**
 * `/api/sounds` end to end through a real express app — same harness shape as
 * `rooms.test.ts`: `edgeProvenance`, then `requireMinTier`, then an `/api`
 * router with `express.json()`, then `attachSounds`.
 *
 * `node:fs/promises`'s `rename` is partially mocked (every other export
 * passed through to the real implementation) so one test can make a single
 * call fail — simulating a process killed between the temp-file write and the
 * rename that would have made it live — without touching anything else on
 * disk.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TIER_ORDER } from '../edge-auth.ts';

vi.mock('node:fs/promises', async () => {
	const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
	return { ...actual, rename: vi.fn(actual.rename) };
});

import { rename } from 'node:fs/promises';

const EDGE_SECRET = 'test-edge-auth-secret';

let soundsMod: typeof import('./sounds.ts');
let edgeMod: typeof import('../edge-auth.ts');

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	soundsMod = await import('./sounds.ts');
	edgeMod = await import('../edge-auth.ts');
});

/* ── harness ─────────────────────────────────────────────────────────── */

const dirs: string[] = [];
const servers: HttpServer[] = [];
/** Every structured line `attachSounds` logged, across every harness opened in the running test. */
let logged: Record<string, unknown>[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-sounds-test-'));
	dirs.push(dir);
	return dir;
}

interface Harness {
	base: string;
}

async function openApp(dir: string): Promise<Harness> {
	const app = express();
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	const api = express.Router();
	api.use(express.json({ limit: '1mb' }));
	soundsMod.attachSounds(api, { dir, log: (entry) => logged.push(entry) });
	app.use('/api', api);

	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	const { port } = server.address() as AddressInfo;
	return { base: `http://127.0.0.1:${port}` };
}

function headersFor(tier: string): Record<string, string> {
	return {
		'x-edge-auth': EDGE_SECRET,
		'x-hadoku-tier': tier,
		'x-user-id': 'user-1',
		'x-user-name': 'user-1',
		'x-user-key': 'friend-key-1',
	};
}

interface Reply {
	status: number;
	text: string;
	json: () => unknown;
	headers: Headers;
}

async function call(
	h: Harness,
	method: string,
	path: string,
	opts: { tier?: string; body?: unknown } = {},
): Promise<Reply> {
	const headers: Record<string, string> = { ...headersFor(opts.tier ?? 'friend') };
	let body: string | undefined;
	if (opts.body !== undefined) {
		body = JSON.stringify(opts.body);
		headers['content-type'] = 'application/json';
	}
	const res = await fetch(`${h.base}${path}`, { method, headers, body });
	const text = await res.text();
	return { status: res.status, text, json: () => JSON.parse(text), headers: res.headers };
}

const TAKE = {
	file: 'm-win/take-synth-1.ogg',
	sound: 'm-win',
	name: 'Victory',
	group: 'Victory',
	section: 'Moments',
	label: 'Victory · hand-rolled',
	seconds: 1.2,
	prompt: 'A triumphant chord.',
};

const TAKE2 = {
	file: 'wu/take-v1-4000.ogg',
	sound: 'WU',
	name: 'Azorius',
	group: 'Azorius',
	section: 'Colour sounds',
	label: 'Azorius · 1a',
	seconds: 1.1,
	prompt: 'A rising bell chord.',
};

async function writeCatalogue(dir: string, takes: unknown[]): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'catalogue.json'), JSON.stringify({ takes }), 'utf8');
}

async function writeTakeFile(dir: string, rel: string, bytes = 'fake-ogg-bytes'): Promise<void> {
	const full = join(dir, 'takes', rel);
	await mkdir(dirname(full), { recursive: true });
	await writeFile(full, bytes, 'utf8');
}

function cellPath(cell: string): string {
	return `/api/sounds/assignments/${encodeURIComponent(cell)}`;
}

afterEach(() => {
	vi.restoreAllMocks();
	logged = [];
});

afterAll(async () => {
	for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/* ── catalogue ───────────────────────────────────────────────────────── */

describe('GET /api/sounds/catalogue', () => {
	it('a missing data dir is an empty catalogue, never an error', async () => {
		const dir = join(await tempDir(), 'does-not-exist');
		const h = await openApp(dir);
		const res = await call(h, 'GET', '/api/sounds/catalogue');
		expect(res.status).toBe(200);
		expect(res.json()).toEqual({ takes: [] });
	});

	it('returns the takes the import tool wrote', async () => {
		const dir = await tempDir();
		await writeCatalogue(dir, [TAKE]);
		const h = await openApp(dir);
		const res = await call(h, 'GET', '/api/sounds/catalogue');
		expect(res.status).toBe(200);
		expect(res.json()).toEqual({ takes: [TAKE] });
	});

	it('a friend can read the catalogue', async () => {
		const dir = await tempDir();
		await writeCatalogue(dir, [TAKE]);
		const h = await openApp(dir);
		const res = await call(h, 'GET', '/api/sounds/catalogue', { tier: 'friend' });
		expect(res.status).toBe(200);
	});

	it('a catalogue.json that fails to parse degrades to empty, and logs it rather than staying silent', async () => {
		const dir = await tempDir();
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'catalogue.json'), '{ not json', 'utf8');
		const h = await openApp(dir);
		const res = await call(h, 'GET', '/api/sounds/catalogue');
		expect(res.status).toBe(200);
		expect(res.json()).toEqual({ takes: [] });
		expect(logged).toContainEqual(
			expect.objectContaining({ event: 'sounds-file-corrupt', file: 'catalogue.json', reason: 'invalid JSON' }),
		);
	});

	it('a catalogue.json that fails the schema degrades to empty, and logs it', async () => {
		const dir = await tempDir();
		await writeCatalogue(dir, [{ ...TAKE, file: 'not a valid take path' }]);
		const h = await openApp(dir);
		const res = await call(h, 'GET', '/api/sounds/catalogue');
		expect(res.status).toBe(200);
		expect(res.json()).toEqual({ takes: [] });
		expect(logged).toContainEqual(expect.objectContaining({ event: 'sounds-file-corrupt', file: 'catalogue.json', reason: 'schema' }));
	});
});

/* ── assignments: reads, and canEdit ────────────────────────────────── */

describe('GET /api/sounds/assignments', () => {
	it('a friend can read; canEdit is false', async () => {
		const h = await openApp(await tempDir());
		const res = await call(h, 'GET', '/api/sounds/assignments', { tier: 'friend' });
		expect(res.status).toBe(200);
		expect(res.json()).toEqual({ cells: {}, gains: {}, canEdit: false });
	});

	it('canEdit is true only for admin', async () => {
		const h = await openApp(await tempDir());
		// The whole ladder, from edge-auth: a tier added there is checked here without anyone
		// remembering to list it (hadoku_site's tier audit, 2026-10-07).
		for (const tier of TIER_ORDER) {
			const res = await call(h, 'GET', '/api/sounds/assignments', { tier });
			if (tier === 'public') {
				// Below the friend gate: refused outright, never a read with canEdit false.
				expect(res.status, tier).toBe(404);
				continue;
			}
			expect(res.status, tier).toBe(200);
			expect((res.json() as { canEdit: boolean }).canEdit, tier).toBe(tier === 'admin');
		}
	});

	it('a dropped invalid cell is logged with a count, not left silent', async () => {
		const dir = await tempDir();
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, 'assignments.json'),
			JSON.stringify({
				cells: { 'g.win|play': [TAKE.file], 'not-a-cell': ['x'], 'WU|spell': 'not-an-array' },
				gains: { 'g.win|play': 0.5, 'g.draw|play': 9 },
			}),
			'utf8',
		);
		const h = await openApp(dir);
		const res = await call(h, 'GET', '/api/sounds/assignments', { tier: 'admin' });
		expect(res.json()).toMatchObject({ cells: { 'g.win|play': [TAKE.file] }, gains: { 'g.win|play': 0.5 } });
		expect(logged).toContainEqual(expect.objectContaining({ event: 'sounds-assignments-cells-dropped', count: 3 }));
	});
});

/* ── assignments: writes ─────────────────────────────────────────────── */

describe('PUT /api/sounds/assignments/:cell', () => {
	it('a friend cannot write: 403, and nothing is persisted', async () => {
		const dir = await tempDir();
		await writeCatalogue(dir, [TAKE]);
		const h = await openApp(dir);
		const res = await call(h, 'PUT', cellPath('g.win|play'), { tier: 'friend', body: { files: [TAKE.file] } });
		expect(res.status).toBe(403);
		const after = await call(h, 'GET', '/api/sounds/assignments', { tier: 'admin' });
		expect((after.json() as { cells: unknown }).cells).toEqual({});
	});

	it('an admin can write, and a subsequent read sees it', async () => {
		const dir = await tempDir();
		await writeCatalogue(dir, [TAKE]);
		const h = await openApp(dir);
		const res = await call(h, 'PUT', cellPath('g.win|play'), { tier: 'admin', body: { files: [TAKE.file] } });
		expect(res.status).toBe(200);
		expect(res.json()).toEqual({ cell: 'g.win|play', files: [TAKE.file], gain: 1 });
		const after = await call(h, 'GET', '/api/sounds/assignments', { tier: 'admin' });
		expect((after.json() as { cells: unknown }).cells).toEqual({ 'g.win|play': [TAKE.file] });
	});

	it('stores a gain beside the files, and a PUT without one keeps it', async () => {
		const dir = await tempDir();
		await writeCatalogue(dir, [TAKE]);
		const h = await openApp(dir);
		const res = await call(h, 'PUT', cellPath('g.win|play'), { tier: 'admin', body: { files: [TAKE.file], gain: 0.4 } });
		expect(res.json()).toEqual({ cell: 'g.win|play', files: [TAKE.file], gain: 0.4 });
		await call(h, 'PUT', cellPath('g.win|play'), { tier: 'admin', body: { files: [] } });
		const after = await call(h, 'GET', '/api/sounds/assignments', { tier: 'admin' });
		expect(after.json()).toMatchObject({ cells: { 'g.win|play': [] }, gains: { 'g.win|play': 0.4 } });
	});

	it('a gain outside 0..2 is 400', async () => {
		const dir = await tempDir();
		await writeCatalogue(dir, [TAKE]);
		const h = await openApp(dir);
		const res = await call(h, 'PUT', cellPath('g.win|play'), { tier: 'admin', body: { files: [], gain: 3 } });
		expect(res.status).toBe(400);
	});

	it('a malformed cell id is 400, and nothing is persisted', async () => {
		const dir = await tempDir();
		const h = await openApp(dir);
		const res = await call(h, 'PUT', cellPath('not-a-cell'), { tier: 'admin', body: { files: [] } });
		expect(res.status).toBe(400);
		const after = await call(h, 'GET', '/api/sounds/assignments', { tier: 'admin' });
		expect((after.json() as { cells: unknown }).cells).toEqual({});
	});

	it('a file not in the catalogue is 400, and nothing is persisted', async () => {
		const dir = await tempDir();
		await writeCatalogue(dir, [TAKE]);
		const h = await openApp(dir);
		const res = await call(h, 'PUT', cellPath('g.win|play'), {
			tier: 'admin',
			body: { files: ['m-win/take-ghost.ogg'] },
		});
		expect(res.status).toBe(400);
		const after = await call(h, 'GET', '/api/sounds/assignments', { tier: 'admin' });
		expect((after.json() as { cells: unknown }).cells).toEqual({});
	});

	it('clears a cell with an empty file list', async () => {
		const dir = await tempDir();
		await writeCatalogue(dir, [TAKE]);
		const h = await openApp(dir);
		await call(h, 'PUT', cellPath('g.win|play'), { tier: 'admin', body: { files: [TAKE.file] } });
		const res = await call(h, 'PUT', cellPath('g.win|play'), { tier: 'admin', body: { files: [] } });
		expect(res.status).toBe(200);
		const after = await call(h, 'GET', '/api/sounds/assignments', { tier: 'admin' });
		expect((after.json() as { cells: unknown }).cells).toEqual({ 'g.win|play': [] });
	});

	it('two concurrent PUTs to different cells both land — no lost update', async () => {
		const dir = await tempDir();
		await writeCatalogue(dir, [TAKE, TAKE2]);
		const h = await openApp(dir);
		const [r1, r2] = await Promise.all([
			call(h, 'PUT', cellPath('g.win|play'), { tier: 'admin', body: { files: [TAKE.file] } }),
			call(h, 'PUT', cellPath('WU|spell'), { tier: 'admin', body: { files: [TAKE2.file] } }),
		]);
		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);
		const after = await call(h, 'GET', '/api/sounds/assignments', { tier: 'admin' });
		expect((after.json() as { cells: unknown }).cells).toEqual({
			'g.win|play': [TAKE.file],
			'WU|spell': [TAKE2.file],
		});
	});

	it('a rename failure mid-write leaves assignments.json untouched and the temp file behind', async () => {
		const dir = await tempDir();
		await writeCatalogue(dir, [TAKE]);
		const h = await openApp(dir);

		// A known prior state to prove untouched-ness against.
		const first = await call(h, 'PUT', cellPath('g.win|play'), { tier: 'admin', body: { files: [TAKE.file] } });
		expect(first.status).toBe(200);
		const assignmentsPath = join(dir, 'assignments.json');
		const before = await readFile(assignmentsPath, 'utf8');

		vi.mocked(rename).mockRejectedValueOnce(new Error('simulated crash between write and rename'));
		const res = await call(h, 'PUT', cellPath('g.win|play'), { tier: 'admin', body: { files: [] } });
		expect(res.status).toBe(500);

		const after = await readFile(assignmentsPath, 'utf8');
		expect(after).toBe(before);

		const names = await readdir(dir);
		const tmp = names.filter((n) => n.startsWith('assignments.json.') && n.endsWith('.tmp'));
		expect(tmp.length).toBeGreaterThan(0);
	});
});

/* ── take audio: serving, and the traversal gate ────────────────────── */

describe('GET /api/sounds/takes/:folder/:file', () => {
	it('serves the bytes with an audio/ogg content type and a long immutable cache header', async () => {
		const dir = await tempDir();
		await writeTakeFile(dir, 'm-win/take-synth-1.ogg', 'fake-ogg-bytes');
		const h = await openApp(dir);
		const res = await call(h, 'GET', '/api/sounds/takes/m-win/take-synth-1.ogg');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('audio/ogg');
		expect(res.headers.get('cache-control')).toContain('immutable');
		expect(res.text).toBe('fake-ogg-bytes');
	});

	it('404s a well-formed path that does not exist', async () => {
		const h = await openApp(await tempDir());
		const res = await call(h, 'GET', '/api/sounds/takes/m-win/take-ghost.ogg');
		expect(res.status).toBe(404);
	});

	it('400s every traversal, encoded-slash, and malformed-path attempt, never leaking a file outside the dir', async () => {
		const dir = await tempDir();
		await writeTakeFile(dir, 'm-win/take-synth-1.ogg');
		// A secret that sits OUTSIDE the sounds dir — what a successful
		// traversal would have had to read.
		const secretPath = join(dir, '..', `secret-${Date.now()}.txt`);
		await writeFile(secretPath, 'top secret contents');
		const h = await openApp(dir);

		const attempts = [
			'/api/sounds/takes/..%2F..%2Fetc/take-1.ogg', // encoded slash, dotdot folder
			'/api/sounds/takes/etc/..%2F..%2Fsecret.ogg', // encoded slash in file
			'/api/sounds/takes/%2Fetc/take-1.ogg', // encoded leading slash (absolute-looking)
			'/api/sounds/takes/m-win/take-1.wav', // wrong extension
			'/api/sounds/takes/M-Win/take-1.ogg', // uppercase folder
			'/api/sounds/takes/m-win/other-1.ogg', // missing take- prefix
		];
		for (const path of attempts) {
			const res = await call(h, 'GET', path);
			expect(res.status, path).toBe(400);
			expect(res.text).not.toContain('top secret');
		}

		await rm(secretPath, { force: true });
	});
});

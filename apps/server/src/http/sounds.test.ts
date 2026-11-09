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
import { decodeSoundPack, MUSIC_REVIEW_APP_ID } from '@hadoku/shared';
import { TIER_ORDER } from '../edge-auth.ts';
import { createMusicReviewStore } from './musicReviewStore.ts';
import { createPrefsRowsStandIn, standInFetch, type PrefsRowsStandIn } from './prefsRowsStandIn.ts';

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
	/** prefs-api, as far as these routes reach it: people's review rows. */
	prefs: PrefsRowsStandIn;
}

const SERVICE_KEY = 'cardtable-service-key';
const PREFS_BASE = 'https://prefs.test/prefs';
/** A person's key, as the edge stamps it: one per user, so whose row a write lands in is checked. */
const keyOf = (user: string) => `key-${user}`;

async function openApp(dir: string, mods = { sounds: soundsMod, edge: edgeMod }): Promise<Harness> {
	const app = express();
	app.use(mods.edge.edgeProvenance);
	app.use(mods.edge.requireMinTier);
	const api = express.Router();
	api.use(express.json({ limit: '1mb' }));
	const prefs = createPrefsRowsStandIn({ app: 'cardtable', serviceKey: SERVICE_KEY, userOfKey: (k) => (k.startsWith('key-') ? k.slice(4) : null) });
	const reviews = createMusicReviewStore({
		baseUrl: PREFS_BASE,
		serviceKey: SERVICE_KEY,
		fetch: standInFetch(prefs, PREFS_BASE),
		onBadRow: (userId) => logged.push({ event: 'sounds-music-review-bad-row', userId }),
	});
	mods.sounds.attachSounds(api, { dir, reviews, log: (entry) => logged.push(entry) });
	app.use('/api', api);

	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	const { port } = server.address() as AddressInfo;
	return { base: `http://127.0.0.1:${port}`, prefs };
}

function headersFor(tier: string, user = 'user-1'): Record<string, string> {
	return {
		'x-edge-auth': EDGE_SECRET,
		'x-hadoku-tier': tier,
		'x-user-id': user,
		'x-user-name': user,
		'x-user-key': keyOf(user),
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
	opts: { tier?: string; body?: unknown; user?: string; key?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
	const headers: Record<string, string> = { ...headersFor(opts.tier ?? 'friend', opts.user), ...(opts.key === undefined ? {} : { 'x-user-key': opts.key }), ...opts.headers };
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

	it('reads the catalogue again once the import tool rewrites it, and not before', async () => {
		const dir = await tempDir();
		await writeCatalogue(dir, [TAKE]);
		const h = await openApp(dir);
		const files = async () => ((await call(h, 'GET', '/api/sounds/catalogue')).json() as { takes: { file: string }[] }).takes.map((t) => t.file);
		expect(await files()).toEqual([TAKE.file]);
		expect(await files()).toEqual([TAKE.file]);
		await writeCatalogue(dir, [TAKE, { ...TAKE, file: 'm-win/take-synth-2.ogg' }]);
		expect(await files()).toEqual([TAKE.file, 'm-win/take-synth-2.ogg']);
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
		expect(res.json()).toEqual({ cells: {}, gains: {}, names: {}, versions: {}, pack: '', canEdit: false });
	});

	it('canEdit is true only for admin', async () => {
		const h = await openApp(await tempDir());
		// The whole ladder, from edge-auth: a tier added there is checked here without anyone
		// remembering to list it (hadoku_site's tier audit, 2026-10-07).
		for (const tier of TIER_ORDER) {
			const res = await call(h, 'GET', '/api/sounds/assignments', { tier });
			if (TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf('friend')) {
				// Below the default friend floor (public, member): refused outright,
				// never a read with canEdit false.
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

describe('GET /api/sounds/audio/:folder/:file', () => {
	it('serves the bytes as audio/ogg, revalidated rather than cached blind', async () => {
		const dir = await tempDir();
		await writeTakeFile(dir, 'm-win/take-synth-1.ogg', 'fake-ogg-bytes');
		const h = await openApp(dir);
		const res = await call(h, 'GET', '/api/sounds/audio/m-win/take-synth-1.ogg');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('audio/ogg');
		expect(res.headers.get('cache-control')).toBe('no-cache');
		expect(res.headers.get('etag')).toMatch(/^W\/"[\w-]+"$/);
		expect(res.text).toBe('fake-ogg-bytes');
	});

	it('answers 304 for an unchanged take, and the new bytes once it is re-cut in place', async () => {
		const dir = await tempDir();
		await writeTakeFile(dir, 'm-win/take-synth-1.ogg', 'first cut');
		const h = await openApp(dir);
		const first = await call(h, 'GET', '/api/sounds/audio/m-win/take-synth-1.ogg');
		const etag = first.headers.get('etag')!;
		// A browser revalidating from its cache. A bare conditional `fetch` would also send
		// `cache-control: no-cache` (the Fetch spec's rule for hand-set conditionals), which asks for
		// the bytes again, so the header is set the way a revalidation sends it.
		const revalidate = { ...headersFor('friend'), 'if-none-match': etag, 'cache-control': 'max-age=0' };
		const again = await fetch(`${h.base}/api/sounds/audio/m-win/take-synth-1.ogg`, { headers: revalidate });
		expect(again.status).toBe(304);

		await writeTakeFile(dir, 'm-win/take-synth-1.ogg', 'second, longer cut');
		const recut = await fetch(`${h.base}/api/sounds/audio/m-win/take-synth-1.ogg`, { headers: revalidate });
		expect(recut.status).toBe(200);
		expect(await recut.text()).toBe('second, longer cut');
	});

	it('keeps a take for good only at the version /assignments gives, and a re-cut moves it to a new one', async () => {
		const dir = await tempDir();
		await writeTakeFile(dir, 'm-win/take-synth-1.ogg', 'first cut');
		await writeFile(join(dir, 'assignments.json'), JSON.stringify({ cells: { 'g.draw|play': ['m-win/take-synth-1.ogg'] }, gains: {} }), 'utf8');
		const h = await openApp(dir);
		const versionNow = async () => ((await call(h, 'GET', '/api/sounds/assignments')).json() as { versions: Record<string, string> }).versions['m-win/take-synth-1.ogg']!;
		const first = await versionNow();
		const at = (v: string) => call(h, 'GET', `/api/sounds/audio/m-win/take-synth-1.ogg?v=${encodeURIComponent(v)}`);
		expect((await at(first)).headers.get('cache-control')).toBe('private, max-age=31536000, immutable');

		await writeTakeFile(dir, 'm-win/take-synth-1.ogg', 'second, longer cut');
		const second = await versionNow();
		expect(second).not.toBe(first);
		const stale = await at(first);
		expect(stale.headers.get('cache-control')).toBe('no-cache');
		expect(stale.text).toBe('second, longer cut');
		expect((await at(second)).headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
	});

	it('answers a range with just those bytes', async () => {
		const dir = await tempDir();
		await writeTakeFile(dir, 'm-win/take-synth-1.ogg', '0123456789');
		const h = await openApp(dir);
		const res = await fetch(`${h.base}/api/sounds/audio/m-win/take-synth-1.ogg`, { headers: { ...headersFor('friend'), range: 'bytes=2-5' } });
		expect(res.status).toBe(206);
		expect(await res.text()).toBe('2345');
	});

	it('packs every cue take, no music, kept for good at the version /assignments gives, and a re-cut moves it', async () => {
		const dir = await tempDir();
		await writeTakeFile(dir, 'm-win/take-synth-1.ogg', 'win');
		await writeTakeFile(dir, 'g-draw/take-1.ogg', 'draw');
		await writeTakeFile(dir, 'music-web/take-1.ogg', 'a long loop');
		const cells = { 'g.draw|play': ['g-draw/take-1.ogg'], 'ui.select|play': ['m-win/take-synth-1.ogg'], 'music.match|play': ['music-web/take-1.ogg'] };
		await writeFile(join(dir, 'assignments.json'), JSON.stringify({ cells, gains: {} }), 'utf8');
		const h = await openApp(dir);
		const packNow = async () => ((await call(h, 'GET', '/api/sounds/assignments')).json() as { pack: string }).pack;
		const first = await packNow();
		const get = (v: string, extra: Record<string, string> = {}) => fetch(`${h.base}/api/sounds/pack?v=${encodeURIComponent(v)}`, { headers: { ...headersFor('friend'), ...extra } });

		const res = await get(first);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
		const takes = decodeSoundPack(await res.arrayBuffer())!;
		expect(Object.fromEntries([...takes].map(([f, b]) => [f, new TextDecoder().decode(b)]))).toEqual({ 'g-draw/take-1.ogg': 'draw', 'm-win/take-synth-1.ogg': 'win' });
		const etag = res.headers.get('etag')!;
		expect((await get(first, { 'if-none-match': etag, 'cache-control': 'max-age=0' })).status).toBe(304);

		await writeTakeFile(dir, 'g-draw/take-1.ogg', 'a new draw');
		const second = await packNow();
		expect(second).not.toBe(first);
		const stale = await get(first);
		expect(stale.headers.get('cache-control')).toBe('no-cache');
		expect(new TextDecoder().decode(decodeSoundPack(await stale.arrayBuffer())!.get('g-draw/take-1.ogg'))).toBe('a new draw');
	});

	it('no longer answers the old immutable path', async () => {
		const dir = await tempDir();
		await writeTakeFile(dir, 'm-win/take-synth-1.ogg');
		const h = await openApp(dir);
		expect((await call(h, 'GET', '/api/sounds/takes/m-win/take-synth-1.ogg')).status).toBe(404);
	});

	it('404s a well-formed path that does not exist', async () => {
		const h = await openApp(await tempDir());
		const res = await call(h, 'GET', '/api/sounds/audio/m-win/take-ghost.ogg');
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
			'/api/sounds/audio/..%2F..%2Fetc/take-1.ogg', // encoded slash, dotdot folder
			'/api/sounds/audio/etc/..%2F..%2Fsecret.ogg', // encoded slash in file
			'/api/sounds/audio/%2Fetc/take-1.ogg', // encoded leading slash (absolute-looking)
			'/api/sounds/audio/m-win/take-1.wav', // wrong extension
			'/api/sounds/audio/M-Win/take-1.ogg', // uppercase folder
			'/api/sounds/audio/m-win/other-1.ogg', // missing take- prefix
		];
		for (const path of attempts) {
			const res = await call(h, 'GET', path);
			expect(res.status, path).toBe(400);
			expect(res.text).not.toContain('top secret');
		}

		await rm(secretPath, { force: true });
	});
});

/* ── retiring a take, and undoing it ────────────────────────────────── */

describe('POST /api/sounds/retire and /restore', () => {
	async function seeded(): Promise<{ dir: string; h: Harness }> {
		const dir = await tempDir();
		await writeCatalogue(dir, [TAKE, TAKE2]);
		await writeTakeFile(dir, TAKE.file, 'victory bytes');
		await writeTakeFile(dir, TAKE2.file);
		const h = await openApp(dir);
		for (const cell of ['g.win|play', 'g.lose|play']) {
			expect((await call(h, 'PUT', cellPath(cell), { tier: 'admin', body: { files: [TAKE.file, TAKE2.file] } })).status).toBe(200);
		}
		return { dir, h };
	}

	it('takes it out of the catalogue and every cell, keeps its audio aside, and logs why', async () => {
		const { dir, h } = await seeded();
		const res = await call(h, 'POST', '/api/sounds/retire', { tier: 'admin', body: { file: TAKE.file, reason: 'broken' } });
		expect(res.status).toBe(200);
		expect(res.json()).toEqual({ file: TAKE.file, reason: 'broken', cells: ['g.win|play', 'g.lose|play'] });

		expect(((await call(h, 'GET', '/api/sounds/catalogue')).json() as { takes: { file: string }[] }).takes.map((t) => t.file)).toEqual([TAKE2.file]);
		const { cells } = (await call(h, 'GET', '/api/sounds/assignments')).json() as { cells: Record<string, string[]> };
		expect(cells).toEqual({ 'g.win|play': [TAKE2.file], 'g.lose|play': [TAKE2.file] });
		expect((await call(h, 'GET', `/api/sounds/audio/${TAKE.file}`)).status).toBe(404);
		expect(await readFile(join(dir, 'retired', TAKE.file), 'utf8')).toBe('victory bytes');

		const lines = (await readFile(join(dir, 'retired.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ action: 'retire', file: TAKE.file, reason: 'broken', take: TAKE, cells: ['g.win|play', 'g.lose|play'] });
		expect(typeof lines[0].at).toBe('string');
	});

	it('restore puts it back exactly: catalogue entry, cells and audio', async () => {
		const { h } = await seeded();
		await call(h, 'POST', '/api/sounds/retire', { tier: 'admin', body: { file: TAKE.file, reason: 'bad' } });
		const res = await call(h, 'POST', '/api/sounds/restore', { tier: 'admin', body: { file: TAKE.file } });
		expect(res.status).toBe(200);
		expect(((await call(h, 'GET', '/api/sounds/catalogue')).json() as { takes: { file: string }[] }).takes).toContainEqual(TAKE);
		const { cells } = (await call(h, 'GET', '/api/sounds/assignments')).json() as { cells: Record<string, string[]> };
		expect(cells['g.win|play']).toEqual([TAKE2.file, TAKE.file]);
		expect((await call(h, 'GET', `/api/sounds/audio/${TAKE.file}`)).text).toBe('victory bytes');
		// Nothing left to undo.
		expect((await call(h, 'POST', '/api/sounds/restore', { tier: 'admin', body: { file: TAKE.file } })).status).toBe(404);
	});

	it('is admin-only, refuses a reason it does not know, and 404s a take that is not in the catalogue', async () => {
		const { h } = await seeded();
		expect((await call(h, 'POST', '/api/sounds/retire', { tier: 'friend', body: { file: TAKE.file, reason: 'bad' } })).status).toBe(403);
		expect((await call(h, 'POST', '/api/sounds/restore', { tier: 'friend', body: { file: TAKE.file } })).status).toBe(403);
		expect((await call(h, 'POST', '/api/sounds/retire', { tier: 'admin', body: { file: TAKE.file, reason: 'meh' } })).status).toBe(400);
		expect((await call(h, 'POST', '/api/sounds/retire', { tier: 'admin', body: { file: 'm-win/take-ghost.ogg', reason: 'bad' } })).status).toBe(404);
		expect(((await call(h, 'GET', '/api/sounds/catalogue')).json() as { takes: { file: string }[] }).takes).toHaveLength(2);
	});
});

/* ── keep / delete marks ────────────────────────────────────────────── */

describe('GET and PUT /api/sounds/marks', () => {
	it('sets, changes and clears a take’s mark, and anyone may read them', async () => {
		const dir = await tempDir();
		await writeCatalogue(dir, [TAKE, TAKE2]);
		const h = await openApp(dir);
		expect((await call(h, 'GET', '/api/sounds/marks')).json()).toEqual({ marks: {} });
		expect((await call(h, 'PUT', '/api/sounds/marks', { tier: 'admin', body: { file: TAKE.file, mark: 'trash' } })).status).toBe(200);
		await call(h, 'PUT', '/api/sounds/marks', { tier: 'admin', body: { file: TAKE2.file, mark: 'keep' } });
		expect((await call(h, 'GET', '/api/sounds/marks', { tier: 'friend' })).json()).toEqual({ marks: { [TAKE.file]: 'trash', [TAKE2.file]: 'keep' } });
		await call(h, 'PUT', '/api/sounds/marks', { tier: 'admin', body: { file: TAKE.file, mark: null } });
		expect((await call(h, 'GET', '/api/sounds/marks')).json()).toEqual({ marks: { [TAKE2.file]: 'keep' } });
		// A label only: the take is still in the catalogue.
		expect(((await call(h, 'GET', '/api/sounds/catalogue')).json() as { takes: unknown[] }).takes).toHaveLength(2);
	});

	it('is admin-only to write, refuses an unknown mark, and 404s a take that is not in the catalogue', async () => {
		const dir = await tempDir();
		await writeCatalogue(dir, [TAKE]);
		const h = await openApp(dir);
		expect((await call(h, 'PUT', '/api/sounds/marks', { tier: 'friend', body: { file: TAKE.file, mark: 'keep' } })).status).toBe(403);
		expect((await call(h, 'PUT', '/api/sounds/marks', { tier: 'admin', body: { file: TAKE.file, mark: 'maybe' } })).status).toBe(400);
		expect((await call(h, 'PUT', '/api/sounds/marks', { tier: 'admin', body: { file: 'm-win/take-ghost.ogg', mark: 'keep' } })).status).toBe(404);
	});
});

/* ── the friend gate, on every route ────────────────────────────────── */

describe('every /api/sounds route is friend tier and above', () => {
	const ROUTES: { method: string; path: string; body?: unknown }[] = [
		{ method: 'GET', path: '/api/sounds/catalogue' },
		{ method: 'GET', path: `/api/sounds/audio/${TAKE.file}` },
		{ method: 'GET', path: '/api/sounds/assignments' },
		{ method: 'PUT', path: cellPath('g.win|play'), body: { files: [] } },
		{ method: 'POST', path: '/api/sounds/retire', body: { file: TAKE.file, reason: 'bad' } },
		{ method: 'POST', path: '/api/sounds/restore', body: { file: TAKE.file } },
		{ method: 'GET', path: '/api/sounds/marks' },
		{ method: 'PUT', path: '/api/sounds/marks', body: { file: TAKE.file, mark: 'keep' } },
		{ method: 'POST', path: '/api/sounds/music-review', body: { slots: {} } },
		{ method: 'GET', path: '/api/sounds/music-review/mine' },
		{ method: 'GET', path: '/api/sounds/music-review' },
	];

	it('below friend is refused before any route runs; friend and above get past the gate', async () => {
		const dir = await tempDir();
		await writeCatalogue(dir, [TAKE]);
		await writeTakeFile(dir, TAKE.file);
		const h = await openApp(dir);
		const below = TIER_ORDER.filter((t) => TIER_ORDER.indexOf(t) < TIER_ORDER.indexOf('friend'));
		expect(below).toEqual(['public', 'member']);
		for (const r of ROUTES) {
			for (const tier of [...below, 'not-a-tier']) {
				const res = await call(h, r.method, r.path, { tier, body: r.body });
				expect(res.status, `${tier} ${r.method} ${r.path}`).toBe(404);
				expect(res.text).toBe('not found');
			}
		}
		// Nothing a refused caller sent reached the disk.
		expect((await readdir(dir)).sort()).toEqual(['catalogue.json', 'takes']);
		for (const r of ROUTES) {
			const res = await call(h, r.method, r.path, { tier: 'friend', body: r.body });
			expect(res.status, `friend ${r.method} ${r.path}`).not.toBe(404);
		}
	});
});

describe('the music review is friend tier and above even when the app lets members in', () => {
	let mods: { sounds: typeof import('./sounds.ts'); edge: typeof import('../edge-auth.ts') };

	beforeAll(async () => {
		const saved = process.env.CARDTABLE_MIN_TIER;
		process.env.CARDTABLE_MIN_TIER = 'member';
		try {
			vi.resetModules();
			mods = { sounds: await import('./sounds.ts'), edge: await import('../edge-auth.ts') };
		} finally {
			if (saved === undefined) delete process.env.CARDTABLE_MIN_TIER;
			else process.env.CARDTABLE_MIN_TIER = saved;
		}
	});

	it('a member gets 403 from the music-review routes and writes nothing; the takes themselves stay open to them', async () => {
		const dir = await tempDir();
		await writeCatalogue(dir, [TAKE]);
		const h = await openApp(dir, mods);
		const post = await call(h, 'POST', '/api/sounds/music-review', { tier: 'member', body: { slots: {} } });
		const mine = await call(h, 'GET', '/api/sounds/music-review/mine', { tier: 'member' });
		expect(post.status).toBe(403);
		expect(mine.status).toBe(403);
		expect((await call(h, 'GET', '/api/sounds/music-review', { tier: 'member' })).status).toBe(403);
		expect(h.prefs.rows(MUSIC_REVIEW_APP_ID).size).toBe(0);
		expect((await readdir(dir)).sort()).toEqual(['catalogue.json']);
		expect((await call(h, 'GET', '/api/sounds/catalogue', { tier: 'member' })).status).toBe(200);
		expect((await call(h, 'GET', '/api/sounds/music-review/mine', { tier: 'friend' })).status).toBe(200);
	});

	it('a member the operator verifies passes the friend gate exactly as a friend; a forged verification past the edge does not', async () => {
		const dir = await tempDir();
		await writeCatalogue(dir, [TAKE]);
		const h = await openApp(dir, mods);
		const verified = { 'x-hadoku-verified': '1' };
		expect((await call(h, 'GET', '/api/sounds/music-review/mine', { tier: 'member', headers: verified })).status).toBe(200);
		expect((await call(h, 'POST', '/api/sounds/music-review', { tier: 'member', headers: verified, body: { slots: {} } })).status).not.toBe(403);
		// A plain member is refused as before.
		expect((await call(h, 'GET', '/api/sounds/music-review/mine', { tier: 'member' })).status).toBe(403);
		// No X-Edge-Auth: the verification is stripped with the rest, and the floor answers first.
		expect((await call(h, 'GET', '/api/sounds/music-review/mine', { tier: 'member', headers: { ...verified, 'x-edge-auth': '' } })).status).toBe(404);
		expect((await call(h, 'GET', '/api/sounds/music-review/mine', { tier: 'member', headers: { ...verified, 'x-edge-auth': 'forged' } })).status).toBe(404);
		// Admin stays admin's: a verification is not a promotion past friend (everyone's reviews, a mark).
		expect((await call(h, 'GET', '/api/sounds/music-review', { tier: 'member', headers: verified })).status).toBe(403);
		expect((await call(h, 'PUT', '/api/sounds/marks', { tier: 'member', headers: verified, body: {} })).status).toBe(403);
	});
});

/* ── the match-music review ─────────────────────────────────────────── */

describe('POST /api/sounds/music-review and GET /mine', () => {
	const music = (slug: string, name: string) => ({
		file: `music-${slug}/take-1.ogg`,
		sound: `music-${slug}`,
		name,
		group: 'Music',
		section: 'Music',
		label: name,
		seconds: 120,
		prompt: `${name} prompt`,
	});
	const WEB = music('dawnlight-sanctum', 'Dawnlight Sanctum');
	const JIG = music('w-tavern-jig', 'W · tavern jig');
	const FANFARE = music('w-heraldic-fanfare', 'W · heraldic fanfare');
	const SENATE = music('wu-clockwork-senate', 'WU · clockwork senate');
	const W = 'music.match.W|play';
	const WU = 'music.match.WU|play';

	async function reviewDir(): Promise<string> {
		const dir = await tempDir();
		await writeCatalogue(dir, [WEB, JIG, FANFARE, SENATE, TAKE]);
		await writeFile(join(dir, 'assignments.json'), JSON.stringify({ cells: { [W]: [WEB.file] }, gains: {} }), 'utf8');
		return dir;
	}

	it('names the takes the music cells hold, and only those', async () => {
		const dir = await reviewDir();
		await writeFile(join(dir, 'assignments.json'), JSON.stringify({ cells: { [W]: [WEB.file], 'g.draw|play': [TAKE.file] }, gains: {} }), 'utf8');
		const h = await openApp(dir);
		const res = await call(h, 'GET', '/api/sounds/assignments');
		expect((res.json() as { names: unknown }).names).toEqual({ [WEB.file]: WEB.name });
	});

	it('nobody has a review until they submit one', async () => {
		const h = await openApp(join(await tempDir(), 'does-not-exist'));
		const res = await call(h, 'GET', '/api/sounds/music-review/mine');
		expect(res.status).toBe(200);
		expect(res.json()).toEqual({ review: null });
	});

	it('a friend submits into their own prefs row; a new one replaces it; mine reads their own only', async () => {
		const dir = await reviewDir();
		const h = await openApp(dir);
		const first = await call(h, 'POST', '/api/sounds/music-review', {
			tier: 'friend',
			user: 'bob',
			body: { slots: { [W]: { picks: [JIG.file, FANFARE.file], ratings: { [WEB.file]: 'maybe', [FANFARE.file]: 'no' }, notes: { [JIG.file]: 'the jig' } } } },
		});
		expect(first.status).toBe(200);
		const rec = first.json() as { at: string; slots: unknown };
		expect(rec).toEqual({
			at: rec.at,
			slots: { [W]: { picks: [JIG.file, FANFARE.file], ratings: { [WEB.file]: 'maybe', [FANFARE.file]: 'no' }, notes: { [JIG.file]: 'the jig' } } },
		});
		expect(Number.isNaN(Date.parse(rec.at))).toBe(false);
		// The row is bob's, named by his key, and holds no name or id of its own.
		expect(h.prefs.rows(MUSIC_REVIEW_APP_ID).get('bob')?.blob).toEqual(rec);

		await call(h, 'POST', '/api/sounds/music-review', { tier: 'admin', user: 'alice', body: { slots: { [WU]: { picks: [SENATE.file] } } } });
		const second = await call(h, 'POST', '/api/sounds/music-review', {
			tier: 'friend',
			user: 'bob',
			body: { slots: { [W]: { picks: [WEB.file] }, [WU]: { notes: { [SENATE.file]: 'not this one' } } } },
		});
		expect(second.status).toBe(200);

		// Newest replaces older, whole: the first review's W ratings and notes are gone, not merged in.
		const bob = (await call(h, 'GET', '/api/sounds/music-review/mine', { user: 'bob' })).json() as { review: { slots: unknown } };
		expect(bob.review.slots).toEqual({
			[W]: { picks: [WEB.file], ratings: {}, notes: {} },
			[WU]: { picks: [], ratings: {}, notes: { [SENATE.file]: 'not this one' } },
		});
		expect([...h.prefs.rows(MUSIC_REVIEW_APP_ID).keys()].sort()).toEqual(['alice', 'bob']);
		const alice = (await call(h, 'GET', '/api/sounds/music-review/mine', { tier: 'admin', user: 'alice' })).json() as { review: { slots: unknown } };
		expect(alice.review.slots).toEqual({ [WU]: { picks: [SENATE.file], ratings: {}, notes: {} } });
		const carol = (await call(h, 'GET', '/api/sounds/music-review/mine', { user: 'carol' })).json();
		expect(carol).toEqual({ review: null });
		expect(logged).toContainEqual(expect.objectContaining({ event: 'sounds-music-review-saved', userId: 'bob', slots: 1 }));
		// No file: a review is the person's row, and nothing of it is kept here.
		expect(await readdir(dir)).not.toContain('music-reviews.jsonl');
	});

	it('an admin lists every review by userId; a friend may not', async () => {
		const dir = await reviewDir();
		const h = await openApp(dir);
		await call(h, 'POST', '/api/sounds/music-review', { user: 'bob', body: { slots: { [W]: { picks: [JIG.file] } } } });
		await call(h, 'POST', '/api/sounds/music-review', { user: 'carol', body: { slots: { [WU]: { picks: [SENATE.file] } } } });
		expect((await call(h, 'GET', '/api/sounds/music-review', { user: 'bob' })).status).toBe(403);
		const list = (await call(h, 'GET', '/api/sounds/music-review', { tier: 'admin', user: 'alice' })).json() as { reviews: { userId: string; slots: unknown }[] };
		expect(list.reviews.map((r) => [r.userId, r.slots])).toEqual([
			['bob', { [W]: { picks: [JIG.file], ratings: {}, notes: {} } }],
			['carol', { [WU]: { picks: [SENATE.file], ratings: {}, notes: {} } }],
		]);
		expect(list.reviews.every((r) => !('name' in r))).toBe(true);
	});

	it('refuses a slot that is not match music, a take its slot never offered, and a bad body — and stores nothing', async () => {
		const dir = await reviewDir();
		const h = await openApp(dir);
		const refused = [
			{ slots: { 'music.lobby|play': { picks: [WEB.file] } } },
			{ slots: { [W]: { picks: [SENATE.file] } } },
			{ slots: { [WU]: { ratings: { [JIG.file]: 'keep' } } } },
			{ slots: { [W]: { picks: [TAKE.file] } } },
			{ slots: { [W]: { ratings: { [JIG.file]: 'love' } } } },
			{ slots: { [W]: { picks: ['../../etc/passwd'] } } },
			{ picks: {} },
		];
		for (const body of refused) {
			const res = await call(h, 'POST', '/api/sounds/music-review', { body });
			expect(res.status, JSON.stringify(body)).toBe(400);
		}
		expect(h.prefs.rows(MUSIC_REVIEW_APP_ID).size).toBe(0);
	});

	it('a key prefs-api does not know stores nothing and answers 502, logged without the key', async () => {
		const dir = await reviewDir();
		const h = await openApp(dir);
		const res = await call(h, 'POST', '/api/sounds/music-review', { user: 'bob', body: { slots: { [W]: { picks: [JIG.file] } } }, key: 'nobody-knows-this-key' });
		expect(res.status).toBe(502);
		expect(h.prefs.rows(MUSIC_REVIEW_APP_ID).size).toBe(0);
		const line = logged.find((l) => l.event === 'sounds-music-review-prefs-error');
		expect(line).toMatchObject({ route: 'save', status: 403 });
		expect(JSON.stringify(logged)).not.toContain('nobody-knows-this-key');
	});

	it('a row that does not parse is no review, and is logged', async () => {
		const dir = await reviewDir();
		const h = await openApp(dir);
		h.prefs.rows(MUSIC_REVIEW_APP_ID).set('bob', { blob: { at: 7 }, version: 1, updatedAt: 0 });
		expect((await call(h, 'GET', '/api/sounds/music-review/mine', { user: 'bob' })).json()).toEqual({ review: null });
		expect(logged).toContainEqual({ event: 'sounds-music-review-bad-row', userId: 'bob' });
	});
});

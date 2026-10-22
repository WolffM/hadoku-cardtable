/**
 * Acceptance 2 (`docs/planning/wave73-2026-10-21.md`): a Cube Cobra import,
 * proven without the internet — the committed, trimmed fixture
 * (`fixtures/lsvcube-sample.json`, name + `scryfall_id` only, verified live
 * against `LSVCube` 2026-10-21) stands in for the network response via an
 * injected `fetchJson`. Checks:
 *
 *   - the stored file has no image field;
 *   - refresh overwrites it;
 *   - delete by a non-importer is refused 403.
 *
 * Plus `createCubeStore` directly, for the refusals and the ordering HTTP
 * alone would make slow and indirect to assert.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import type { CubeSummary, DraftCard, PoolVerdict } from '@hadoku/shared';
import { attachCubeRoutes, createCubeStore, CubeStoreRefusal, type CubeStore } from './cubes.ts';
import type { CardCatalog } from './catalog.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, 'fixtures', 'lsvcube-sample.json');

// w74 §G widened `CardCatalog` with `byPrinting`/`swap`; this file's own stand-in
// just needs to keep typechecking — none of these tests exercise either method.
const EMPTY_CATALOG: CardCatalog = { byName: () => null, byPrinting: () => null, swap: () => false };

function shortlistCard(name: string): DraftCard {
	return {
		cardId: `sl-${name}`,
		name,
		manaCost: [],
		manaValue: 0,
		colors: [],
		typeLine: 'Land',
		oracleText: '',
		setCode: 'LEA',
		collectorNumber: '1',
		rarity: 'common',
	};
}

const OK_CHECK = async (cards: readonly DraftCard[]): Promise<PoolVerdict> => ({ ok: true, cards: cards.length });

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeDirs(): Promise<{ shortlistDir: string; importDir: string }> {
	const shortlistDir = await mkdtemp(join(tmpdir(), 'cubes-shortlist-'));
	const importDir = await mkdtemp(join(tmpdir(), 'cubes-import-'));
	dirs.push(shortlistDir, importDir);
	await mkdir(shortlistDir, { recursive: true });
	await writeFile(
		join(shortlistDir, 'demo-cube.json'),
		JSON.stringify({ cube: 'Demo Cube', size: 2, cards: [shortlistCard('Forest'), shortlistCard('Island')] }),
		'utf8',
	);
	return { shortlistDir, importDir };
}

async function readFixture(): Promise<unknown> {
	return JSON.parse(await readFile(FIXTURE_PATH, 'utf8'));
}

describe('createCubeStore', () => {
	it('lists the shortlist (file order) when there are no imports', async () => {
		const { shortlistDir, importDir } = await makeDirs();
		const store = createCubeStore({ shortlistDir, importDir, catalog: EMPTY_CATALOG });
		expect(store.list()).toEqual([expect.objectContaining({ id: 'demo-cube', origin: 'shortlist', size: 2 })]);
	});

	it('cards() answers null for an id it does not know', async () => {
		const { shortlistDir, importDir } = await makeDirs();
		const store = createCubeStore({ shortlistDir, importDir, catalog: EMPTY_CATALOG });
		expect(store.cards('not-a-cube')).toBeNull();
	});

	it('imports the committed fixture: name + scryfallId only reach cards(), and the stored file has no image field', async () => {
		const { shortlistDir, importDir } = await makeDirs();
		const fixture = await readFixture();
		const store = createCubeStore({ shortlistDir, importDir, catalog: EMPTY_CATALOG, fetchJson: async () => fixture });

		const summary = await store.importLink('https://cubecobra.com/cube/overview/lsv-cube-fixture', 'fk:alice');
		expect(summary.origin).toBe('cubecobra');
		expect(summary.id).toBe('cc-lsv-cube-fixture');
		expect(summary.size).toBe(36);
		expect(summary.importedBy).toBe('fk:alice');

		const cards = store.cards(summary.id);
		expect(cards).toHaveLength(36);
		expect(cards?.[0]?.name).toBe('Giver of Runes');

		const onDisk = JSON.parse(await readFile(join(importDir, `${summary.id}.json`), 'utf8')) as { cards: unknown[] };
		expect(onDisk.cards).toHaveLength(36);
		for (const card of onDisk.cards) {
			expect(Object.keys(card as Record<string, unknown>).sort()).toEqual(['name', 'scryfallId']);
		}
		const serialised = JSON.stringify(onDisk);
		expect(serialised).not.toMatch(/image|art_crop|thumbnail|picture/i);
	});

	it('refresh overwrites the stored snapshot', async () => {
		const { shortlistDir, importDir } = await makeDirs();
		const fixtureA = (await readFixture()) as { name: string; cards: { mainboard: unknown[] } };
		let current: unknown = fixtureA;
		const store = createCubeStore({ shortlistDir, importDir, catalog: EMPTY_CATALOG, fetchJson: async () => current });

		const imported = await store.importLink('lsv-cube-fixture', 'fk:alice');
		expect(imported.size).toBe(36);

		const fixtureB = { name: 'LSV Cube (refreshed)', cards: { mainboard: fixtureA.cards.mainboard.slice(0, 5) } };
		current = fixtureB;
		const refreshed = await store.refresh(imported.id, 'fk:bob');
		expect(refreshed.id).toBe(imported.id);
		expect(refreshed.name).toBe('LSV Cube (refreshed)');
		expect(refreshed.size).toBe(5);
		expect(refreshed.refreshedAt).not.toBeNull();

		const onDisk = JSON.parse(await readFile(join(importDir, `${imported.id}.json`), 'utf8')) as { cards: unknown[]; name: string };
		expect(onDisk.cards).toHaveLength(5);
		expect(onDisk.name).toBe('LSV Cube (refreshed)');
		expect(store.cards(imported.id)).toHaveLength(5);
	});

	it('remove refuses a non-importer with a typed 403, and never silently no-ops', async () => {
		const { shortlistDir, importDir } = await makeDirs();
		const fixture = await readFixture();
		const store = createCubeStore({ shortlistDir, importDir, catalog: EMPTY_CATALOG, fetchJson: async () => fixture });
		const imported = await store.importLink('lsv-cube-fixture', 'fk:alice');

		expect(() => store.remove(imported.id, 'fk:bob')).toThrow(CubeStoreRefusal);
		let caught: unknown = null;
		try {
			store.remove(imported.id, 'fk:bob');
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(CubeStoreRefusal);
		expect((caught as CubeStoreRefusal).status).toBe(403);
		// Still there — the refusal did not silently no-op.
		expect(store.cards(imported.id)).not.toBeNull();

		store.remove(imported.id, 'fk:alice');
		expect(store.cards(imported.id)).toBeNull();
	});

	it('remove refuses a shortlist cube with 400, and an unknown id with 404', async () => {
		const { shortlistDir, importDir } = await makeDirs();
		const store = createCubeStore({ shortlistDir, importDir, catalog: EMPTY_CATALOG });
		expect(() => store.remove('demo-cube', 'fk:anyone')).toThrow(CubeStoreRefusal);
		let shortlistCaught: unknown = null;
		try {
			store.remove('demo-cube', 'fk:anyone');
		} catch (err) {
			shortlistCaught = err;
		}
		expect((shortlistCaught as CubeStoreRefusal).status).toBe(400);

		let unknownCaught: unknown = null;
		try {
			store.remove('does-not-exist', 'fk:anyone');
		} catch (err) {
			unknownCaught = err;
		}
		expect((unknownCaught as CubeStoreRefusal).status).toBe(404);
	});

	it('list() puts imports before the shortlist, newest import first', async () => {
		// Two import files written directly with controlled `importedAt` stamps —
		// no real-time wait: a wall-clock sleep between two `importLink` calls
		// would assert an ordering this test cannot actually control.
		const { shortlistDir, importDir } = await makeDirs();
		const older = { id: 'cc-older', name: 'Older', cubeCobraId: 'older', importedBy: 'fk:alice', importedAt: '2026-01-01T00:00:00.000Z', refreshedAt: null, verdict: null, cards: [{ name: 'Forest', scryfallId: null }] };
		const newer = { id: 'cc-newer', name: 'Newer', cubeCobraId: 'newer', importedBy: 'fk:bob', importedAt: '2026-06-01T00:00:00.000Z', refreshedAt: null, verdict: null, cards: [{ name: 'Island', scryfallId: null }] };
		await writeFile(join(importDir, `${older.id}.json`), JSON.stringify(older), 'utf8');
		await writeFile(join(importDir, `${newer.id}.json`), JSON.stringify(newer), 'utf8');

		const store = createCubeStore({ shortlistDir, importDir, catalog: EMPTY_CATALOG });
		const ids = store.list().map((c) => c.id);
		expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
		expect(ids.indexOf(older.id)).toBeLessThan(ids.indexOf('demo-cube'));
	});

	it('a card the catalog cannot resolve is still counted, with an empty typeLine', async () => {
		const { shortlistDir, importDir } = await makeDirs();
		const fixture = await readFixture();
		const store = createCubeStore({ shortlistDir, importDir, catalog: EMPTY_CATALOG, fetchJson: async () => fixture });
		const summary = await store.importLink('lsv-cube-fixture', 'fk:alice');
		const cards = store.cards(summary.id);
		expect(cards).toHaveLength(36);
		for (const card of cards ?? []) expect(card.typeLine).toBe('');
	});

	it('persists an imported cube across a restart (reloads importDir at construction)', async () => {
		const { shortlistDir, importDir } = await makeDirs();
		const fixture = await readFixture();
		const storeA = createCubeStore({ shortlistDir, importDir, catalog: EMPTY_CATALOG, fetchJson: async () => fixture });
		const imported = await storeA.importLink('lsv-cube-fixture', 'fk:alice');

		const storeB = createCubeStore({ shortlistDir, importDir, catalog: EMPTY_CATALOG });
		const summaries = storeB.list();
		expect(summaries.some((s) => s.id === imported.id && s.size === 36)).toBe(true);
	});
});

describe('attachCubeRoutes', () => {
	const servers: HttpServer[] = [];

	afterAll(async () => {
		for (const server of servers.splice(0)) await new Promise<void>((done) => server.close(() => done()));
	});

	async function openApp(store: CubeStore): Promise<string> {
		const app = express();
		const api = express.Router();
		attachCubeRoutes(api, { store, check: OK_CHECK, log: () => undefined });
		app.use('/api', api);
		const server = createServer(app);
		await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
		servers.push(server);
		return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	}

	async function call(
		base: string,
		method: string,
		path: string,
		as: string,
		body?: unknown,
	): Promise<{ status: number; json: unknown }> {
		const res = await fetch(`${base}${path}`, {
			method,
			headers: { 'x-user-id': `dev-${as}`, 'x-user-key': `fk:${as}`, 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await res.text();
		return { status: res.status, json: text === '' ? null : (JSON.parse(text) as unknown) };
	}

	it('imports over HTTP, attaching a verdict, and GET lists it first', async () => {
		const { shortlistDir, importDir } = await makeDirs();
		const fixture = await readFixture();
		const store = createCubeStore({ shortlistDir, importDir, catalog: EMPTY_CATALOG, fetchJson: async () => fixture });
		const base = await openApp(store);

		const imported = await call(base, 'POST', '/api/pools/cubes/import', 'alice', { link: 'lsv-cube-fixture' });
		expect(imported.status).toBe(201);
		const summary = imported.json as CubeSummary;
		expect(summary.size).toBe(36);
		expect(summary.verdict).toEqual({ ok: true, cards: 36 });

		const list = await call(base, 'GET', '/api/pools/cubes', 'alice');
		expect(list.status).toBe(200);
		const ids = (list.json as CubeSummary[]).map((c) => c.id);
		expect(ids[0]).toBe(summary.id);
		expect(ids).toContain('demo-cube');
	});

	it('refuses a bad link with 400', async () => {
		const { shortlistDir, importDir } = await makeDirs();
		const store = createCubeStore({ shortlistDir, importDir, catalog: EMPTY_CATALOG });
		const base = await openApp(store);
		const res = await call(base, 'POST', '/api/pools/cubes/import', 'alice', { link: 'https://example.com/not/cubecobra at all' });
		expect(res.status).toBe(400);
	});

	it('refuses a failed fetch with 400, and the cube is not saved', async () => {
		const { shortlistDir, importDir } = await makeDirs();
		const store = createCubeStore({
			shortlistDir,
			importDir,
			catalog: EMPTY_CATALOG,
			fetchJson: async () => {
				throw new Error('ECONNREFUSED');
			},
		});
		const base = await openApp(store);
		const res = await call(base, 'POST', '/api/pools/cubes/import', 'alice', { link: 'lsv-cube-fixture' });
		expect(res.status).toBe(400);
		const list = await call(base, 'GET', '/api/pools/cubes', 'alice');
		expect((list.json as CubeSummary[]).some((c) => c.origin === 'cubecobra')).toBe(false);
	});

	it('refresh overwrites, over HTTP', async () => {
		const { shortlistDir, importDir } = await makeDirs();
		const fixtureA = (await readFixture()) as { name: string; cards: { mainboard: unknown[] } };
		let current: unknown = fixtureA;
		const store = createCubeStore({ shortlistDir, importDir, catalog: EMPTY_CATALOG, fetchJson: async () => current });
		const base = await openApp(store);

		const imported = (await call(base, 'POST', '/api/pools/cubes/import', 'alice', { link: 'lsv-cube-fixture' })).json as CubeSummary;
		current = { name: 'Refreshed', cards: { mainboard: fixtureA.cards.mainboard.slice(0, 4) } };
		const refreshed = await call(base, 'POST', `/api/pools/cubes/${imported.id}/refresh`, 'bob');
		expect(refreshed.status).toBe(200);
		expect((refreshed.json as CubeSummary).size).toBe(4);
	});

	it('delete by a non-importer is refused 403; the importer succeeds', async () => {
		const { shortlistDir, importDir } = await makeDirs();
		const fixture = await readFixture();
		const store = createCubeStore({ shortlistDir, importDir, catalog: EMPTY_CATALOG, fetchJson: async () => fixture });
		const base = await openApp(store);

		const imported = (await call(base, 'POST', '/api/pools/cubes/import', 'alice', { link: 'lsv-cube-fixture' })).json as CubeSummary;

		const refusedDelete = await call(base, 'DELETE', `/api/pools/cubes/${imported.id}`, 'bob');
		expect(refusedDelete.status).toBe(403);

		const stillThere = await call(base, 'GET', '/api/pools/cubes', 'alice');
		expect((stillThere.json as CubeSummary[]).some((c) => c.id === imported.id)).toBe(true);

		const okDelete = await call(base, 'DELETE', `/api/pools/cubes/${imported.id}`, 'alice');
		expect(okDelete.status).toBe(204);

		const gone = await call(base, 'GET', '/api/pools/cubes', 'alice');
		expect((gone.json as CubeSummary[]).some((c) => c.id === imported.id)).toBe(false);
	});

	it('delete of a shortlist cube is refused 400', async () => {
		const { shortlistDir, importDir } = await makeDirs();
		const store = createCubeStore({ shortlistDir, importDir, catalog: EMPTY_CATALOG });
		const base = await openApp(store);
		const res = await call(base, 'DELETE', '/api/pools/cubes/demo-cube', 'alice');
		expect(res.status).toBe(400);
	});

	it('refresh/delete of an unknown id is 404', async () => {
		const { shortlistDir, importDir } = await makeDirs();
		const store = createCubeStore({ shortlistDir, importDir, catalog: EMPTY_CATALOG });
		const base = await openApp(store);
		expect((await call(base, 'POST', '/api/pools/cubes/nope/refresh', 'alice')).status).toBe(404);
		expect((await call(base, 'DELETE', '/api/pools/cubes/nope', 'alice')).status).toBe(404);
	});

	it("GET :id/cards answers the cube's cards — lane B preloads a plan's art from this before the deal", async () => {
		const { shortlistDir, importDir } = await makeDirs();
		const store = createCubeStore({ shortlistDir, importDir, catalog: EMPTY_CATALOG });
		const base = await openApp(store);
		const res = await call(base, 'GET', '/api/pools/cubes/demo-cube/cards', 'alice');
		expect(res.status).toBe(200);
		const cards = res.json as DraftCard[];
		expect(cards).toHaveLength(2);
		expect(cards.map((c) => c.name).sort()).toEqual(['Forest', 'Island']);
	});

	it('GET :id/cards is 404 for an unknown id', async () => {
		const { shortlistDir, importDir } = await makeDirs();
		const store = createCubeStore({ shortlistDir, importDir, catalog: EMPTY_CATALOG });
		const base = await openApp(store);
		const res = await call(base, 'GET', '/api/pools/cubes/nope/cards', 'alice');
		expect(res.status).toBe(404);
		expect(res.json).toEqual({ error: expect.any(String) });
	});
});

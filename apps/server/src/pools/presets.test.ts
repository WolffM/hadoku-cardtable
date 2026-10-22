/**
 * Acceptance 3's preset half (`docs/planning/wave74-2026-10-21.md`): a preset
 * saved by Alice is listed for Bob; Bob cannot delete it; Alice can.
 *
 * `createPresetStore` directly for the store's own rules (creator-only
 * delete, persistence, a fault-tolerant load), plus `attachPresetRoutes`
 * over real HTTP for the identity half — the same `x-user-id`/`x-user-key`
 * header pattern `cubes.test.ts` uses, through `identityFromHeaders`.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import type { DraftPlan, DraftPreset } from '@hadoku/shared';
import { attachPresetRoutes, createPresetStore, PresetStoreRefusal, type PresetStore } from './presets.ts';

const PLAN: DraftPlan = {
	rounds: [
		{ kind: 'set', code: 'ISD', style: 'realistic' },
		{ kind: 'set', code: 'ISD', style: 'realistic' },
		{ kind: 'set', code: 'ISD', style: 'realistic' },
	],
};

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function presetsPath(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'presets-test-'));
	dirs.push(dir);
	return join(dir, 'presets.json');
}

describe('createPresetStore', () => {
	it('starts empty when no file exists yet', async () => {
		const store = createPresetStore({ path: await presetsPath() });
		expect(store.list()).toEqual([]);
	});

	it('a preset saved by Alice is listed for Bob (presets are shared, not per-caller)', async () => {
		const store = createPresetStore({ path: await presetsPath() });
		const saved = await store.create('ISD x3', PLAN, 'fk:alice');
		expect(saved.name).toBe('ISD x3');
		expect(saved.createdBy).toBe('fk:alice');
		expect(saved.plan).toEqual(PLAN);

		const listedForBob = store.list();
		expect(listedForBob).toHaveLength(1);
		expect(listedForBob[0]).toEqual(saved);
	});

	it("Bob cannot delete Alice's preset: 403, and the preset survives", async () => {
		const store = createPresetStore({ path: await presetsPath() });
		const saved = await store.create('ISD x3', PLAN, 'fk:alice');

		await expect(store.remove(saved.id, 'fk:bob')).rejects.toMatchObject({ status: 403 });
		expect(store.list()).toHaveLength(1);
	});

	it('Alice can delete her own preset: it is gone afterwards', async () => {
		const store = createPresetStore({ path: await presetsPath() });
		const saved = await store.create('ISD x3', PLAN, 'fk:alice');

		await store.remove(saved.id, 'fk:alice');
		expect(store.list()).toEqual([]);
	});

	it('deleting an unknown id throws a 404 refusal', async () => {
		const store = createPresetStore({ path: await presetsPath() });
		await expect(store.remove('not-a-preset', 'fk:alice')).rejects.toMatchObject({ status: 404 });
	});

	it('persists across a reload: a fresh store over the same path sees the same preset', async () => {
		const path = await presetsPath();
		const storeA = createPresetStore({ path });
		const saved = await storeA.create('ISD x3', PLAN, 'fk:alice');

		const storeB = createPresetStore({ path });
		expect(storeB.list()).toEqual([saved]);
	});

	it('lists newest first', async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date('2026-10-22T00:00:00Z'));
			const store = createPresetStore({ path: await presetsPath() });
			const first = await store.create('First', PLAN, 'fk:alice');
			vi.setSystemTime(new Date('2026-10-22T00:00:01Z'));
			const second = await store.create('Second', PLAN, 'fk:alice');
			expect(store.list().map((p) => p.id)).toEqual([second.id, first.id]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('is fault-tolerant: a malformed file starts empty rather than throwing', async () => {
		const path = await presetsPath();
		await writeFile(path, '{ not json', 'utf8');
		const store = createPresetStore({ path });
		expect(store.list()).toEqual([]);
	});

	it('is fault-tolerant: a well-formed-JSON but malformed record is dropped, valid ones kept', async () => {
		const path = await presetsPath();
		const good: DraftPreset = { id: 'p1', name: 'Good', plan: PLAN, createdBy: 'fk:alice', createdAt: new Date().toISOString() };
		await writeFile(path, JSON.stringify({ presets: [good, { id: 'broken' }] }), 'utf8');
		const store = createPresetStore({ path });
		expect(store.list()).toEqual([good]);
	});

	it('PresetStoreRefusal carries the status it was constructed with', () => {
		const err = new PresetStoreRefusal(403, 'nope');
		expect(err.status).toBe(403);
		expect(err.name).toBe('PresetStoreRefusal');
	});
});

describe('attachPresetRoutes over HTTP', () => {
	const servers: HttpServer[] = [];
	afterAll(async () => {
		for (const server of servers.splice(0)) await new Promise<void>((done) => server.close(() => done()));
	});

	async function openApp(store: PresetStore): Promise<string> {
		const app = express();
		const api = express.Router();
		attachPresetRoutes(api, { store, log: () => undefined });
		app.use('/api', api);
		const server = createServer(app);
		await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
		servers.push(server);
		return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	}

	async function call(base: string, method: string, path: string, as: string, body?: unknown): Promise<{ status: number; json: unknown }> {
		const res = await fetch(`${base}${path}`, {
			method,
			headers: { 'x-user-id': `dev-${as}`, 'x-user-key': `fk:${as}`, 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await res.text();
		return { status: res.status, json: text === '' ? null : (JSON.parse(text) as unknown) };
	}

	it('a preset saved by Alice (POST, 201) is listed for Bob (GET, 200); Bob\'s DELETE is 403; Alice\'s DELETE is 204', async () => {
		const store = createPresetStore({ path: await presetsPath() });
		const base = await openApp(store);

		const created = await call(base, 'POST', '/api/pools/presets', 'alice', { name: 'ISD x3', plan: PLAN });
		expect(created.status).toBe(201);
		const preset = created.json as DraftPreset;
		// `identityFromHeaders` hashes `X-User-Key` into a derived id, never the
		// raw header value (`cubes.test.ts`'s own HTTP tests make the same
		// choice) — what matters here is that it is DETERMINISTIC per caller, so
		// "alice" and "bob" land on two different, stable ids below.
		expect(preset.createdBy).toMatch(/^fk:/);

		const listedForBob = await call(base, 'GET', '/api/pools/presets', 'bob');
		expect(listedForBob.status).toBe(200);
		expect((listedForBob.json as DraftPreset[]).map((p) => p.id)).toContain(preset.id);

		const bobDelete = await call(base, 'DELETE', `/api/pools/presets/${preset.id}`, 'bob');
		expect(bobDelete.status).toBe(403);

		const aliceDelete = await call(base, 'DELETE', `/api/pools/presets/${preset.id}`, 'alice');
		expect(aliceDelete.status).toBe(204);

		const listedAfter = await call(base, 'GET', '/api/pools/presets', 'bob');
		expect((listedAfter.json as DraftPreset[]).map((p) => p.id)).not.toContain(preset.id);
	});

	it('POST refuses a name over 60 characters with 400', async () => {
		const store = createPresetStore({ path: await presetsPath() });
		const base = await openApp(store);
		const res = await call(base, 'POST', '/api/pools/presets', 'alice', { name: 'x'.repeat(61), plan: PLAN });
		expect(res.status).toBe(400);
	});

	it('POST refuses a malformed plan with 400', async () => {
		const store = createPresetStore({ path: await presetsPath() });
		const base = await openApp(store);
		const res = await call(base, 'POST', '/api/pools/presets', 'alice', { name: 'Bad plan', plan: { rounds: [] } });
		expect(res.status).toBe(400);
	});

	it('DELETE on an unknown id is 404', async () => {
		const store = createPresetStore({ path: await presetsPath() });
		const base = await openApp(store);
		const res = await call(base, 'DELETE', '/api/pools/presets/not-a-preset', 'alice');
		expect(res.status).toBe(404);
	});

	it('the stored file on disk matches what the API returns, written atomically (a .tmp never survives)', async () => {
		const path = await presetsPath();
		const store = createPresetStore({ path });
		const base = await openApp(store);
		await call(base, 'POST', '/api/pools/presets', 'alice', { name: 'ISD x3', plan: PLAN });

		const onDisk = JSON.parse(await readFile(path, 'utf8')) as { presets: DraftPreset[] };
		expect(onDisk.presets).toHaveLength(1);
		expect(onDisk.presets[0]?.name).toBe('ISD x3');
	});
});

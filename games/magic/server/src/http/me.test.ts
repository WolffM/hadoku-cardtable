/**
 * `/api/me` against a real express app behind the edge's own middleware, over a real store
 * directory: each caller reads and writes only their own document.
 */

import express from 'express';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RateLimitConfig } from '@wolffm/rooms-server';
import { buildCardIndex, buildCatalog, type GameplayCard } from '@hadoku/carddata';
import { loadCardCatalog, printingsOf, type CardCatalog } from '../pools/catalog.ts';
import { createMagicUserStore, BUILT_DECKS_MAX, type MagicUserStore } from '../users/index.ts';

const EDGE_SECRET = 'test-edge-auth-secret';
const ALICE = 'a11ce000-7b3d-4a8e-9c56-2f0d1b8e6a03';
const BOB = 'b0b00000-2a4f-4e6b-8c9d-0f1e2d3c4b5a';
const BOLT_LEA = 'e8b7e2a3-6c1f-4f0e-9b1a-0d2c3b4a5f60';
const BOLT_M10 = 'e8b7e2a3-6c1f-4f0e-9b1a-0d2c3b4a5f61';
const SHOCK_M10 = '5c0c4000-6c1f-4f0e-9b1a-0d2c3b4a5f62';

/** A Scryfall card as `cards.jsonl` holds it, cut to what the catalog reads (`cards.test.ts`'s shape). */
const scryfall = (id: string, name: string, set: string, collector: string): GameplayCard =>
	({
		id,
		name,
		lang: 'en',
		layout: 'normal',
		set,
		set_name: set.toUpperCase(),
		set_type: 'expansion',
		collector_number: collector,
		released_at: '2009-07-17',
		type_line: 'Instant',
		oracle_text: '',
		mana_cost: '{R}',
		cmc: 1,
		colors: ['R'],
		rarity: 'common',
		games: ['paper'],
		artist: 'Someone',
	}) as GameplayCard;

/** A real catalog file, built by the nightly refresh's own code and loaded as the server loads it. */
let catalog: CardCatalog;

let meMod: typeof import('./me.ts');
let edgeMod: typeof import('@hadoku/game-server/edge-auth');

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	meMod = await import('./me.ts');
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-me-catalog-'));
	dirs.push(dir);
	const cards = [scryfall(BOLT_LEA, 'Lightning Bolt', 'lea', '161'), scryfall(BOLT_M10, 'Lightning Bolt', 'm10', '146'), scryfall(SHOCK_M10, 'Shock', 'm10', '158')];
	await writeFile(join(dir, 'cards.json'), `${JSON.stringify(buildCatalog(buildCardIndex(cards)))}\n`);
	catalog = loadCardCatalog(join(dir, 'cards.json'));
	edgeMod = await import('@hadoku/game-server/edge-auth');
});

const dirs: string[] = [];
const servers: HttpServer[] = [];
afterAll(async () => {
	for (const server of servers) await new Promise<void>((done) => server.close(() => done()));
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function openApp(opts: { rateLimit?: RateLimitConfig | null; now?: () => number } = {}): Promise<{ base: string; users: MagicUserStore; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-me-test-'));
	dirs.push(dir);
	const users = createMagicUserStore(join(dir, 'users'), () => undefined);
	const app = express();
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	const api = express.Router();
	meMod.attachMe(api, { users, printings: (name) => printingsOf(catalog, name), rateLimit: opts.rateLimit === undefined ? null : opts.rateLimit, log: () => undefined, ...(opts.now ? { now: opts.now } : {}) });
	app.use('/api', api);
	const server = createServer(app);
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	servers.push(server);
	return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, users, dir: join(dir, 'users') };
}

const headers = (userId: string | null): Record<string, string> => ({
	'x-edge-auth': EDGE_SECRET,
	'x-hadoku-tier': 'member',
	...(userId === null ? {} : { 'x-user-id': userId }),
	'content-type': 'application/json',
});

async function call(base: string, method: string, path: string, as: string | null = ALICE, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await fetch(`${base}${path}`, { method, headers: headers(as), body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await res.text();
	return { status: res.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

describe('/api/me', () => {
	it("answers an empty library for someone with no document, and writes nothing", async () => {
		const { base, dir } = await openApp();
		expect(await call(base, 'GET', '/api/me/library')).toEqual({ status: 200, json: { favourites: {}, decks: {}, built: [], poolFavourites: {} } });
		await expect(readdir(dir)).rejects.toThrow(/ENOENT/);
	});

	it('refuses a caller the edge named nobody', async () => {
		const { base } = await openApp();
		expect((await call(base, 'GET', '/api/me/library', null)).status).toBe(401);
		expect((await call(base, 'PUT', '/api/me/favourites/draft:pod-1', null, { on: true })).status).toBe(401);
	});

	it("stars and unstars a deck, only in the caller's own document", async () => {
		let t = 1_000;
		const { base } = await openApp({ now: () => t });
		expect(await call(base, 'PUT', '/api/me/favourites/draft:pod-1', ALICE, { on: true })).toEqual({ status: 200, json: { favourites: { 'draft:pod-1': 1_000 } } });
		t = 2_000;
		// Starring again keeps when it was first starred.
		await call(base, 'PUT', '/api/me/favourites/draft:pod-1', ALICE, { on: true });
		await call(base, 'PUT', '/api/me/favourites/built:abc', ALICE, { on: true });
		expect((await call(base, 'GET', '/api/me/library')).json.favourites).toEqual({ 'draft:pod-1': 1_000, 'built:abc': 2_000 });
		expect((await call(base, 'GET', '/api/me/library', BOB)).json.favourites).toEqual({});
		expect((await call(base, 'PUT', '/api/me/favourites/draft:pod-1', ALICE, { on: false })).json).toEqual({ favourites: { 'built:abc': 2_000 } });
	});

	it("stars and unstars a cube or a set, only in the caller's own document, apart from the decks", async () => {
		let t = 1_000;
		const { base } = await openApp({ now: () => t });
		expect(await call(base, 'PUT', '/api/me/pool-favourites/cube:cc-2plnt', ALICE, { on: true })).toEqual({ status: 200, json: { poolFavourites: { 'cube:cc-2plnt': 1_000 } } });
		t = 2_000;
		await call(base, 'PUT', '/api/me/pool-favourites/cube:cc-2plnt', ALICE, { on: true });
		await call(base, 'PUT', '/api/me/pool-favourites/set:ISD', ALICE, { on: true });
		const library = (await call(base, 'GET', '/api/me/library')).json;
		expect(library.poolFavourites).toEqual({ 'cube:cc-2plnt': 1_000, 'set:ISD': 2_000 });
		expect(library.favourites).toEqual({});
		expect((await call(base, 'GET', '/api/me/library', BOB)).json.poolFavourites).toEqual({});
		expect((await call(base, 'PUT', '/api/me/pool-favourites/set:ISD', ALICE, { on: false })).json).toEqual({ poolFavourites: { 'cube:cc-2plnt': 1_000 } });
		expect((await call(base, 'PUT', '/api/me/pool-favourites/cube:x', null, { on: true })).status).toBe(401);
	});

	it('refuses a pool key that is not a cube or a set, and a star past the cap', async () => {
		const { base, users } = await openApp();
		for (const key of ['deck:abc', 'cube:', 'set:IS D', 'cube']) expect((await call(base, 'PUT', `/api/me/pool-favourites/${encodeURIComponent(key)}`, ALICE, { on: true })).status).toBe(400);
		expect((await call(base, 'PUT', '/api/me/pool-favourites/set:ISD', ALICE, { on: 'yes' })).status).toBe(400);
		await users.update(ALICE, (d) => {
			for (let i = 0; i < meMod.FAVOURITES_MAX; i++) d.poolFavourites[`cube:c${i}`] = i;
		});
		expect(await call(base, 'PUT', '/api/me/pool-favourites/set:ISD', ALICE, { on: true })).toEqual({ status: 409, json: { error: `at most ${meMod.FAVOURITES_MAX} favourites` } });
		// At the cap, a star already kept and an unstar still answer.
		expect((await call(base, 'PUT', '/api/me/pool-favourites/cube:c0', ALICE, { on: true })).status).toBe(200);
		expect((await call(base, 'PUT', '/api/me/pool-favourites/cube:c0', ALICE, { on: false })).status).toBe(200);
	});

	it('refuses a malformed favourite', async () => {
		const { base } = await openApp();
		expect((await call(base, 'PUT', '/api/me/favourites/draft:pod-1', ALICE, { on: 'yes' })).status).toBe(400);
		expect((await call(base, 'PUT', '/api/me/favourites/draft:pod-1', ALICE, { on: true, extra: 1 })).status).toBe(400);
		expect((await call(base, 'PUT', `/api/me/favourites/${encodeURIComponent('a b')}`, ALICE, { on: true })).status).toBe(400);
	});

	it('saves, lists, updates and deletes a built deck, by either spelling of its id', async () => {
		let t = 10;
		const { base } = await openApp({ now: () => t });
		const deck = { name: 'Izzet Spells', format: 'modern', dck: '[metadata]\nName=Izzet Spells\n[Main]\n4 Lightning Bolt\n' };
		const saved = await call(base, 'PUT', '/api/me/built/0f9c2d6e-1111-4222-8333-944455556666', ALICE, deck);
		expect(saved).toEqual({ status: 200, json: { built: { id: 'built:0f9c2d6e-1111-4222-8333-944455556666', ...deck, createdAt: 10, updatedAt: 10 } } });
		t = 20;
		await call(base, 'PUT', '/api/me/built/built:0f9c2d6e-1111-4222-8333-944455556666', ALICE, { ...deck, name: 'Izzet Tempo' });
		await call(base, 'PUT', '/api/me/favourites/built:0f9c2d6e-1111-4222-8333-944455556666', ALICE, { on: true });
		const library = (await call(base, 'GET', '/api/me/library')).json;
		expect(library.built).toEqual([{ id: 'built:0f9c2d6e-1111-4222-8333-944455556666', ...deck, name: 'Izzet Tempo', createdAt: 10, updatedAt: 20 }]);
		expect((await call(base, 'GET', '/api/me/library', BOB)).json.built).toEqual([]);
		// Bob cannot delete Alice's deck: it is not in his document.
		expect((await call(base, 'DELETE', '/api/me/built/0f9c2d6e-1111-4222-8333-944455556666', BOB)).status).toBe(404);
		expect((await call(base, 'DELETE', '/api/me/built/0f9c2d6e-1111-4222-8333-944455556666')).status).toBe(204);
		const after = (await call(base, 'GET', '/api/me/library')).json;
		// Its star goes with it.
		expect(after).toEqual({ favourites: {}, decks: {}, built: [], poolFavourites: {} });
		expect((await call(base, 'DELETE', '/api/me/built/0f9c2d6e-1111-4222-8333-944455556666')).status).toBe(404);
	});

	it('refuses a built deck that is too big, unnamed, or past the limit', async () => {
		const { base, users } = await openApp();
		expect((await call(base, 'PUT', '/api/me/built/x1', ALICE, { name: 'Big', format: 'modern', dck: 'x'.repeat(16 * 1024 + 1) })).status).toBe(400);
		expect((await call(base, 'PUT', '/api/me/built/x1', ALICE, { name: ' ', format: 'modern', dck: '' })).status).toBe(400);
		expect((await call(base, 'PUT', '/api/me/built/a%2Fb', ALICE, { name: 'A', format: 'modern', dck: '' })).status).toBe(400);
		await users.update(ALICE, (d) => {
			for (let i = 0; i < BUILT_DECKS_MAX; i++) d.built[`built:n${i}`] = { name: `d${i}`, format: 'modern', dck: '', createdAt: i, updatedAt: i };
		});
		expect((await call(base, 'PUT', '/api/me/built/one-more', ALICE, { name: 'A', format: 'modern', dck: '' })).status).toBe(409);
		// Changing one already kept is not a new one.
		expect((await call(base, 'PUT', '/api/me/built/n3', ALICE, { name: 'Renamed', format: 'modern', dck: '' })).status).toBe(200);
	});

	it('keeps art rules, picks keyed by the normalised card name', async () => {
		const { base } = await openApp();
		expect(await call(base, 'GET', '/api/me/art')).toEqual({ status: 200, json: { oldest: false, picks: {} } });
		const put = await call(base, 'PUT', '/api/me/art', ALICE, { oldest: true, picks: { ' Lightning Bolt': BOLT_LEA } });
		expect(put).toEqual({ status: 200, json: { oldest: true, picks: { 'lightning bolt': BOLT_LEA } } });
		expect((await call(base, 'GET', '/api/me/art')).json).toEqual({ oldest: true, picks: { 'lightning bolt': BOLT_LEA } });
		expect((await call(base, 'GET', '/api/me/art', BOB)).json).toEqual({ oldest: false, picks: {} });
		expect((await call(base, 'PUT', '/api/me/art', ALICE, { oldest: true, picks: { Bolt: 'not-an-id' } })).status).toBe(400);
	});

	it('refuses a pick that is not a printing of its card, and keeps the rules it had', async () => {
		const { base } = await openApp();
		expect((await call(base, 'PUT', '/api/me/art', ALICE, { oldest: false, picks: { 'Lightning Bolt': BOLT_M10 } })).status).toBe(200);
		// Another card's printing, a card the catalog does not know, an id no card has.
		for (const picks of [{ 'Lightning Bolt': SHOCK_M10 }, { 'Not A Card': BOLT_LEA }, { 'Lightning Bolt': '00000000-0000-4000-8000-000000000000' }]) {
			const refused = await call(base, 'PUT', '/api/me/art', ALICE, { oldest: true, picks: { Shock: SHOCK_M10, ...picks } });
			expect(refused.status, JSON.stringify(picks)).toBe(400);
		}
		expect((await call(base, 'GET', '/api/me/art', ALICE)).json).toEqual({ oldest: false, picks: { 'lightning bolt': BOLT_M10 } });
	});

	it('limits writes per caller, never reads', async () => {
		const { base } = await openApp({ rateLimit: { capacity: 2, refillAmount: 1, refillIntervalMs: 60_000 } });
		expect((await call(base, 'PUT', '/api/me/favourites/d1', ALICE, { on: true })).status).toBe(200);
		expect((await call(base, 'PUT', '/api/me/favourites/d2', ALICE, { on: true })).status).toBe(200);
		expect((await call(base, 'PUT', '/api/me/favourites/d3', ALICE, { on: true })).status).toBe(429);
		expect((await call(base, 'PUT', '/api/me/favourites/d3', BOB, { on: true })).status).toBe(200);
		expect((await call(base, 'GET', '/api/me/library')).status).toBe(200);
		// A cube's star draws on the same budget.
		expect((await call(base, 'PUT', '/api/me/pool-favourites/set:ISD', ALICE, { on: true })).status).toBe(429);
		expect((await call(base, 'PUT', '/api/me/pool-favourites/set:ISD', BOB, { on: true })).status).toBe(200);
	});
});

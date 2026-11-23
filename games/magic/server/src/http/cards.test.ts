// @reads e2e/fixtures/sets-catalog.json
/**
 * `/api/cards/search` and `/api/cards/printings` over real HTTP, against a real catalog file: one
 * `build-catalog` writes from Scryfall-shaped cards (`buildCatalog`, the same code the nightly
 * refresh runs), loaded by `loadCardCatalog` as the server loads it. Plus the e2e stack's committed
 * catalog, which predates printing dates, to show an older file still answers.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCardIndex, buildCatalog } from '@hadoku/carddata';
import type { GameplayCard } from '@hadoku/carddata';
import { DraftCardSchema } from '@hadoku/shared';
import { z } from 'zod';

import { loadCardCatalog, printingsOf, searchCatalog, type CardCatalog } from '../pools/catalog.ts';
import { attachCards, type CardsDeps } from './cards.ts';

const servers: HttpServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise<void>((done) => server.close(() => done()));
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

let n = 0;
/** A Scryfall card as `cards.jsonl` holds it, cut to what the catalog reads. */
function card(name: string, set: string, collector: string, releasedAt: string, extra: Record<string, unknown> = {}): GameplayCard {
	n += 1;
	return {
		id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
		name,
		lang: 'en',
		layout: 'normal',
		set,
		set_name: set.toUpperCase(),
		set_type: 'expansion',
		collector_number: collector,
		released_at: releasedAt,
		type_line: 'Instant',
		oracle_text: '',
		mana_cost: '{R}',
		cmc: 1,
		colors: ['R'],
		rarity: 'common',
		games: ['paper'],
		artist: `Artist of ${set}`,
		...extra,
	} as GameplayCard;
}

const BOLT_M10 = card('Lightning Bolt', 'm10', '146', '2009-07-17');
const BOLT_LEA = card('Lightning Bolt', 'lea', '161', '1993-08-05', { artist: 'Christopher Rush' });
const BOLT_2ED = card('Lightning Bolt', '2ed', '162', '1993-12-01');
const BOLT_DIGITAL = card('Lightning Bolt', 'prm', '35932', '1990-01-01', { digital: true, games: ['mtgo'] });
const BOLT_ARENA = card('Lightning Bolt', 'sta', '42', '1991-01-01', { games: ['arena'] });
const BOLT_ALCHEMY = card('Lightning Bolt', 'ymid', '44', '1989-01-01', { digital: true, games: ['arena'], set_type: 'alchemy' });
const HELIX = card('Lightning Helix', 'rav', '213', '2005-10-07');
const CHAIN = card('Chain Lightning', 'leg', '137', '1994-06-01', { type_line: 'Sorcery' });
const BOLT_TOKEN = card('Lightning Elemental Token', 'tm10', '5', '2009-07-17', { type_line: 'Token Creature — Elemental' });
const PLANE = card('Lightning Plane', 'hop', '9', '2009-09-04', { type_line: 'Plane — Lightningland' });
const SHOCK = card('Shock', 'm10', '158', '2009-07-17');

const CORPUS = [BOLT_M10, BOLT_LEA, BOLT_2ED, BOLT_DIGITAL, BOLT_ARENA, BOLT_ALCHEMY, HELIX, CHAIN, BOLT_TOKEN, PLANE, SHOCK];

async function catalogOf(cards: readonly GameplayCard[]): Promise<CardCatalog> {
	const dir = await mkdtemp(join(tmpdir(), 'cards-test-'));
	dirs.push(dir);
	const path = join(dir, 'cards.json');
	await writeFile(path, `${JSON.stringify(buildCatalog(buildCardIndex(cards)))}\n`);
	return loadCardCatalog(path);
}

async function serve(deps: CardsDeps) {
	const app = express();
	const api = express.Router();
	attachCards(api, { log: () => undefined, ...deps });
	app.use('/api', api);
	const server = createServer(app);
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	servers.push(server);
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return async (path: string, as = 'alice'): Promise<{ status: number; json: unknown }> => {
		const res = await fetch(`${base}${path}`, { headers: { 'x-user-id': `dev-${as}`, 'x-user-key': `fk:${as}` } });
		return { status: res.status, json: await res.json() };
	};
}

const SearchBody = z.strictObject({ cards: z.array(DraftCardSchema) });
const PrintingsBody = z.strictObject({
	name: z.string(),
	printings: z.array(z.strictObject({ scryfallId: z.string(), set: z.string(), collectorNumber: z.string(), releasedAt: z.string().nullable(), artist: z.string().nullable() })),
});

describe('GET /api/cards/printings', () => {
	it('a card\'s paper printings, oldest first: no digital-only, Arena-only or Alchemy printing', async () => {
		const get = await serve({ catalog: await catalogOf(CORPUS), rateLimit: null });
		const res = await get('/api/cards/printings?name=lightning%20bolt');
		expect(res.status).toBe(200);
		const body = PrintingsBody.parse(res.json);
		expect(body.name).toBe('Lightning Bolt');
		expect(body.printings).toEqual([
			{ scryfallId: BOLT_LEA.id, set: 'LEA', collectorNumber: '161', releasedAt: '1993-08-05', artist: 'Christopher Rush' },
			{ scryfallId: BOLT_2ED.id, set: '2ED', collectorNumber: '162', releasedAt: '1993-12-01', artist: 'Artist of 2ed' },
			{ scryfallId: BOLT_M10.id, set: 'M10', collectorNumber: '146', releasedAt: '2009-07-17', artist: 'Artist of m10' },
		]);
	});

	it('a name nobody printed is a 404; a missing or empty name a 400', async () => {
		const get = await serve({ catalog: await catalogOf(CORPUS), rateLimit: null });
		expect((await get('/api/cards/printings?name=Not%20A%20Card')).status).toBe(404);
		expect((await get('/api/cards/printings')).status).toBe(400);
		expect((await get('/api/cards/printings?name=%20')).status).toBe(400);
		expect((await get('/api/cards/printings?name=a&name=b')).status).toBe(400);
	});

	it('a catalog built before printings carried dates still answers, undated, by set and number', () => {
		const old = loadCardCatalog(resolve(import.meta.dirname, '../../../../../e2e/fixtures/sets-catalog.json'));
		const plains = printingsOf(old, 'Plains');
		expect(plains?.printings.length).toBeGreaterThan(1);
		expect(plains?.printings.every((p) => p.releasedAt === null && p.artist === null)).toBe(true);
		const ala = plains!.printings.filter((p) => p.set === 'ALA').map((p) => Number(p.collectorNumber));
		expect(ala).toEqual([...ala].sort((a, b) => a - b));
	});

	it('a stand-in catalog, not loaded from a file, has no printings and finds nothing', () => {
		const standIn: CardCatalog = { byName: () => null, byNameInSet: () => null, byPrinting: () => null, isAlchemy: () => false, swap: () => false };
		expect(printingsOf(standIn, 'Lightning Bolt')).toBeNull();
		expect(searchCatalog(standIn, 'bolt')).toEqual([]);
	});
});

describe('GET /api/cards/search', () => {
	it('name prefix first, then substring, each by name; tokens and planes never', async () => {
		const get = await serve({ catalog: await catalogOf(CORPUS), rateLimit: null });
		const res = await get('/api/cards/search?q=Lightning');
		expect(res.status).toBe(200);
		expect(SearchBody.parse(res.json).cards.map((c) => c.name)).toEqual(['Lightning Bolt', 'Lightning Helix', 'Chain Lightning']);
		expect(SearchBody.parse((await get('/api/cards/search?q=BOLT')).json).cards.map((c) => c.name)).toEqual(['Lightning Bolt']);
	});

	it('limit caps the answer, and a prefix match outranks a substring one even past the limit', async () => {
		const get = await serve({ catalog: await catalogOf(CORPUS), rateLimit: null });
		expect(SearchBody.parse((await get('/api/cards/search?q=lightning&limit=1')).json).cards.map((c) => c.name)).toEqual(['Lightning Bolt']);
		// "Chain Lightning" sorts before both prefix matches but is only a substring match.
		expect(SearchBody.parse((await get('/api/cards/search?q=lightning&limit=2')).json).cards.map((c) => c.name)).toEqual(['Lightning Bolt', 'Lightning Helix']);
	});

	it('sets narrows it to an era, each card as the first listed set printed it', async () => {
		const get = await serve({ catalog: await catalogOf(CORPUS), rateLimit: null });
		const m10 = SearchBody.parse((await get('/api/cards/search?q=l&sets=M10')).json).cards;
		expect(m10.map((c) => [c.name, c.setCode, c.scryfallId])).toEqual([['Lightning Bolt', 'M10', BOLT_M10.id]]);
		const old = SearchBody.parse((await get('/api/cards/search?q=lightning&sets=2ed,LEG')).json).cards;
		expect(old.map((c) => [c.name, c.setCode])).toEqual([['Lightning Bolt', '2ED'], ['Chain Lightning', 'LEG']]);
	});

	it('refuses a missing query, a bad limit and a bad set list', async () => {
		const get = await serve({ catalog: await catalogOf(CORPUS), rateLimit: null });
		for (const path of ['/api/cards/search', '/api/cards/search?q=', '/api/cards/search?q=a&limit=0', '/api/cards/search?q=a&limit=101', '/api/cards/search?q=a&limit=1.5', '/api/cards/search?q=a&sets=M10,<x>']) {
			expect((await get(path)).status, path).toBe(400);
		}
	});

	it('is limited per caller: a burst past the limit is a 429, and another caller is not held by it', async () => {
		const get = await serve({ catalog: await catalogOf(CORPUS), rateLimit: { capacity: 2, refillAmount: 1, refillIntervalMs: 60_000 } });
		expect((await get('/api/cards/search?q=bolt')).status).toBe(200);
		expect((await get('/api/cards/printings?name=Shock')).status).toBe(200);
		expect((await get('/api/cards/search?q=bolt')).status).toBe(200);
		expect((await get('/api/cards/search?q=bolt')).status).toBe(429);
		expect((await get('/api/cards/search?q=bolt', 'bob')).status).toBe(200);
	});
});

/**
 * `/api/rally` over real HTTP, against the real stores: the shortlist cubes this server ships
 * (`pools/cubes`), a preset store on a temp file, and a sets store whose only stand-in is Forge
 * itself (no jar in a unit run; `pools/sets.test.ts` fakes it the same way).
 *
 * What Rally checks is checked here with Rally's own rules (`@hadoku/shared`'s rally schemas, which
 * copy them): ids, labels, the image hosts, the `{ success, data }` wrapper.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	RallyCardsViewSchema,
	RallyPackViewSchema,
	RallySourceSchema,
	RallySuggestionSchema,
	rallyEnvelope,
	type DraftPlan,
} from '@hadoku/shared';
import { z } from 'zod';

import { createCubeStore } from '../pools/cubes.ts';
import type { BoosterCard, SetSummary as ForgeSetSummary } from '../pools/forge.ts';
import { createPresetStore } from '../pools/presets.ts';
import type { CardCatalog } from '../pools/catalog.ts';
import { createSetsStore } from '../pools/sets.ts';
import { attachRally, SYMBOLS_PATH, type RallyDeps } from './rally.ts';
import { rallySymbols, setGlyphs } from './rally-symbols.ts';

const SHORTLIST_DIR = resolve(import.meta.dirname, '../../pools/cubes');
const SYMBOLS_DIR = resolve(import.meta.dirname, '../../../ui/src/symbols');
const PAUPER = 'the-pauper-cube-2026-02';
const VINTAGE = 'mtgo-vintage-cube-2025-04';

const EMPTY_CATALOG: CardCatalog = { byName: () => null, byNameInSet: () => null, byPrinting: () => null, isAlchemy: () => false, swap: () => false };

const ALA: ForgeSetSummary = { code: 'ALA', name: 'Shards of Alara', date: '2008-10-03', type: 'Expansion' };
const ARB: ForgeSetSummary = { code: 'ARB', name: 'Alara Reborn', date: '2009-04-30', type: 'Expansion' };

const names = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

/** Forge's booster: fifteen cards of `code`, a different fifteen for every seed. */
function booster(code: string, seed: string): BoosterCard[] {
	return names(`${code} ${seed}`, 15).map((name, i) => ({ name, set: code, collectorNumber: String(i + 1), foil: i === 14 }));
}

const servers: HttpServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise<void>((done) => server.close(() => done()));
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(opts: { jar?: boolean; packRateLimit?: RallyDeps['packRateLimit']; symbolsDir?: string } = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'rally-test-'));
	dirs.push(dir);
	const boosters = vi.fn(async (code: string, count: number, seed: string) => Array.from({ length: count }, () => booster(code, seed)));
	const forge = {
		sets: async () => [ARB, ALA],
		setCards: async (code: string) => names(code, 249),
		boosters,
	};
	const cubes = createCubeStore({ shortlistDir: SHORTLIST_DIR, importDir: join(dir, 'imports'), catalog: EMPTY_CATALOG });
	const sets = createSetsStore({ forge, catalog: EMPTY_CATALOG, sampleBoosters: 1, log: () => undefined });
	const presets = createPresetStore({ path: join(dir, 'presets.json') });

	const app = express();
	const api = express.Router();
	attachRally(api, {
		symbols: rallySymbols(opts.symbolsDir ?? SYMBOLS_DIR),
		cubes,
		sets,
		presets,
		boosters: opts.jar === false ? null : forge,
		catalog: EMPTY_CATALOG,
		packRateLimit: opts.packRateLimit ?? null,
		log: () => undefined,
	});
	app.use('/api', api);
	const server = createServer(app);
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	servers.push(server);
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	async function get(path: string, as = 'alice'): Promise<{ status: number; headers: Headers; json: unknown }> {
		const res = await fetch(`${base}${path}`, { headers: { 'x-user-id': `dev-${as}`, 'x-user-key': `fk:${as}` } });
		return { status: res.status, headers: res.headers, json: await res.json() };
	}
	async function raw(path: string): Promise<{ status: number; type: string | null; body: Buffer }> {
		const res = await fetch(`${base}${path}`, { headers: { 'x-user-id': 'dev-alice', 'x-user-key': 'fk:alice' } });
		return { status: res.status, type: res.headers.get('content-type'), body: Buffer.from(await res.arrayBuffer()) };
	}
	return { get, raw, presets, boosters };
}

const SourcesBody = rallyEnvelope(z.strictObject({ sources: z.array(RallySourceSchema), symbols: z.literal(SYMBOLS_PATH) }));
const OptionsBody = rallyEnvelope(z.strictObject({ suggestions: z.array(RallySuggestionSchema).max(8) }));
const CardsBody = rallyEnvelope(RallyCardsViewSchema);
const PackBody = rallyEnvelope(RallyPackViewSchema);

function data<T>(schema: z.ZodType<{ success: true; data: T } | { success: false; error: string }>, json: unknown): T {
	const body = schema.parse(json);
	if (!body.success) throw new Error(`expected success, got ${body.error}`);
	return body.data;
}

const MIXED: DraftPlan = {
	rounds: [
		{ kind: 'set', code: 'ALA', style: 'realistic' },
		{ kind: 'set', code: 'ALA', style: 'realistic' },
		{ kind: 'set', code: 'ARB', style: 'set-cube' },
	],
};

const THREE: DraftPlan = {
	rounds: [
		{ kind: 'set', code: 'ALA', style: 'realistic' },
		{ kind: 'set', code: 'ARB', style: 'realistic' },
		{ kind: 'cube', cubeId: VINTAGE },
	],
};

describe('the set symbols Rally draws beside each line', () => {
	it('reads every set glyph out of Keyrune\'s stylesheet', () => {
		expect(setGlyphs('.ss-tmt:before {\n  content: "\\ea06";\n}\n.ss-duo.ss-tmt::after {\n  content: "\\ea07";\n}\n.ss-blb:before {\n  content: "\\e9f4";\n}')).toEqual([
			['tmt', '\\ea06'],
			['blb', '\\e9f4'],
		]);
	});

	it('serves a stylesheet with a rule per set, naming the font by a path beside it, and the font', async () => {
		const { raw } = await setup();
		const css = await raw(`/${SYMBOLS_PATH}`);
		expect(css.status).toBe(200);
		expect(css.type).toMatch(/^text\/css/);
		const text = css.body.toString('utf8');
		expect(text).toContain('src:url("keyrune.woff2")');
		expect(text).toContain('.rally-line-symbol[data-line="set/tmt" i]::before{content:"\\ea06"}');
		expect(text.match(/data-line="set\//g)?.length).toBeGreaterThan(300);
		const font = await raw('/api/rally/keyrune.woff2');
		expect(font.status).toBe(200);
		expect(font.type).toBe('font/woff2');
		expect(font.body.subarray(0, 4).toString('latin1')).toBe('wOF2');
	});

	it('answers 404 when the symbols cannot be read, and reads them again on the next ask', async () => {
		const { raw } = await setup({ symbolsDir: join(tmpdir(), 'no-such-symbols') });
		expect((await raw(`/${SYMBOLS_PATH}`)).status).toBe(404);
		expect((await raw('/api/rally/keyrune.woff2')).status).toBe(404);
	});
});

describe('GET /api/rally/sources', () => {
	// The operator, 2026-11-05: the row reads "Pack", with the set symbol beside it.
	it('lists the three catalogues, each with only the Pack, and where the set symbols are: the cards pages open from an option\'s lines', async () => {
		const { get } = await setup();
		const { sources } = data(SourcesBody, (await get('/api/rally/sources')).json);
		expect(sources.map((s) => [s.kind, s.label])).toEqual([
			['draft-preset', 'Draft presets'],
			['set', 'Sets'],
			['cube', 'Cubes'],
		]);
		for (const s of sources) expect(s.views).toEqual([{ id: 'pack', label: 'Pack' }]);
	});
});

describe('GET /api/rally/options/:kind', () => {
	it('finds a shipped cube by a word of its name: kind Cube, one line of three packs opening its cards, Scryfall art', async () => {
		const { get } = await setup();
		const { suggestions } = data(OptionsBody, (await get('/api/rally/options/cube?q=pau')).json);
		const pauper = suggestions[0]!;
		expect(pauper).toMatchObject({ id: PAUPER, label: expect.stringMatching(/Pauper/), detail: 'Cube' });
		expect(pauper.lines).toEqual([{ text: `3x ${pauper.label} packs`, view: `cube/${PAUPER}/cards` }]);
		expect(pauper.image).toMatch(/^https:\/\/cards\.scryfall\.io\//);
	});

	it('ranks a name that starts with the query above one that only contains it', async () => {
		const { get } = await setup();
		const { suggestions } = data(OptionsBody, (await get('/api/rally/options/set?q=al')).json);
		// "Alara Reborn" and "Shards of Alara" both match; the prefix comes first though the list is newest first either way.
		expect(suggestions.map((s) => s.id)).toEqual(['ARB', 'ALA']);
		// 264: the set's 249 plus the 15 names its booster sample adds (`pools/sets.ts`'s `cardsFor`).
		const { suggestions: shards } = data(OptionsBody, (await get('/api/rally/options/set?q=shards')).json);
		expect(shards).toEqual([
			{ id: 'ALA', label: 'Shards of Alara', detail: 'Realistic', image: null, lines: [{ text: '3x Shards of Alara packs', view: 'set/ALA/cards' }] },
		]);
	});

	it('a preset of three sources: a line per source, each opening only that source\'s cards', async () => {
		const { get, presets } = await setup();
		const saved = await presets.create('Three of a kind', THREE, 'fk:alice');
		const { suggestions } = data(OptionsBody, (await get('/api/rally/options/draft-preset?q=three')).json);
		expect(suggestions).toEqual([
			{
				id: saved.id,
				label: 'Three of a kind',
				detail: 'Realistic + Cube',
				image: expect.toSatisfy((url: unknown) => url === null || typeof url === 'string'),
				lines: [
					{ text: '1x Shards of Alara', view: 'set/ALA/cards' },
					{ text: '1x Alara Reborn', view: 'set/ARB/cards' },
					{ text: expect.stringMatching(/^1x .*Vintage/), view: `cube/${VINTAGE}/cards` },
				],
			},
		]);
	});

	it('a preset mixing kinds names each kind; a source drafted twice is one line', async () => {
		const { get, presets } = await setup();
		await presets.create('Alara block', MIXED, 'fk:alice');
		const { suggestions } = data(OptionsBody, (await get('/api/rally/options/draft-preset?q=alara')).json);
		expect(suggestions[0]).toMatchObject({
			label: 'Alara block',
			detail: 'Realistic + Set cube',
			lines: [
				{ text: '2x Shards of Alara packs', view: 'set/ALA/cards' },
				{ text: '1x Alara Reborn', view: 'set/ARB/cards' },
			],
		});
	});

	it('every line is one Rally accepts: at most four, 1–80 characters, a view it can open', async () => {
		const { get, presets } = await setup();
		await presets.create('Three of a kind', THREE, 'fk:alice');
		for (const kind of ['cube', 'set', 'draft-preset']) {
			const { suggestions } = data(OptionsBody, (await get(`/api/rally/options/${kind}`)).json);
			expect(suggestions.length).toBeGreaterThan(0);
			for (const s of suggestions) {
				expect(s.lines.length).toBeGreaterThan(0);
				expect(s.lines.length).toBeLessThanOrEqual(4);
				for (const line of s.lines) {
					expect(line.text.length).toBeGreaterThan(0);
					expect(line.text.length).toBeLessThanOrEqual(80);
					expect(line.view).toMatch(/^[a-z][a-z0-9-]{0,31}\/[A-Za-z0-9._:-]{1,64}\/[a-z][a-z0-9-]{0,31}$/);
					expect((await get(`/api/rally/views/${line.view}`)).status).toBe(200);
				}
			}
		}
	});

	it('answers an unknown catalogue with 404 in the wrapper', async () => {
		const { get } = await setup();
		const res = await get('/api/rally/options/decks?q=ab');
		expect(res.status).toBe(404);
		expect(res.json).toMatchObject({ success: false });
	});
});

describe('GET /api/rally/views/:kind/:id/cards', () => {
	it("a cube's three rounds are one list: every card in it", async () => {
		const { get } = await setup();
		const view = data(CardsBody, (await get(`/api/rally/views/cube/${PAUPER}/cards`)).json);
		expect(view.groups).toHaveLength(1);
		expect(view.groups[0]!.label).toBeNull();
		expect(view.groups[0]!.cards.length).toBeGreaterThan(300);
	});

	it("a mixed preset shows each pool once, under the rounds that draft it, less the plan's without", async () => {
		const { get, presets } = await setup();
		const saved = await presets.create('Alara block', { ...MIXED, without: ['ARB 1'] }, 'fk:alice');
		const view = data(CardsBody, (await get(`/api/rally/views/draft-preset/${saved.id}/cards`)).json);
		expect(view.name).toBe('Alara block');
		expect(view.groups.map((g) => g.label)).toEqual(['Rounds 1 and 2 · Shards of Alara', 'Round 3 · Alara Reborn']);
		expect(view.groups[1]!.cards.map((c) => c.name)).not.toContain('ARB 1');
		expect(view.groups[1]!.cards.map((c) => c.name)).toContain('ARB 2');
	});

	it('says plainly that a deleted preset is gone', async () => {
		const { get, presets } = await setup();
		const saved = await presets.create('Gone soon', MIXED, 'fk:alice');
		await presets.remove(saved.id, 'fk:alice');
		const res = await get(`/api/rally/views/draft-preset/${saved.id}/cards`);
		expect(res.status).toBe(404);
		expect(res.json).toEqual({ success: false, error: 'This draft preset has been deleted.' });
	});
});

describe('GET /api/rally/views/:kind/:id/pack', () => {
	it("deals a cube's pack fresh on every load, fifteen of the cube's own cards, never cached", async () => {
		const { get } = await setup();
		const first = await get(`/api/rally/views/cube/${VINTAGE}/pack`);
		expect(first.headers.get('cache-control')).toBe('no-store');
		const a = data(PackBody, first.json);
		const b = data(PackBody, (await get(`/api/rally/views/cube/${VINTAGE}/pack`)).json);
		expect(a.packs).toHaveLength(1);
		expect(a.packs[0]!.cards).toHaveLength(15);
		const pool = new Set(data(CardsBody, (await get(`/api/rally/views/cube/${VINTAGE}/cards`)).json).groups[0]!.cards.map((c) => c.name));
		for (const card of a.packs[0]!.cards) expect(pool.has(card.name)).toBe(true);
		expect(a.packs[0]!.cards.map((c) => c.name)).not.toEqual(b.packs[0]!.cards.map((c) => c.name));
	});

	it("opens a set's pack with Forge's own booster, foil and all", async () => {
		const { get, boosters } = await setup();
		const view = data(PackBody, (await get('/api/rally/views/set/ALA/pack')).json);
		expect(view.name).toBe('Shards of Alara');
		expect(view.packs).toHaveLength(1);
		expect(view.packs[0]!.cards).toHaveLength(15);
		expect(view.packs[0]!.cards.some((c) => c.foil === true)).toBe(true);
		expect(boosters).toHaveBeenLastCalledWith('ALA', 1, expect.stringMatching(/^rally:/));
	});

	it('a mixed preset opens one pack per pool, labelled by round', async () => {
		const { get, presets } = await setup();
		const saved = await presets.create('Alara block', MIXED, 'fk:alice');
		const view = data(PackBody, (await get(`/api/rally/views/draft-preset/${saved.id}/pack`)).json);
		expect(view.packs.map((p) => p.label)).toEqual(['Rounds 1 and 2 · Shards of Alara · Realistic', 'Round 3 · Alara Reborn · Set-cube']);
		expect(view.packs[1]!.cards.every((c) => c.name.startsWith('ARB '))).toBe(true);
	});

	it("says a set's pack needs Forge on a server without one", async () => {
		const { get } = await setup({ jar: false });
		const res = await get('/api/rally/views/set/ALA/pack');
		expect(res.status).toBe(503);
		expect(res.json).toMatchObject({ success: false, error: expect.stringMatching(/Forge/) });
	});

	it('limits sample packs per caller', async () => {
		const { get } = await setup({ packRateLimit: { capacity: 1, refillAmount: 1, refillIntervalMs: 60_000 } });
		expect((await get(`/api/rally/views/cube/${PAUPER}/pack`)).status).toBe(200);
		expect((await get(`/api/rally/views/cube/${PAUPER}/pack`)).status).toBe(429);
		expect((await get(`/api/rally/views/cube/${PAUPER}/pack`, 'bob')).status).toBe(200);
	});
});

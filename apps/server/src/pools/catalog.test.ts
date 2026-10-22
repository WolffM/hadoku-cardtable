/**
 * `loadCardCatalog` against a tiny hand-built catalog file — the shape
 * `build-catalog.ts` writes (`{ cards, aliases, printings }`), never the
 * 26 MB real one.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadCardCatalog, type CardCatalog } from './catalog.ts';

const BOLT = {
	cardId: 'lightning bolt',
	name: 'Lightning Bolt',
	manaCost: ['R'],
	manaValue: 1,
	colors: ['R'],
	typeLine: 'Instant',
	oracleText: 'Lightning Bolt deals 3 damage to any target.',
	setCode: 'LEA',
	collectorNumber: '161',
	rarity: 'common',
};

const DELVER = {
	cardId: 'delver of secrets // insectile aberration',
	scryfallId: '45f81bc4-0c86-4f8a-8b7e-7b1c9a1e6a11',
	name: 'Delver of Secrets // Insectile Aberration',
	manaCost: ['U'],
	manaValue: 1,
	colors: ['U'],
	typeLine: 'Creature — Human Wizard',
	oracleText: 'At the beginning of your upkeep, look at the top card of your library...',
	setCode: 'ISD',
	collectorNumber: '51',
	rarity: 'common',
	power: '1',
	toughness: '1',
};

/** BOLT's own id — the catalog's CHOSEN printing (LEA #161). */
const LEA_BOLT_SCRYFALL_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
/** A DIFFERENT printing of the same card — M19 #141, its own art — never the chosen one under `cards`. */
const M19_BOLT_SCRYFALL_ID = 'bbbbbbbb-0000-4000-8000-000000000002';

async function writeCatalog(
	dir: string,
	file: { cards: Record<string, unknown>; aliases: Record<string, unknown>; printings?: Record<string, unknown> },
): Promise<string> {
	const path = join(dir, 'cards.json');
	await writeFile(path, JSON.stringify(file), 'utf8');
	return path;
}

describe('loadCardCatalog', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'catalog-test-'));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('answers a known name, case and whitespace aside', async () => {
		const path = await writeCatalog(dir, { cards: { 'lightning bolt': BOLT }, aliases: {} });
		const catalog: CardCatalog = loadCardCatalog(path);
		expect(catalog.byName(' Lightning Bolt ')?.name).toBe('Lightning Bolt');
		expect(catalog.byName('LIGHTNING BOLT')?.name).toBe('Lightning Bolt');
	});

	it('resolves an alias (a bare front face) to its canonical card', async () => {
		const path = await writeCatalog(dir, {
			cards: { 'delver of secrets // insectile aberration': DELVER },
			aliases: { 'delver of secrets': 'delver of secrets // insectile aberration' },
		});
		const catalog = loadCardCatalog(path);
		const hit = catalog.byName('Delver of Secrets');
		expect(hit?.name).toBe('Delver of Secrets // Insectile Aberration');
	});

	it('answers null for a name it has never heard of', async () => {
		const path = await writeCatalog(dir, { cards: { 'lightning bolt': BOLT }, aliases: {} });
		const catalog = loadCardCatalog(path);
		expect(catalog.byName('Not A Real Card')).toBeNull();
	});

	it('drops an entry that fails DraftCardSchema rather than throwing', async () => {
		const path = await writeCatalog(dir, {
			cards: { 'lightning bolt': BOLT, broken: { name: 'Broken', typeLine: 'not a draft card' } },
			aliases: {},
		});
		const catalog = loadCardCatalog(path);
		expect(catalog.byName('Lightning Bolt')?.name).toBe('Lightning Bolt');
		expect(catalog.byName('Broken')).toBeNull();
	});

	it('is a reported fault, not a throw, when the file is missing', () => {
		const catalog = loadCardCatalog(join(dir, 'does-not-exist.json'));
		expect(catalog.byName('Lightning Bolt')).toBeNull();
	});

	it('is a reported fault, not a throw, when the file is malformed JSON', async () => {
		const path = join(dir, 'cards.json');
		await writeFile(path, '{ not json', 'utf8');
		const catalog = loadCardCatalog(path);
		expect(catalog.byName('Lightning Bolt')).toBeNull();
	});
});

describe('loadCardCatalog byPrinting', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'catalog-test-'));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('answers the chosen printing by set + collector number, case aside, with its own scryfallId', async () => {
		const path = await writeCatalog(dir, {
			cards: { 'lightning bolt': BOLT },
			aliases: {},
			printings: { 'LEA:161': { key: 'lightning bolt', scryfallId: LEA_BOLT_SCRYFALL_ID } },
		});
		const catalog = loadCardCatalog(path);
		expect(catalog.byPrinting('lea', '161')?.name).toBe('Lightning Bolt');
		expect(catalog.byPrinting('LEA', '161')?.scryfallId).toBe(LEA_BOLT_SCRYFALL_ID);
	});

	it('answers a DIFFERENT printing of the same card — the whole reason byPrinting exists — with its OWN scryfallId, not the chosen printing\'s', async () => {
		const path = await writeCatalog(dir, {
			cards: { 'lightning bolt': BOLT }, // BOLT itself carries no scryfallId; the chosen printing has none recorded here on purpose
			aliases: {},
			printings: {
				'LEA:161': { key: 'lightning bolt', scryfallId: LEA_BOLT_SCRYFALL_ID },
				'M19:141': { key: 'lightning bolt', scryfallId: M19_BOLT_SCRYFALL_ID },
			},
		});
		const catalog = loadCardCatalog(path);

		const m19 = catalog.byPrinting('M19', '141');
		expect(m19?.name).toBe('Lightning Bolt'); // same text as the canonical card
		expect(m19?.oracleText).toBe(BOLT.oracleText);
		expect(m19?.setCode).toBe('M19'); // THIS printing's own set
		expect(m19?.collectorNumber).toBe('141'); // THIS printing's own collector number
		expect(m19?.scryfallId).toBe(M19_BOLT_SCRYFALL_ID); // THIS printing's own art, not LEA's

		const lea = catalog.byPrinting('LEA', '161');
		expect(lea?.scryfallId).toBe(LEA_BOLT_SCRYFALL_ID);
		expect(lea?.scryfallId).not.toBe(m19?.scryfallId);
	});

	it('misses a printing with no entry in `printings` at all (the caller falls back to byName)', async () => {
		const path = await writeCatalog(dir, {
			cards: { 'lightning bolt': BOLT },
			aliases: {},
			printings: { 'LEA:161': { key: 'lightning bolt', scryfallId: LEA_BOLT_SCRYFALL_ID } },
		});
		const catalog = loadCardCatalog(path);
		expect(catalog.byPrinting('FDN', '1')).toBeNull();
	});

	it('misses every printing on an older-shape file with no `printings` section at all', async () => {
		const path = await writeCatalog(dir, { cards: { 'lightning bolt': BOLT }, aliases: {} });
		const catalog = loadCardCatalog(path);
		expect(catalog.byPrinting('LEA', '161')).toBeNull();
	});

	it("a printings entry whose key names a card not in `cards` (a malformed file) misses rather than throwing", async () => {
		const path = await writeCatalog(dir, {
			cards: { 'lightning bolt': BOLT },
			aliases: {},
			printings: { 'LEA:161': { key: 'some other card not in cards', scryfallId: LEA_BOLT_SCRYFALL_ID } },
		});
		const catalog = loadCardCatalog(path);
		expect(catalog.byPrinting('LEA', '161')).toBeNull();
	});

	it('answers null when the file has never been loaded', () => {
		const catalog = loadCardCatalog(join(dir, 'does-not-exist.json'));
		expect(catalog.byPrinting('LEA', '161')).toBeNull();
	});
});

describe('loadCardCatalog swap', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'catalog-test-'));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('replaces the live data in place: every holder of the object sees the swap, with no reload of their own', async () => {
		const path = await writeCatalog(dir, { cards: { 'lightning bolt': BOLT }, aliases: {} });
		const catalog: CardCatalog = loadCardCatalog(path);
		expect(catalog.byName('Delver of Secrets')).toBeNull();

		// Overwrite the SAME path with different content, then swap with no argument:
		// the catalog remembers the path it was built from.
		await writeCatalog(dir, {
			cards: { 'delver of secrets // insectile aberration': DELVER },
			aliases: { 'delver of secrets': 'delver of secrets // insectile aberration' },
			printings: { 'ISD:51': { key: 'delver of secrets // insectile aberration', scryfallId: DELVER.scryfallId } },
		});
		const swapped = catalog.swap();

		expect(swapped).toBe(true);
		expect(catalog.byName('Lightning Bolt')).toBeNull();
		expect(catalog.byName('Delver of Secrets')?.name).toBe('Delver of Secrets // Insectile Aberration');
		expect(catalog.byPrinting('ISD', '51')?.name).toBe('Delver of Secrets // Insectile Aberration');
	});

	it('swap(path) can point at a different file entirely', async () => {
		const pathA = await writeCatalog(dir, { cards: { 'lightning bolt': BOLT }, aliases: {} });
		const pathB = await writeCatalog(join(await mkdtemp(join(tmpdir(), 'catalog-test-'))), {
			cards: { 'delver of secrets // insectile aberration': DELVER },
			aliases: {},
		});
		const catalog = loadCardCatalog(pathA);
		expect(catalog.swap(pathB)).toBe(true);
		expect(catalog.byName('Delver of Secrets // Insectile Aberration')?.name).toBe('Delver of Secrets // Insectile Aberration');
	});

	it('a fault (missing file) keeps the old data serving and reports false', async () => {
		const path = await writeCatalog(dir, { cards: { 'lightning bolt': BOLT }, aliases: {} });
		const catalog = loadCardCatalog(path);
		const swapped = catalog.swap(join(dir, 'does-not-exist.json'));
		expect(swapped).toBe(false);
		expect(catalog.byName('Lightning Bolt')?.name).toBe('Lightning Bolt');
	});

	it('a fault (malformed JSON) keeps the old data serving and reports false', async () => {
		const path = await writeCatalog(dir, { cards: { 'lightning bolt': BOLT }, aliases: {} });
		const catalog = loadCardCatalog(path);
		const badPath = join(dir, 'broken.json');
		await writeFile(badPath, '{ not json', 'utf8');
		const swapped = catalog.swap(badPath);
		expect(swapped).toBe(false);
		expect(catalog.byName('Lightning Bolt')?.name).toBe('Lightning Bolt');
	});
});

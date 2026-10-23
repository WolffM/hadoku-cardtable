/**
 * `pools/sets.ts`: `createSetsStore` and `attachSetRoutes`.
 *
 * Done when (wave 74 §E step 6): `GET /api/pools/sets` on a jar-env local
 * server lists ISD, ALA, ARB — that is proven live, against the real jar,
 * in `index.ts`'s own boot smoke test (this file's fakes stand in for Forge
 * everywhere else, the same discipline `room/plan.ts`'s own tests use).
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { DraftCard, PoolVerdict } from '@hadoku/shared';
import { attachSetRoutes, createSetsStore, warmSetsStore, type CatalogLookup, type SetsForge, type SetsStore } from './sets.ts';
import type { BoosterCard, SetSummary as ForgeSetSummary } from './forge.ts';

function card(name: string, code: string): DraftCard {
	return {
		cardId: `${code}-${name}`,
		name,
		manaCost: [],
		manaValue: 0,
		colors: [],
		typeLine: 'Creature — Test',
		oracleText: '',
		setCode: code,
		collectorNumber: '1',
		rarity: 'common',
	};
}

const EMPTY_CATALOG: CatalogLookup = { byName: () => null, byNameInSet: () => null, byPrinting: () => null };

function booster(names: string[], code: string): BoosterCard[] {
	return names.map((name) => ({ name, set: code, collectorNumber: '1', foil: false }));
}

function fakeForge(opts: {
	sets?: ForgeSetSummary[];
	setCards?: Record<string, string[]>;
	boosters?: Record<string, BoosterCard[][]>;
	failSetCards?: Set<string>;
	failBoosters?: Set<string>;
}): SetsForge {
	return {
		sets: vi.fn(async () => opts.sets ?? []),
		setCards: vi.fn(async (code: string) => {
			if (opts.failSetCards?.has(code)) throw new Error(`setCards failed for ${code}`);
			return opts.setCards?.[code] ?? [];
		}),
		boosters: vi.fn(async (code: string) => {
			if (opts.failBoosters?.has(code)) throw new Error(`boosters failed for ${code}`);
			return opts.boosters?.[code] ?? [];
		}),
	};
}

const ISD: ForgeSetSummary = { code: 'ISD', name: 'Innistrad', date: '2011-09-30', type: 'Expansion' };
const ALA: ForgeSetSummary = { code: 'ALA', name: 'Shards of Alara', date: '2008-10-03', type: 'Expansion' };
const ARB: ForgeSetSummary = { code: 'ARB', name: 'Alara Reborn', date: '2009-04-30', type: 'Expansion' };

describe('createSetsStore — list()', () => {
	it('without a jar, lists nothing', async () => {
		const store = createSetsStore({ forge: null, catalog: EMPTY_CATALOG });
		expect(await store.list()).toEqual([]);
	});

	it('lists every set, newest first, each with its set-cube size and a null verdict before anything is checked', async () => {
		const forge = fakeForge({
			sets: [ALA, ISD, ARB],
			setCards: { ISD: ['Card A', 'Card B'], ALA: ['Card C'], ARB: ['Card D', 'Card E', 'Card F'] },
		});
		const store = createSetsStore({ forge, catalog: EMPTY_CATALOG, log: () => undefined });
		const list = await store.list();
		expect(list.map((s) => s.code)).toEqual(['ISD', 'ARB', 'ALA']); // 2011, 2009, 2008
		expect(list.every((s) => s.verdict === null)).toBe(true);
		expect(list.find((s) => s.code === 'ISD')?.cards).toBe(2);
		expect(list.find((s) => s.code === 'ARB')?.cards).toBe(3);
	});

	it('caches: a second list() does not call Forge again', async () => {
		const forge = fakeForge({ sets: [ISD], setCards: { ISD: ['Card A'] } });
		const store = createSetsStore({ forge, catalog: EMPTY_CATALOG });
		await store.list();
		await store.list();
		expect(forge.sets).toHaveBeenCalledTimes(1);
	});

	it('reflects a verdict `checkSource`-style code already set, by reading the shared cache', async () => {
		const forge = fakeForge({ sets: [ISD], setCards: { ISD: ['Card A'] } });
		const store = createSetsStore({ forge, catalog: EMPTY_CATALOG });
		const verdict: PoolVerdict = { ok: true, cards: 1 };
		store.setVerdict('ISD', verdict);
		const list = await store.list();
		expect(list[0]?.verdict).toEqual(verdict);
	});

	it('nameOf answers null before list() has ever resolved a code, and the real name after', async () => {
		const forge = fakeForge({ sets: [ISD], setCards: { ISD: [] } });
		const store = createSetsStore({ forge, catalog: EMPTY_CATALOG });
		expect(store.nameOf('ISD')).toBeNull();
		await store.list();
		expect(store.nameOf('ISD')).toBe('Innistrad');
	});
});

/*
 * The server listens before the warm-up finishes, so every reader of this
 * store's caches runs against a half-warm store: names must arrive with the
 * FIRST Forge answer (`sets()`), not after every set's card list, and a
 * plan check asking for a set mid-warm must share the warm-up's round-trip.
 */
describe('createSetsStore — read while list() is still warming', () => {
	function hangingSetCards(): { forge: SetsForge; release: () => void } {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((r) => (release = r));
		const forge: SetsForge = {
			sets: vi.fn(async () => [ISD, ALA]),
			setCards: vi.fn(async (code: string) => {
				await gate;
				return [`${code} card`];
			}),
			boosters: vi.fn(async () => []),
		};
		return { forge, release: () => release() };
	}

	it('every set is named, and onNamed heard once, as soon as Forge lists the sets — before any card list resolves', async () => {
		const { forge, release } = hangingSetCards();
		const store = createSetsStore({ forge, catalog: EMPTY_CATALOG });
		const heard = vi.fn();
		store.onNamed(heard);
		const listing = store.list();
		await vi.waitFor(() => expect(forge.setCards).toHaveBeenCalled());
		expect(store.nameOf('ISD')).toBe('Innistrad');
		expect(store.nameOf('ALA')).toBe('Shards of Alara');
		expect(heard).toHaveBeenCalledTimes(1);
		release();
		await listing;
		expect(heard, 'a finished list names nothing new').toHaveBeenCalledTimes(1);
	});

	it('a cardsFor() asked mid-warm shares the warm-up\'s Forge round-trip instead of starting its own', async () => {
		const { forge, release } = hangingSetCards();
		const store = createSetsStore({ forge, catalog: EMPTY_CATALOG });
		const listing = store.list();
		// ISD is newest, so it is the set the warm-up is waiting on right now.
		await vi.waitFor(() => expect(forge.setCards).toHaveBeenCalledWith('ISD'));
		const asked = store.cardsFor('ISD');
		release();
		expect((await asked)?.map((c) => c.name)).toEqual(['ISD card']);
		await listing;
		expect(vi.mocked(forge.setCards).mock.calls.filter(([code]) => code === 'ISD')).toHaveLength(1);
		expect(forge.setCards).toHaveBeenCalledTimes(2);
	});
});

/*
 * `index.ts` starts this at boot and never awaits it — a rejected
 * `forge.sets()` (or any `resolveCards` round-trip inside it) must never
 * surface as an unhandled rejection. `warmSetsStore` is the function that
 * can never reject: `nameOf` falls back to the bare code until
 * the NEXT successful `list()` (the next `GET /api/pools/sets` — `list()`
 * already clears its own `listPromise` on a failure, so that next call is a
 * fresh attempt, not a dead cached rejection).
 */
describe('warmSetsStore — never rejects, even when Forge is unreachable at boot', () => {
	it('a forge.sets() that rejects: warmSetsStore still resolves, and logs one line', async () => {
		const forge: SetsForge = {
			sets: vi.fn(async () => {
				throw new Error('the pool JVM did not answer within 30000ms');
			}),
			setCards: vi.fn(async () => []),
			boosters: vi.fn(async () => []),
		};
		const log = vi.fn();
		const store = createSetsStore({ forge, catalog: EMPTY_CATALOG, log: () => undefined });
		await expect(warmSetsStore(store, log)).resolves.toBeUndefined();
		expect(log).toHaveBeenCalledWith(expect.objectContaining({ evt: 'sets-warm-failed' }));
		// The server stays up with no set names yet — a later GET retries fresh.
		expect(store.nameOf('ISD')).toBeNull();
	});

	it('a clean boot logs the warmed count', async () => {
		const forge = fakeForge({ sets: [ISD], setCards: { ISD: ['Card A'] } });
		const log = vi.fn();
		const store = createSetsStore({ forge, catalog: EMPTY_CATALOG, log: () => undefined });
		await warmSetsStore(store, log);
		expect(log).toHaveBeenCalledWith(expect.objectContaining({ evt: 'sets-warmed', count: 1 }));
		expect(store.nameOf('ISD')).toBe('Innistrad');
	});
});

describe('createSetsStore — cardsFor: the land/DFC slot setCards alone would miss', () => {
	it('unions setCards names with a booster sample, deduped', async () => {
		const forge = fakeForge({
			setCards: { ISD: ['Card A', 'Card B'] },
			boosters: { ISD: [booster(['Card A', 'Startled Awake // Persistent Nightmare'], 'ISD')] },
		});
		const catalog: CatalogLookup = { byName: (name) => card(name, 'ISD'), byNameInSet: () => null, byPrinting: () => null };
		const store = createSetsStore({ forge, catalog, sampleBoosters: 1 });
		const cards = await store.cardsFor('ISD');
		expect(cards?.map((c) => c.name).sort()).toEqual(['Card A', 'Card B', 'Startled Awake // Persistent Nightmare'].sort());
	});

	it("draws each card as the set printed it, and by name only where the catalog has no printing of it there", async () => {
		const forge = fakeForge({ setCards: { ISD: ['Giant Growth', 'Card B'] }, boosters: { ISD: [booster(['Card B'], 'ISD')] } });
		const catalog: CatalogLookup = {
			byName: (name) => card(name, 'LEA'),
			byNameInSet: (name, set) => (name === 'Giant Growth' ? card(name, set) : null),
			byPrinting: () => null,
		};
		const store = createSetsStore({ forge, catalog, sampleBoosters: 1 });
		const cards = await store.cardsFor('ISD');
		expect(cards?.find((c) => c.name === 'Giant Growth')?.setCode).toBe('ISD');
		expect(cards?.find((c) => c.name !== 'Giant Growth')?.setCode).toBe('LEA');
	});

	it("draws a card the set's boosters take from a bonus sheet as that sheet printed it (the operator, 2026-10-23: Precursor Golem in a Brothers' War set-cube drew Scars of Mirrodin's)", async () => {
		const forge = fakeForge({
			setCards: { BRO: ['Urza, Lord Protector'] },
			boosters: { BRO: [[{ name: 'Precursor Golem', set: 'BRR', collectorNumber: '41', foil: false }]] },
		});
		const byPrinting = vi.fn((set: string, collectorNumber: string) => ({ ...card('Precursor Golem', set), collectorNumber }));
		const catalog: CatalogLookup = {
			byName: (name) => card(name, 'SOM'),
			byNameInSet: (name, set) => (name === 'Urza, Lord Protector' ? card(name, set) : null),
			byPrinting,
		};
		const store = createSetsStore({ forge, catalog, sampleBoosters: 1 });
		const cards = await store.cardsFor('BRO');
		expect(cards?.find((c) => c.name === 'Precursor Golem')).toMatchObject({ setCode: 'BRR', collectorNumber: '41' });
		// A name the set itself printed keeps the set's own printing, whatever a booster dealt.
		expect(cards?.find((c) => c.name === 'Urza, Lord Protector')?.setCode).toBe('BRO');
		expect(byPrinting).toHaveBeenCalledWith('BRR', '41');
	});

	it("looks a set's printings up under the code Scryfall prints it as, where Forge's differs (Conflux: CFX, CON)", async () => {
		const forge = fakeForge({
			sets: [{ code: 'CFX', name: 'Conflux', date: '2009-02-06', type: 'Expansion', scryfallCode: 'CON' }],
			setCards: { CFX: ['Giant Growth'] },
		});
		const byNameInSet = vi.fn((name: string, set: string) => card(name, set));
		const store = createSetsStore({ forge, catalog: { byName: (name) => card(name, 'LEA'), byNameInSet, byPrinting: () => null }, sampleBoosters: 0 });
		await store.list();
		expect((await store.cardsFor('CFX'))?.[0]?.setCode).toBe('CON');
		expect(byNameInSet).toHaveBeenCalledWith('Giant Growth', 'CON');
	});

	it('a name the catalog cannot resolve carries typeLine \'\' — missingText, same signal pools/cubes.ts uses', async () => {
		const forge = fakeForge({ setCards: { ISD: ['Known', 'Mystery'] } });
		const catalog: CatalogLookup = { byName: (name) => (name === 'Known' ? card(name, 'ISD') : null), byNameInSet: () => null, byPrinting: () => null };
		const store = createSetsStore({ forge, catalog, sampleBoosters: 1 });
		const cards = await store.cardsFor('ISD');
		expect(cards?.find((c) => c.name === 'Mystery')?.typeLine).toBe('');
		expect(cards?.find((c) => c.name === 'Known')?.typeLine).not.toBe('');
	});

	it('without a jar, cardsFor answers null', async () => {
		const store = createSetsStore({ forge: null, catalog: EMPTY_CATALOG });
		expect(await store.cardsFor('ISD')).toBeNull();
	});

	it('setCards failing answers null (unknown/unreachable set), logged', async () => {
		const forge = fakeForge({ failSetCards: new Set(['ISD']) });
		const log = vi.fn();
		const store = createSetsStore({ forge, catalog: EMPTY_CATALOG, log });
		expect(await store.cardsFor('ISD')).toBeNull();
		expect(log).toHaveBeenCalledWith(expect.objectContaining({ evt: 'set-cards-failed', code: 'ISD' }));
	});

	it('the booster sample failing (no draft template, or a transient fault) still answers from setCards alone, logged', async () => {
		const forge = fakeForge({ setCards: { ARB: ['Card D'] }, failBoosters: new Set(['ARB']) });
		const catalog: CatalogLookup = { byName: (name) => card(name, 'ARB'), byNameInSet: () => null, byPrinting: () => null };
		const log = vi.fn();
		const store = createSetsStore({ forge, catalog, log });
		const cards = await store.cardsFor('ARB');
		expect(cards?.map((c) => c.name)).toEqual(['Card D']);
		expect(log).toHaveBeenCalledWith(expect.objectContaining({ evt: 'set-booster-sample-failed', code: 'ARB' }));
	});

	it('caches: a second cardsFor() does not call Forge again, and cachedCards reads it back synchronously', async () => {
		const forge = fakeForge({ setCards: { ISD: ['Card A'] } });
		const store = createSetsStore({ forge, catalog: EMPTY_CATALOG });
		expect(store.cachedCards('ISD')).toBeNull();
		await store.cardsFor('ISD');
		await store.cardsFor('ISD');
		expect(forge.setCards).toHaveBeenCalledTimes(1);
		expect(store.cachedCards('ISD')?.map((c) => c.name)).toEqual(['Card A']);
	});
});

describe('createSetsStore — verdict cache', () => {
	function storeWith(): SetsStore {
		return createSetsStore({ forge: fakeForge({}), catalog: EMPTY_CATALOG });
	}

	it('set/get round-trips, and is null before anything is set', () => {
		const store = storeWith();
		expect(store.cachedVerdict('ISD')).toBeNull();
		const verdict: PoolVerdict = { ok: true, cards: 10 };
		store.setVerdict('ISD', verdict);
		expect(store.cachedVerdict('ISD')).toEqual(verdict);
	});

	it('clearMissingTextVerdicts drops only a verdict refused for missingText — an ok verdict and an unplayable-only refusal both survive', () => {
		const store = storeWith();
		const ok: PoolVerdict = { ok: true, cards: 10 };
		const unplayableOnly: PoolVerdict = { ok: false, unplayable: ['Bad Card'], missingText: [] };
		const missingText: PoolVerdict = { ok: false, unplayable: [], missingText: ['Mystery'] };
		store.setVerdict('OK', ok);
		store.setVerdict('UNPLAYABLE', unplayableOnly);
		store.setVerdict('MISSING', missingText);
		store.clearMissingTextVerdicts();
		expect(store.cachedVerdict('OK')).toEqual(ok);
		expect(store.cachedVerdict('UNPLAYABLE')).toEqual(unplayableOnly);
		expect(store.cachedVerdict('MISSING')).toBeNull();
	});
});

describe('attachSetRoutes', () => {
	const servers: HttpServer[] = [];

	afterAll(async () => {
		for (const server of servers.splice(0)) await new Promise<void>((done) => server.close(() => done()));
	});

	async function openApp(store: SetsStore): Promise<string> {
		const app = express();
		const api = express.Router();
		attachSetRoutes(api, { store, log: () => undefined });
		app.use('/api', api);
		const server = createServer(app);
		await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
		servers.push(server);
		return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	}

	it('GET /api/pools/sets answers the store\'s list', async () => {
		const forge = fakeForge({ sets: [ISD, ALA, ARB], setCards: { ISD: ['A'], ALA: ['B'], ARB: ['C', 'D'] } });
		const store = createSetsStore({ forge, catalog: EMPTY_CATALOG });
		const base = await openApp(store);
		const res = await fetch(`${base}/api/pools/sets`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { code: string }[];
		expect(body.map((s) => s.code)).toEqual(['ISD', 'ARB', 'ALA']);
	});

	it('answers 503 when the store cannot list (Forge unreachable mid-call)', async () => {
		const forge: SetsForge = {
			sets: vi.fn(async () => {
				throw new Error('jvm is gone');
			}),
			setCards: vi.fn(async () => []),
			boosters: vi.fn(async () => []),
		};
		const store = createSetsStore({ forge, catalog: EMPTY_CATALOG, log: () => undefined });
		const base = await openApp(store);
		const res = await fetch(`${base}/api/pools/sets`);
		expect(res.status).toBe(503);
	});
});

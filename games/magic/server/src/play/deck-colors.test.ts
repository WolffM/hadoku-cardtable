import { describe, expect, it } from 'vitest';
import { DeckColorsSchema } from '@hadoku/shared';

import { roomDeckCosts, seatDeckColors, type CatalogCosts } from './deck-colors.js';
import type { ForgeMatchSpec } from './forge-spec.js';

const costs: Record<string, string> = { 'Lightning Bolt': '{R}', 'Grizzly Bears': '{1}{G}', 'Gut Shot': '{R/P}', Naturalize: '{1}{G}' };
const fixed = () => costs;

/** Every `roomDeckCosts` test's library: no catalogued eras this file cares about. */
const NO_LIBRARY = { format: () => undefined };
/** No name answers — the production shape (`pools/catalog.ts`'s `CardCatalog`) satisfies this; tests use a lighter fixture. */
const EMPTY_CATALOG: CatalogCosts = { byName: () => null };

const red = '[metadata]\nName=Red\n[main]\n4 Lightning Bolt|M10\n20 Mountain\n';
const gruul = '[metadata]\nName=Gruul\n[Main]\n4 Lightning Bolt\n4 Grizzly Bears\n18 Forest|M10\n';
const splashSide = '[metadata]\nName=Side\n[main]\n4 Lightning Bolt\n[Sideboard]\n2 Naturalize\n';
const colourless = '[metadata]\nName=Rocks\n[main]\n4 Gut Shot\n20 Wastes\n';

describe("a seat's deck colours, for the match's music", () => {
	const spec = (deck: string | null): Pick<ForgeMatchSpec, 'seats'> => ({ seats: [{ name: 'a', ai: false, deck }, { name: 'b', ai: false, deck: gruul }] });

	it('folds the main deck the seat was started with, never the other seat’s', () => {
		expect(seatDeckColors(spec(red), 0, fixed)).toEqual(['R']);
		expect(seatDeckColors(spec(red), 1, fixed)).toEqual(['R', 'G']);
	});

	it('leaves the sideboard and Phyrexian mana out', () => {
		expect(seatDeckColors(spec(splashSide), 0, fixed)).toEqual(['R']);
		expect(seatDeckColors(spec(colourless), 0, fixed)).toEqual([]);
	});

	it('is null for a precon the server never saw', () => {
		expect(seatDeckColors(spec(null), 0, fixed)).toBeNull();
	});

	it('travels on the shared wire schema', () => {
		expect(DeckColorsSchema.safeParse({ matchId: 'm', colors: seatDeckColors(spec(red), 1, fixed) }).success).toBe(true);
		expect(DeckColorsSchema.safeParse({ matchId: 'm', colors: null }).success).toBe(true);
	});
});

describe('the costs a room folds against', () => {
	const era = { fixture: { manaCost: { 'Era Card': '{U}' } } };
	const library = { format: (id: string) => (id === 'era' ? era : undefined) };

	it("adds the era's costs, and a drafted pool's cube costs, to the library's", () => {
		const costsFor = roomDeckCosts(library, [{ name: 'Cube Card', manaCost: ['2', 'B'] }], EMPTY_CATALOG);
		expect(costsFor('era')['Era Card']).toBe('{U}');
		expect(costsFor('era')['Lightning Bolt']).toBe('{R}');
		expect(costsFor('draft:cube')['Cube Card']).toBe('{2}{B}');
		expect(costsFor('era')['Cube Card']).toBeUndefined();
	});

	it("falls back to the catalog for a name none of the tables cover, never shadowing a table's own entry", () => {
		const catalog: CatalogCosts = { byName: (name) => (name === 'Cube Card' ? { manaCost: ['2', 'B'] } : null) };
		const costsFor = roomDeckCosts(library, null, catalog);
		expect(costsFor('era')['Cube Card']).toBe('{2}{B}');
		// A table entry (the library's own) still wins over the catalog for the same name.
		expect(costsFor('era')['Lightning Bolt']).toBe('{R}');
		// A name nothing knows — not the tables, not the catalog — is still honest absence.
		expect(costsFor('era')['Nothing Knows This']).toBeUndefined();
	});
});

/*
 * measured on the operator's own pod, r-67759762d971 (2 humans, 6 bots): the real drafted
 * pool (`~/srv-data/cardtable/drafts/<room>.json`'s `app.state.pools[1]`, seat 1 = "Hadoku" per
 * `displayNames`), an Abzan (W/B/G) pool with a Teval splash (U). Its real format id, read off
 * `http/routes.ts`'s own rule for a `gameType: 'draft'` room (`draftPoolId(room.id)`), is
 * `draft:r-67759762d971` — not the DEFAULT cube, so `state.defaultCubeCards`-only coverage misses
 * every one of these cards, and `LIBRARY_CARD_COSTS` covers only Qarsi Revenant (also a precon
 * staple). `seatDeckColors` folded this to `["B"]` in the prod log's `room-match-started` line for
 * every game this pod started, through exactly this production path (`deck-colors.ts`'s
 * `roomDeckCosts`, used for the match's own music) — RED here reproduces that, not a guess at it.
 */
describe("the operator's own drafted deck (r-67759762d971)", () => {
	// Real names and costs off the pool, as `app.state.pools[1]` holds them — none in `cube`
	// (`null`: this pod is not the server's DEFAULT cube) and only Qarsi Revenant in the library's own
	// `LIBRARY_CARD_COSTS`. The catalog answers every one of them, as the server's real catalog does
	// for any card it has ever synced from Scryfall.
	const HADOKU_MAIN = `[metadata]\nName=Cube draft r-67759762d971\n[main]\n1 Qarsi Revenant\n1 Severance Priest\n1 Betor, Kin to All\n1 Teval, Arbiter of Virtue\n1 Dusyut Earthcarver\n8 Plains\n7 Swamp\n7 Forest\n`;
	const POOL_COSTS: Record<string, readonly string[]> = {
		'Qarsi Revenant': ['1', 'B', 'B'],
		'Severance Priest': ['W', 'B', 'G'],
		'Betor, Kin to All': ['2', 'W', 'B', 'G'],
		'Teval, Arbiter of Virtue': ['2', 'B', 'G', 'U'],
		'Dusyut Earthcarver': ['5', 'G'],
	};
	const catalog: CatalogCosts = { byName: (name) => (POOL_COSTS[name] === undefined ? null : { manaCost: [...POOL_COSTS[name]] }) };
	const FORMAT = 'draft:r-67759762d971';
	const spec: Pick<ForgeMatchSpec, 'seats' | 'format'> = { format: FORMAT, seats: [{ name: 'Hadoku', ai: false, deck: HADOKU_MAIN }, { name: 'bot', ai: true, deck: null }] };

	it('folds the whole drafted pool — W, U, B and G — not just Qarsi Revenant’s own black', () => {
		const costsFor = roomDeckCosts(NO_LIBRARY, null, catalog);
		expect(seatDeckColors(spec, 0, costsFor)).toEqual(['W', 'U', 'B', 'G']);
	});
});

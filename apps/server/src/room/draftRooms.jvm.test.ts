/**
 * The realistic-round flow end to end, against the REAL jar and the REAL
 * catalog: `ForgePools.boosters` → the catalog's `byName` (the mapping
 * `http/rooms.ts`'s `/start` route and `resolveBoosterCard` do) → `deal()`'s
 * `realistic` hook → `createDraft`.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_CATALOG=… \
 *   CI=1 pnpm exec vitest run apps/server/src/room/draftRooms.jvm.test.ts
 *
 * Wave 74 §E, done when: "a realistic ISD pack from the real jar has a DFC,
 * shown in a JVM test run with the jar env and a skip count of 0." ISD's
 * `Booster=` template guarantees exactly one DFC slot per pack (see
 * `pools/forge.jvm.test.ts`'s own header on the same guarantee), so this
 * asserts it on every one of 8 seats, not just "at least one across all of
 * them" — a weaker assertion would pass even if the guarantee were broken
 * for seven of eight seats.
 *
 * A DFC resolved through the catalog carries the canonical, Scryfall-style
 * `Front // Back` name (`catalog.ts`'s own alias table resolves Forge's bare
 * front-face filing name to it — the same resolution `pools/forge.jvm.test.ts`
 * proves the OTHER direction for, Scryfall name -> Forge's). Asserting on
 * that joined name, rather than a hand-kept list of the 20 ISD front faces,
 * is what makes this test fail loudly if the catalog ever stops resolving
 * Forge's bare names rather than silently shipping an unresolved stand-in.
 */

import { afterAll, describe, expect, it } from 'vitest';
import type { DraftCard, DraftPlan } from '@hadoku/shared';
import { deal, type RealisticPacks } from '@hadoku/draft';

import { jvmHostConfig } from '../play/host.js';
import { createForgePools, type ForgePools } from '../pools/forge.js';
import { loadCardCatalog } from '../pools/catalog.js';
import { CONFIG } from '../config.js';

const available = jvmHostConfig();
const title = available.ok
	? "a realistic ISD pack, dealt end to end, carries Forge's guaranteed DFC slot"
	: `a realistic ISD pack, dealt end to end, carries Forge's guaranteed DFC slot — SKIPPED: ${available.reason}`;

const SEAT_COUNT = 8;

describe.skipIf(!available.ok)(title, () => {
	let pools: ForgePools | null = null;

	afterAll(async () => {
		if (pools !== null) await pools.close();
	});

	it('every seat\'s pack has at least one card whose resolved name is a DFC\'s "Front // Back"', { timeout: 60_000 }, async () => {
		if (!available.ok) return;
		pools ??= createForgePools(available.config, (entry) => console.log(`[draftRooms.jvm] ${JSON.stringify(entry)}`));

		const catalog = loadCardCatalog(CONFIG.catalogPath);
		const boosters = await pools.boosters('ISD', SEAT_COUNT, 'draftRooms-jvm-isd-dfc');
		expect(boosters).toHaveLength(SEAT_COUNT);

		// The exact mapping `resolveBoosterCard` (http/rooms.ts) does: the
		// catalog's `byName` over Forge's own filing name. `byPrinting` is
		// skipped here on purpose — this test is about the NAME resolution
		// that puts a DFC's two faces together, not about which printing's
		// art a card carries.
		const packs: DraftCard[][] = boosters.map((pack) =>
			pack.map(
				(card): DraftCard =>
					catalog.byName(card.name) ?? {
						cardId: card.name,
						name: card.name,
						manaCost: [],
						manaValue: 0,
						colors: [],
						typeLine: '',
						oracleText: '',
						setCode: card.set,
						collectorNumber: card.collectorNumber,
						rarity: 'special',
					},
			),
		);

		// All three rounds are realistic, all three handed the SAME fetched
		// packs — this test only cares that round 0's dealt cards are the
		// catalog-mapped packs, and a plan whose OTHER rounds are cube/set-cube
		// would call `sources()`, which has nothing to shuffle here.
		const plan: DraftPlan = {
			rounds: [{ kind: 'set', code: 'ISD', style: 'realistic' }, { kind: 'set', code: 'ISD', style: 'realistic' }, { kind: 'set', code: 'ISD', style: 'realistic' }],
		};
		const realistic: RealisticPacks = () => packs;
		const neverCalled = () => {
			throw new Error('a realistic round must never ask for a pool to shuffle');
		};
		const dealt = deal(plan, neverCalled, 'draftRooms-jvm-isd-dfc', SEAT_COUNT, 15, realistic);

		expect(dealt[0]).toHaveLength(SEAT_COUNT);
		const missingDfc: number[] = [];
		dealt[0]?.forEach((pack, seat) => {
			if (!pack.some((c) => c.name.includes(' // '))) missingDfc.push(seat);
		});
		if (missingDfc.length > 0) {
			console.log(`[draftRooms.jvm] seats with no resolved DFC name: ${JSON.stringify(missingDfc)}; names: ${JSON.stringify(dealt[0]?.map((p) => p.map((c) => c.name)))}`);
		}
		expect(missingDfc).toEqual([]);
	});
});

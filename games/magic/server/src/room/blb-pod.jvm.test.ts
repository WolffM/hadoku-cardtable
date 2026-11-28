// @reads e2e/fixtures/sets-catalog.json
/**
 * A Bloomburrow set-cube pod, the draft half of Sunday's tournament, against real Forge: the set's
 * cards as the server resolves them (`pools/sets.ts`'s `cardsFor`, Forge's `setCards` and a booster
 * sample, through the catalog), dealt as eight seats of three 15-card packs (`@hadoku/draft`'s
 * `deal`), drafted to the end by eight bots (`runBots`), and every bot's deck built as a pod table
 * builds it (`botDeckText`). Each deck must be legal, every card in it must be one Forge can play,
 * and two of them must start a real game.
 *
 * The catalog is the e2e fixture's (`e2e/fixtures/sets-catalog.json`, every Bloomburrow printing):
 * a claw has no catalog of its own.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run games/magic/server/src/room/blb-pod.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { resolve } from 'node:path';

import { parseDck } from '@hadoku/carddata/dck';
import { deckFromDeckFile, deckIssues, mainDeckSize } from '@hadoku/deck';
import { createDraft, deal, runBots } from '@hadoku/draft';
import type { DraftCard, DraftPlan } from '@hadoku/shared';
import { afterAll, describe, expect, it } from 'vitest';

import { available, startScenario, waitUntil } from '../play/scenario.js';
import { loadCardCatalog } from '../pools/catalog.js';
import { createForgePools, type ForgePools } from '../pools/forge.js';
import { createSetsStore } from '../pools/sets.js';
import { BOT_DECK_SIZE, botDeckText } from './botDeck.js';

const title = (t: string): string => (available.ok ? t : `${t} — SKIPPED: ${available.reason}`);

const SEATS = 8;
const PACKS = 3;
const PACK_SIZE = 15;
const BASIC = /^(Snow-Covered )?(Plains|Island|Swamp|Mountain|Forest|Wastes)$/;
const SEEDS = ['blb-pod-1', 'blb-pod-2', 'blb-pod-3'];
const OPENING = /keep your hand|play or draw/i;

const BLB_SET_CUBE: DraftPlan = { rounds: [0, 1, 2].map(() => ({ kind: 'set' as const, code: 'BLB', style: 'set-cube' as const })) as DraftPlan['rounds'] };

/** The main deck's card names, one entry a copy. */
const mainNames = (text: string): string[] => (parseDck(text).sections.get('main') ?? []).flatMap((e) => Array.from({ length: e.count }, () => e.card.name));

describe.skipIf(!available.ok)(title('a Bloomburrow set-cube pod deals, drafts and builds decks that Forge plays'), () => {
	let pools: ForgePools | null = null;
	afterAll(async () => {
		if (pools !== null) await pools.close();
	});

	it('three seeds: 15-card packs with no basic, eight bots draft 45 each, and every bot deck is legal and playable', { timeout: 300_000 }, async () => {
		if (!available.ok) return;
		pools = createForgePools(available.config, () => {});
		const catalog = loadCardCatalog(resolve(import.meta.dirname, '../../../../../e2e/fixtures/sets-catalog.json'));
		const store = createSetsStore({ forge: pools, catalog, log: () => {} });
		const cards = await store.cardsFor('BLB');
		expect(cards, 'Forge and the catalog resolve the set').not.toBeNull();
		const blb = cards!;
		expect(blb.filter((c) => c.typeLine === '').map((c) => c.name), 'every card has its text').toEqual([]);
		expect(blb.filter((c) => BASIC.test(c.name)).map((c) => c.name), 'a set cube holds no basic').toEqual([]);

		const decks: string[] = [];
		for (const seed of SEEDS) {
			const packs = deal(BLB_SET_CUBE, () => blb, seed, SEATS, PACK_SIZE);
			expect(packs, seed).toHaveLength(PACKS);
			for (const round of packs) {
				expect(round, seed).toHaveLength(SEATS);
				for (const pack of round) {
					const names = pack.map((c: DraftCard) => c.name);
					expect(names, seed).toHaveLength(PACK_SIZE);
					expect(names.filter((n) => BASIC.test(n)), seed).toEqual([]);
					expect(new Set(names).size, `${seed}: no card twice in one pack`).toBe(PACK_SIZE);
				}
			}
			const drafted = runBots(createDraft({ draftId: seed, seed, packs, seatCount: SEATS, packCount: PACKS, packSize: PACK_SIZE, humans: [] }), () => {});
			expect(drafted.state.status, `${seed}: the bots finish the draft`).toBe('complete');
			for (const [seat, pool] of drafted.state.pools.entries()) {
				expect(pool, `${seed} seat ${seat}`).toHaveLength(PACKS * PACK_SIZE);
				const text = botDeckText(pool, `${seed} bot ${seat}`);
				const deck = deckFromDeckFile(parseDck(text));
				expect(mainDeckSize(deck), `${seed} seat ${seat}`).toBe(BOT_DECK_SIZE);
				expect(deckIssues(deck), `${seed} seat ${seat}`).toEqual([]);
				decks.push(text);
			}
		}
		const everyName = [...new Set(decks.flatMap(mainNames))];
		expect(everyName.length, 'the decks name their cards').toBeGreaterThan(20);
		expect(await pools.check(everyName), 'every card a bot built in is one Forge can play').toEqual([]);

		// Two of them, at a real table: the deck seat 0 plays and the AI's.
		const s = await startScenario(available.config, { seed: 2929, decks: [decks[0]!, decks[1]!], aiOpponent: true });
		try {
			await waitUntil(
				() => {
					s.keepHands(OPENING);
					s.answerAsks();
					return /^Priority: /.test(s.prompt(0)) && s.zone(0, 'Hand').length > 0;
				},
				'seat 0 to hold a hand of its drafted deck with priority',
				120_000,
				s,
			);
			const deck0 = new Set(mainNames(decks[0]!));
			const hand = s.zone(0, 'Hand').map((c) => c.name);
			expect(hand.every((n) => deck0.has(n)), `the hand is the drafted deck's: ${hand.join(', ')}`).toBe(true);
		} finally {
			await s.stop();
		}
	});
});

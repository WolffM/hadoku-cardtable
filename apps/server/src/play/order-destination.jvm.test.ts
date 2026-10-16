/**
 * Where an order's cards go (`OrderSchema`'s `destination`), as the bridge
 * reads it off real Forge (`PlayBridge.java`'s `orderDestination`).
 *
 * The operator, 2026-10-16, over Tezzeret, Agent of Bolas's +1 ("… Put the
 * rest on the bottom of your library in any order"), which Forge captions
 * "Closest to top": *"the 'Closest to top 2' wording is confusing. can we
 * instead just show 'Bottom of deck'"*. Forge's caption comes from
 * `orderedMoveToTopOfLibrary`, which reads `LibraryPosition` only; Tezzeret's
 * rest go to `LibraryPosition2` (-1, the bottom). So:
 *
 *  - Tezzeret's +1: the bottom of the library, and Forge reverses the answer
 *    (its caption says "Closest to top") before sliding each card under in
 *    turn, so the answer's first card ends lowest;
 *  - Ponder: the top of the library, the answer's first card highest;
 *  - Foresee's Scry 4: the cards picked go under the library, the first one
 *    highest, and the server's fold puts the rest back on top, first highest.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/order-destination.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import type { ServerFrame } from '@hadoku/forge-wire';

import { available, deck, finishMulligan, landPayer, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'where an order’s cards go, read off real Forge'
	: `where an order’s cards go, read off real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Mountain']), deck('Any B', ['40 Mountain'])];

type OrderAsk = Extract<ServerFrame, { kind: 'ask'; method: 'order' }>;

const firstOrder = (s: Scenario): OrderAsk | undefined => s.asks.find((a): a is OrderAsk => a.kind === 'ask' && a.method === 'order');

/** Answer every ask and press OK for either seat while the stack waits, until the first `order` ask reaches seat 0. */
async function untilOrder(s: Scenario, what: string): Promise<OrderAsk> {
	const pay = landPayer(s, 0);
	await waitUntil(
		() => {
			if (firstOrder(s) !== undefined) return true;
			s.answerAsks();
			pay();
			for (const seat of [0, 1]) if (!/Pay Mana Cost/.test(s.prompt(seat)) && /Stack: 1 to Resolve/.test(s.prompt(seat)) && s.buttons(seat)?.enable1 === true) s.ok(seat);
			return firstOrder(s) !== undefined;
		},
		what,
		45_000,
		s,
	);
	const ask = firstOrder(s)!;
	console.log(`[order-destination] ${what}: ${JSON.stringify({ title: ask.title, top: ask.top, destination: ask.destination, rest: ask.rest })}`);
	return ask;
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'Tezzeret’s +1, captioned “Closest to top” by Forge: the bottom of the library, the answer’s first card lowest',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 16, decks: DECKS, scenario: scenarioText('od-tezzeret-pile') });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return /Stack: Empty/m.test(s.prompt(0)) && s.buttons(0)?.enable1 === true;
				}, "seat 0's own main phase", 20_000, s);
				const tezzeret = s.zone(0, 'Battlefield').find((c) => c.name === 'Tezzeret, Agent of Bolas');
				if (tezzeret === undefined) throw new Error('no Tezzeret on the battlefield');
				s.select(0, tezzeret.id);
				const ask = await untilOrder(s, 'Tezzeret’s order');
				expect(ask.top, 'Forge’s own caption, which says nothing about the bottom').toBe('Closest to top');
				expect(ask.destination).toEqual({ zone: 'library', end: 'bottom', first: 'bottom' });
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'Ponder: the top of the library, the answer’s first card highest',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 11, decks: DECKS, scenario: scenarioText('order-drag-ponder') });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return /Stack: Empty/m.test(s.prompt(0)) && s.buttons(0)?.enable1 === true;
				}, "seat 0's own main phase", 20_000, s);
				const ponder = s.zone(0, 'Hand').find((c) => c.name === 'Ponder');
				if (ponder === undefined) throw new Error('no Ponder in hand');
				s.select(0, ponder.id);
				const ask = await untilOrder(s, 'Ponder’s order');
				expect(ask.destination).toEqual({ zone: 'library', end: 'top', first: 'top' });
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'Foresee’s Scry 4: the picked cards under the library, first highest; the rest back on top, first highest',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 4, decks: DECKS, scenario: scenarioText('scry-one-prompt') });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return /Stack: Empty/m.test(s.prompt(0)) && s.buttons(0)?.enable1 === true;
				}, "seat 0's own main phase", 20_000, s);
				const foresee = s.zone(0, 'Hand').find((c) => c.name === 'Foresee');
				if (foresee === undefined) throw new Error('no Foresee in hand');
				s.select(0, foresee.id);
				const ask = await untilOrder(s, 'Foresee’s scry');
				expect(ask.destination).toEqual({ zone: 'library', end: 'bottom', first: 'top' });
				expect(ask.rest).toEqual({ zone: 'library', end: 'top', first: 'top' });
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});

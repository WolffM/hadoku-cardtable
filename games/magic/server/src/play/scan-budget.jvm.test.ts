/**
 * #92, nightly monkey 44998670203 (2026-11-22), m-c06d9701150a: Solar Flare's own Main 2, Remand in hand on an
 * empty stack, 22 cards to scan on a claw playing two matches. Forge's highlight scan ran out of its budget (50 ms
 * a card, `heuristic timed out after 1100ms`) and offered every card it had not reached as a play. The seat clicked
 * Remand, and Forge's own check of the click (`AvailableActions.offered`, which has no budget) refused it.
 *
 * The bridge gives the scan the time to finish (`PlayBridge.SCAN_BUDGET_MS`). Here the same main phase: four
 * counterspells with nothing to target and a 20-permanent board. None of them may be offered, and the scan may not
 * time out. `-Dcardtable.scanBudgetMs=1` in `CARDTABLE_PLAY_JVM_OPTS` cuts the scan short the way a loaded claw
 * did, and this test then fails: that is the reproduction.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/scan-budget \
 *   pnpm exec vitest run games/magic/server/src/play/scan-budget.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, inOwnMain, scenarioText, startScenario, timeline, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'the priority scan finishes, so a card it offers is one Forge takes, against real Forge'
	: `the priority scan finishes, so a card it offers is one Forge takes, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Islands', ['40 Island']), deck('Forests', ['40 Forest'])];

const COUNTERSPELLS = ['Remand', 'Mana Leak', 'Counterspell', 'Cancel'];

/** Every card Forge offered seat 0, over every `setWeaklySelectable` it sent. */
function offered(s: Scenario): Set<number> {
	return new Set(
		s.lines.flatMap((l) =>
			l.t === 'frame' && l.seat === 0 && (l.frame as { method?: unknown } | null)?.method === 'setWeaklySelectable'
				? ((l.frame as { cards?: { id: number }[] }).cards ?? []).map((c) => c.id)
				: [],
		),
	);
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'seat 0’s own main phase on an empty stack: no counterspell is offered, and the scan never runs out',
		async () => {
			if (!available.ok) throw new Error(available.reason);
			const s = await startScenario(available.config, { seed: 92, decks: DECKS, scenario: scenarioText('scan-budget-remand'), skipOpening: true, aiOpponent: true });
			try {
				await waitUntil(
					() => {
						s.answerAsks();
						return inOwnMain(s, 0, 1) && offered(s).size > 0;
					},
					"seat 0's own Main 1, with Forge's offer",
					60_000,
					s,
				);
				const hand = s.zone(0, 'Hand');
				const counters = hand.filter((c) => COUNTERSPELLS.includes(c.name));
				expect(counters.map((c) => c.name).sort()).toEqual([...COUNTERSPELLS].sort());
				const offer = offered(s);
				// The scan did reach the board: the Island in hand is a land drop.
				expect(offer.has(hand.find((c) => c.name === 'Island')!.id)).toBe(true);
				expect(counters.filter((c) => offer.has(c.id)).map((c) => c.name)).toEqual([]);
				expect(s.stderr().match(/heuristic timed out/g) ?? []).toEqual([]);
			} catch (err) {
				console.log(`[scan-budget] offered ${JSON.stringify([...offered(s)])}\n${timeline(s, 0)}`);
				throw err;
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});

/**
 * A payment Forge's Auto cannot settle and the highlighted cards can, against real Forge.
 *
 * The monkey's `ask-unclassified method=payment` (runs 42332476095, 42333563074; Mono Black Control,
 * Hive of the Eye Tyrant's {3}{B} animation): a payment whose Cancel is live is unclassified only when
 * Forge's Auto is dead and the cards it highlights are still enough to pay it. Auto is Forge's AI
 * payer, which never chains a source that needs mana of its own (a Signet) nor taps the card being
 * paid for (a man-land toward its own animation), so such a payment is the player's to finish by
 * hand. `answerability` said so in its notes and still logged every one as a question it had no
 * rule for. The board here is w68-pay's (`e2e/w68-pay.spec.ts` pays it by hand): two Islands and
 * Izzet Signet for Divination.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/by-hand \
 *   pnpm exec vitest run apps/server/src/play/by-hand-payment.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, inOwnMain, scenarioText, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? 'a payment the highlighted cards finish by hand while Auto is dead, against real Forge'
	: `a payment the highlighted cards finish by hand while Auto is dead, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Islands', ['40 Island']), deck('Mountains', ['40 Mountain'])];

describe.skipIf(!available.ok)(title, () => {
	it(
		'Divination over two Islands and Izzet Signet: Auto dead, the window reaches the seat, and the server has a rule for it',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 31, decks: DECKS, scenario: scenarioText('w68-pay'), skipOpening: true, aiOpponent: true });
			try {
				await waitUntil(
					() => {
						s.answerAsks();
						return inOwnMain(s, 0, 1);
					},
					"seat 0's own Main 1",
					60_000,
					s,
				);
				const divination = s.zone(0, 'Hand').find((c) => c.name === 'Divination');
				if (divination === undefined) throw new Error('no Divination in hand');
				s.select(0, divination.id);
				await waitUntil(
					() => {
						s.answerAsks();
						return /Pay Mana Cost/.test(s.prompt(0)) && s.logs.some((l) => l.evt === 'prompt-forwarded' && l.kind === 'payment');
					},
					"Divination's payment window, forwarded to the seat",
					30_000,
					s,
				);

				const offered = s.logs.filter((l) => l.evt === 'offered' && l.kind === 'payment').at(-1)?.cards as number[] | undefined;
				console.log(`[by-hand] payment: prompt=${JSON.stringify(s.prompt(0))} bar=${JSON.stringify(s.buttons(0))} offered=${JSON.stringify(offered)}`);
				// Forge's own facts: Auto dead, Cancel live, three highlighted sources for {2}{U}.
				expect(s.buttons(0)?.enable1, "Forge's Auto, which never chains the Signet").toBe(false);
				expect(s.buttons(0)?.enable2, 'Cancel: the payment is optional').toBe(true);
				expect(offered?.length).toBeGreaterThanOrEqual(3);

				// The claim: a question the server has a rule for.
				expect(s.logs.filter((l) => l.evt === 'ask-unclassified')).toEqual([]);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});

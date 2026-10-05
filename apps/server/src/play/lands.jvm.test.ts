/**
 * Wave 35, §F / R15 — "lands are tappable", against a REAL Forge match.
 *
 * Desktop Forge lets a player tap a land for mana at any point it holds priority,
 * before casting anything. Our click filter excluded every mana ability
 * (`forge-ai/src/main/java/forge/ai/AvailableActions.java`, `!sa.isManaAbility()`),
 * so a land was never offered (`setWeaklySelectable`) at priority and clicking it
 * did nothing useful. Fails on the jar installed when this test was written;
 * passes once the fork offers a tap-only mana ability too.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w35-f/work \
 *   pnpm exec vitest run apps/server/src/play/lands.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, inOwnMain, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? 'an untapped land is offered at priority, and clicking it taps for mana and nothing else, against real Forge'
	: `an untapped land is offered at priority, and clicking it taps for mana and nothing else, against real Forge — SKIPPED: ${available.reason}`;

describe.skipIf(!available.ok)(title, () => {
	it(
		'a basic land on the battlefield is in the offered set and taps cleanly when clicked',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, {
				seed: 35,
				decks: [deck('L A', ['40 Mountain']), deck('L B', ['40 Mountain'])],
			});
			try {
				await waitUntil(() => { s.keepHands(); s.answerAsks(); return [0, 1].some((n) => inOwnMain(s, n, 1)); }, 'turn 1 main', 90_000);
				const x = [0, 1].find((n) => inOwnMain(s, n, 1)) as number;

				// Play a land so there is an untapped one in play to offer and click.
				const land = s.zone(x, 'Hand').find((c) => c.land);
				if (land === undefined) throw new Error('no land in hand');
				s.select(x, land.id);
				await waitUntil(() => { s.answerAsks(); return s.zone(x, 'Battlefield').some((c) => c.id === land.id); }, 'the land to enter play', 20_000);

				// Priority returns to the same window (a land drop is a special action, not a pass).
				await waitUntil(() => { s.answerAsks(); return inOwnMain(s, x, 1); }, 'priority back after the land drop', 20_000);

				// The offered set: the last `setWeaklySelectable` this seat was sent before the click.
				const offered = [...s.sent].reverse().find((e) => e.seat === x && e.envelope.frame.method === 'setWeaklySelectable');
				const offeredIds = offered === undefined ? [] : (offered.envelope.frame as unknown as { cards: { id: number }[] }).cards.map((c) => c.id);
				expect(offeredIds, 'the untapped land was not offered at priority').toContain(land.id);

				const asksBefore = s.asks.length;
				const handBefore = s.zone(x, 'Hand').map((c) => c.id).sort();
				const battlefieldBefore = s.zone(x, 'Battlefield').map((c) => ({ id: c.id, tapped: c.tapped }));
				const oppHandBefore = s.zone(1 - x, 'Hand').length;

				// Click it: a basic land's mana ability has no choice to make, so no ask and no stack item.
				s.select(x, land.id);
				// The tapped flag and the returned priority arrive in separate frames; waiting on
				// the flag alone and then asserting priority read the gap between them (CI
				// 37231620033, 37262596895). Wait for the whole state the assertions below check.
				await waitUntil(
					() => {
						s.answerAsks();
						return (
							s.zone(x, 'Battlefield').find((c) => c.id === land.id)?.tapped === true &&
							/^Stack: Empty$/m.test(s.prompt(x)) &&
							inOwnMain(s, x, 1)
						);
					},
					'the land to tap for mana and priority to come back in its own main',
					20_000,
				);

				// Nothing else happened: Forge's own `getAbilityToPlay` re-asks itself for
				// every single-ability action (wave 34 §S4, confirmed for a land's own mana
				// ability too) — never a real choice, since each offer names exactly the one
				// ability. Priority stays put, and hand/battlefield are otherwise unchanged.
				const asksAfter = s.asks.slice(asksBefore);
				for (const ask of asksAfter) {
					const f = ask as unknown as { method: string; abilities: unknown[] };
					expect(f.method, 'tapping a land for mana asked something other than which ability to use').toBe('getAbilityToPlay');
					expect(f.abilities, 'tapping a land for mana offered more than its one ability').toHaveLength(1);
				}
				expect(/^Stack: Empty$/m.test(s.prompt(x))).toBe(true);
				expect(inOwnMain(s, x, 1)).toBe(true);
				expect(s.zone(x, 'Hand').map((c) => c.id).sort()).toEqual(handBefore);
				expect(s.zone(1 - x, 'Hand').length).toBe(oppHandBefore);
				const battlefieldAfter = s.zone(x, 'Battlefield').map((c) => ({ id: c.id, tapped: c.tapped }));
				expect(battlefieldAfter.filter((c) => c.id !== land.id)).toEqual(battlefieldBefore.filter((c) => c.id !== land.id));
				expect(battlefieldAfter.find((c) => c.id === land.id)?.tapped, 'the land did not tap').toBe(true);
			} finally {
				await s.stop();
			}
		},
		180_000,
	);
});

/**
 * Wave 33 §S, item 3 — Q14, against a REAL Forge match, set up by a
 * scenario: seat 0's creature is already an attacker (the `|Attacking`
 * marker) and the game lands straight in Declare Attackers Step — no click
 * needed to get there, which is the point: the claim under test is what
 * happens to an attacker that is ALREADY declared, not the declaring of one.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w33-S \
 *   pnpm exec vitest run apps/server/src/play/scenario-combat.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, scenarioText, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? 'an already-declared attacker, set up by a scenario, against real Forge'
	: `an already-declared attacker, set up by a scenario, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Mountain']), deck('Any B', ['40 Mountain'])];

describe.skipIf(!available.ok)(title, () => {
	it(
		'Q14: the attacker lands already declared, with the combat state to prove it',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 14, decks: DECKS, scenario: scenarioText('attackers-declared') });
			try {
				await finishMulligan(s);
				const attacker = await waitUntil(
					() => {
						s.answerAsks();
						return s.zone(0, 'Battlefield').some((c) => c.name === 'Memnite');
					},
					"seat 0's board to reflect the scripted attacker",
					20_000,
				).then(() => s.zone(0, 'Battlefield').find((c) => c.name === 'Memnite'));
				if (attacker === undefined) throw new Error('no Memnite on seat 0’s battlefield');
				// The claim: the game is in Declare Attackers Step, and the SERVER'S
				// own record of combat (not merely the scenario file) already has this
				// creature down as an attacker — `GameState`'s `|Attacking` marker took,
				// through `GameState.handleCombat`, not just placed the card.
				await waitUntil(() => {
					s.answerAsks();
					return s.phase(0) === 'Declare Attackers Step';
				}, 'the game to be in Declare Attackers Step', 20_000);
				const view = [...s.state(0).values()].find((o) => o._type === 0 && o._id === attacker.id);
				expect((view?.Attacking as { v?: boolean } | undefined)?.v, 'the wire never said this creature is attacking').toBe(true);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});

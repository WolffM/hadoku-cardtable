/**
 * Wave 33 §S, item 3 — Q14, against a REAL Forge match: "clicking a declared
 * attacker, and a box, pull attackers back." The scenario lands at seat 0's
 * own Main Phase 1 with one untapped, non-sick creature on the battlefield
 * (no `|Attacking` marker — see `scenarios/attackers-declared.state`'s own
 * header for why a GameState-declared attack skips Forge's live
 * `InputAttack` entirely, which is the bug E found in this file's first
 * design). The test presses priority forward through the ordinary main loop
 * so Forge's own phase transition opens the REAL declare-attackers window.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w33-S \
 *   pnpm exec vitest run apps/server/src/play/scenario-combat.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, scenarioText, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? 'the live declare-attackers window, set up by a scenario, against real Forge'
	: `the live declare-attackers window, set up by a scenario, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Mountain']), deck('Any B', ['40 Mountain'])];

describe.skipIf(!available.ok)(title, () => {
	it(
		'Q14: clicking a creature declares it as an attacker (Call Back); clicking it again pulls it back',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 14, decks: DECKS, scenario: scenarioText('attackers-declared') });
			try {
				await finishMulligan(s);
				const memnite = await waitUntil(
					() => {
						s.answerAsks();
						return s.zone(0, 'Battlefield').some((c) => c.creature && !c.tapped && !c.sick);
					},
					"seat 0's board to reflect the scripted, attack-ready creature",
					20_000,
				).then(() => s.zone(0, 'Battlefield').find((c) => c.creature));
				if (memnite === undefined) throw new Error('no attack-ready creature on seat 0’s battlefield');

				// Press seat 0's own Main Phase 1 priority stop, ONCE, to let the
				// normal main loop advance into combat — never touching the live
				// declare-attackers prompt once it opens (checked first, each tick).
				let pressedMain1 = false;
				await waitUntil(
					() => {
						s.answerAsks();
						if (/^Select creatures to attack/.test(s.prompt(0))) return true;
						const msg = s.prompt(0);
						if (!pressedMain1 && /^Priority:/.test(msg) && /Main phase, precombat/.test(msg) && s.buttons(0)?.enable1 === true) {
							pressedMain1 = true;
							s.ok(0);
						}
						return false;
					},
					"Forge's live declare-attackers window to open",
					20_000,
				);

				// The precondition: this is the LIVE input, not a GameState shortcut —
				// nothing is declared yet, so "Call Back" cannot be showing already.
				expect(s.buttons(0)?.label2, 'the window opened with an attacker already declared — not the claim under test').not.toBe('Call Back');

				// Click the creature: declares it as an attacker.
				s.select(0, memnite.id);
				await waitUntil(
					() => {
						s.answerAsks();
						return s.buttons(0)?.label2 === 'Call Back';
					},
					'the creature to be declared, showing "Call Back"',
					10_000,
				);
				expect(s.prompt(0), 'declaring an attacker left the live window entirely').toMatch(/^Select creatures to attack/);
				const declaredView = [...s.state(0).values()].find((o) => o._type === 0 && o._id === memnite.id);
				expect((declaredView?.Attacking as { v?: boolean } | undefined)?.v, 'the wire never marked the creature as attacking').toBe(true);

				// Click the SAME creature again: pulls it back (undeclares it).
				s.select(0, memnite.id);
				await waitUntil(
					() => {
						s.answerAsks();
						return s.buttons(0)?.label2 !== 'Call Back';
					},
					'"Call Back" to go away once the attacker is pulled back',
					10_000,
				);
				const undeclaredView = [...s.state(0).values()].find((o) => o._type === 0 && o._id === memnite.id);
				expect((undeclaredView?.Attacking as { v?: boolean } | undefined)?.v, 'the creature stayed marked as attacking after being pulled back').not.toBe(true);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});

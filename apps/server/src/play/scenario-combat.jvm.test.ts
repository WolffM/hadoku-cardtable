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

import { available, deck, finishMulligan, forgeFrames, scenarioText, startScenario, timeline, waitUntil } from './scenario.js';

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

	it(
		'T3: once the attacker is declared and the window closed with one OK, the priority window in the same step passes on its own — no second OK',
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
				s.select(0, memnite.id);
				await waitUntil(
					() => {
						s.answerAsks();
						return s.buttons(0)?.label2 === 'Call Back';
					},
					'the creature to be declared, showing "Call Back"',
					10_000,
				);
				// The ONE press the declaration needs. From here the test presses nothing.
				s.ok(0);
				let emptyStopSeen = false;
				await waitUntil(
					() => {
						s.answerAsks();
						const msg = s.prompt(0);
						if (/^Priority:/.test(msg) && /Declare Attackers Step/.test(msg) && s.buttons(0)?.enable1 === true) emptyStopSeen = true;
						return /^Priority:/.test(msg) && !/Declare Attackers Step/.test(msg);
					},
					'the Declare Attackers step to end with no further press',
					20_000,
				);
				expect(
					s.logs.some((l) => l.evt === 'auto-passed' && l.phase === 'Declare Attackers Step'),
					`the server passed the post-declaration window (the empty stop was ${emptyStopSeen ? '' : 'never '}offered to the seat)`,
				).toBe(true);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		"Juggernaut must attack: the attacker's OK carries Forge's refusal until Juggernaut is declared, and Forge takes it then",
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 31, decks: DECKS, scenario: scenarioText('must-attack') });
			const refusal = (): string | undefined => s.buttons(0)?.refusal1;
			const attacking = (id: number): boolean => {
				const view = [...s.state(0).values()].find((o) => o._type === 0 && o._id === id);
				return (view?.Attacking as { v?: boolean } | undefined)?.v === true;
			};
			const say = (step: string): void => console.log(`[must-attack] ${step} | ${JSON.stringify(s.buttons(0))}`);
			try {
				await finishMulligan(s);
				await waitUntil(
					() => {
						s.answerAsks();
						return s.zone(0, 'Battlefield').filter((c) => c.creature && !c.sick).length === 2;
					},
					"alice's Juggernaut and Bears on the board",
					20_000,
					s,
				);
				const juggernaut = s.zone(0, 'Battlefield').find((c) => c.name === 'Juggernaut')!;
				const bears = s.zone(0, 'Battlefield').find((c) => c.name === 'Grizzly Bears')!;
				let pressedMain1 = false;
				await waitUntil(
					() => {
						s.answerAsks();
						const msg = s.prompt(0);
						if (/^Select creatures to attack/.test(msg)) return true;
						if (!pressedMain1 && /^Priority:/.test(msg) && /Main phase, precombat/.test(msg) && s.buttons(0)?.enable1 === true) {
							pressedMain1 = true;
							s.ok(0);
						}
						return false;
					},
					"Forge's declare-attackers window to open",
					20_000,
					s,
				);
				say('opened');
				expect(s.buttons(0)?.enable1, 'Forge enables its OK').toBe(true);

				// What Forge does with the press: PhaseHandler finds the declaration invalid and asks again.
				const linesBeforeRefusedOk = s.lines.length;
				s.ok(0);
				await waitUntil(
					() => {
						s.answerAsks();
						return forgeFrames(s, 0, linesBeforeRefusedOk).some((f) => f.method === 'showPromptMessage' && /^Select creatures to attack/.test(f.message ?? ''));
					},
					"Forge's answer to OK with Juggernaut not attacking",
					10_000,
					s,
				);
				console.log(`[must-attack] OK with nothing declared: ${JSON.stringify(forgeFrames(s, 0, linesBeforeRefusedOk).map((f) => f.method))} | prompt ${JSON.stringify(s.prompt(0))}`);

				await waitUntil(() => refusal() !== undefined, 'nothing declared to be refused', 10_000, s);
				say('nothing declared');
				expect(refusal()).toBe('Attack declaration invalid');

				s.select(0, bears.id);
				await waitUntil(() => attacking(bears.id) && refusal() !== undefined, 'the Bears alone to be refused', 10_000, s);
				say('bears only');

				s.select(0, juggernaut.id);
				await waitUntil(() => attacking(juggernaut.id) && refusal() === undefined, 'Juggernaut attacking to make the declaration valid', 10_000, s);
				say('juggernaut declared');

				const linesBeforeOk = s.lines.length;
				s.ok(0);
				await waitUntil(
					() => {
						s.answerAsks();
						return forgeFrames(s, 0, linesBeforeOk).some((f) => f.method === 'showPromptMessage' && /^Priority:[\s\S]*Declare Attackers Step/.test(f.message ?? ''));
					},
					'Forge to take the declaration and move on to priority',
					10_000,
					s,
				);
				expect(attacking(juggernaut.id) && attacking(bears.id), 'both attack').toBe(true);
			} catch (err) {
				console.log(`[must-attack-timeline]\n${timeline(s, 0)}`);
				throw err;
			} finally {
				await s.stop();
			}
		},
		180_000,
	);
});

/**
 * Wave 33 §S, item 3 — Q17 and Q7, against a REAL Forge match, set up by a
 * scenario instead of played through three turns of land drops
 * (`priority.jvm.test.ts` did that; these two scenarios land directly in
 * seat 0's uncontested Main Phase 1 with the mana and the spell already in
 * hand).
 *
 * **Q17's case asserts the scripted hand card is offered as actionable BEFORE
 * selecting it** — not merely legal to select. That assertion used to fail:
 * every `setWeaklySelectable` sent to a scenario-landed seat carried an empty
 * list, because the FIRST `chooseSpellAbilityToPlay()` of any match runs
 * during the natural UNTAP step, before this hook has replaced anyone's
 * hand, and caches that (correctly empty, for UNTAP) result —
 * `InputPassPriority.showNormalPrompt()` (what sends `setWeaklySelectable`
 * for an ordinary priority window) reuses that stale cache rather than
 * rescanning. Fixed in `PlayBridge.java`'s `hostMatch()`: `refreshActionable`
 * forces one fresh `pushActionableCards(false)` per human seat right after
 * the scenario applies, before the game thread ever reaches a real priority
 * window. Mutation-tested: reverting that one call times out this exact
 * assertion (1/1); restored, both cases pass (2/2, two consecutive runs).
 * Full writeup: `docs/planning/wave33-evidence/s3-blockers.md`.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w33-S \
 *   pnpm exec vitest run apps/server/src/play/scenario-priority.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, scenarioText, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? 'priority on the stack, set up by a scenario, against real Forge'
	: `priority on the stack, set up by a scenario, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Mountain']), deck('Any B', ['40 Mountain'])];

describe.skipIf(!available.ok)(title, () => {
	it(
		'Q17: the caster does not hold priority on its own spell (no opponent, no response)',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 17, decks: DECKS, scenario: scenarioText('own-spell') });
			try {
				await finishMulligan(s);
				const memnite = await waitUntil(
					() => {
						s.answerAsks();
						return s.zone(0, 'Hand').some((c) => c.name === 'Memnite');
					},
					"seat 0's hand to reflect the scripted Memnite",
					20_000,
				).then(() => s.zone(0, 'Hand').find((c) => c.name === 'Memnite'));
				if (memnite === undefined) throw new Error('no Memnite in hand');
				// The precondition §S's bridge fix (`PlayBridge.java`'s
				// `refreshActionable`) exists for: the scripted hand card is actually
				// offered as actionable BEFORE anything selects it — not merely legal
				// to select. Without the fix this times out (every `setWeaklySelectable`
				// to seat 0 carries an empty list; see `wave33-evidence/s3-blockers.md`).
				await waitUntil(
					() => {
						s.answerAsks();
						return s.sent.some(
							(x) =>
								x.seat === 0 &&
								x.envelope.frame.method === 'setWeaklySelectable' &&
								(x.envelope.frame as unknown as { cards: { id: number }[] }).cards.some((c) => c.id === memnite.id),
						);
					},
					'Memnite to be offered as actionable to seat 0',
					15_000,
				);
				const logsBefore = s.logs.length;
				s.select(0, memnite.id);
				// The precondition: the caster really was given priority with its OWN
				// spell on the stack (not skipped straight to "resolved").
				await waitUntil(
					() => {
						s.answerAsks();
						return /Stack: 1 to Resolve/.test(s.prompt(0));
					},
					'the caster to be shown its own spell on the stack',
					20_000,
				);
				// The claim: it was passed anyway (an auto-pass, not a click), and the
				// spell resolved on its own.
				await waitUntil(
					() => {
						s.answerAsks();
						return /^Stack: Empty$/m.test(s.prompt(0));
					},
					'the spell to resolve without a click',
					20_000,
				);
				const passed = s.logs.slice(logsBefore).filter((l) => l.evt === 'auto-passed' && l.seat === 0);
				expect(passed.length, 'the caster held priority on its own spell').toBeGreaterThan(0);
				expect(s.zone(0, 'Battlefield').some((c) => c.name === 'Memnite')).toBe(true);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'Q7: a lone spell on the stack answers "select target spell" with a one-option, optional ask (min 0, max 1)',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, {
				seed: 7,
				decks: DECKS,
				scenario: scenarioText('lone-spell'),
				// The player's own answer to the target question: the one spell.
				reply: (f) => {
					if (f.method !== 'getChoices') return undefined;
					const choices = f.choices as { key: string }[];
					return /target/i.test(String(f.message)) && choices[0] !== undefined ? [choices[0].key] : undefined;
				},
			});
			try {
				await finishMulligan(s);
				// lone-spell.state: it is already seat 1's ("ai") Main Phase 1; cast
				// its free Memnite, which puts the one spell on the stack.
				const memnite = await waitUntil(
					() => {
						s.answerAsks();
						return s.zone(1, 'Hand').some((c) => c.name === 'Memnite');
					},
					"seat 1's hand to reflect the scripted Memnite",
					20_000,
				).then(() => s.zone(1, 'Hand').find((c) => c.name === 'Memnite'));
				if (memnite === undefined) throw new Error('no Memnite in hand');
				s.select(1, memnite.id);
				await waitUntil(
					() => {
						s.answerAsks();
						return /Stack: 1 to Resolve/.test(s.prompt(0)) && s.buttons(0)?.enable1 === true;
					},
					'seat 0 to be given priority with the spell on the stack',
					20_000,
				);
				const leak = s.zone(0, 'Hand').find((c) => c.name === 'Mana Leak');
				if (leak === undefined) throw new Error('no Mana Leak in hand');
				const askedBefore = s.asks.length;
				s.select(0, leak.id);
				await waitUntil(
					() => {
						s.answerAsks();
						return s.asks.slice(askedBefore).some((a) => a.method === 'getChoices');
					},
					'the target question',
					20_000,
				);
				const question = s.asks.slice(askedBefore).find((a) => a.method === 'getChoices') as unknown as {
					message: string;
					min: number;
					max: number;
					choices: { key: string; ref: { kind: string } | null }[];
				};
				expect(question.message).toBe('Select target spell');
				expect(question.choices).toHaveLength(1);
				expect(question.choices[0]?.ref?.kind).toBe('stackItem');
				expect({ min: question.min, max: question.max }).toEqual({ min: 0, max: 1 });
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});

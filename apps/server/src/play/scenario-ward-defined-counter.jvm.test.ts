/**
 * The operator, 2026-10-23 (match m-90a27550a092): cast Charge of the Mites at the
 * AI's warded Brutal Cathar, had no mana left, the server auto-cancelled the ward
 * payment (correct — Forge said unpayable) and Forge countered the spell. *"i
 * understand why that got auto-skipped but i would have liked to at least see an
 * animation for what happened. everything happened too fast there."*
 *
 * `live/placed.ts`'s countered beat fires off `StackEntry.targetStackItemId`
 * (`adapter.ts`: `stackTargetSpells?.get(sid)`), which `PlayBridge.stackTargetOf`
 * builds by reading each stack item's `TargetChoices` for a target that is itself
 * another stack item — the shape a Counterspell/Essence Scatter needs. Ward's own
 * trigger counters by a DEFINED reference instead (`CardFactoryUtil.java`, the
 * `Ward` keyword branch: `"DB$ Counter | Defined$ TriggeredSourceSA | UnlessCost$ "
 * + cost + " | UnlessPayer$ TriggeredSourceSAController"` — no `ValidTgts`, so
 * `TargetChoices` never carries a target at all), which `stackTargetOf` had no
 * branch for: it read ONLY `TargetChoices.getTargetSpells()`. So the pairing never
 * reached the wire for a ward trigger (or any other Counter-on-Defined effect —
 * `TriggeredSpellAbility`, `Remembered`, …), and the client drew no arrow and no
 * countered beat — Doom Blade (standing in for Charge of the Mites) just vanished
 * like an ordinary resolve.
 *
 * This is the direct, real-Forge proof of the fix. The scenario (`ward-defined-
 * counter.state`) is `auto-target.state` (Doom Blade, mandatory, single legal
 * target) with Ward {1} added to the lone creature: Armored Armadillo, colorless
 * and so nonblack, is Doom Blade's only legal target — Forge still asks for it
 * (one click, same as `scenario-targets.jvm.test.ts`), but there is nothing else
 * it could be. Alice has exactly {1}{B} (two Swamps): enough to cast it, nothing
 * left to pay ward's {1}. Forge's own policy (`decidePay`'s single-source branch
 * pays Doom Blade automatically; `decideCancel`'s `noWayToPay` branch cancels the
 * unpayable ward cost automatically) needs no further client act at all.
 *
 * Measured against the real jar: the whole arc — cast, trigger, the unpayable
 * cost, the counter, the graveyard move — runs inside ONE synchronous burst with
 * no priority stop in between (no `Stack: 1 to Resolve`/`Stack: 2 to Resolve`
 * ever reaches this seat's prompt at all). That IS the operator's "too fast":
 * nobody is ever asked anything, Forge resolves it outright. So this test never
 * waits for a stack count — it instead unions `stackTargetSpells` across EVERY
 * `applyDelta` this seat was sent during the burst (`addStackFacts` runs on every
 * one, wave 49 §A), because the pairing appears for however many of those deltas
 * the live stack genuinely held both items, even if no human-visible prompt ever
 * showed it. `foldFrames` (`visibility.ts`) never prunes a stack item once seen,
 * so both items' `Description` stay readable off the folded state even after the
 * stack is empty again.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/scenario-ward-defined-counter.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { DELTA_TYPE } from '@hadoku/forge-wire';

import { available, deck, finishMulligan, scenarioText, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? 'Ward {1} counters by a Defined reference, never a target — the pairing still reaches stackTargetSpells, against real Forge'
	: `Ward {1} counters by a Defined reference — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Mountain']), deck('Any B', ['40 Mountain'])];

describe.skipIf(!available.ok)(title, () => {
	it(
		'stackTargetSpells pairs the ward trigger with Doom Blade while both are on the stack, then Doom Blade is countered',
		async () => {
			if (!available.ok) return;

			const s = await startScenario(available.config, { seed: 67, decks: DECKS, scenario: scenarioText('ward-defined-counter') });
			try {
				await finishMulligan(s);

				const armadillo = await waitUntil(() => {
					s.answerAsks();
					return s.zone(1, 'Battlefield').some((c) => c.name === 'Armored Armadillo');
				}, "seat 1's battlefield to reflect the scripted Armored Armadillo", 20_000).then(() =>
					s.zone(1, 'Battlefield').find((c) => c.name === 'Armored Armadillo'),
				);
				if (armadillo === undefined) throw new Error('no Armored Armadillo on seat 1’s battlefield');

				const doomBlade = await waitUntil(() => {
					s.answerAsks();
					return s.zone(0, 'Hand').some((c) => c.name === 'Doom Blade');
				}, "seat 0's hand to reflect the scripted Doom Blade", 20_000).then(() => s.zone(0, 'Hand').find((c) => c.name === 'Doom Blade'));
				if (doomBlade === undefined) throw new Error('no Doom Blade in seat 0’s hand');

				s.select(0, doomBlade.id);
				// Targeting a CARD is a click (`scenario-targets.jvm.test.ts`), not a
				// `getChoices` ask — Doom Blade has exactly one legal target once it is
				// announced, but Forge still asks for it.
				let targeted = false;
				await waitUntil(
					() => {
						s.answerAsks();
						if (!targeted && /Select.*target/i.test(s.prompt(0))) {
							targeted = true;
							s.select(0, armadillo.id);
						}
						return targeted;
					},
					'Doom Blade to be announced and ask for its target',
					20_000,
					s,
				);

				// Mana ({1}{B}, two Swamps), the trigger, ward's own unpayable {1}, and
				// the counter all resolve off policy alone (`auto.ts`'s `decidePay`
				// single-source branch, then `decideCancel`'s `noWayToPay` branch) in one
				// synchronous burst — no act, and no stack-count prompt, of this test's own.
				await waitUntil(() => {
					s.answerAsks();
					return s.zone(0, 'Graveyard').some((c) => c.id === doomBlade.id);
				}, 'Doom Blade to land in the graveyard once the burst settles', 20_000, s);
				expect(s.zone(1, 'Battlefield').some((c) => c.id === armadillo.id), 'Armored Armadillo survived — the spell never resolved').toBe(true);

				// The items never get pruned from the folded state, even once gone from
				// the live stack (`foldFrames`), so both are still readable by name here.
				const items = [...s.state(0).values()].filter((o) => o._type === DELTA_TYPE.stackItem);
				const doomBladeItem = items.find((o) => ((o['Description'] as { v?: string } | undefined)?.v ?? '').includes('Doom Blade'));
				expect(doomBladeItem, 'Doom Blade’s own stack item').toBeDefined();
				const wardItem = items.find((o) => o !== doomBladeItem && ((o['Description'] as { v?: string } | undefined)?.v ?? '').includes('Ward'));
				expect(wardItem, 'the ward trigger’s own stack item').toBeDefined();

				// `stackTargetSpells` is a sibling of the frame's own `packet`
				// (wave 49 §A), never a property on the stack item's bag — read it off
				// EVERY `applyDelta`/`setGameView` this seat was sent across the whole
				// burst, since the live stack held both items for however many of those
				// deltas, never for a frame a human ever saw on its own.
				const allPairs = s.sent
					.filter((x) => x.seat === 0 && x.envelope.frame.kind === 'notify')
					.map((x) => x.envelope.frame as unknown as { payload?: { stackTargetSpells?: unknown } })
					.flatMap((f) => (Array.isArray(f.payload?.stackTargetSpells) ? (f.payload!.stackTargetSpells as [number, number][]) : []));
				expect(allPairs.length, 'at least one frame carried a stackTargetSpells pair').toBeGreaterThan(0);
				expect(
					allPairs,
					`stackTargetSpells names the ward trigger (${wardItem!._id}) → Doom Blade (${doomBladeItem!._id}) in at least one of the burst's deltas`,
				).toContainEqual([wardItem!._id, doomBladeItem!._id]);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});

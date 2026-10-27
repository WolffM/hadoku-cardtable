/**
 * AE27 — a spell countered by ANOTHER spell (Counterspell on Memnite), as distinct from one that
 * fizzles on its own (`scenario-countered-fizzle.jvm.test.ts`) and from `scenario-w46-b-counterspell.
 * jvm.test.ts`, which stops the moment Counterspell reaches the stack and never lets it resolve.
 *
 * `CounterEffect.resolve` (`forge-game/.../ability/effects/CounterEffect.java`) removes its TARGET
 * from the stack directly (`game.getStack().remove(si)`), mid-resolution of the countering spell —
 * the target's own `SpellAbility.resolve()` never runs, so Forge never fires a
 * `GameEventSpellResolved` for it at all, only `GameEventSpellRemovedFromStack`.
 * `PlayBridge.java`'s `EffectJournal.removed` journals exactly that case onto
 * `counteredStackItems`; `EffectJournal.resolved` marks Counterspell's OWN id as having resolved
 * cleanly first, so Counterspell's own later `GameEventSpellRemovedFromStack` (once IT finishes
 * resolving) is never mistaken for a second counter.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/scenario-countered-counterspell.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { DELTA_TYPE } from '@hadoku/forge-wire';

import { available, deck, finishMulligan, landPayer, scenarioText, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? 'Counterspell on Memnite: once it resolves, counteredStackItems names Memnite, never Counterspell — against real Forge'
	: `Counterspell on Memnite resolving — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Mountain']), deck('Any B', ['40 Mountain'])];

describe.skipIf(!available.ok)(title, () => {
	it(
		'counteredStackItems names the countered spell (Memnite), never the countering one (Counterspell)',
		async () => {
			if (!available.ok) return;

			const s = await startScenario(available.config, {
				seed: 7,
				decks: DECKS,
				scenario: scenarioText('w46-b-counterspell'),
				// The stack-target ask (`TargetSelection.chooseCardFromStack`) offers stack-item refs, which
				// `answerAsks`'s plain fallback does not know how to pick for — same `reply` as
				// `scenario-w46-b-counterspell.jvm.test.ts`, which this scenario is shared with.
				reply: (f) => {
					if (f.method !== 'getChoices') return undefined;
					const choices = f.choices as { key: string; label?: string; ref?: unknown }[];
					return /target/i.test(String(f.message)) && choices[0] !== undefined ? [choices[0].key] : undefined;
				},
			});
			try {
				await finishMulligan(s);

				const memnite = await waitUntil(() => {
					s.answerAsks();
					return s.zone(1, 'Hand').some((c) => c.name === 'Memnite');
				}, "seat 1's hand to reflect Memnite", 20_000).then(() => s.zone(1, 'Hand').find((c) => c.name === 'Memnite'));
				if (memnite === undefined) throw new Error('no Memnite in hand');
				s.select(1, memnite.id);
				await waitUntil(() => {
					s.answerAsks();
					return /Stack: 1 to Resolve/.test(s.prompt(0)) && s.buttons(0)?.enable1 === true;
				}, 'seat 0 to be given priority with Memnite on the stack', 20_000);

				const outcome = s.match.setFullControl(0, true);
				expect(outcome.ok).toBe(true);

				const counterspell = s.zone(0, 'Hand').find((c) => c.name === 'Counterspell');
				if (counterspell === undefined) throw new Error('no Counterspell in hand');
				s.select(0, counterspell.id);

				const payLand = landPayer(s, 0);
				await waitUntil(() => {
					s.answerAsks();
					payLand();
					return /Stack: 2 to Resolve/.test(s.prompt(0));
				}, 'Counterspell to reach the stack (Stack: 2 to Resolve)', 30_000, s);

				const items = [...s.state(0).values()].filter((o) => o._type === DELTA_TYPE.stackItem);
				const counterItem = items.find((o) => ((o['Description'] as { v?: string } | undefined)?.v ?? '').includes('Counterspell'));
				const memniteItem = items.find((o) => o !== counterItem);
				expect(counterItem, 'Counterspell’s own stack item').toBeDefined();
				expect(memniteItem, 'Memnite’s own stack item').toBeDefined();

				// Let the stack resolve: Counterspell counters Memnite (removed with no resolved event of
				// its own), then resolves itself cleanly.
				await waitUntil(
					() => {
						s.answerAsks();
						if (s.buttons(0)?.enable1 === true) s.ok(0);
						return s.zone(1, 'Graveyard').some((c) => c.id === memnite.id);
					},
					'Memnite to be countered into seat 1’s graveyard',
					30_000,
					s,
				);
				expect(s.zone(0, 'Graveyard').some((c) => c.id === counterspell.id), 'Counterspell resolved into seat 0’s own graveyard').toBe(true);

				const allCountered = s.sent
					.filter((x) => x.seat === 0 && x.envelope.frame.kind === 'notify')
					.map((x) => x.envelope.frame as unknown as { payload?: { counteredStackItems?: unknown } })
					.flatMap((f) => (Array.isArray(f.payload?.counteredStackItems) ? (f.payload!.counteredStackItems as number[]) : []));
				expect(allCountered, `counteredStackItems names Memnite (${memniteItem!._id}), never Counterspell (${counterItem!._id})`).toContain(memniteItem!._id);
				expect(allCountered).not.toContain(counterItem!._id);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});

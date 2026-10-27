/**
 * AE27 — the operator: spells that are countered should "crack and fade", never the ordinary
 * glide a clean resolution gets, and that has to cover a FIZZLE (a spell whose own target is gone
 * when its turn to resolve comes) exactly like a direct counter (`scenario-ward-defined-counter.
 * jvm.test.ts`, `scenario-w46-b-counterspell.jvm.test.ts` — neither of which lets its spell actually
 * resolve/fizzle, only reach the stack).
 *
 * `MagicStack.resolveStack` fires `GameEventSpellResolved(sa, hasFizzled)` for EVERY item that
 * resolves, fizzled or not (`forge-game/.../zone/MagicStack.java:660`); a direct counter
 * (`CounterEffect.removeFromStack`) instead calls `game.getStack().remove(si)` on its TARGET
 * directly, which never fires a resolved event for that target at all — only
 * `GameEventSpellRemovedFromStack` (`forge-game/.../ability/effects/CounterEffect.java`). So
 * `PlayBridge.java`'s `EffectJournal` tells the two apart the same way: `resolved` marks a
 * SpellAbility id as having resolved (fizzled or not); `removed` journals `counteredStackItems` only
 * when NO resolved event marked that id first — covering a direct counter. A FIZZLE is journaled
 * straight off `resolved`'s own `hasFizzled` flag, in the same `countered` list, since the client's
 * `placed.ts` draws both the same way (crack and fade, never the house glide).
 *
 * The scenario (`countered-fizzle.state`): Doom Blade targets the ai's lone creature, Memnite; before
 * passing priority, Unsummon targets Memnite too. LIFO: Unsummon resolves first and bounces Memnite
 * to hand, so Doom Blade's own turn to resolve finds no legal target — `hasFizzled` true, never a
 * counter from another spell.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/scenario-countered-fizzle.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { DELTA_TYPE } from '@hadoku/forge-wire';

import { available, deck, finishMulligan, landPayer, scenarioText, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? 'a fizzled spell (its own target gone when it resolves) is journaled onto counteredStackItems — against real Forge'
	: `a fizzled spell is journaled onto counteredStackItems — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Mountain']), deck('Any B', ['40 Mountain'])];

describe.skipIf(!available.ok)(title, () => {
	it(
		'counteredStackItems names Doom Blade (fizzled) and never Unsummon (resolved cleanly)',
		async () => {
			if (!available.ok) return;

			const s = await startScenario(available.config, { seed: 11, decks: DECKS, scenario: scenarioText('countered-fizzle') });
			try {
				await finishMulligan(s);

				const memnite = await waitUntil(() => {
					s.answerAsks();
					return s.zone(1, 'Battlefield').some((c) => c.name === 'Memnite');
				}, "seat 1's battlefield to reflect the scripted Memnite", 20_000).then(() => s.zone(1, 'Battlefield').find((c) => c.name === 'Memnite'));
				if (memnite === undefined) throw new Error('no Memnite on seat 1’s battlefield');

				// Full control BEFORE casting Doom Blade: the default policy auto-passes a seat's own
				// priority once nothing is left to respond to, which would resolve Doom Blade outright
				// before Unsummon ever reaches the stack behind it.
				const outcome = s.match.setFullControl(0, true);
				expect(outcome.ok).toBe(true);

				const doomBlade = s.zone(0, 'Hand').find((c) => c.name === 'Doom Blade');
				if (doomBlade === undefined) throw new Error('no Doom Blade in seat 0’s hand');
				s.select(0, doomBlade.id);
				let targeted = false;
				const payDoomBlade = landPayer(s, 0);
				await waitUntil(
					() => {
						s.answerAsks();
						if (!targeted && /Select.*target/i.test(s.prompt(0))) {
							targeted = true;
							s.select(0, memnite.id);
						}
						payDoomBlade();
						return /Stack: 1 to Resolve/.test(s.prompt(0));
					},
					'Doom Blade to be announced, targeted and paid for (Stack: 1 to Resolve)',
					30_000,
					s,
				);

				const unsummon = s.zone(0, 'Hand').find((c) => c.name === 'Unsummon');
				if (unsummon === undefined) throw new Error('no Unsummon in seat 0’s hand');
				s.select(0, unsummon.id);
				let targetedUnsummon = false;
				const payUnsummon = landPayer(s, 0);
				await waitUntil(
					() => {
						s.answerAsks();
						if (!targetedUnsummon && /Select.*target/i.test(s.prompt(0))) {
							targetedUnsummon = true;
							s.select(0, memnite.id);
						}
						payUnsummon();
						return /Stack: 2 to Resolve/.test(s.prompt(0));
					},
					'Unsummon to be announced, targeted and paid for, on top of Doom Blade (Stack: 2 to Resolve)',
					30_000,
					s,
				);

				// Pass priority until the stack is empty: Unsummon resolves first (LIFO), bouncing Memnite;
				// Doom Blade's own resolution then finds no legal target and fizzles rather than doing
				// anything.
				await waitUntil(
					() => {
						s.answerAsks();
						if (s.buttons(0)?.enable1 === true) s.ok(0);
						return /Stack: Empty/.test(s.prompt(0));
					},
					'the stack to empty once Doom Blade has fizzled behind the resolved Unsummon',
					30_000,
					s,
				);
				expect(s.zone(1, 'Hand').some((c) => c.id === memnite.id), 'Memnite bounced to seat 1’s hand by Unsummon').toBe(true);
				expect(s.zone(1, 'Battlefield').some((c) => c.id === memnite.id), 'Memnite is no longer on the battlefield').toBe(false);

				// `foldFrames` never prunes a stack item once seen, so both are still readable by name
				// off the folded state even after the stack is empty again.
				const items = [...s.state(0).values()].filter((o) => o._type === DELTA_TYPE.stackItem);
				const doomBladeItem = items.find((o) => ((o['Description'] as { v?: string } | undefined)?.v ?? '').includes('Doom Blade'));
				expect(doomBladeItem, 'Doom Blade’s own stack item').toBeDefined();
				const unsummonItem = items.find((o) => ((o['Description'] as { v?: string } | undefined)?.v ?? '').includes('Unsummon'));
				expect(unsummonItem, 'Unsummon’s own stack item').toBeDefined();

				// `counteredStackItems` is `PlayBridge.java`'s `EffectJournal`, a sibling of `applyDelta`'s own
				// `packet` exactly like `deaths`/`damage` — union it across every frame this seat was sent
				// (`effectsSince` only sends what is new since the LAST frame, so the fizzle's own entry rides
				// whichever delta the server built once resolution settled).
				const allCountered = s.sent
					.filter((x) => x.seat === 0 && x.envelope.frame.kind === 'notify')
					.map((x) => x.envelope.frame as unknown as { payload?: { counteredStackItems?: unknown } })
					.flatMap((f) => (Array.isArray(f.payload?.counteredStackItems) ? (f.payload!.counteredStackItems as number[]) : []));
				expect(allCountered, `counteredStackItems names fizzled Doom Blade (${doomBladeItem!._id}), never cleanly-resolved Unsummon (${unsummonItem!._id})`).toContain(
					doomBladeItem!._id,
				);
				expect(allCountered).not.toContain(unsummonItem!._id);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});

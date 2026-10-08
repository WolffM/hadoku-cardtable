/**
 * Wave 46 §B item 3 — what the wire says when a spell targets ANOTHER SPELL
 * on the stack (Counterspell on Memnite), against a real Forge JVM.
 *
 * `live/placed.ts`'s `.placed__arrow`s (and, until wave 64/J6 deleted it,
 * `auto-targets.ts`'s `autoTargetArrows`) draw a passive arrow from
 * `StackEntry.targetCardIds`/`targetPlayerIds` —
 * `StackItemView`'s own `TargetCards`/`TargetPlayers` (`TrackableProperty.java:
 * 225-226`), set from `SpellAbilityStackInstance.getTargetChoices()`. Those
 * two collections are typed `CardViewCollectionType`/`PlayerViewCollectionType`
 * on the wire, and Forge's own `TargetChoices` (`forge-game/.../spellability/
 * TargetChoices.java:45-97`) can hold a `Player`, a `Card`, OR a bare
 * `SpellAbility` — three disjoint Java types — with `getTargetCards()`/
 * `getTargetPlayers()` filtering strictly by runtime type. `TargetSelection.
 * chooseCardFromStack` (`forge-gui/.../player/TargetSelection.java:299-336`)
 * adds the countered ability as `stackItemViewCache.get(choice).getSpellAbility()`
 * — a `SpellAbility`, not a `Card` — so it fails BOTH filters.
 *
 * This is the direct, real-Forge proof of that reading: Counterspell's own
 * resulting `StackItemView` carries `TargetCards: []` and `TargetPlayers: []`
 * once it is on the stack, even though the ability plainly does target
 * something. There is no third `Target*` collection on the wire at the
 * STACK ITEM's own property-bag layer — `TrackableProperty.java` has exactly
 * the two — so the targeted stack item's id is NOT recoverable from the
 * resolved `StackItemView` at all, by any field on it. See
 * `docs/planning/wave46-evidence/B/README.md` for what this meant for the
 * arc at the time (wave 46: the arrow drawn from client-side intent,
 * recorded at the moment THIS seat answers the `getChoices` ask).
 *
 * **Wave 49 §A** closed the gap this left for the OPPONENT (who answers no
 * ask and holds no client-side intent): `PlayBridge.java` now computes the
 * same pairing itself, off the live stack rather than off `StackItemView`'s
 * property bag, and sends it as `stackTargetSpells` — a SIBLING of the frame's
 * `packet`/`gameView`, not a `TrackableProperty` (`packages/forge-wire/src/
 * tier-c.ts`'s `StackTargetSpellsSchema`). The final assertions below (after
 * the `TargetCards`/`TargetPlayers` ones) are that proof, read off the actual
 * frames this seat was sent, in the SAME exchange: the wire now DOES carry
 * the pairing — just not on the stack item's own property bag, which stays
 * empty exactly as the assertions above prove.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/scenario-w46-b-counterspell.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, idsOf, landPayer, scenarioText, startScenario, waitUntil } from './scenario.js';
import { TYPE } from './visibility.js';

const title = available.ok
	? 'Counterspell over Memnite: the resulting stack item’s TargetCards/TargetPlayers, against real Forge'
	: `Counterspell over Memnite, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Mountain']), deck('Any B', ['40 Mountain'])];

describe.skipIf(!available.ok)(title, () => {
	it(
		'the countering stack item carries no target id at all — confirmed against the real jar',
		async () => {
			if (!available.ok) return;

			/** Every `getChoices` ask seen, with the live stack items at the moment it arrived. */
			const targetAsks: { message: string; choiceRefs: unknown[]; stackItemsAtAsk: { id: number; desc: string | null }[] }[] = [];

			const s = await startScenario(available.config, {
				seed: 7,
				decks: DECKS,
				scenario: scenarioText('w46-b-counterspell'),
				reply: (f) => {
					if (f.method !== 'getChoices') return undefined;
					const choices = f.choices as { key: string; label?: string; ref?: unknown }[];
					if (!/target/i.test(String(f.message)) || choices[0] === undefined) return undefined;
					const stackItemsAtAsk = [...s.state(0).values()]
						.filter((o) => o._type === TYPE.stackItem)
						.map((o) => ({ id: o._id, desc: (o['Description'] as { v?: string } | undefined)?.v ?? null }));
					targetAsks.push({ message: String(f.message), choiceRefs: choices.map((c) => c.ref), stackItemsAtAsk });
					return [choices[0].key];
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

				// One land per observed prompt change (`landPayer`).
				const payLand = landPayer(s, 0);
				await waitUntil(() => {
					s.answerAsks();
					payLand();
					return /Stack: 2 to Resolve/.test(s.prompt(0));
				}, 'Counterspell to reach the stack (Stack: 2 to Resolve)', 30_000, s);

				// The target ask fired exactly once, and at that moment the choice it
				// offered was a STACK ITEM ref (Memnite's), not a card ref — matching
				// `TargetSelection.chooseCardFromStack`'s own `getChoices` over
				// `StackItemView`s, never a card offer.
				expect(targetAsks).toHaveLength(1);
				const ask = targetAsks[0]!;
				expect(ask.choiceRefs.length).toBeGreaterThan(0);
				expect(ask.choiceRefs[0]).toMatchObject({ kind: 'stackItem' });
				// And Counterspell's OWN stack item did not exist yet when the ask
				// fired: Forge resolves the target before the countering spell itself
				// is represented on the stack this client was sent.
				expect(ask.stackItemsAtAsk).toHaveLength(1);

				// Now Counterspell is the top of the stack (2 items total). Its own
				// StackItemView carries TargetCards/TargetPlayers — and per the header,
				// both read empty: the thing it targeted was added as a bare
				// SpellAbility, which neither collection's runtime-type filter keeps.
				const state0 = s.state(0);
				const items = [...state0.values()].filter((o) => o._type === TYPE.stackItem);
				expect(items).toHaveLength(2);
				const counterItem = items.find((o) => ((o['Description'] as { v?: string } | undefined)?.v ?? '').includes('Counterspell'));
				expect(counterItem, 'Counterspell’s own stack item').toBeDefined();
				expect(idsOf(counterItem, 'TargetCards')).toEqual([]);
				expect(idsOf(counterItem, 'TargetPlayers')).toEqual([]);

				// The other item is still Memnite's, untouched — a sanity check that
				// this is reading the right two objects.
				const memniteItem = items.find((o) => o !== counterItem);
				expect(((memniteItem?.['Description'] as { v?: string } | undefined)?.v ?? '')).toMatch(/Memnite/);

				// Wave 49 §A: `stackTargetSpells` is a SIBLING of the frame's own
				// `packet`, not a property on the stack item's bag read above — so
				// read it off the actual frames this seat was sent
				// (`s.sent`, the server's REAL emit calls, projected through
				// `visibility.ts` exactly as a browser would receive them), not off
				// `s.state(0)`. The latest frame to carry the field wins, since it is
				// a full snapshot every time, never a delta of pairs.
				const framesWithPairs = s.sent
					.filter((x) => x.seat === 0 && x.envelope.frame.kind === 'notify')
					.map((x) => x.envelope.frame as unknown as { payload?: { stackTargetSpells?: unknown } })
					.filter((f) => Array.isArray(f.payload?.stackTargetSpells));
				expect(framesWithPairs.length, 'at least one frame carried stackTargetSpells').toBeGreaterThan(0);
				const latestPairs = framesWithPairs[framesWithPairs.length - 1]!.payload!.stackTargetSpells as [number, number][];
				expect(
					latestPairs,
					`stackTargetSpells names Counterspell (${counterItem!._id}) → Memnite (${memniteItem!._id})`,
				).toContainEqual([counterItem!._id, memniteItem!._id]);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});

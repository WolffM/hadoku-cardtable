/**
 * Wave 33 §S, item 3 — the auto-target arrow (first list's item 8) and Q18's
 * evidence, against a REAL Forge match, each set up by a scenario.
 *
 * Auto-target: Doom Blade ("destroy target nonblack creature", mandatory —
 * not Fiend Hunter's optional "you may exile", which never showed a
 * populated `TargetCards` within this lane's budget; see
 * `wave33-evidence/s3-blockers.md`'s "the auto-target scenario" for that
 * attempt) against a lone, colorless legal target. The claim this suite
 * proves is narrower than the UI arrow: that the WIRE carries `TargetCards`
 * for the cast spell's stack item, which is the one fact §G needs before it
 * can draw the arrow at all (its own brief: "if S's wire evidence says the
 * targets do not reach the browser, stop on this item and report" — this is
 * that evidence).
 *
 * Q18 evidence: a permanent's own non-mana ability, once activated, is a
 * STACK ITEM whose `sourceCard` is the permanent — still on the battlefield,
 * never consumed — unlike a spell, whose card leaves its zone. `Board.tsx`'s
 * bug (§B item 1) is selecting a stack entry by that `sourceCardId`, which
 * for an ability is the permanent Forge already lets the seat click for its
 * OWN reasons (reactivating it), not Stifle-like targeting of the ability
 * itself.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w33-S \
 *   pnpm exec vitest run apps/server/src/play/scenario-targets.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, idsOf, scenarioText, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? 'targets on the wire, set up by a scenario, against real Forge'
	: `targets on the wire, set up by a scenario, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Mountain']), deck('Any B', ['40 Mountain'])];

describe.skipIf(!available.ok)(title, () => {
	it(
		'the auto-target arrow: TargetCards is on the wire for a mandatory single-target spell',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 1008, decks: DECKS, scenario: scenarioText('auto-target') });
			try {
				await finishMulligan(s);
				const doomBlade = await waitUntil(
					() => {
						s.answerAsks();
						return s.zone(0, 'Hand').some((c) => c.name === 'Doom Blade');
					},
					"seat 0's hand to reflect the scripted Doom Blade",
					20_000,
				).then(() => s.zone(0, 'Hand').find((c) => c.name === 'Doom Blade'));
				if (doomBlade === undefined) throw new Error('no Doom Blade in hand');
				const memnite = s.zone(1, 'Battlefield').find((c) => c.name === 'Memnite');
				if (memnite === undefined) throw new Error("no Memnite on seat 1's battlefield — the scenario's one legal target");
				s.select(0, doomBlade.id);
				// Casting a spell that needs a target announces it WITH that target
				// already chosen (CR 601.2c). Unlike Q7's Mana Leak (which targets a
				// STACK ITEM and asks via `getChoices`), targeting a CARD is a click —
				// `setSelectables`/`setHighlighted` mark the lone legal target and the
				// player (here, the test) selects it with an ordinary `selectCard` act,
				// the same `s.select()` any card click uses. Confirmed via a real run:
				// the prompt is "Select target nonblack creature" with OK disabled until
				// a target is clicked — not an `ask` `answerAsks()` would catch.
				let targeted = false;
				let lastSeen: unknown = null;
				await waitUntil(
					() => {
						s.answerAsks();
						if (!targeted && /Select target/.test(s.prompt(0))) {
							targeted = true;
							s.select(0, memnite.id);
						}
						const item = [...s.state(0).values()].find((o) => o._type === 2);
						if (item !== undefined) lastSeen = item;
						return item !== undefined && idsOf(item, 'TargetCards').length > 0;
					},
					"Doom Blade's stack item to carry a target",
					20_000,
				).catch(() => {
					// Let the assertion below report it with the last frame seen, rather
					// than a bare timeout.
				});
				const targetCards = idsOf(lastSeen as Parameters<typeof idsOf>[0], 'TargetCards');
				writeFileSync(
					'/tmp/claude-1000/w33-S/auto-target-stackitem.json',
					JSON.stringify({ lastSeen, targetCards, asks: s.asks.map((a) => ({ method: a.method })) }, null, 2),
				);
				expect(targetCards, `TargetCards did not reach the wire for Doom Blade's stack item: ${JSON.stringify(lastSeen)}`).toContain(memnite.id);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'Q18 evidence: an activated ability on the stack is identified by its SOURCE PERMANENT, still on the battlefield',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 18, decks: DECKS, scenario: scenarioText('glint-hawk') });
			try {
				await finishMulligan(s);
				const sorcerer = await waitUntil(
					() => {
						s.answerAsks();
						return s.zone(0, 'Battlefield').some((c) => c.name === 'Prodigal Sorcerer');
					},
					"seat 0's board to reflect the scripted Prodigal Sorcerer",
					20_000,
				).then(() => s.zone(0, 'Battlefield').find((c) => c.name === 'Prodigal Sorcerer'));
				if (sorcerer === undefined) throw new Error('no Prodigal Sorcerer on seat 0’s battlefield');
				expect(sorcerer.tapped, 'the ability needs an untapped source').toBe(false);
				s.select(0, sorcerer.id);
				// Prodigal Sorcerer's ability targets "any target"; answer with the
				// opponent player once Forge asks for one.
				const oppId = s.match.seats[1]?.playerId as number;
				let targeted = false;
				await waitUntil(
					() => {
						s.answerAsks();
						if (!targeted && /target/i.test(s.prompt(0))) {
							targeted = true;
							s.match.fromClient(0, { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: oppId }, triggerEvent: null } as never);
						}
						return [...s.state(0).values()].some((o) => o._type === 2);
					},
					'the ability to be announced and reach the stack',
					20_000,
				);
				const stackItem = [...s.state(0).values()].find((o) => o._type === 2);
				// `SourceCard` (TrackableProperty.java:223) is a single `CardView` ref,
				// flattened to a plain int by Tier C — not a list, so `idsOf` (lists and
				// sets only) does not apply; read the tagged int directly.
				const sourceCardRaw = stackItem?.SourceCard as { t?: string; v?: unknown } | undefined;
				const sourceCardId = sourceCardRaw?.t === 'int' && typeof sourceCardRaw.v === 'number' ? sourceCardRaw.v : null;
				writeFileSync(
					'/tmp/claude-1000/w33-S/glint-hawk-stackitem.json',
					JSON.stringify({ stackItem, sourceCardId, sorcererId: sorcerer.id, sorcererTapped: s.zone(0, 'Battlefield').find((c) => c.id === sorcerer.id)?.tapped }, null, 2),
				);
				// The claim: the stack item's source IS the permanent, and that
				// permanent is STILL on the battlefield — this is what makes
				// `Board.tsx`'s `selectable = interaction.selectable.has(item.sourceCardId)`
				// a card-selection path rather than Stifle-like ability targeting.
				expect(sourceCardId, 'the stack item carries no source card at all').not.toBeNull();
				expect(s.zone(0, 'Battlefield').some((c) => c.id === sourceCardId), 'the source left the battlefield — this would be a spell, not an ability').toBe(true);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});

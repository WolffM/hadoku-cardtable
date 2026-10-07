/**
 * Wave 35 §S follow-up, item 1 — the regression lane E found running the real
 * `forge-e2e` suite (`docs/planning/wave35-evidence/e-runs.md`): `play.spec.ts`
 * "a spell resolves unattended" failed 5/5 after F's R15 land-tapping fix.
 *
 * The mechanism, verified against `auto.ts`: `decideStop` only auto-passes a
 * priority window once Forge's own actionable set is empty. R15 makes Forge
 * offer every UNTAPPED LAND with a mana ability through that same set at
 * ordinary priority, so a seat holding even one untapped land is never
 * "empty" by the old measure — the "nothing to do, pass" shortcut almost
 * never fires on an ordinary turn. The fix reads `facts.nonManaSources`
 * (the actionable set minus the seat's own battlefield lands) at that one
 * branch instead of raw `facts.sources`.
 *
 * `auto.jvm.test.ts`'s existing suite DOES fail when this fix is reverted,
 * but for a mix of reasons — a combat-phase `skipsThisTurn` quirk unrelated
 * to this branch (`isStopPhase`/`skipsThisTurn` run and return BEFORE the
 * `nonManaSources` check and don't read it at all) is bundled in with real
 * signal there, because that suite was never built to isolate this one
 * branch. This file isolates exactly the branch lane E's finding named: a
 * priority window where the stack is NON-EMPTY (someone else's spell
 * resolving), the seat holds no cards and no abilities, and the only thing
 * Forge calls "actionable" is the seat's own untapped lands. `decideStop`'s
 * stack-non-empty path falls through to the same `nonManaSources` check once
 * `policy.passOwnSpell && stackTopMine` does not apply (`auto.ts:1025-1031`)
 * — i.e. for the NON-casting seat watching the other seat's spell resolve,
 * which is exactly "a spell resolves unattended".
 *
 * `scenarios/land-only-pass.state`: seat 0 casts a 1-mana creature (Raging
 * Goblin) off one of three untapped Mountains, leaving two Mountains
 * untapped; seat 1 holds nothing and has one untapped Mountain of its own.
 * Seat 0's own post-cast window auto-passes unconditionally via
 * `passOwnSpell` (not this branch); seat 1's window, with the spell on the
 * stack and nothing of its own to do but tap a land, is this branch exactly.
 * The test drives seat 0 only — seat 1 NEVER calls back into the match — and
 * asserts seat 1's actionable set was its own untapped lands and nothing
 * else, that it was auto-passed by the SERVER (not by any click), and that
 * the spell resolved.
 *
 * The scenario harness's own `setWeaklySelectable` push right after a
 * scenario applies is a known, pre-existing, timing-dependent race (see
 * `PlayBridge.java`'s `refreshActionable` doc) — confirmed separately that it
 * sometimes ships a stale empty set for several seconds with no further push
 * until an actual selection forces Forge to recompute, and separately again
 * that the SELECTION itself (not just the highlight) is occasionally a
 * no-op against that same stale cache — measured directly, interleaved
 * against an otherwise-identical scenario, as markedly WORSE with fewer
 * lands on the caster's own battlefield (see `land-only-pass.state`'s own
 * comment for the counts). This test does not wait for that first
 * highlight push: it selects the scripted hand card directly (a legal
 * selection is honoured by Forge regardless of what the stale highlight
 * said) and retries the same click, harmlessly, for as long as the card
 * still sits unselected in hand.
 *
 * Every assertion about seat 1's window is read from the RECORDED history
 * (`s.sent`/`s.logs`) once the whole cast has resolved, never from a live
 * poll of seat 1's own prompt/actionable state: both the caster's own
 * post-cast window AND the opponent's auto-passed one can open and close
 * between two 25 ms polls (`passOwnSpell`/this fix both pass on the spot),
 * so polling for either prompt text live is racy by construction — caught
 * directly, by the manager, as 2 of 4 runs failing at "seat 0's own spell to
 * reach the stack" with the live-prompt-text version of this test. Waiting on
 * the STACK ZONE itself (`GameView.Stack`, read off this seat's own folded
 * state) for seat 0, and on the recorded frame history for seat 1, is not
 * racy: both persist regardless of how fast Forge or this file's own
 * auto-pass fix moves past the window they describe.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w35-s/work \
 *   pnpm exec vitest run apps/server/src/play/auto-pass-land.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, idsOf, landPayer, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';
import { TYPE, type WireObj } from './visibility.js';

const title = available.ok
	? "wave 35 §S follow-up: a spell resolves unattended for the seat holding only lands, against real Forge"
	: `wave 35 §S follow-up: a spell resolves unattended for the seat holding only lands, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Land A', ['40 Mountain']), deck('Land B', ['40 Mountain'])];

/** `GameView.Stack` — the stack's item ids, from this seat's own projection. */
function stackIds(s: Scenario, seat: number): number[] {
	const game = [...s.state(seat).values()].find((o: WireObj) => o._type === TYPE.game);
	return idsOf(game, 'Stack');
}

describe.skipIf(!available.ok)(title, () => {
	it(
		"seat 1 holds only untapped lands while seat 0's spell is on the stack, and is auto-passed without ever acting",
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 35, decks: DECKS, scenario: scenarioText('land-only-pass') });
			try {
				await finishMulligan(s);
				const logsBefore = s.logs.length;

				const goblin = await waitUntil(
					() => {
						s.answerAsks();
						return s.zone(0, 'Hand').some((c) => c.name === 'Raging Goblin');
					},
					"seat 0's hand to reflect the scripted Raging Goblin",
					20_000,
					s,
				).then(() => s.zone(0, 'Hand').find((c) => c.name === 'Raging Goblin'));
				if (goblin === undefined) throw new Error('no Raging Goblin in hand');

				s.select(0, goblin.id);
				// Pay the single {R}: Forge's own `InputPayMana` plays a single mana
				// ability without asking (`InputPayMana.java:102-106`), but the bridge
				// still needs the untapped Mountain clicked once to fire it.
				// `landPayer` (ledger Y26's neighbour, wave 53 §E) is the fix the other
				// jvm suites already use for the race this used to hand-roll with its
				// own `clicked` Set: a click on the NEXT 25 ms tick, before Forge's
				// reply tapped the land it was already playing, is refused
				// ("Should wait till previous call to playAbility finishes",
				// `InputPayMana.java:210-213`) and never retried by a Set keyed on the
				// land's id alone — only once the "Pay Mana Cost" prompt text has itself
				// changed does `landPayer` send the next land.
				const payLand = landPayer(s, 0);
				await waitUntil(
					() => {
						s.answerAsks();
						// The initial `select` above can land before Forge's own actionable
						// cache has caught up with the scenario (the same pre-existing,
						// timing-dependent bridge race `PlayBridge.java`'s `refreshActionable`
						// doc describes), and the click is silently a no-op when Forge does
						// not currently consider the card legal to select — retried while it
						// still sits in hand and no payment window has opened yet, so a cast
						// already under way is never clicked twice.
						//
						// Known hazard, NOT guarded here: retrying on every 25 ms tick can
						// resend `selectCard` for the same card while Forge's game thread is
						// still inside the FIRST `chooseSpellAbilityToPlay()` for it — see
						// `B-auto-pass-land.md` for a reproduced failure and why no order-based
						// signal (as opposed to a clock) was found to gate the retry on: in the
						// one capture, the SAME 25 ms tick that sent the retry was also the
						// very first tick after the original select, with zero new wire traffic
						// from either seat in between — nothing arrives to tell this test
						// whether the first attempt is still being processed or was silently
						// dropped, so there is no signal to wait for, only a clock, which is
						// not allowed. Left as the pre-existing behaviour; the CI line for this
						// test stays pinned.
						if (s.zone(0, 'Hand').some((c) => c.id === goblin.id) && !/Pay Mana Cost/.test(s.prompt(0))) {
							s.select(0, goblin.id);
						}
						payLand();
						// Wait on the STACK ZONE, not the prompt text: `passOwnSpell` passes
						// the caster's own window immediately, so the "Stack: 1 to Resolve"
						// PROMPT can come and go between two 25 ms polls — a race the manager
						// also caught. `stackIds` is read off this seat's own folded state,
						// which holds whatever the stack most recently contained, not a
						// point-in-time prompt string — a non-empty stack is unambiguous
						// here since this scenario only ever casts the one spell (stack
						// item ids are their own id space, not the card's, so a plain
						// non-empty check is used rather than matching `goblin.id`).
						return stackIds(s, 0).length > 0;
					},
					"seat 0's own spell to reach the stack",
					// Generous on purpose: the retry above is a harmless no-op against an
					// actionable cache Forge has not yet refreshed (never a double-cast —
					// confirmed directly, mutation-testing this exact budget), and that
					// cache has been measured taking several real seconds to catch up.
					45_000,
					s,
				);

				// The claim: seat 1 is passed anyway, by the SERVER, having never once
				// acted — no select, no OK, nothing — and the spell resolves on its own.
				await waitUntil(
					() => {
						s.answerAsks();
						return s.zone(0, 'Battlefield').some((c) => c.name === 'Raging Goblin');
					},
					'Raging Goblin to resolve onto the battlefield without any click from seat 1',
					20_000,
					s,
				);

				// The precondition lane E's finding depends on, checked from the
				// RECORDED history rather than a live poll (the same race as above —
				// seat 1's own window can open and auto-pass between two polls): seat 1
				// really was shown a priority window with the spell still unresolved,
				// and Forge's own actionable set for it (R15) was lands only, not empty.
				//
				// read off `s.lines` (what Forge itself SAID), never
				// `s.sent` (what this seat's wire carried) — the whole point of this
				// window is that it is auto-passed, and `match.ts` now withholds an
				// auto-passed window's `showPromptMessage` entirely rather than
				// forwarding it and correcting the buttons after. `s.lines` is immune:
				// it is the raw bridge stream, unaffected by what the server decides
				// to forward.
				const seat1StackPromptAt = s.lines.findIndex(
					(l) =>
						l.t === 'frame' &&
						l.seat === 1 &&
						(l.frame as { method?: unknown } | null)?.method === 'showPromptMessage' &&
						/Stack: 1 to Resolve/.test((l.frame as { message?: string }).message ?? ''),
				);
				expect(seat1StackPromptAt, "seat 1 must have been shown a 'Stack: 1 to Resolve' window at some point").toBeGreaterThanOrEqual(0);
				// The actionable set in effect for THAT window: the LAST
				// `setWeaklySelectable` to seat 1 before this seat's own next priority
				// prompt (there is only one such window here) — not necessarily AFTER
				// the prompt that names the window, since `updateButtons`/actionable
				// can arrive before the `showPromptMessage` describing it (the same
				// Forge ordering quirk `match.ts`'s own `maybeAutoPay` comment notes).
				// `setWeaklySelectable` is never withheld (only the prompt/buttons pair
				// is), so it is on `s.lines` exactly where it was on `s.sent` before.
				const seat1NextPromptAt = s.lines.findIndex(
					(l, i) => i > seat1StackPromptAt && l.t === 'frame' && l.seat === 1 && (l.frame as { method?: unknown } | null)?.method === 'showPromptMessage',
				);
				const seat1WindowEnd = seat1NextPromptAt === -1 ? s.lines.length : seat1NextPromptAt;
				const seat1Actionable = [...s.lines]
					.slice(0, seat1WindowEnd)
					.reverse()
					.find((l) => l.t === 'frame' && l.seat === 1 && (l.frame as { method?: unknown } | null)?.method === 'setWeaklySelectable') as
					| { frame: { cards?: { id: number }[] } }
					| undefined;
				const seat1ActionableIds = seat1Actionable?.frame.cards?.map((c) => c.id) ?? [];
				const seat1Lands = s.zone(1, 'Battlefield').filter((c) => c.land).map((c) => c.id);
				expect(seat1ActionableIds.length, 'seat 1 must actually be offered its own untapped lands as actionable here').toBeGreaterThan(0);
				expect(
					seat1ActionableIds.every((id) => seat1Lands.includes(id)),
					`seat 1 was offered something that is not its own land: ${JSON.stringify(seat1ActionableIds)}`,
				).toBe(true);

				const seat1Passed = s.logs.slice(logsBefore).filter((l) => l.evt === 'auto-passed' && l.seat === 1);
				expect(seat1Passed.length, 'seat 1 was auto-passed on a window that offered only its own lands').toBeGreaterThan(0);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});

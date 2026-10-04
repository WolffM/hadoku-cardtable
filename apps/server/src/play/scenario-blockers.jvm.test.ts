/**
 * Wave 33 §S, item 3 — Q10 and Q12, against a REAL Forge match, set up by a
 * scenario instead of played through two seats' first three turns
 * (`blockers.jvm.test.ts`'s `setUp`/`attack` helpers did that; these two
 * scenarios land in Declare ATTACKERS Step with the attack already declared,
 * one step short of Declare Blockers).
 *
 * **Why not land straight on Declare Blockers.** It was the first design, and
 * it is wrong: `GameState.applyGameOnThread` (the deploy tree's forge-build
 * cache; `forge/` is not initialised in this worktree) calls the combat setup
 * (`handleCombat`) BEFORE its own unconditional `checkStateEffects(true)` —
 * but landing the `activephase` key straight on `COMBAT_DECLARE_BLOCKERS`
 * makes `handleCombat` itself walk there (`devAdvanceToPhase`, which opens the
 * real block input and computes who may block) before that check ever runs.
 * Measured against a real match: a scripted, untapped, non-sick creature on
 * the defender's battlefield was offered as a blocker ZERO times —
 * `pushBlockerCandidates` sent `setWeaklySelectable` with an EMPTY list, and
 * the window closed itself (an `auto-passed` log line for the ATTACKER'S side
 * only, same as a defender with no creature at all). See
 * `wave33-evidence/s3-blockers.md` for the full repro and the fix below.
 *
 * **The fix.** Land one step earlier, at Declare Attackers Step, and drive
 * the one remaining step — the attacker's own priority stop there — through
 * the NORMAL game loop (`attackerPassesDeclareAttackers` below), not through
 * `GameState`'s shortcut. By the time Forge opens the REAL Declare Blockers
 * window this way, `checkStateEffects` has run at least once already (the
 * scenario's own unconditional call) and the normal main loop runs it again
 * on every priority pass, so the defender's creature's characteristics are
 * never stale when Forge decides who may block.
 *
 * `scenario.ts`'s `finishMulligan` answers the coin toss and the keep-or-
 * mulligan question for both seats and then stops. From there this file uses
 * `answerAsks()` and its own minimal press — never `keepHands()`/`passUntil`
 * again, both of which press OK on ANY enabled, non-`Priority:` prompt and
 * would therefore answer the Declare Blockers window itself.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/w33-S \
 *   pnpm exec vitest run apps/server/src/play/scenario-blockers.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'Declare Blockers, set up by a scenario, against real Forge'
	: `Declare Blockers, set up by a scenario, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Mountain']), deck('Any B', ['40 Mountain'])];

/**
 * Press OK once for the ATTACKER's own priority stop at Declare Attackers
 * Step — the one press `isStop`/the server's own policy expect from the
 * active player there — so the game advances into the REAL Declare Blockers
 * window through the normal main loop. Never touches the defender's prompt.
 */
async function passDeclareAttackers(s: Scenario, attacker: number): Promise<void> {
	let pressed = false;
	await waitUntil(
		() => {
			s.answerAsks();
			const msg = s.prompt(attacker);
			if (!pressed && /^Priority:/.test(msg) && /Declare Attackers Step/.test(msg) && s.buttons(attacker)?.enable1 === true) {
				pressed = true;
				s.ok(attacker);
			}
			return s.phase(attacker) !== 'Declare Attackers Step';
		},
		"the attacker's own Declare Attackers Step priority window to pass",
		30_000,
		s,
	);
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'Q10: a defender with no creature is passed through Declare Blockers, with nothing to assign',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 10, decks: DECKS, scenario: scenarioText('no-creatures') });
			try {
				await finishMulligan(s);
				// The precondition, so "no stop" below is not vacuous because the
				// attack never happened: the attacker really holds its attacker.
				await waitUntil(
					() => {
						s.answerAsks();
						return s.zone(0, 'Battlefield').some((c) => c.creature);
					},
					"the attacker's board to reflect the scripted creature",
					20_000,
					s,
				);
				await passDeclareAttackers(s, 0);
				await waitUntil(
					() => {
						s.answerAsks();
						return s.logs.some((l) => l.evt === 'auto-passed' && l.seat === 1 && l.phase === 'Declare Blockers Step');
					},
					'the defender to be auto-passed through Declare Blockers with nothing to assign',
					30_000,
					s,
				);
				expect(
					s.sent.some(
						(x) =>
							x.seat === 1 &&
							x.envelope.frame.method === 'setWeaklySelectable' &&
							(x.envelope.frame as unknown as { cards: unknown[] }).cards.length > 0,
					),
					'the defender was never offered a blocker — there was none to offer',
				).toBe(false);
			} finally {
				await s.stop();
			}
		},
		180_000,
	);

	it(
		'Q12: a defender with one creature is NOT auto-passed through Declare Blockers, and can assign the block',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 12, decks: DECKS, scenario: scenarioText('one-creature') });
			try {
				await finishMulligan(s);
				const blocker = await waitUntil(
					() => {
						s.answerAsks();
						return s.zone(1, 'Battlefield').some((c) => c.creature);
					},
					"the defender's board to reflect the scripted creature",
					20_000,
					s,
				).then(() => s.zone(1, 'Battlefield').find((c) => c.creature));
				if (blocker === undefined) throw new Error("no creature on seat 1's battlefield");
				await passDeclareAttackers(s, 0);
				await waitUntil(
					() => {
						s.answerAsks();
						return /^Select creatures to block/.test(s.prompt(1));
					},
					'the block-assignment input to open for the defender',
					30_000,
					s,
				);
				expect(s.buttons(1)?.enable1).toBe(true);
				expect(s.logs.some((l) => l.evt === 'auto-passed' && l.seat === 1 && l.phase === 'Declare Blockers Step')).toBe(false);

				// The precondition, read off the SAME wire property the defender's
				// client would draw a blue highlight from: Forge really offered a
				// blocker, not an empty set (which would make "can assign the block"
				// below vacuous).
				const offered = s.sent
					.filter((x) => x.seat === 1 && x.envelope.frame.method === 'setWeaklySelectable')
					.map((x) => (x.envelope.frame as unknown as { cards: { id: number }[] }).cards.map((c) => c.id))
					.filter((ids) => ids.length > 0)
					.at(-1);
				expect(offered, 'the defender was never offered a blocker').toContain(blocker.id);

				// The block can actually be made.
				s.select(1, blocker.id);
				await waitUntil(() => {
					const view = [...s.state(1).values()].find((o) => o._type === 0 && o._id === blocker.id);
					return (view?.Blocking as { v?: boolean } | undefined)?.v === true;
				}, 'the creature to be declared blocking', 10_000, s);
				s.ok(1);
				await waitUntil(() => /Declare Blockers Step/.test(s.prompt(1)), 'the priority window after the block', 10_000, s);
			} finally {
				await s.stop();
			}
		},
		180_000,
	);
});

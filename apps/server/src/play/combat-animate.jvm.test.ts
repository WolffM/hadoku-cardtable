/**
 * The operator, 2026-10-23, against real Forge: *"is it possible to try and detect when a player has
 * a man-land or a man-artifact they need to activate in the beginning of combat step? at the moment
 * the game auto-progresses through this and doesn't give the player a chance to activate their
 * lands"*. The bridge names, per priority window, the permanents that can make themselves a creature
 * that could attack (`setWeaklySelectable.animates`), and `judgeStop` keeps the seat's own Beginning
 * of Combat for them (`StopPolicy.stopToAnimate`). The control: the same Mutavault played this turn,
 * and a castable instant in hand — the step is passed exactly as before.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/animate \
 *   pnpm exec vitest run apps/server/src/play/combat-animate.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, timeline, waitUntil } from './scenario.js';

const title = available.ok
	? 'a man-land stops its controller’s Beginning of Combat, against real Forge'
	: `a man-land stops its controller’s Beginning of Combat, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Mountains', ['40 Mountain']), deck('Islands', ['40 Island'])];

const COMBAT_BEGIN = /^Phase: Beginning of Combat Step$/m;

/** The `animates` of every offer Forge itself sent seat 0. */
function animatesOffered(s: Awaited<ReturnType<typeof startScenario>>): number[] {
	return s.lines.flatMap((l) =>
		l.t === 'frame' && l.seat === 0 && (l.frame as { method?: unknown } | null)?.method === 'setWeaklySelectable'
			? ((l.frame as { animates?: { id: number }[] }).animates ?? []).map((c) => c.id)
			: [],
	);
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'Mutavault and a Mountain: passing Main 1 stops at Beginning of Combat, and Mutavault is the card that kept it',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 23, decks: DECKS, scenario: scenarioText('combat-animate') });
			try {
				await finishMulligan(s);
				await waitUntil(
					() => {
						s.answerAsks();
						return inOwnMain(s, 0, 1);
					},
					"seat 0's own Main 1",
					60_000,
					s,
				);
				s.ok(0);
				await waitUntil(
					() => {
						s.answerAsks();
						const msg = s.prompt(0);
						return msg.startsWith('Priority:') && COMBAT_BEGIN.test(msg) && /^Stack: Empty$/m.test(msg) && s.buttons(0)?.enable1 === true;
					},
					"seat 0's Beginning of Combat, put to the seat",
					60_000,
					s,
				);
				const mutavault = s.zone(0, 'Battlefield').find((c) => c.name === 'Mutavault')?.id;
				expect(mutavault).toBeDefined();
				expect(new Set(animatesOffered(s))).toEqual(new Set([mutavault]));
				expect(s.logs.filter((l) => l.evt === 'auto-passed' && l.seat === 0 && l.phase === 'Beginning of Combat Step')).toEqual([]);
			} catch (err) {
				console.log(`[combat-animate-timeline]\n${timeline(s, 0)}`);
				throw err;
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'the same Mutavault played this turn, and a Lightning Bolt in hand: Beginning of Combat is passed',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 23, decks: DECKS, scenario: scenarioText('combat-animate-sick') });
			try {
				await finishMulligan(s);
				await waitUntil(
					() => {
						s.answerAsks();
						return inOwnMain(s, 0, 1);
					},
					"seat 0's own Main 1",
					60_000,
					s,
				);
				s.ok(0);
				await waitUntil(
					() => {
						s.answerAsks();
						return s.logs.some((l) => l.evt === 'auto-passed' && l.seat === 0 && l.phase === 'Beginning of Combat Step');
					},
					"seat 0's Beginning of Combat, passed by the server",
					60_000,
					s,
				);
				expect(animatesOffered(s)).toEqual([]);
			} catch (err) {
				console.log(`[combat-animate-timeline]\n${timeline(s, 0)}`);
				throw err;
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});

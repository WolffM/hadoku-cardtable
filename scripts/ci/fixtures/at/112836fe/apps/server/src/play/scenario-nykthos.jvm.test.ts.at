/**
 * The operator's frozen match, 2026-10-11 (m-34ad8755db4d): "can't play nykthos?". Seat 1 played
 * Nykthos, Shrine to Nyx, Forge was answered "Play land", and then sent nothing again. Its stderr held
 * the reason:
 *
 *   NullPointerException: ... "SpellAbility.getManaPart()" is null
 *     at forge.ai.AvailableActions.canAffordWithManaRocks(AvailableActions.java:222)
 *     ... PlayerControllerHuman.chooseSpellAbilityToPlay ... PhaseHandler.mainGameLoop
 *
 * Nykthos's second ability (`AB$ ChooseColor | Cost$ 2 T | SubAbility$ DBMana`) is a mana ability
 * whose mana part lives on its sub-ability, so its own `getManaPart()` is null. The actionable sweep
 * (which only decides what the board highlights) read it as a mana rock and threw on the game thread,
 * which ended the game for both seats.
 *
 * Both ways in are covered: playing Nykthos (the operator's exact sequence), and a first priority
 * window with Nykthos already in play. Each must come back with a live priority window.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/scenario-nykthos.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, castNamed, deck, finishMulligan, inOwnMain, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'Nykthos, Shrine to Nyx does not stop the game, against real Forge'
	: `Nykthos, Shrine to Nyx does not stop the game, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Nyx A', ['40 Forest']), deck('Nyx B', ['40 Mountain'])];

/** Forge's own stderr for the crash, if it was printed: the reason a frozen game froze. */
function crashOf(s: Scenario): string | undefined {
	return s.logs.map((l) => JSON.stringify(l)).find((l) => l.includes('NullPointerException') || l.includes('getManaPart'));
}

describe.skipIf(!available.ok)(title, () => {
	it('playing Nykthos lands it and gives seat 0 its next priority window', async () => {
		if (!available.ok) return;
		const s = await startScenario(available.config, { seed: 4242, decks: DECKS, scenario: scenarioText('nykthos') });
		try {
			await finishMulligan(s);
			await waitUntil(() => {
				s.answerAsks();
				return inOwnMain(s, 0, 1);
			}, "seat 0's first priority window", 60_000, s);
			await castNamed(s, 0, 'Nykthos, Shrine to Nyx');
			expect(s.zone(0, 'Battlefield').some((c) => c.name === 'Nykthos, Shrine to Nyx'), crashOf(s)).toBe(true);
			expect(inOwnMain(s, 0, 1), 'still seat 0’s main phase, with priority').toBe(true);
		} finally {
			await s.stop();
		}
	}, 150_000);

	it('a first priority window with Nykthos already in play arrives', async () => {
		if (!available.ok) return;
		const s = await startScenario(available.config, { seed: 4243, decks: DECKS, scenario: scenarioText('nykthos-in-play') });
		try {
			await finishMulligan(s);
			await waitUntil(() => {
				s.answerAsks();
				return inOwnMain(s, 0, 1);
			}, "seat 0's first priority window", 60_000, s);
			expect(s.zone(0, 'Battlefield').some((c) => c.name === 'Nykthos, Shrine to Nyx')).toBe(true);
		} finally {
			await s.stop();
		}
	}, 150_000);
});

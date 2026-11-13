/**
 * A second Lion's Eye Diamond, against real Forge (m-474ce1ddd243, 2026-11-08): *"i tried to sac a
 * lion's eye diamond and i dont see any prompt on the screen"*.
 *
 * LED's mana ability asks two cost confirms of one ability on one card ("discard your hand?",
 * "sacrifice it?"). The server answers both for a seat that chose the ability (`chosenCostConfirm`).
 * The first LED's discard put a state delta between them; the second's, with no hand left, did not,
 * and the server took the second confirm for Forge re-showing the first (`decideWindow`'s `repeat`,
 * then judged by what the window asked) and withheld it unanswered. A repeat is now only the same
 * Forge input, by the id the bridge tags each frame with. The test holds the seat to the board: it
 * never presses a confirm, so a withheld one Forge still waits on stalls the run.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/led \
 *   pnpm exec vitest run games/magic/server/src/play/led-softlock.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, timeline, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? "two Lion's Eye Diamonds sacrificed one after the other, against real Forge"
	: `two Lion's Eye Diamonds sacrificed one after the other, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Forests', ['40 Forest']), deck('Islands', ['40 Island'])];

function offeredTo(s: Scenario, seat: number): number[] {
	const last = [...s.lines]
		.reverse()
		.find((l) => l.t === 'frame' && l.seat === seat && /^(set|clear)WeaklySelectable$/.test(String((l.frame as { method?: unknown } | null)?.method)));
	const frame = (last as { frame?: unknown } | undefined)?.frame as { method: string; cards?: { id: number }[] } | undefined;
	return frame?.method === 'setWeaklySelectable' ? (frame.cards ?? []).map((c) => c.id) : [];
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'each LED takes its two cost confirms without the seat, and priority comes back after the second',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 474, decks: DECKS, scenario: scenarioText('led-two') });
			try {
				await finishMulligan(s);
				await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, "seat 0's main phase with two LEDs", 60_000, s);
				const leds = s.zone(0, 'Battlefield').filter((c) => c.name === "Lion's Eye Diamond");
				expect(leds).toHaveLength(2);
				const logsBefore = s.logs.length;
				for (const [i, led] of leds.entries()) {
					await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1) && offeredTo(s, 0).includes(led.id); }, `LED ${i + 1} offered at priority`, 20_000, s);
					s.select(0, led.id);
					// `answerAsks` picks the colour ("Select Mana to Produce"); nothing here presses a confirm.
					await waitUntil(
						() => { s.answerAsks(); return s.zone(0, 'Graveyard').some((c) => c.id === led.id) && inOwnMain(s, 0, 1); },
						`LED ${i + 1} sacrificed and priority back`,
						30_000,
						s,
					);
				}
				expect(s.zone(0, 'Hand'), 'the first LED discarded the hand').toEqual([]);
				const mine = s.logs.slice(logsBefore).filter((l) => l.seat === 0);
				expect(mine.filter((l) => l.evt === 'auto-confirmed'), 'four cost confirms, two per LED, each answered by the server').toHaveLength(4);
				expect(mine.filter((l) => l.evt === 'stuck-window'), 'none left for the safety net').toEqual([]);
				const confirmsShown = s.sent.filter((x) => x.seat === 0 && x.envelope.frame.method === 'showPromptMessage' && (x.envelope.frame as { confirmAbility?: unknown }).confirmAbility !== undefined);
				expect(confirmsShown, 'no cost confirm reached the seat').toEqual([]);
			} catch (err) {
				console.log(`[led-timeline]\n${timeline(s, 0)}`);
				throw err;
			} finally {
				await s.stop();
			}
		},
		150_000,
	);
});

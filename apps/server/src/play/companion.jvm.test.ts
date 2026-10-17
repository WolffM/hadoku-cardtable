/**
 * Choosing a companion, against real Forge.
 *
 * The operator, 2026-10-17: *"Choose a companion, None. Completely deadlocked the game after none was
 * clicked."* Forge's `Player.assignCompanion` (Player.java:3105) asks optionally and then moves the
 * answer to the command zone without checking for none: a "None" threw inside `moveTo` and the game
 * thread died at the first frame. And "None" was all the seat could pick: the companions are sideboard
 * cards Forge's net client never tracked, so the option list reached the seat empty. The bridge
 * (`PlayBridge.java`'s `chooseCompanion`) reads the companions off the live game and asks a required
 * `getChoices` naming them — choosing one obliges nothing.
 *
 * Seat 0's deck is forty Plains with Jegantha, the Wellspring and Lurrus of the Dream-Den in its
 * sideboard — both qualify, since the deck has no mana symbols and no permanent costs over two. Two,
 * because a lone companion is the server's one-option answer and never reaches the seat. The question
 * must reach the seat required and naming both; the seat picks Lurrus, Lurrus must be in its command
 * zone, and the game must go on to the opening hand. Without the fix the seat is sent an optional ask
 * with no options, this test answers None, and the game freezes: the red it was proven against.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/companion \
 *   pnpm exec vitest run apps/server/src/play/companion.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? 'companion: a companion is a required choice, and the game goes on, against real Forge'
	: `companion: a companion is a required choice, and the game goes on, against real Forge — SKIPPED: ${available.reason}`;

const WITH_COMPANIONS = `[metadata]\nName=Plains and two companions\n[main]\n40 Plains\n[sideboard]\n1 Jegantha, the Wellspring\n1 Lurrus of the Dream-Den\n`;
const DECKS: [string, string] = [WITH_COMPANIONS, deck('Forests', ['40 Forest'])];

describe.skipIf(!available.ok)(title, () => {
	it(
		'Forge asks seat 0 for its companion as a required choice naming each, and the game goes on with the one chosen',
		async () => {
			if (!available.ok) return;
			const seen: { method: string; required: boolean; options: string[] }[] = [];
			const s = await startScenario(available.config, {
				seed: 91,
				decks: DECKS,
				reply: (f) => {
					if (f.method === 'getChoices' && f.message === 'Choose a companion') {
						const choices = f.choices as { key: string; label: string }[];
						seen.push({ method: f.method, required: (f.min as number) >= 1, options: choices.map((c) => c.label).sort() });
						return [choices.find((c) => c.label === 'Lurrus of the Dream-Den')?.key ?? choices[0]!.key];
					}
					if (f.method === 'chooseSingleEntityForEffect' && f.title === 'Choose a companion') {
						seen.push({ method: f.method, required: f.isOptional !== true, options: (f.optionList as unknown[]).map(String) });
						// Offered a "None", the click that froze the game.
						return null;
					}
					return undefined;
				},
			});
			try {
				await waitUntil(
					() => {
						s.answerAsks();
						return seen.length > 0 && /keep your hand|play or draw|mulligan/i.test(s.prompt(0) + ' ' + s.prompt(1));
					},
					'the companion asked and answered, and the game on to the opening hand',
					60_000,
					s,
				);
				console.log(`[companion.jvm] asks ${JSON.stringify(seen)}; prompts "${s.prompt(0).split('\n')[0]}" / "${s.prompt(1).split('\n')[0]}"`);
				expect(seen, 'one companion question, required, naming both').toEqual([
					{ method: 'getChoices', required: true, options: ['Jegantha, the Wellspring', 'Lurrus of the Dream-Den'] },
				]);
				const command = s.zone(0, 'Command').map((c) => c.name);
				console.log(`[companion.jvm] command zone ${JSON.stringify(command)}`);
				expect(command, 'the companion chosen waits in the command zone').toContain('Lurrus of the Dream-Den');
				expect(command, 'and only that one').not.toContain('Jegantha, the Wellspring');
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});

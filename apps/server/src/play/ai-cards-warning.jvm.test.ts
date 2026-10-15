/**
 * No "AI can't play these cards" reveal at the start of a vs-AI match, against real Forge.
 *
 * The operator, 2026-10-15, starting a vs-AI match: a reveal box "=== Main Deck === Beast Within
 * === Sideboard === Beast Within OK". Forge's `Match.prepareAllZones` reveals every card the AI's
 * controller complains it can't play well (`AI:RemoveDeck:All`, e.g. Beast Within) to every seat
 * when `GameRules.warnAboutAICards()` holds (`Match.java:347`). It only warns: the cards stay in the
 * deck. Forge's own Adventure mode turns it off (`DuelScene.java:519`); so does the bridge.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/ai-cards \
 *   pnpm exec vitest run apps/server/src/play/ai-cards-warning.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? 'ai-cards-warning: a vs-AI match starts without the "AI can’t play these cards" reveal, against real Forge'
	: `ai-cards-warning: a vs-AI match starts without the "AI can’t play these cards" reveal, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Plains', ['60 Plains']), deck('Beasts', ['40 Forest', '20 Beast Within'])];

describe.skipIf(!available.ok)(title, () => {
	it(
		'the human seat is shown no reveal before its first turn when the AI deck holds Beast Within',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 15, decks: DECKS, aiOpponent: true });
			try {
				await waitUntil(
					() => {
						s.keepHands(/keep your hand|play or draw/i);
						s.answerAsks();
						return s.turn(0) !== null;
					},
					'the human seat to reach its first in-game prompt',
					90_000,
					s,
				);
				const reveals = s.sent
					.filter((x) => x.seat === 0 && x.envelope.frame.method === 'getChoices')
					.map((x) => x.envelope.frame as unknown as { message: string; min: number; max: number; choices: { label: string }[] })
					.filter((f) => f.min === -1 && f.max === -1);
				for (const r of reveals) {
					console.log(`[bw-ai-cards.jvm] seat 0 reveal: ${JSON.stringify(r.message)} → ${r.choices.map((c) => c.label).join(' | ')}`);
				}
				console.log(`[bw-ai-cards.jvm] seat 0 reached ${JSON.stringify(s.turn(0))} with ${String(reveals.length)} reveal(s)`);
				expect(reveals, 'no reveal reaches the human seat at match start').toEqual([]);
			} finally {
				await s.stop();
			}
		},
		150_000,
	);
});

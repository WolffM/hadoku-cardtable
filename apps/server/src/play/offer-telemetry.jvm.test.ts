/**
 * The match log answers "X wasn't clickable", against real Forge: a priority window the seat is
 * shown logs what Forge offered (`offered`), and a card click logs what came of it (`click`).
 * Seat 0 holds a Clue and two Mountains on its own first main, clicks the Clue, and it is cracked.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/offer-telemetry \
 *   pnpm exec vitest run apps/server/src/play/offer-telemetry.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? 'offer telemetry: offered sets and card clicks reach the match log, against real Forge'
	: `offer telemetry: offered sets and card clicks reach the match log, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Islands', ['40 Island']), deck('Plains', ['40 Plains'])];

const STATE = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=20',
	'humanhand=',
	'humanbattlefield=T:c_a_clue_draw;Mountain;Mountain',
	'humanlibrary=Island;Island;Island;Island;Island;Island',
	'humangraveyard=',
	'aihand=',
	'aibattlefield=Plains',
	'ailibrary=Plains;Plains;Plains;Plains;Plains;Plains',
	'aigraveyard=',
].join('\n');

describe.skipIf(!available.ok)(title, () => {
	it(
		"seat 0's main logs the Clue as offered, and its click as answered",
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 70, decks: DECKS, scenario: STATE });
			try {
				await finishMulligan(s);
				const clueOf = () => s.zone(0, 'Battlefield').find((c) => c.name.startsWith('Clue'));
				await waitUntil(() => { s.answerAsks(); return clueOf() !== undefined && inOwnMain(s, 0, 1); }, "seat 0's own first main with its Clue", 30_000, s);
				const clue = clueOf()!;
				await waitUntil(() => s.logs.some((l) => l.evt === 'offered' && l.seat === 0 && (l.cards as number[]).includes(clue.id)), 'the Clue in an `offered` record', 10_000, s);
				s.select(0, clue.id);
				await waitUntil(() => { s.answerAsks(); return clueOf() === undefined; }, 'the Clue cracked', 20_000, s);
				const records = s.logs.filter((l) => (l.evt === 'offered' || l.evt === 'click') && l.seat === 0);
				for (const r of records) console.log(`[offer-telemetry.jvm] ${JSON.stringify(r)}`);
				expect(records.find((l) => l.evt === 'click')).toMatchObject({ card: clue.id, outcome: 'answered' });
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});

/**
 * Delve is one choice. The operator, 2026-10-19: *"if i delve 6 i should be picking 6 cards not 1
 * card 6 times."* Forge's `PlayerControllerHuman.chooseCardsToDelve` asks "Delve how many cards?"
 * (`getGui().one` over 0..min(generic, graveyard)) and then "Exile which card(i/N)?" once per card.
 * The bridge's `SeatController` asks once: a `getChoices` of the graveyard's cards, from none up to
 * that many, and how many are picked is how many are delved.
 *
 * `dv-delve.state`: alice casts Treasure Cruise ({7}{U}) with eight Islands and eight graveyard
 * cards. She picks six: those six are exiled, the rest of the graveyard stays, and the spell costs
 * {1}{U}, so two Islands tap. On a bridge without the fix the first question is the number list.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/dv \
 *   pnpm exec vitest run apps/server/src/play/delve.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, waitUntil } from './scenario.js';

const title = available.ok ? 'delve, against real Forge' : `delve, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Delve A', ['40 Island']), deck('Delve B', ['40 Island'])];

interface Choice {
	key: string;
	label: string;
	ref: { kind: string; id: number } | null;
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'one pick of graveyard cards: six picked, six exiled, the cost six less',
		async () => {
			if (!available.ok) return;
			const seen: { message: string; min: number; max: number; cards: number[]; labels: string[] }[] = [];
			let picked: number[] = [];
			const s = await startScenario(available.config, {
				seed: 1019,
				decks: DECKS,
				scenario: scenarioText('dv-delve'),
				reply: (f) => {
					if (f.method !== 'getChoices' || !/delve|exile which card/i.test(String(f.message))) return undefined;
					const choices = f.choices as Choice[];
					const cards = choices.filter((c) => c.ref?.kind === 'card').map((c) => c.ref!.id);
					seen.push({ message: String(f.message), min: f.min as number, max: f.max as number, cards, labels: choices.map((c) => c.label) });
					// Forge's own number question, answered so a bridge without the fix still finishes the cast.
					if (cards.length === 0) return [choices.find((c) => c.label === '6')?.key ?? choices[choices.length - 1]!.key];
					const take = choices.filter((c) => c.ref?.kind === 'card').slice(0, Math.min(6, f.max as number));
					picked.push(...take.map((c) => c.ref!.id));
					return take.map((c) => c.key);
				},
			});
			try {
				await finishMulligan(s);
				await waitUntil(() => s.zone(0, 'Hand').some((c) => c.name === 'Treasure Cruise'), 'Treasure Cruise in alice’s hand', 20_000, s);
				await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, 'alice holds priority at her turn-1 main phase', 20_000, s);
				const cruise = s.zone(0, 'Hand').find((c) => c.name === 'Treasure Cruise')!;
				const grave = s.zone(0, 'Graveyard').map((c) => c.id);
				expect(grave, 'eight cards in alice’s graveyard').toHaveLength(8);
				picked = [];
				s.select(0, cruise.id);
				let paid = false;
				await waitUntil(
					() => {
						s.answerAsks();
						if (!paid && s.buttons(0)?.label1 === 'Auto' && s.buttons(0)?.enable1 === true) {
							paid = true;
							s.ok(0);
						}
						return s.zone(0, 'Graveyard').some((c) => c.name === 'Treasure Cruise');
					},
					'Treasure Cruise cast, paid for and resolved',
					30_000,
					s,
				);
				const after = s.zone(0, 'Graveyard').map((c) => c.id);
				const tapped = s.zone(0, 'Battlefield').filter((c) => c.land && c.tapped).length;
				console.log(`[dv] delve asks ${JSON.stringify(seen)}; picked ${JSON.stringify(picked)}; graveyard now ${JSON.stringify(s.zone(0, 'Graveyard').map((c) => c.name))}; tapped ${tapped}`);

				expect(seen.map((q) => ({ message: q.message, min: q.min, max: q.max, cards: [...q.cards].sort() })), 'one question: up to seven of the graveyard’s cards').toEqual([
					{ message: 'Delve how many cards?', min: 0, max: 7, cards: [...grave].sort() },
				]);
				expect(picked, 'six picked').toHaveLength(6);
				expect(after.filter((id) => picked.includes(id)), 'the six picked left the graveyard').toEqual([]);
				expect(after, 'the two not picked and the Cruise are what is left').toHaveLength(3);
				expect(tapped, 'the cost was six less: {1}{U} taps two Islands').toBe(2);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});

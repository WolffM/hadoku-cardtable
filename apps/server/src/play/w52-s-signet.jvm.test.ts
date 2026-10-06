/**
 * Wave 52 §S, item 2 — a seat holding a Signet and nothing castable is auto-passed
 * exactly where a land-only seat is (`auto-pass-land.jvm.test.ts`), against real
 * Forge with w52's jar.
 *
 * The blast radius this guards: w52's fork commit offers a mana ability that also
 * costs mana (Azorius Signet, `{1},{T}`) at priority. A Signet is not a land, so
 * `decideStop`'s "nothing but lands is actionable" pass would have become a stop in
 * every priority window for a seat holding one. The bridge now names the offered
 * cards whose every playable ability is a mana ability (`setWeaklySelectable.
 * manaOnly`), and `nonManaSources` leaves them out.
 *
 * `scenarios/w52-s-signet.state`: seat 0 casts Raging Goblin; seat 1 holds an empty
 * hand, Azorius Signet and two Islands. Seat 1 never acts. The test asserts its
 * stack window's offer named the Signet (the new jar), that every offered card was
 * a mana source, that the server passed it, and that the Goblin resolved.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/w52-s \
 *   pnpm exec vitest run apps/server/src/play/w52-s-signet.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, idsOf, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';
import { TYPE, type WireObj } from './visibility.js';

const title = available.ok
	? 'wave 52 §S: a seat holding a Signet and nothing castable is passed like a land-only seat, against real Forge'
	: `wave 52 §S: a seat holding a Signet and nothing castable is passed like a land-only seat, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Mountains', ['40 Mountain']), deck('Islands', ['40 Island'])];

function stackIds(s: Scenario, seat: number): number[] {
	const game = [...s.state(seat).values()].find((o: WireObj) => o._type === TYPE.game);
	return idsOf(game, 'Stack');
}

type Offer = { cards: { id: number }[]; manaOnly?: { id: number }[] };

describe.skipIf(!available.ok)(title, () => {
	it(
		"seat 1's window with seat 0's spell on the stack offers the Signet, and is auto-passed without seat 1 acting",
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 52, decks: DECKS, scenario: scenarioText('w52-s-signet') });
			try {
				await finishMulligan(s);
				const logsBefore = s.logs.length;
				await waitUntil(
					() => {
						s.answerAsks();
						return s.zone(0, 'Hand').some((c) => c.name === 'Raging Goblin');
					},
					"seat 0's scripted Raging Goblin",
					20_000,
					s,
				);
				const goblin = s.zone(0, 'Hand').find((c) => c.name === 'Raging Goblin');
				if (goblin === undefined) throw new Error('no Raging Goblin in hand');
				s.select(0, goblin.id);
				const clicked = new Set<number>();
				await waitUntil(
					() => {
						s.answerAsks();
						// The scenario-start race (`PlayBridge.java`'s `refreshActionable`): a first
						// select can be dropped, so it is repeated while the card is still in hand
						// and no payment has opened.
						if (s.zone(0, 'Hand').some((c) => c.id === goblin.id) && !/Pay Mana Cost/.test(s.prompt(0))) s.select(0, goblin.id);
						if (/Pay Mana Cost/.test(s.prompt(0))) {
							const land = s.zone(0, 'Battlefield').find((c) => c.land && !c.tapped && !clicked.has(c.id));
							if (land !== undefined) {
								clicked.add(land.id);
								s.select(0, land.id);
							}
						}
						return stackIds(s, 0).length > 0;
					},
					"seat 0's Raging Goblin to reach the stack",
					45_000,
					s,
				);
				await waitUntil(
					() => {
						s.answerAsks();
						return s.zone(0, 'Battlefield').some((c) => c.name === 'Raging Goblin');
					},
					'Raging Goblin to resolve without any act from seat 1',
					20_000,
					s,
				);

				const signet = s.zone(1, 'Battlefield').find((c) => c.name === 'Azorius Signet');
				expect(signet, 'seat 1 controls the scripted Signet').toBeDefined();
				const windowAt = s.sent.findIndex(
					(x) => x.seat === 1 && x.envelope.frame.method === 'showPromptMessage' && /Stack: 1 to Resolve/.test((x.envelope.frame as unknown as { message: string }).message),
				);
				expect(windowAt, "seat 1 was shown a window with seat 0's spell on the stack").toBeGreaterThanOrEqual(0);
				const nextAt = s.sent.findIndex((x, i) => i > windowAt && x.seat === 1 && x.envelope.frame.method === 'showPromptMessage');
				const offer = [...s.sent.slice(0, nextAt === -1 ? s.sent.length : nextAt)]
					.reverse()
					.find((x) => x.seat === 1 && x.envelope.frame.method === 'setWeaklySelectable')?.envelope.frame as unknown as Offer | undefined;
				const offered = offer?.cards.map((c) => c.id) ?? [];
				expect(offered, 'the new jar offers the Signet at priority').toContain(signet?.id);
				expect(new Set(offer?.manaOnly?.map((c) => c.id))).toEqual(new Set(offered));
				expect(s.logs.slice(logsBefore).filter((l) => l.evt === 'auto-passed' && l.seat === 1).length).toBeGreaterThan(0);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});

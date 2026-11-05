/**
 * Which held cards the bridge names `unaffordable` — held back by their cost alone — against real Forge.
 *
 * The operator, 2026-11-05: on turn 1 with no land played, a click on a spell should say "I don't have
 * enough mana for that." The browser refuses that click before it reaches Forge, and a spell can be
 * left out of the offer for timing, a `CantBeCast` effect or no legal target as well as for mana, so
 * the mistake bubble said nothing. The bridge now reads, per window, the cards nothing can be taken on
 * whose spell fails only Forge's affordability test (`SeatController.heldBackByCost`), and the
 * browser says the mana line for exactly those (`mistakes.ts`).
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, forgeFrames, inOwnMain, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'the bridge names the held cards a seat cannot pay for, and only those, against real Forge'
	: `the bridge names the held cards a seat cannot pay for, and only those, against real Forge — SKIPPED: ${available.reason}`;

/** The names on the seat's last offer that carried an `unaffordable` reading, and the names it offered. */
function lastOffer(s: Scenario): { unaffordable: string[]; offered: string[] } | null {
	const frame = forgeFrames(s, 0).findLast((f) => f.method === 'setWeaklySelectable' && 'unaffordable' in f) as
		| { cards: { id: number }[]; unaffordable: { id: number }[] }
		| undefined;
	if (frame === undefined) return null;
	const name = (id: number) => s.zone(0, 'Hand').find((c) => c.id === id)?.name ?? s.zone(0, 'Battlefield').find((c) => c.id === id)?.name ?? `#${id}`;
	return { unaffordable: frame.unaffordable.map((c) => name(c.id)).sort(), offered: [...new Set(frame.cards.map((c) => name(c.id)))].sort() };
}

describe.skipIf(!available.ok)(title, () => {
	it('turn 1, no land: Bears, Bolt and Elves are named, Ornithopter and the Forest are offered; after the Forest, the Elves are not', async () => {
		if (!available.ok) return;
		const s = await startScenario(available.config, {
			seed: 41,
			decks: [deck('Forests', ['40 Forest']), deck('Mountains', ['40 Mountain'])],
			scenario: scenarioText('mana-line'),
		});
		try {
			await finishMulligan(s);
			await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1) && lastOffer(s) !== null; }, "alice's first main with an offer read", 60_000, s);
			expect(lastOffer(s)).toEqual({ unaffordable: ['Grizzly Bears', 'Lightning Bolt', 'Llanowar Elves'], offered: ['Forest', 'Ornithopter'] });

			s.select(0, s.zone(0, 'Hand').find((c) => c.name === 'Forest')!.id);
			await waitUntil(
				() => {
					s.answerAsks();
					return inOwnMain(s, 0, 1) && s.zone(0, 'Battlefield').some((c) => c.name === 'Forest') && lastOffer(s)?.offered.includes('Llanowar Elves') === true;
				},
				'the Forest played and the next offer read',
				30_000,
				s,
			);
			expect(lastOffer(s)?.unaffordable).toEqual(['Grizzly Bears', 'Lightning Bolt']);
		} finally {
			await s.stop();
		}
	}, 180_000);
});

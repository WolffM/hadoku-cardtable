/**
 * AF413 creature entries: the real-Forge half of a graveyard arrival. `live/numbers.ts`'s `diffViews`
 * tells a `rise` (`live/entries.ts`'s `entryMotionFor('graveyard')`) from nothing at all by one fact
 * alone — a permanent that WAS in a graveyard and now sits on a battlefield — read here straight off
 * a real Forge match rather than a hand-built view, so the one real-Forge risk in that diff (does
 * Forge's own zone-change actually look the way the pure function assumes) is checked at its source.
 *
 * `af413-reanimate.state`: seat 0 holds Reanimate, one untapped Swamp to pay its {B}, and Griselbrand
 * — the graveyard's only creature, so its target selection needs no further choice — already in the
 * graveyard. The test casts it and reads both zones before and after.
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? 'Reanimate puts Griselbrand on the battlefield: a real graveyard -> battlefield arrival'
	: `Reanimate puts Griselbrand on the battlefield: a real graveyard -> battlefield arrival — SKIPPED: ${available.reason}`;

describe.skipIf(!available.ok)(title, () => {
	it('Griselbrand leaves the graveyard and lands on the battlefield once Reanimate resolves', async () => {
		if (!available.ok) return;
		const s = await startScenario(available.config, {
			seed: 4130,
			decks: [deck('Swamps', ['40 Swamp']), deck('Mountains', ['40 Mountain'])],
			scenario: scenarioText('af413-reanimate'),
		});
		try {
			await finishMulligan(s);
			await waitUntil(() => {
				s.answerAsks();
				return inOwnMain(s, 0, 1);
			}, "alice's main phase with the scripted board", 60_000, s);

			const before = {
				graveyard: s.zone(0, 'Graveyard').map((c) => c.name),
				battlefield: s.zone(0, 'Battlefield').map((c) => c.name),
			};
			expect(before.graveyard, 'Griselbrand starts in the graveyard').toEqual(['Griselbrand']);
			expect(before.battlefield.includes('Griselbrand'), 'not yet on the battlefield').toBe(false);

			const reanimate = s.zone(0, 'Hand').find((c) => c.name === 'Reanimate');
			if (reanimate === undefined) throw new Error('no Reanimate in hand');
			s.select(0, reanimate.id);

			// Reanimate's own target: Griselbrand, the graveyard's one legal creature.
			await waitUntil(() => {
				s.answerAsks();
				if (!/Choose target|Select target/.test(s.prompt(0))) return false;
				const griselbrandInGy = s.zone(0, 'Graveyard').find((c) => c.name === 'Griselbrand');
				if (griselbrandInGy === undefined) throw new Error('Griselbrand left the graveyard before it could be targeted');
				s.select(0, griselbrandInGy.id);
				return true;
			}, "Reanimate's own target prompt", 20_000, s);

			await waitUntil(() => {
				s.answerAsks();
				return s.zone(0, 'Graveyard').every((c) => c.name !== 'Griselbrand') && /^Stack: Empty$/m.test(s.prompt(0)) && s.buttons(0)?.enable1 === true;
			}, "Reanimate to resolve", 30_000, s);

			const after = {
				graveyard: s.zone(0, 'Graveyard').map((c) => c.name),
				battlefield: s.zone(0, 'Battlefield'),
			};
			const griselbrand = after.battlefield.find((c) => c.name === 'Griselbrand');
			expect(after.graveyard.includes('Griselbrand'), 'left the graveyard').toBe(false);
			expect(griselbrand, 'arrived on the battlefield').not.toBeUndefined();
			expect(griselbrand?.creature, "entryHeft reads it as a creature, not a land's mana value").toBe(true);
			expect(griselbrand?.sick, 'summoning sick like any other arrival').toBe(true);
		} finally {
			await s.stop();
		}
	}, 180_000);
});

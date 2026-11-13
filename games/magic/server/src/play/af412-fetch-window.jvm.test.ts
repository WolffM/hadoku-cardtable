/**
 * The window before an attack tax, against real Forge.
 *
 * A fetchland is no mana ability (CR 605.1a): it cannot be cracked inside the payment, only with
 * priority before it. So when an attack tax applies to the seat's creatures and it holds one, its
 * Beginning of Combat is a stop, even though the seat's policy skips that step: it cracks the
 * fetch there, then declares and pays.
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, passUntil, promptBar, scenarioText, startScenario, timeline, waitUntil } from './scenario.js';

const title = available.ok
	? 'the Beginning of Combat window before an attack tax, against real Forge'
	: `the Beginning of Combat window before an attack tax, against real Forge — SKIPPED: ${available.reason}`;

const BEGIN_COMBAT = /^Priority: A\n[\s\S]*^Phase: Beginning of Combat Step$[\s\S]*^Stack: Empty$/m;
const DECLARE = /^Select creatures to attack/;
const UPKEEP_TRIGGER = /^Priority: A\n[\s\S]*^Phase: Upkeep step$[\s\S]*^Stack: 1 to Resolve/m;

describe.skipIf(!available.ok)(title, () => {
	it('Elephant Grass, one land short and a fetchland: the seat stops at Beginning of Combat, cracks it, then attacks and pays', async () => {
		if (!available.ok) return;
		const s = await startScenario(available.config, {
			seed: 4120,
			decks: [deck('Mountains', ['40 Mountain']), deck('Forests', ['40 Forest'])],
			scenario: scenarioText('af412-fetch-window'),
		});
		try {
			await finishMulligan(s);
			await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, "alice's main phase with the scripted board", 60_000, s);
			const from = s.sent.length;
			const lineFrom = s.lines.length;
			s.ok(0);
			await waitUntil(
				() => { s.answerAsks(); return (BEGIN_COMBAT.test(s.prompt(0)) && promptBar(s, 0)?.enable1 === true) || DECLARE.test(s.prompt(0)); },
				'her Beginning of Combat priority, or the declaration past it',
				20_000,
				s,
			);
			expect(s.prompt(0), `the seat was not given its Beginning of Combat with a fetchland and a tax ahead\n${timeline(s, 0, lineFrom, from)}`).toMatch(BEGIN_COMBAT);

			const fetch = s.zone(0, 'Battlefield').find((c) => c.name === 'Wooded Foothills')!;
			s.select(0, fetch.id);
			// With the fetch spent, nothing holds the step any more: it passes on to the declaration.
			await waitUntil(
				() => { s.answerAsks(); return s.zone(0, 'Battlefield').filter((c) => c.name === 'Mountain' && !c.tapped).length === 2 && DECLARE.test(s.prompt(0)) && promptBar(s, 0) !== null; },
				'the fetched Mountain on the battlefield, at the declaration',
				30_000,
				s,
			);
			const bears = s.zone(0, 'Battlefield').find((c) => c.name === 'Grizzly Bears')!;
			s.select(0, bears.id);
			await waitUntil(() => { s.answerAsks(); return promptBar(s, 0)?.label2 === 'Call Back'; }, 'the Bears declared', 10_000, s);
			s.ok(0);
			// The tax is the seat's to pay, with Forge's Auto live now that two Mountains can.
			await waitUntil(() => { s.answerAsks(); return /an attacker[\s\S]*Pay Mana Cost: \{2\}/.test(s.prompt(0)) && s.buttons(0)?.enable1 === true; }, 'the {2} tax, payable', 20_000, s);
			s.ok(0);
			await waitUntil(
				() => {
					s.answerAsks();
					const view = [...s.state(0).values()].find((o) => o._type === 0 && o._id === bears.id);
					return (view?.Attacking as { v?: boolean } | undefined)?.v === true;
				},
				'the Bears attacking',
				20_000,
				s,
			);
			expect(s.logs.filter((l) => l.evt === 'ask-unanswerable'), 'nothing was taken from the seat').toEqual([]);
		} finally {
			await s.stop();
		}
	}, 180_000);

	it('Elephant Grass’s cumulative upkeep with only a fetchland: the seat keeps the trigger’s window, cracks it, then pays', async () => {
		if (!available.ok) return;
		const s = await startScenario(available.config, {
			seed: 4121,
			decks: [deck('Mountains', ['40 Mountain']), deck('Forests', ['40 Forest'])],
			scenario: scenarioText('af412-upkeep-window'),
		});
		try {
			await finishMulligan(s);
			const from = s.sent.length;
			const lineFrom = s.lines.length;
			const grassGone = (): boolean => !s.zone(0, 'Battlefield').some((c) => c.name === 'Elephant Grass');
			await passUntil(s, () => (UPKEEP_TRIGGER.test(s.prompt(0)) && promptBar(s, 0)?.enable1 === true) || grassGone() || inOwnMain(s, 0, 2), 'her upkeep trigger’s window, or past it', 60_000);
			expect(s.prompt(0), `the seat was not given its upkeep trigger’s window with a fetchland and the cost ahead\n${timeline(s, 0, lineFrom, from)}`).toMatch(UPKEEP_TRIGGER);

			const fetch = s.zone(0, 'Battlefield').find((c) => c.name === 'Wooded Foothills')!;
			s.select(0, fetch.id);
			// With the fetch spent the trigger's window is the seat's own spell again: it resolves into the payment.
			await waitUntil(
				() => { s.answerAsks(); return s.zone(0, 'Battlefield').some((c) => c.name === 'Mountain' && !c.tapped) && /Pay Mana Cost: \{1\}/.test(s.prompt(0)) && s.buttons(0)?.enable1 === true; },
				'the fetched Mountain, and the {1} upkeep cost payable',
				30_000,
				s,
			);
			s.ok(0);
			await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 2); }, 'her main phase', 20_000, s);
			expect(grassGone(), 'Elephant Grass stays: its upkeep was paid').toBe(false);
		} finally {
			await s.stop();
		}
	}, 180_000);
});

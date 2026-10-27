/**
 * An attack tax the seat cannot pay unwinds that attack instead of sitting open, against real Forge.
 *
 * Elephant Grass taxes each nonblack attacker {2}. Alice declares two attackers holding one
 * untapped Mountain and a fetchland, which is no mana ability and cannot be cracked inside a
 * payment: neither tax can be paid, and Forge's own decline (Cancel) is that creature not attacking.
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, promptBar, scenarioText, startScenario, timeline, waitUntil } from './scenario.js';

const title = available.ok
	? 'an attack tax the seat cannot pay, against real Forge'
	: `an attack tax the seat cannot pay, against real Forge — SKIPPED: ${available.reason}`;

const ATTACK_TAX = /an attacker[\s\S]*Pay Mana Cost/;

describe.skipIf(!available.ok)(title, () => {
	it('Elephant Grass with no way to pay: no tax reaches the seat, nobody attacks, the turn goes on', async () => {
		if (!available.ok) return;
		const s = await startScenario(available.config, {
			seed: 4000,
			decks: [deck('Mountains', ['40 Mountain']), deck('Forests', ['40 Forest'])],
			scenario: scenarioText('af400-elephant-grass'),
		});
		try {
			await finishMulligan(s);
			await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, "alice's main phase with the scripted board", 60_000, s);
			const from = s.sent.length;
			const lineFrom = s.lines.length;
			// Main 1, then the Beginning of Combat the fetchland holds open with the tax ahead: OK on each, once.
			const pressed = new Set<string>();
			await waitUntil(
				() => {
					s.answerAsks();
					const msg = s.prompt(0);
					if (/^Select creatures to attack/.test(msg)) return promptBar(s, 0) !== null;
					const step = /^Phase: (Main phase, precombat|Beginning of Combat Step)$/m.exec(msg)?.[1];
					if (step !== undefined && /^Priority:/.test(msg) && !pressed.has(step) && promptBar(s, 0)?.enable1 === true) {
						pressed.add(step);
						s.ok(0);
					}
					return false;
				},
				"Forge's live declare-attackers window",
				20_000,
				s,
			);
			const attackers = s.zone(0, 'Battlefield').filter((c) => c.creature);
			for (const c of attackers) {
				const declared = s.sent.length;
				s.select(0, c.id);
				await waitUntil(() => s.sent.slice(declared).some((x) => x.seat === 0 && x.envelope.frame.method === 'updateButtons'), `${c.name} declared`, 10_000, s);
			}
			s.ok(0);
			const shownTax = (): string[] =>
				s.sent
					.slice(from)
					.filter((x) => x.seat === 0 && x.envelope.frame.method === 'showPromptMessage')
					.map((x) => (x.envelope.frame as { message: string }).message)
					.filter((m) => ATTACK_TAX.test(m));
			// Forge's own decline removes each attacker it could not pay for (`PhaseHandler.java:578-583`)
			// and the step goes on to its priority: past the declaration, with nobody attacking.
			await waitUntil(
				() => { s.answerAsks(); return shownTax().length > 0 || /^Priority: A\n[\s\S]*^Phase: Declare Attackers Step$/m.test(s.prompt(0)); },
				'a tax shown to the seat, or priority after the declaration',
				30_000,
				s,
			);
			expect(shownTax(), `the seat was asked to pay a tax it cannot pay\n${timeline(s, 0, lineFrom, from)}`).toEqual([]);
			const attacking = [...s.state(0).values()].filter((o) => o._type === 0 && (o.Attacking as { v?: boolean } | undefined)?.v === true);
			expect(attacking, 'nobody attacks').toEqual([]);
			expect(s.logs.filter((l) => l.evt === 'ask-unanswerable' && l.method === 'payment').map((l) => l.card), 'each unpayable tax logs ask-unanswerable with its attacker').toEqual(attackers.map((c) => c.id));
		} finally {
			await s.stop();
		}
	}, 180_000);
});

/**
 * A "you may pay" the seat has no way to pay is never put to it, against real Forge.
 *
 * Two Punishing Fires sit in alice's graveyard with no red source on her side. When bob gains
 * life, each trigger asks "Pay Mana Cost: {R}" — a payment no card of hers can make, whose only
 * legal answer is Forge's own Cancel (the unpaid branch: the card stays in the graveyard).
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, timeline, waitUntil } from './scenario.js';

const title = available.ok
	? 'an unpayable optional payment is answered by the server, against real Forge'
	: `an unpayable optional payment is answered by the server, against real Forge — SKIPPED: ${available.reason}`;

const PAY_PUNISHING = /Punishing Fire[\s\S]*Pay Mana Cost/;

describe.skipIf(!available.ok)(title, () => {
	it('Punishing Fire with no red source: neither trigger reaches the seat, both stay in the graveyard', async () => {
		if (!available.ok) return;
		const s = await startScenario(available.config, {
			seed: 3980,
			decks: [deck('Forests', ['40 Forest']), deck('Forests', ['40 Forest'])],
			scenario: scenarioText('af398-punishing-fire'),
		});
		try {
			await finishMulligan(s);
			await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, "alice's main phase with the scripted board", 60_000, s);
			const from = s.sent.length;
			const lineFrom = s.lines.length;
			const swords = s.zone(0, 'Hand').find((c) => c.name === 'Swords to Plowshares')!;
			const bears = s.zone(1, 'Battlefield').find((c) => c.name === 'Grizzly Bears')!;
			s.select(0, swords.id);
			await waitUntil(() => { s.answerAsks(); return /Select target creature/.test(s.prompt(0)); }, "Swords' target prompt", 20_000, s);
			s.select(0, bears.id);
			const shown = (): string[] =>
				s.sent
					.slice(from)
					.filter((x) => x.seat === 0 && x.envelope.frame.method === 'showPromptMessage')
					.map((x) => (x.envelope.frame as { message: string }).message)
					.filter((m) => PAY_PUNISHING.test(m));
			await waitUntil(
				() => { s.answerAsks(); return shown().length > 0 || (inOwnMain(s, 0, 1) && !s.zone(1, 'Battlefield').some((c) => c.name === 'Grizzly Bears')); },
				'a payment shown to the seat, or Swords and both triggers resolved back to her main phase',
				30_000,
				s,
			);
			expect(shown(), `the seat was asked to pay a cost it cannot pay\n${timeline(s, 0, lineFrom, from)}`).toEqual([]);
			expect(s.zone(0, 'Graveyard').filter((c) => c.name === 'Punishing Fire'), 'both Punishing Fires stay in the graveyard').toHaveLength(2);
			expect(s.zone(0, 'Hand').filter((c) => c.name === 'Punishing Fire'), 'neither returned to hand').toEqual([]);
			const fires = s.zone(0, 'Graveyard').filter((c) => c.name === 'Punishing Fire').map((c) => c.id).sort();
			expect(s.logs.filter((l) => l.evt === 'ask-unanswerable' && l.method === 'payment').map((l) => l.card).sort(), 'each unpayable trigger logs ask-unanswerable with its card').toEqual(fires);
		} finally {
			await s.stop();
		}
	}, 180_000);
});

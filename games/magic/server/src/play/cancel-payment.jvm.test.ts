/**
 * The server's auto-cancel of a cost Forge says cannot be paid presses Cancel on that payment,
 * never on the input Forge opens after it, against real Forge.
 *
 * af57, run 39163377412: alice cast Brainstorm and Forge's Auto paid its {U} while the server read
 * the payment window mid-pay (the Island already tapped, Auto dead) as unpayable and sent a plain
 * `selectButtonCancel`. The payment had ended by the time it landed, so it pressed the next
 * priority window's End Turn: alice yielded the turn and her put-back pick closed unpicked. The
 * cancel is now the bridge's `cancel-payment`, read against the input open when it arrives
 * (`PlayBridge.java`'s `cancelPayment`); `af68-unpayable-offer.spec.ts` holds that it still
 * cancels a payment that is open.
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'an auto-cancel that arrives after its payment, against real Forge'
	: `an auto-cancel that arrives after its payment, against real Forge — SKIPPED: ${available.reason}`;

const STATE = [
	'turn=1',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=20',
	'ailife=20',
	'humanhand=',
	'humanbattlefield=Forest',
	'humanlibrary=Forest;Forest;Forest;Forest;Forest;Forest',
	'humangraveyard=',
	'aihand=',
	'aibattlefield=Island',
	'ailibrary=Island;Island;Island;Island;Island;Island',
	'aigraveyard=',
].join('\n');

/** Seat 0's prompts sent since `from` that say it is yielding the turn. */
const yielding = (s: Scenario, from: number): string[] =>
	s.sent
		.slice(from)
		.filter((x) => x.seat === 0 && x.envelope.frame.method === 'showPromptMessage')
		.map((x) => (x.envelope.frame as { message: string }).message)
		.filter((m) => /Yielding/.test(m));

async function atOwnMain(): Promise<Scenario> {
	if (!available.ok) throw new Error(available.reason);
	const s = await startScenario(available.config, {
		seed: 6501,
		decks: [deck('Forests', ['40 Forest']), deck('Islands', ['40 Island'])],
		scenario: STATE,
	});
	await finishMulligan(s);
	await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, "seat 0's main phase with the scripted board", 60_000, s);
	return s;
}

describe.skipIf(!available.ok)(title, () => {
	// What the server sent before: a plain Cancel at a priority window is Forge's End Turn.
	it('a plain Cancel there is End Turn: the seat yields', async () => {
		const s = await atOwnMain();
		try {
			const from = s.sent.length;
			s.cancel(0);
			await waitUntil(() => yielding(s, from).length > 0, 'seat 0 yielding the turn', 20_000, s);
		} finally {
			await s.stop();
		}
	}, 120_000);

	it('presses nothing at the priority window open by then: the seat keeps its turn and the next click still lands', async () => {
		const s = await atOwnMain();
		try {
			const forest = s.zone(0, 'Battlefield').find((c) => c.name === 'Forest')!;
			const from = s.sent.length;

			s.command({ t: 'cancel-payment', seat: 0 });
			// Commands reach Forge in order: had the Cancel pressed this window's End Turn, seat 0
			// would be yielding by the time the click arrives, and the Forest would stay untapped.
			s.select(0, forest.id);
			await waitUntil(() => { s.answerAsks(); return s.zone(0, 'Battlefield').some((c) => c.id === forest.id && c.tapped) && inOwnMain(s, 0, 1); }, 'the Forest tapped at the same priority', 20_000, s);

			expect(yielding(s, from), 'seat 0 never yields').toEqual([]);
		} finally {
			await s.stop();
		}
	}, 120_000);
});

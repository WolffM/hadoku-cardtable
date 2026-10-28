/**
 * AF397 (doomed cards): a target choice that would send its target off the battlefield, against
 * real Forge.
 *
 * Swords to Plowshares (`Api$ChangeZone|Destination$Exile`) targeting a creature is the class this
 * proves: `PlayBridge.java`'s `leavesBattlefield` reads the open target input's own ability — its
 * API and params, never the target's name — and the wire's `selection.offBattlefield` should name
 * exactly the legal targets while that choice stands open.
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, timeline, waitUntil } from './scenario.js';

const title = available.ok
	? 'a target choice that would exile its target carries selection.offBattlefield, against real Forge'
	: `a target choice that would exile its target carries selection.offBattlefield, against real Forge — SKIPPED: ${available.reason}`;

interface SelectionFrame {
	method: string;
	selection?: { targets: boolean; offBattlefield?: { cards: { kind: string; id: number }[] } };
}

describe.skipIf(!available.ok)(title, () => {
	it('Swords to Plowshares targeting Grizzly Bears: the open target choice names the bear as off-battlefield', async () => {
		if (!available.ok) return;
		const s = await startScenario(available.config, {
			seed: 3971,
			decks: [deck('Swords', ['40 Forest']), deck('Bears', ['40 Forest'])],
			scenario: scenarioText('af397-swords-target'),
		});
		try {
			const lineFrom = s.lines.length;
			await finishMulligan(s);
			await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, "alice's main phase with the scripted board", 60_000, s);
			const swords = s.zone(0, 'Hand').find((c) => c.name === 'Swords to Plowshares')!;
			const bears = s.zone(1, 'Battlefield').find((c) => c.name === 'Grizzly Bears')!;
			s.select(0, swords.id);
			await waitUntil(() => { s.answerAsks(); return /Select target creature/.test(s.prompt(0)); }, "Swords' target prompt", 20_000, s);
			const last = [...s.sent].reverse().find((x) => x.seat === 0 && x.envelope.frame.method === 'showPromptMessage');
			const frame = last?.envelope.frame as SelectionFrame | undefined;
			expect(frame?.selection?.targets, `the open target prompt:\n${timeline(s, 0, lineFrom)}`).toBe(true);
			const cards = frame?.selection?.offBattlefield?.cards ?? [];
			expect(cards.map((c) => c.id)).toEqual([bears.id]);
		} finally {
			await s.stop();
		}
	}, 180_000);
});

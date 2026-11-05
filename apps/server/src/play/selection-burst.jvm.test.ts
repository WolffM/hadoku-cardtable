/**
 * Clicks sent to answer a selection are for that selection alone, against real Forge.
 *
 * Forge's `ActGate` holds a click that arrives between two inputs and gives it to whatever input opens
 * next — on purpose: a creature clicked right after a land play casts. A burst of clicks answering
 * Brainstorm's "put two back", though, ran past the pick: the monkey's third click landed on the
 * priority window after it (2026-11-05, m-d83ea567b2b8), where a castable card would have been cast.
 * A click the browser marks `forSelection` is applied to the selection it was shown or dropped
 * (`PlayBridge.java`'s `MatchContext.selectionClicks`). All three clicks here are sent back to back,
 * synchronously, before Forge has taken the first.
 */

import { ClientFrameSchema } from '@hadoku/forge-wire';
import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'a click sent to answer a selection never reaches the input after it, against real Forge'
	: `a click sent to answer a selection never reaches the input after it, against real Forge — SKIPPED: ${available.reason}`;

const click = (id: number, forSelection: boolean) =>
	ClientFrameSchema.parse({ kind: 'act', method: 'selectCard', card: { kind: 'card', id }, otherCardViewsToSelect: [], triggerEvent: null, ...(forSelection ? { forSelection: true } : {}) });
const handNames = (s: Scenario): string[] => s.zone(0, 'Hand').map((c) => c.name).sort();

/** Brainstorm cast and resolved to its put-back pick; the hand then holds Bolt and the three cards drawn. */
async function toThePick(seed: number): Promise<Scenario> {
	if (!available.ok) throw new Error(available.reason);
	const s = await startScenario(available.config, {
		seed,
		decks: [deck('Islands', ['40 Island']), deck('Mountains', ['40 Mountain'])],
		scenario: scenarioText('selection-burst'),
	});
	await finishMulligan(s);
	await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, "alice's main phase with the scripted board", 60_000, s);
	s.select(0, s.zone(0, 'Hand').find((c) => c.name === 'Brainstorm')!.id);
	await waitUntil(() => { s.answerAsks(); return handNames(s).length === 4 && /hand/i.test(s.prompt(0)) && !/^Priority:/.test(s.prompt(0)); }, "Brainstorm's put-back pick", 30_000, s);
	return s;
}

describe.skipIf(!available.ok)(title, () => {
	it('two cards for the pick, then Bolt, all marked for the pick: the two go back, and Bolt is dropped, never cast', async () => {
		if (!available.ok) return;
		const s = await toThePick(31);
		try {
			const hand = s.zone(0, 'Hand');
			const burst = ['Forest', 'Plains', 'Lightning Bolt'].map((n) => hand.find((c) => c.name === n)!);
			for (const c of burst) expect(s.match.fromClient(0, click(c.id, true))).toEqual({ ok: true });
			await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1) && handNames(s).length === 2; }, 'the pick taken and priority back', 30_000, s);
			// Long enough for a held click to have reached that window, had it been let through.
			await new Promise((r) => setTimeout(r, 1_500));
			s.answerAsks();
			expect(handNames(s)).toEqual(['Lightning Bolt', 'Swamp']);
			expect(s.prompt(0)).toMatch(/^Priority:/);
			expect(s.logs.filter((l) => l.evt === 'bridge-dropped').map((l) => l.card)).toEqual([burst[2]!.id]);
		} finally {
			await s.stop();
		}
	}, 180_000);

	it('the same burst with Bolt unmarked — a play, not an answer — still carries to the next window, as a click after a land play does', async () => {
		if (!available.ok) return;
		const s = await toThePick(32);
		try {
			const hand = s.zone(0, 'Hand');
			const [forest, plains, bolt] = ['Forest', 'Plains', 'Lightning Bolt'].map((n) => hand.find((c) => c.name === n)!);
			expect(s.match.fromClient(0, click(forest!.id, true))).toEqual({ ok: true });
			expect(s.match.fromClient(0, click(plains!.id, true))).toEqual({ ok: true });
			expect(s.match.fromClient(0, click(bolt!.id, false))).toEqual({ ok: true });
			await waitUntil(() => { s.answerAsks(); return /target/i.test(s.prompt(0)); }, "Bolt's target prompt, the click carried to the window after the pick", 30_000, s);
			expect(s.logs.filter((l) => l.evt === 'bridge-dropped')).toEqual([]);
		} finally {
			await s.stop();
		}
	}, 180_000);
});

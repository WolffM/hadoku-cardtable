/**
 * Which players a target selection accepts, sent with `setSelectables`, against real Forge.
 *
 * Forge publishes the legal CARDS of a target selection and checks a player only when it is
 * clicked, so the browser offered every player and the arrow snapped to faces a spell could
 * not target (the operator, 2026-10-04: Grasp of Darkness; in match m-09487f336215 a refused
 * `selectPlayer` sent twice locked the game). The bridge now runs Forge's own player checks
 * when the selection opens and sends the players that pass.
 */
import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'a target selection names the players it accepts, against real Forge'
	: `a target selection names the players it accepts, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Mountain']), deck('Any B', ['40 Mountain'])];

type SelectablesFrame = { method: 'setSelectables'; cards: { id: number }[]; players?: { id: number }[] };

function lastSelectables(s: Scenario, seat: number, since: number): SelectablesFrame | undefined {
	const frames = s.sent
		.slice(since)
		.filter((x) => x.seat === seat && (x.envelope.frame as { method?: string }).method === 'setSelectables')
		.map((x) => x.envelope.frame as unknown as SelectablesFrame);
	return frames.at(-1);
}

async function selectionFor(scenario: string, seed: number, spell: string): Promise<SelectablesFrame> {
	if (!available.ok) throw new Error('unreachable');
	const s = await startScenario(available.config, { seed, decks: DECKS, scenario: scenarioText(scenario) });
	try {
		await finishMulligan(s);
		await waitUntil(
			() => {
				s.answerAsks();
				return s.zone(0, 'Hand').some((c) => c.name === spell);
			},
			`seat 0's hand to hold the scripted ${spell}`,
			20_000,
		);
		const card = s.zone(0, 'Hand').find((c) => c.name === spell)!;
		const since = s.sent.length;
		s.select(0, card.id);
		let frame: SelectablesFrame | undefined;
		await waitUntil(
			() => {
				s.answerAsks();
				frame = lastSelectables(s, 0, since);
				return frame !== undefined;
			},
			`${spell}'s target selection to open for seat 0`,
			20_000,
		);
		return frame!;
	} finally {
		s.stop();
	}
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'Doom Blade (target nonblack creature) names no player',
		async () => {
			const frame = await selectionFor('auto-target', 4101, 'Doom Blade');
			expect(frame.cards.length, 'its legal creature is offered').toBeGreaterThan(0);
			expect(frame.players, 'the bridge read the selection').toBeDefined();
			expect(frame.players).toEqual([]);
		},
		90_000,
	);

	it(
		'Lightning Bolt (any target) names both players',
		async () => {
			const frame = await selectionFor('bolt-player', 4102, 'Lightning Bolt');
			expect(frame.players, 'the bridge read the selection').toBeDefined();
			expect(frame.players!.length).toBe(2);
		},
		90_000,
	);
});

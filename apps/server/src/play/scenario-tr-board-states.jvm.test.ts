/**
 * Lane testing-states — the operator, 2026-10-23: "i also need some rooms
 * that have tournaments and games in progress so i can validate the ui and
 * game actions better. can you construct some more complex board states …
 * that i can jump into?" This is the "a state Forge rejects is a bug" proof
 * for the `tr-*.state` files `room/testing-rooms.ts` starts its new
 * board-state testing rooms from, against a REAL Forge match: each board
 * comes up with exactly the permanents, counters, attachments, loyalty and
 * zones the file asks for.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=~/.cache/… \
 *   pnpm exec vitest run apps/server/src/play/scenario-tr-board-states.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok ? 'the board-state testing rooms, against real Forge' : `the board-state testing rooms, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Mountain']), deck('Any B', ['40 Mountain'])];

/**
 * Seat 0 — the admin, who every `tr-*` board hands priority — has its own live priority window: the
 * mulligan is done and the state applied. Seat 0's own, not either seat's: a live bar on seat 1 came
 * while seat 0 was still on its keep-or-mulligan prompt, and `turn(0)`, read off that prompt, was null
 * (`tr-combat`, run 40016234195).
 */
async function toPriority(s: Scenario): Promise<void> {
	await waitUntil(
		() => {
			s.keepHands();
			s.answerAsks();
			return s.prompt(0).startsWith('Priority:') && s.buttons(0)?.enable1 === true;
		},
		'a live priority window',
		60_000,
		s,
	);
}

/** This seat's wire object for a battlefield card by name — there is exactly one of each name in every `tr-*` board. */
function cardState(s: Scenario, seat: number, name: string): Record<string, unknown> {
	const id = s.zone(seat, 'Battlefield').find((c) => c.name === name)?.id;
	const obj = [...s.state(seat).values()].find((o) => o._type === 0 && o._id === id);
	if (obj === undefined) throw new Error(`${name} is not on seat ${seat}'s battlefield`);
	return obj as Record<string, unknown>;
}

/** `Counters` as a plain `[kind, count]` list — `WireObj.Counters` is `{ t: 'multiset', v: [[kind, count], …] }`. */
function counters(obj: Record<string, unknown>): [string, number][] {
	return ((obj.Counters as { v?: [string, number][] } | undefined)?.v ?? []) as [string, number][];
}

/** How many OTHER permanents are attached to this one (`AttachedCards`, absent when none). */
function attachedCount(obj: Record<string, unknown>): number {
	return ((obj.AttachedCards as { v?: unknown[] } | undefined)?.v ?? []).length;
}

/** This player's life total, off their own `Life` property. */
function life(s: Scenario, seat: number): number {
	const playerId = s.match.seats[seat]?.playerId ?? -1;
	const obj = [...s.state(seat).values()].find((o) => o._type === 1 && o._id === playerId);
	return ((obj?.Life as { v?: number } | undefined)?.v) ?? -1;
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'tr-midgame: both sides built out — tapped and untapped creatures, an equipped and an enchanted one, a +1/+1 counter, a token, a planeswalker, hands and graveyards, life not 20',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 1, decks: DECKS, scenario: scenarioText('tr-midgame') });
			try {
				await toPriority(s);
				expect(s.zone(0, 'Battlefield').map((c) => c.name).sort()).toEqual(
					['Bonesplitter', "Elspeth, Sun's Champion", 'Forest', 'Grizzly Bears', 'Hill Giant', 'Island', 'Llanowar Elves', 'Rancor', 'Soldier Token'].sort(),
				);
				expect(s.zone(1, 'Battlefield').map((c) => c.name).sort()).toEqual(['Boggart Brute', 'Colossal Dreadmaw', 'Goblin Token', 'Mountain', 'Swamp'].sort());
				expect(s.zone(0, 'Hand').map((c) => c.name)).toEqual(['Lightning Bolt', 'Giant Growth']);
				expect(s.zone(1, 'Hand').map((c) => c.name)).toEqual(['Shock']);
				expect(s.zone(0, 'Graveyard').map((c) => c.name).sort()).toEqual(['Lightning Bolt', 'Mountain'].sort());
				expect(s.zone(1, 'Graveyard').map((c) => c.name).sort()).toEqual(['Forest', 'Shock'].sort());
				expect(life(s, 0)).toBe(14);
				expect(life(s, 1)).toBe(11);
				// The planeswalker's loyalty.
				expect(counters(cardState(s, 0, "Elspeth, Sun's Champion"))).toEqual([['Loyalty', 5]]);
				// The +1/+1 counter and the equipment riding along with it (`AttachedCards`).
				const elves = cardState(s, 0, 'Llanowar Elves');
				expect(counters(elves)).toEqual([['+1/+1', 1]]);
				expect(attachedCount(elves)).toBe(1);
				// The aura on the other creature.
				expect(attachedCount(cardState(s, 0, 'Hill Giant'))).toBe(1);
				expect(counters(cardState(s, 1, 'Colossal Dreadmaw'))).toEqual([['+1/+1', 1]]);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		"a board room's opening: straight onto the board, no coin toss and no mulligan for anyone to answer",
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 1, decks: DECKS, scenario: scenarioText('tr-combat'), skipOpening: true, aiOpponent: true });
			try {
				// Nothing is answered: an ask for play-or-draw or a mulligan would hold this short of priority.
				await waitUntil(() => s.prompt(0).startsWith('Priority:') && s.buttons(0)?.enable1 === true, 'priority on the board, unasked', 60_000, s);
				expect(s.turn(0)).toEqual({ n: 4, owner: s.names[0] });
				expect(s.phase(0)).toBe('Main phase, precombat');
				expect(s.zone(0, 'Battlefield').map((c) => c.name).sort()).toEqual(['Boggart Brute', 'Colossal Dreadmaw', 'Forest', 'Forest', 'Grizzly Bears', 'Mountain'].sort());
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'tr-protection: flying, ward (both shapes), hexproof, shroud, menace and trample on one board, including a flyer with ward on each side',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 1, decks: DECKS, scenario: scenarioText('tr-protection') });
			try {
				await toPriority(s);
				expect(s.zone(0, 'Battlefield').map((c) => c.name).sort()).toEqual(
					['Boggart Brute', 'Colossal Dreadmaw', 'Forest', 'Gladecover Scout', 'Island', 'Kalonian Behemoth', 'Owlin Shieldmage', 'Waterfall Aerialist'].sort(),
				);
				expect(s.zone(1, 'Battlefield').map((c) => c.name).sort()).toEqual(['Grizzly Bears', 'Mountain', 'Rimeshield Frost Giant', 'Serra Angel', 'Swamp'].sort());
				expect(s.zone(0, 'Hand').map((c) => c.name)).toEqual(['Lightning Bolt']);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'tr-combat: seat 0 at its own Main Phase 1 with several live attackers, facing first strike and deathtouch blockers',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 1, decks: DECKS, scenario: scenarioText('tr-combat') });
			try {
				await toPriority(s);
				expect(s.turn(0)).toEqual({ n: 4, owner: s.names[0] });
				expect(s.phase(0)).toBe('Main phase, precombat');
				expect(s.zone(0, 'Battlefield').map((c) => c.name).sort()).toEqual(['Boggart Brute', 'Colossal Dreadmaw', 'Forest', 'Forest', 'Grizzly Bears', 'Mountain'].sort());
				expect(s.zone(1, 'Battlefield').map((c) => c.name).sort()).toEqual(['Anaba Bodyguard', 'Ankle Biter', 'Hill Giant', 'Mountain', 'Swamp'].sort());
				// Every would-be attacker is untapped and not summoning sick.
				for (const name of ['Colossal Dreadmaw', 'Boggart Brute', 'Grizzly Bears']) {
					const card = s.zone(0, 'Battlefield').find((c) => c.name === name)!;
					expect(card.tapped).toBe(false);
					expect(card.sick).toBe(false);
				}
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'tr-stack: the ai\'s spell sits on the stack, unresolved, with a live priority window for the admin holding Counterspell',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 1, decks: DECKS, scenario: scenarioText('tr-stack') });
			try {
				await toPriority(s);
				expect(s.buttons(0)?.enable1).toBe(true);
				expect(s.prompt(0)).toMatch(/^Stack: 1 to Resolve\.$/m);
				expect(s.zone(0, 'Hand').map((c) => c.name)).toEqual(['Counterspell']);
				expect(s.zone(0, 'Battlefield').map((c) => c.name).sort()).toEqual(['Grizzly Bears', 'Island', 'Island', 'Waterfall Aerialist'].sort());
				expect(s.zone(1, 'Battlefield').map((c) => c.name).sort()).toEqual(['Boggart Brute', 'Mountain', 'Mountain'].sort());
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'tr-triggers: fifteen creatures a side, the human\'s nearly all triggers, every one ready to attack, and the hand that sets them off',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 1, decks: DECKS, scenario: scenarioText('tr-triggers') });
			try {
				await toPriority(s);
				expect(s.turn(0)).toEqual({ n: 3, owner: s.names[0] });
				expect(s.phase(0)).toBe('Main phase, precombat');
				const creatures = (seat: number) => s.zone(seat, 'Battlefield').filter((c) => !/^(Mountain|Plains|Forest|Swamp|Island|Impact Tremors|Glorious Anthem|Goblin Bombardment)$/.test(c.name));
				expect(creatures(0)).toHaveLength(15);
				expect(creatures(1)).toHaveLength(14);
				for (const card of creatures(0)) {
					expect(card.tapped, card.name).toBe(false);
					expect(card.sick, card.name).toBe(false);
				}
				for (const name of ['Soul Warden', 'Blood Artist', 'Zulaport Cutthroat', 'Young Pyromancer', 'Impact Tremors', 'Goblin Bombardment']) {
					expect(s.zone(0, 'Battlefield').some((c) => c.name === name), name).toBe(true);
				}
				expect(s.zone(0, 'Hand').map((c) => c.name)).toEqual(['Pyroclasm', 'Lightning Bolt', 'Raise the Alarm', 'Siege-Gang Commander']);
				expect(life(s, 0)).toBe(40);
				expect(life(s, 1)).toBe(40);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);

	it(
		'tr-bigboard: 15 permanents a side',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 1, decks: DECKS, scenario: scenarioText('tr-bigboard') });
			try {
				await toPriority(s);
				expect(s.zone(0, 'Battlefield')).toHaveLength(15);
				expect(s.zone(1, 'Battlefield')).toHaveLength(15);
			} finally {
				await s.stop();
			}
		},
		300_000,
	);
});

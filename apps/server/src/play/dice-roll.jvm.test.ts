/**
 * A die roll reaches both seats as one `message` frame that carries the roll itself: who rolled,
 * the die's sides, each result and the card it came from — what the board draws its die from.
 * Forge sends the roll's result only as prose (`RollDiceEffect`'s `notifyOfValue`, "Alice rolled
 * 14"), so the bridge reads it where Forge still holds the ability (`PlayBridge.java`'s
 * `SeatController.notifyOfValue`).
 *
 * Against the real jar, `scenarios/wd-dice.state`: alice taps Wizard's Spellbook (a d20) at bob's
 * Lightning Bolt, then casts Goblin Tutor (a d6, its sides Forge's default).
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=~/.cache/… \
 *   pnpm exec vitest run apps/server/src/play/dice-roll.jvm.test.ts
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, landPayer, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = (t: string): string => (available.ok ? t : `${t} — SKIPPED: ${available.reason}`);

interface Said {
	seat: number;
	message: string;
	roll?: { player: { kind: string; id: number }; sides: number | null; results: number[]; ignored?: number[]; source: { kind: string; id: number } | null };
}

/** Every `message` frame each seat was sent from `from` on that says someone rolled. */
function rolls(s: Scenario, from: number): Said[] {
	return s.sent
		.slice(from)
		.filter((x) => x.envelope.frame.method === 'message' && / rolled /.test((x.envelope.frame as { message: string }).message))
		.map((x) => ({ seat: x.seat, ...(x.envelope.frame as unknown as Omit<Said, 'seat'>) }));
}

describe.skipIf(!available.ok)(title('a die roll carries its die, against real Forge'), () => {
	it("Wizard's Spellbook rolls a d20 and Goblin Tutor a d6: both seats are told each roll, its sides and its source", async () => {
		const s = await startScenario(available.ok ? available.config : (undefined as never), {
			seed: 2020,
			decks: [deck('wd-a', ['20 Mountain']), deck('wd-b', ['20 Mountain'])],
			names: ['Alice', 'Bob'],
			scenario: scenarioText('wd-dice'),
		});
		try {
			await finishMulligan(s);
			await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, "alice's main phase with the scripted board", 60_000, s);
			const aliceId = s.match.seats[0]?.playerId;
			const book = s.zone(0, 'Battlefield').find((c) => c.name === "Wizard's Spellbook")!;
			const bolt = s.zone(1, 'Graveyard').find((c) => c.name === 'Lightning Bolt')!;
			const from = s.sent.length;
			s.select(0, book.id);
			await waitUntil(() => { s.answerAsks(); return /target instant or sorcery/i.test(s.prompt(0)); }, "the Spellbook's target prompt", 20_000, s);
			s.select(0, bolt.id);
			await waitUntil(() => { s.answerAsks(); return rolls(s, from).length >= 2; }, 'the d20 roll told to both seats', 30_000, s);
			const d20 = rolls(s, from);
			console.log(`[dice] d20: ${JSON.stringify(d20)}`);
			expect(d20.map((r) => r.seat).sort()).toEqual([0, 1]);
			for (const r of d20) {
				expect(r.roll).toBeDefined();
				expect(r.roll!.player).toEqual({ kind: 'player', id: aliceId });
				expect(r.roll!.sides).toBe(20);
				expect(r.roll!.results).toHaveLength(1);
				expect(r.message).toBe(`Alice rolled ${r.roll!.results[0]}`);
				expect(r.roll!.source).toEqual({ kind: 'card', id: book.id });
			}

			// The result's "you may cast the copy" (any row of the table): no.
			await waitUntil(() => { s.answerAsks(); return /Do you want to play Lightning Bolt/.test(s.prompt(0)); }, "the Spellbook's offer to cast the copy", 30_000, s);
			s.cancel(0);
			await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, "alice's priority back after the Spellbook", 60_000, s);
			const tutor = s.zone(0, 'Hand').find((c) => c.name === 'Goblin Tutor')!;
			const second = s.sent.length;
			const pay = landPayer(s, 0);
			s.select(0, tutor.id);
			await waitUntil(() => { pay(); s.answerAsks(); return rolls(s, second).length >= 2; }, 'the d6 roll told to both seats', 30_000, s);
			const d6 = rolls(s, second);
			console.log(`[dice] d6: ${JSON.stringify(d6)}`);
			for (const r of d6) {
				expect(r.roll!.sides).toBe(6);
				expect(r.roll!.results[0]).toBeGreaterThanOrEqual(1);
				expect(r.roll!.results[0]).toBeLessThanOrEqual(6);
				expect(r.roll!.source).toEqual({ kind: 'card', id: tutor.id });
			}
		} finally {
			await s.stop();
		}
	}, 180_000);
});

/**
 * A coin flip reaches both seats as one `message` frame that carries the flip itself: who flipped, the
 * face it came up, whether a call was won, and the card it came from — what the board draws its coin
 * from. Forge tells a flip only as a word (`FlipCoinEffect.flipCoin`'s `notifyOfValue`: "heads", or
 * "win" for a called flip), so the bridge reads it where Forge still holds the ability, the same way it
 * reads a die roll (`PlayBridge.java`'s `SeatController.notifyOfValue`), and a called flip's face from
 * the call (`SeatController.chooseBinary`). Nothing here is about one card.
 *
 * Against the real jar, `scenarios/wd-coin.state`: alice casts Stitch in Time (one called flip), then
 * Mana Clash (both players flip, uncalled, until both come up heads on the same flip).
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=~/.cache/… \
 *   pnpm exec vitest run apps/server/src/play/coin-flip.jvm.test.ts
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, landPayer, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = (t: string): string => (available.ok ? t : `${t} — SKIPPED: ${available.reason}`);

interface Said {
	seat: number;
	message: string;
	flip?: { player: { kind: string; id: number }; outcome: 'heads' | 'tails' | null; won: boolean | null; source: { kind: string; id: number } | null };
}

/** Every `message` frame each seat was sent from `from` on that carries a flip. Seats only: the watchers' copy (`seat` -1) is the public gate's. */
function flips(s: Scenario, from: number): Said[] {
	return s.sent
		.slice(from)
		.filter((x) => x.seat >= 0 && x.envelope.frame.method === 'message' && 'flip' in x.envelope.frame)
		.map((x) => ({ seat: x.seat, ...(x.envelope.frame as unknown as Omit<Said, 'seat'>) }));
}

describe.skipIf(!available.ok)(title('a coin flip carries its coin, against real Forge'), () => {
	it('a called flip and uncalled flips: both seats are told each flip, its face, the call’s outcome and its source', async () => {
		const s = await startScenario(available.ok ? available.config : (undefined as never), {
			seed: 4242,
			decks: [deck('wc-a', ['20 Mountain']), deck('wc-b', ['20 Mountain'])],
			names: ['Alice', 'Bob'],
			scenario: scenarioText('wd-coin'),
		});
		try {
			await finishMulligan(s);
			await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1); }, "alice's main phase with the scripted board", 60_000, s);
			const alice = s.match.seats[0]?.playerId;
			const bob = s.match.seats[1]?.playerId;

			const stitch = s.zone(0, 'Hand').find((c) => c.name === 'Stitch in Time')!;
			const from = s.sent.length;
			const pay = landPayer(s, 0);
			s.select(0, stitch.id);
			await waitUntil(() => { pay(); s.answerAsks(); return /Call coin flip/.test(s.prompt(0)); }, 'alice is asked to call the coin', 30_000, s);
			s.ok(0); // heads
			await waitUntil(() => { s.answerAsks(); return flips(s, from).length >= 2; }, 'the called flip told to both seats', 30_000, s);
			const called = flips(s, from);
			console.log(`[coin] called: ${JSON.stringify(called)}`);
			expect(called.map((f) => f.seat).sort()).toEqual([0, 1]);
			for (const f of called) {
				expect(f.flip!.player).toEqual({ kind: 'player', id: alice });
				expect(typeof f.flip!.won).toBe('boolean');
				// Alice called heads: every seat knows the face it came up.
				expect(f.flip!.outcome).toBe(f.flip!.won ? 'heads' : 'tails');
				expect(f.flip!.source).toEqual({ kind: 'card', id: stitch.id });
			}
			expect(new Set(called.map((f) => JSON.stringify(f.flip))).size, 'both seats see the same flip').toBe(1);

			await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1) && s.zone(0, 'Hand').some((c) => c.name === 'Mana Clash'); }, "alice's priority back after Stitch in Time", 60_000, s);
			const clash = s.zone(0, 'Hand').find((c) => c.name === 'Mana Clash')!;
			const second = s.sent.length;
			const payClash = landPayer(s, 0);
			s.select(0, clash.id);
			await waitUntil(() => { payClash(); s.answerAsks(); return flips(s, second).filter((f) => f.seat === 0).length >= 2; }, 'the first uncalled flips', 60_000, s);
			await waitUntil(() => { s.answerAsks(); return inOwnMain(s, 0, 1) || s.zone(0, 'Graveyard').some((c) => c.name === 'Mana Clash'); }, 'Mana Clash to finish', 60_000, s);
			const uncalled = flips(s, second).filter((f) => f.seat === 0);
			console.log(`[coin] uncalled (alice's screen): ${JSON.stringify(uncalled.map((f) => f.flip))}`);
			for (const f of uncalled) {
				expect(f.flip!.won).toBeNull();
				expect(['heads', 'tails']).toContain(f.flip!.outcome);
				expect(f.flip!.source).toEqual({ kind: 'card', id: clash.id });
			}
			expect(new Set(uncalled.map((f) => f.flip!.player.id))).toEqual(new Set([alice, bob]));
		} finally {
			await s.stop();
		}
	}, 240_000);
});

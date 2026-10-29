/**
 * A game that has run eight hours is called a draw, against real Forge.
 *
 * The operator, 2026-10-29: *"games that are in-progress for >8hrs should be forced into a draw and
 * players sent back to the lobby"* — "every game", whatever room it is in. The room sweep is the one
 * clock (`boot.ts`'s `sweepRooms`): it asks a match whose own recorded start is eight hours old for a
 * draw, and the bridge ends Forge's game the way a "the game is a draw" card does (`GameDrawEffect`):
 * every player's `intentionalDraw()`, then `Game.setGameOver(GameEndReason.Draw)` — taken through the
 * game's `ActGate` like a concede, so it never runs beside the game thread's own moves.
 *
 * Here the sweep runs with its clock eight hours past the match's start: at the keep-or-mulligan
 * question, in a main phase between two people, and against the AI. Each time Forge's game ends with
 * nobody winning, both seats are told the game is over and why, and the match's result is a draw.
 * `[forced-draw]` is the evidence line.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/draw \
 *   pnpm exec vitest run apps/server/src/play/forced-draw.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { sweepRooms } from '../boot.js';
import { GAME_DRAWN_AFTER_MS, openLobby } from '../room/lobby.js';
import { available, deck, finishMulligan, inOwnMain, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'a game eight hours old is called a draw, against real Forge'
	: `a game eight hours old is called a draw, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Mountains', ['40 Mountain', '20 Raging Goblin']), deck('Forests', ['40 Forest', '20 Grizzly Bears'])];

const over = (s: Scenario): boolean => s.lines.some((l) => l.t === 'gameover');

/** The sweep, run as if eight hours and a moment had passed since the match began. */
async function sweepEightHoursOn(s: Scenario): Promise<Record<string, unknown>[]> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-forced-draw-'));
	try {
		const lobby = await openLobby({ dir });
		const logged: Record<string, unknown>[] = [];
		sweepRooms(lobby, (e) => void logged.push(e), { matches: [s.match], now: s.match.startedAt + GAME_DRAWN_AFTER_MS + 1 });
		return logged;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function expectDrawn(s: Scenario, when: string): Promise<void> {
	await waitUntil(() => over(s), 'Forge ends the game', 30_000, s);
	const gameover = s.lines.find((l) => l.t === 'gameover') as { winner?: unknown; losers?: number[]; lost?: { reason: string }[] } | undefined;
	const humans = s.match.seats.filter((seat) => !seat.ai).map((seat) => seat.seat);
	// What the server told each seat (`Match.finishSeat`), not Forge's own `finishGame` call.
	const told = humans.map((seat) => s.sent.findLast((x) => x.seat === seat && x.envelope.frame.method === 'finishGame')?.envelope.frame);
	const died = [...s.stderr().matchAll(/Exception[^\n]*draw[^\n]*/gi)].map((m) => m[0]);
	console.log(
		`[forced-draw] ${when}: gameover winner=${JSON.stringify(gameover?.winner)} losers=${JSON.stringify(gameover?.losers)}; outcome ${JSON.stringify(s.match.outcome())}; seats told ${JSON.stringify(told)}; errors ${died.length}`,
	);
	expect(gameover?.winner, 'nobody won').toBeNull();
	// Forge's draw: every player in the game drew (`PlayerOutcome.draw()`), which Forge counts as not winning.
	expect([...(gameover?.losers ?? [])].sort(), 'both players drew').toEqual([0, 1]);
	expect(gameover?.lost?.map((l) => l.reason), 'by an intentional draw').toEqual(['IntentionalDraw', 'IntentionalDraw']);
	expect(s.match.outcome(), "the match's result is a draw").toEqual({ kind: 'drawn' });
	for (const [i, frame] of told.entries()) expect(frame, `seat ${humans[i]} is told the game is over, and why`).toMatchObject({ method: 'finishGame', endedBy: 'time-limit' });
	expect(died, 'the draw ran without an error').toEqual([]);
}

describe.skipIf(!available.ok)(title, () => {
	it('at the keep-or-mulligan question', async () => {
		if (!available.ok) return;
		const s = await startScenario(available.config, { seed: 82, decks: DECKS });
		try {
			await waitUntil(() => [0, 1].some((seat) => /keep your hand|play or draw/i.test(s.prompt(seat))), 'the opening question', 90_000, s);
			const logged = await sweepEightHoursOn(s);
			expect(logged).toContainEqual(expect.objectContaining({ event: 'games-drawn', matches: [s.match.id] }));
			await expectDrawn(s, 'opening');
		} finally {
			await s.stop();
		}
	}, 180_000);

	it('in a main phase, between two people', async () => {
		if (!available.ok) return;
		const s = await startScenario(available.config, { seed: 83, decks: DECKS });
		try {
			await finishMulligan(s);
			await waitUntil(() => [0, 1].some((seat) => inOwnMain(s, seat, 1)), 'the first main phase', 60_000, s);
			await sweepEightHoursOn(s);
			await expectDrawn(s, 'main phase');
		} finally {
			await s.stop();
		}
	}, 180_000);

	it('against the AI', async () => {
		if (!available.ok) return;
		const s = await startScenario(available.config, { seed: 84, decks: DECKS, aiOpponent: true });
		try {
			await waitUntil(
				() => {
					s.keepHands(/keep your hand|play or draw/i);
					s.answerAsks();
					return s.turn(0) !== null;
				},
				'the game under way',
				90_000,
				s,
			);
			await sweepEightHoursOn(s);
			await expectDrawn(s, 'vs AI');
		} finally {
			await s.stop();
		}
	}, 180_000);
});

/**
 * A concede that reaches Forge while its game thread is moving cards ends the game, against real Forge.
 *
 * Full run 38381150766 (`e2e/w69-rematch.spec.ts`, m-38274baf550b): bob conceded during the opening
 * deal. Forge's server ran the concede on a background thread, and its game-over check walks every
 * card in the game while the game thread was moving those cards: `InvocationTargetException in
 * concede: java.util.ConcurrentModificationException` (`Game.forEachCardInGame` ←
 * `Player.hasWon` ← `GameAction.checkGameOverCondition` ← `PlayerControllerHuman.concede`). Bob was
 * conceded in a game that was not over, and alice's screen kept the board until she answered a
 * question she never answered.
 *
 * A concede is a player's act like a click: Forge takes it in its turn, once the game waits on an
 * input (`ActGate`), so its walk never meets the game thread's moves.
 *
 * Whether ONE concede lands inside the deal is a matter of milliseconds: sent one at a time through
 * the deal, a concede met the game thread mid-move in none of three matches on a pin that runs it
 * at once (forge.yml run 38408864577). So this sends them in bursts, several per turn of the event
 * loop, from the deal's first frame (the first `applyDelta`, Forge's batch of shuffles and zone
 * moves) until the game is over. Each walk then meets the game thread's moves and the other
 * concedes' own game-over work (`onPlayerLost` takes the loser out of the player list another walk
 * is reading): on such a pin every concede died and the game never ended (run 38408357527). Both
 * are the same fault — a concede run beside whatever else is running on the game — and taking it as
 * an act fixes both: one at a time, and only while the game waits on an input.
 * `[concede-deal]` is the evidence line.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/concede \
 *   pnpm exec vitest run apps/server/src/play/concede-deal.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ClientFrameSchema } from '@hadoku/forge-wire';
import { available, deck, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'a concede during the opening deal ends the game, against real Forge'
	: `a concede during the opening deal ends the game, against real Forge — SKIPPED: ${available.reason}`;

/** Big libraries, so the deal's shuffles and moves last long enough to be met. */
const DECKS: [string, string] = [deck('Mountains', ['200 Mountain']), deck('Islands', ['200 Island'])];
/** Concedes per turn of the event loop, for at most `FOR_MS`: across the deal, the coin toss and the first input. */
const BURST = 4;
const FOR_MS = 3_000;
/** And at most this many in all: every one is a thread on Forge's side. */
const MOST = 400;

/** This match's bridge stderr (`<workDir>/…/<match id>/bridge.stderr.txt`). */
function stderrOf(s: Scenario): string {
	let text = '';
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (name === 'bridge.stderr.txt' && path.includes(s.match.id)) text += readFileSync(path, 'utf8');
		}
	};
	walk(s.workDir);
	return text;
}

const over = (s: Scenario): boolean => s.lines.some((l) => l.t === 'gameover');

describe.skipIf(!available.ok)(title, () => {
	// Three matches, each its own deal: one dispatch is three chances to meet the game thread.
	it.each([69, 70, 71])('seed %i: concedes sent through the deal end the game with seat 1 the loser, and none dies mid-walk', async (seed) => {
		if (!available.ok) return;
		const s = await startScenario(available.config, { seed, decks: DECKS });
		try {
			const dealing = (): boolean => s.lines.some((l) => l.t === 'frame' && (l as { frame?: { method?: unknown } }).frame?.method === 'applyDelta');
			await waitUntil(dealing, "the deal's first frame", 60_000, s);
			const concede = ClientFrameSchema.parse({ kind: 'act', method: 'concede' });
			const started = performance.now();
			let sent = 0;
			while (!over(s) && sent < MOST && performance.now() - started < FOR_MS) {
				for (let i = 0; i < BURST; i++) s.match.fromClient(1, concede);
				sent += BURST;
				await new Promise((r) => setImmediate(r));
			}
			await waitUntil(() => over(s), 'Forge ends the game', 30_000, s).catch(() => undefined);
			const gameover = s.lines.find((l) => l.t === 'gameover') as { losers?: number[] } | undefined;
			const stderr = stderrOf(s);
			const died = [...stderr.matchAll(/InvocationTargetException in concede[^\n]*/g)].map((m) => m[0]);
			const received = [...stderr.matchAll(/Received: GuiGameEvent \d+: concede /g)].length;
			console.log(
				`[concede-deal] seed ${seed}: ${sent} concedes sent over ${Math.round(performance.now() - started)} ms, ${received} received by Forge; ${died.length} died mid-walk${died.length > 0 ? ` (${died[0]})` : ''}; game ${gameover === undefined ? 'NOT over' : `over, losers ${JSON.stringify(gameover.losers)}`}`,
			);
			expect(died, 'no concede died walking cards something else on the game was moving').toEqual([]);
			expect(gameover?.losers, 'the game is over and seat 1 lost it').toEqual([1]);
		} finally {
			await s.stop();
		}
	}, 180_000);
});

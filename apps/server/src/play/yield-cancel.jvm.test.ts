/**
 * Cancel on the "Yielding until end of turn" bar, pressed again and again, against real Forge.
 *
 * Monkey run 42340666519 (m-11b01c334960): a concede that never ended its game. It was never
 * applied at all: it sat behind 146 of the seat's own Cancel presses. While a seat yields, Forge
 * re-shows "Yielding until end of turn" with a live Cancel at every phase, with no input of the
 * seat's waiting (its input is `InputLockUI`, whose Cancel is the yield's cancel). Forge's ActGate
 * held each press until the seat had a real input, up to five seconds apiece, so the presses
 * queued, and every later act, the concede among them, waited behind them.
 *
 * A Cancel on that bar cancels the yield then and there, as `InputLockUI` itself answers it: the
 * seat is back on its windows at once, no bar re-arms, nothing queues, and a concede after it ends
 * the game within one of ActGate's holds.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/yield \
 *   pnpm exec vitest run apps/server/src/play/yield-cancel.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';
import { ClientFrameSchema } from '@hadoku/forge-wire';

import { available, deck, scenarioText, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? 'Cancel on the yield bar, pressed again and again, against real Forge'
	: `Cancel on the yield bar, pressed again and again, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Mountains', ['40 Mountain']), deck('Swamps', ['40 Swamp'])];
const YIELDING = /^Yielding until end of turn/;

describe.skipIf(!available.ok)(title, () => {
	it(
		'the first Cancel ends the yield, no press queues, and a concede after them ends the game within one hold',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 41, decks: DECKS, scenario: scenarioText('yield-flood'), skipOpening: true, aiOpponent: true });
			try {
				expect(s.match.setFullControl(0, true)).toEqual({ ok: true });
				// The first window of the AI's turn that reaches seat 0: End Turn on it.
				await waitUntil(
					() => s.prompt(0).startsWith('Priority: ') && s.buttons(0)?.enable2 === true && s.buttons(0)?.label2 === 'End Turn',
					"a window of the AI's turn with End Turn live",
					60_000,
					s,
				);
				s.cancel(0);
				await waitUntil(() => YIELDING.test(s.prompt(0)) && s.buttons(0)?.enable2 === true, 'the yield bar', 30_000, s);

				// Cancel on every live yield bar, as a player hammering the button does, for six seconds.
				const bars = () => s.sent.filter((x) => x.seat === 0 && x.envelope.frame.method === 'showPromptMessage' && YIELDING.test((x.envelope.frame as { message: string }).message)).length;
				let pressedAt = -1;
				let presses = 0;
				const until = Date.now() + 6_000;
				while (Date.now() < until) {
					const at = bars();
					if (at > pressedAt && YIELDING.test(s.prompt(0)) && s.buttons(0)?.enable2 === true) {
						pressedAt = at;
						presses += 1;
						s.cancel(0);
					}
					await new Promise((r) => setTimeout(r, 50));
				}
				console.log(`[yield] ${presses} Cancel press(es) on ${bars()} yield bar(s)`);
				// The first press ended the yield, so no bar re-armed for another.
				expect(presses).toBe(1);

				const conceded = Date.now();
				expect(s.match.fromClient(0, ClientFrameSchema.parse({ kind: 'act', method: 'concede' }))).toEqual({ ok: true });
				await waitUntil(() => s.lines.some((l) => l.t === 'gameover'), 'the game to end after the concede', 20_000, s);
				const tookMs = Date.now() - conceded;
				console.log(`[yield] the concede ended the game in ${tookMs} ms`);
				// Within one of ActGate's holds (five seconds), never behind a queue of them.
				expect(tookMs).toBeLessThan(6_000);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});

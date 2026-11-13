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
 * The bar is composed on the seat's own thread from the live yield, so one can go up while a press is
 * on its way, and be pressed again after that press ended the yield. Scheduled run 43351776678: that
 * second press reached Forge, ActGate held it for the seat's next input, and it answered that
 * priority window as End Turn, yielding again (4 presses on 4 bars). The bridge drops it instead.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/yield \
 *   pnpm exec vitest run games/magic/server/src/play/yield-cancel.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';
import { ClientActionSchema, ClientFrameSchema } from '@hadoku/forge-wire';

import { available, deck, dumpOnTimeout, scenarioText, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? 'Cancel on the yield bar, pressed again and again, against real Forge'
	: `Cancel on the yield bar, pressed again and again, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Mountains', ['40 Mountain']), deck('Swamps', ['40 Swamp'])];
const YIELDING = /^Yielding until end of turn/;
const CANCEL = ClientActionSchema.parse({ kind: 'act', method: 'selectButtonCancel' });

type Started = Awaited<ReturnType<typeof startScenario>>;

/** The AI's turn, End Turn pressed on its first window that reaches seat 0, and the yield's bar up. */
async function yielding(): Promise<Started> {
	if (!available.ok) throw new Error(available.reason);
	const s = await startScenario(available.config, { seed: 41, decks: DECKS, scenario: scenarioText('yield-flood'), skipOpening: true, aiOpponent: true });
	expect(s.match.setFullControl(0, true)).toEqual({ ok: true });
	await waitUntil(
		() => s.prompt(0).startsWith('Priority: ') && s.buttons(0)?.enable2 === true && s.buttons(0)?.label2 === 'End Turn',
		"a window of the AI's turn with End Turn live",
		60_000,
		s,
	);
	s.cancel(0);
	await waitUntil(() => YIELDING.test(s.prompt(0)) && s.buttons(0)?.enable2 === true, 'the yield bar', 30_000, s);
	return s;
}

/** The Cancels the bridge kept from Forge because the yield they were pressed on had already ended. */
const droppedCancels = (s: Started) => s.lines.filter((l) => l.t === 'dropped' && (l as { seat: number }).seat === 0 && (l as { method: string }).method === 'selectButtonCancel').length;

describe.skipIf(!available.ok)(title, () => {
	it(
		'the first Cancel ends the yield, no press queues, and a concede after them ends the game within one hold',
		async () => {
			const s = await yielding();
			try {
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
				const dropped = droppedCancels(s);
				console.log(`[yield] ${presses} Cancel press(es) on ${bars()} yield bar(s), ${dropped} dropped`);
				// The first press ended the yield. A bar composed while it was on its way can take a second press, which
				// the bridge drops; none re-armed the yield, so none reached Forge. A red keeps its evidence: the match's
				// run dir, stderr included, is reaped by stop().
				expect(presses - 1, presses - 1 === dropped ? undefined : dumpOnTimeout(s, 'yield-cancel presses')).toBe(dropped);

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

	it(
		'a second Cancel on the yield bar, reaching the bridge after the first ended the yield, is dropped and never ends the next window',
		async () => {
			const s = await yielding();
			try {
				const mark = s.sent.length;
				// Both presses as the bridge receives them, back to back on the seat's thread: the second meets the bar the
				// first pressed, with the yield already over (Node's own gate on a re-pressed bar is the other test's).
				s.command({ t: 'act', seat: 0, frame: CANCEL });
				s.command({ t: 'act', seat: 0, frame: CANCEL });
				await waitUntil(() => droppedCancels(s) === 1, 'the second Cancel dropped', 20_000, s);
				// The yield over, the seat's next window reaches it and stays: nothing answered it as End Turn.
				await waitUntil(
					() => s.prompt(0).startsWith('Priority: ') && s.buttons(0)?.label2 === 'End Turn' && s.buttons(0)?.enable2 === true,
					"the seat's next window",
					30_000,
					s,
				);
				const window = s.sent.findLastIndex((x) => x.seat === 0 && x.envelope.frame.method === 'showPromptMessage');
				expect(window).toBeGreaterThanOrEqual(mark);
				expect(YIELDING.test(s.prompt(0))).toBe(false);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});

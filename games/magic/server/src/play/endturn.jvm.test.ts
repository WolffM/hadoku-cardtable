/**
 * Wave 32, Q5 — the crawl after End Turn, against a REAL Forge match.
 *
 * *"skipped phases should not crawl"* (the third play test, Q5), scoped by the
 * operator to *"only when 'end turn' is clicked"*. The crawl is Forge's own sleep:
 * `PlayerControllerHuman.chooseSpellAbilityToPlay` waits `phasesDelay` (exactly
 * 200 ms, `FControlGamePlayback.java:49`) at every phase an auto-passing player
 * is not set up to skip, unless `YIELD_SKIP_PHASE_DELAY` is true
 * (`PlayerControllerHuman.java:1685-1691`). The bridge
 * (`PlayBridge.java`, `SeatGui.setPhaseDelayOff`) turns that preference on with
 * the End Turn click and off again when the yield is over.
 *
 * **No clock decides it.** Forge's sleep decision reads one value, the pref, on the
 * game thread at each phase. The bridge's `SeatController` reads the same value at the
 * same call and emits a `pace-read` line each time it changes, so the suite asserts what
 * Forge saw: the pref turned true at the click's own phase (or the yield's first) and did
 * not turn false again until a later turn, so it was true at every phase of the yield.
 * Every millisecond bound this suite carried before reddened on a loaded host with the
 * exemption armed: 50 ms (ledger Y26), 150 ms (run 40577661708), every gap under 200
 * (runs 44715926901, 44828404697), fewer than half at 200 (run 44875821038), and some gap
 * under 200, which a claw at load 21 crossed at [323,278,264,230] (run 44884684361, #86).
 * The gaps are still logged, as information. A sleep between the two sends was never an
 * acceptable fix (settled, do not reopen).
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/S \
 *   pnpm exec vitest run games/magic/server/src/play/endturn.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { DELTA_TYPE } from '@hadoku/forge-wire';

import { available, deck, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'End Turn passes phases without the pacing sleep, against real Forge'
	: `End Turn passes phases without the pacing sleep, against real Forge — SKIPPED: ${available.reason}`;

/** Every game-object `Phase` change seat `seat` was sent, in order, with its arrival time. */
function phaseChanges(s: Scenario, seat: number): { phase: string; t: number }[] {
	const out: { phase: string; t: number }[] = [];
	for (const { seat: to, envelope, t } of s.sent) {
		if (to !== seat) continue;
		const f = envelope.frame as unknown as { method?: string; payload?: { packet?: { objectDeltas?: Record<string, Record<string, unknown>> } } };
		if (f.method !== 'applyDelta') continue;
		for (const obj of Object.values(f.payload?.packet?.objectDeltas ?? {})) {
			const phase = obj.Phase as { v?: string } | undefined;
			if (obj._type === DELTA_TYPE.game && phase?.v !== undefined) out.push({ phase: phase.v, t });
		}
	}
	return out;
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'an End Turn click passes its phases with no 200 ms pacing sleep between them, and the pacing is back afterwards',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, {
				seed: 32,
				decks: [deck('E A', ['40 Mountain']), deck('E B', ['40 Mountain'])],
			});
			try {
				// Seat X is whoever holds priority in its own first main phase.
				let x = -1;
				await waitUntil(() => {
					s.keepHands();
					s.answerAsks();
					for (const seat of [0, 1]) {
						const turn = s.turn(seat);
						const b = s.buttons(seat);
						if (
							turn !== null &&
							turn.owner === s.names[seat] &&
							s.prompt(seat).startsWith(`Priority: ${s.names[seat]}`) &&
							/^Phase: Main phase, precombat$/m.test(s.prompt(seat)) &&
							b?.enable2 === true &&
							b.label2 === 'End Turn'
						) {
							x = seat;
							return true;
						}
					}
					return false;
				}, 'a seat in its own first main phase with End Turn live', 90_000);

				const y = 1 - x;
				const clickAt = performance.now();
				s.cancel(x);

				// The other seat's first main phase is the end of the yield.
				await waitUntil(() => {
					s.answerAsks();
					const turn = s.turn(y);
					return turn !== null && turn.n === 2 && /^Phase: Main phase, precombat$/m.test(s.prompt(y)) && s.prompt(y).startsWith(`Priority: ${s.names[y]}`);
				}, "the other seat's turn to reach its main phase", 60_000);

				const changes = phaseChanges(s, x).filter((c) => c.t >= clickAt);
				// The yield's own phases: from the click to the end step (cleanup never
				// passes priority, so it is not a window and not a delta).
				const upToEnd = changes.slice(0, changes.findIndex((c) => c.phase === 'END_OF_TURN') + 1);
				const gaps = upToEnd.slice(1).map((c, i) => c.t - (upToEnd[i]?.t ?? c.t));
				console.log(`[q5] phases after End Turn: ${JSON.stringify(upToEnd.map((c) => c.phase))}`);
				console.log(`[q5] gaps ms: ${JSON.stringify(gaps.map((g) => Math.round(g)))}`);
				const pace = s.lines.filter((l) => l.t === 'pace');
				console.log(`[q5] pace lines: ${JSON.stringify(pace)}`);

				expect(upToEnd.length, 'the End Turn run reached the end step through several phases').toBeGreaterThan(3);

				// What Forge's game thread read, each time it changed: true from the click's phase
				// (MAIN1, or the yield's first if the click's own window had passed), and not false
				// again before a later turn, so it held at every phase of the yield.
				const reads = s.lines.filter((l) => l.t === 'pace-read' && (l as unknown as { seat: number }).seat === x) as unknown as { skipPhaseDelay: boolean; turn: number; phase: string }[];
				console.log(`[q5] pace reads: ${JSON.stringify(reads)}`);
				const [on, off] = reads;
				expect(reads.map((r) => r.skipPhaseDelay), "the game thread's reads of the pref").toEqual([true, false]);
				expect(['MAIN1', upToEnd[0]?.phase], 'the phase the game thread first read it true at').toContain(on?.phase);
				expect(off?.turn, 'the turn the game thread first read it false again at').toBeGreaterThan(on?.turn ?? Infinity);

				// The exemption was armed by the click and lifted by the next real window.
				expect(pace.map((l) => (l as unknown as { skipPhaseDelay: boolean }).skipPhaseDelay)).toEqual([true, false]);
				expect(pace.every((l) => (l as unknown as { seat: number }).seat === x)).toBe(true);
			} finally {
				await s.stop();
			}
		},
		240_000,
	);
});

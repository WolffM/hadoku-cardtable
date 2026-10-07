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
 * **The 150 ms bound below (ledger Y26, wave 53 §E).** This used to be 50 ms,
 * tight enough that general host scheduling noise — this suite runs on
 * `hokon`, which is CI's runner, production, AND shares a desktop session —
 * could trip it on its own, with no pacing bug involved. Measured 2026-10-06,
 * 46 runs total under `taskset -c 0` on this same shared host while it was
 * also running an unrelated, CPU-heavy interactive session: the worst ANY
 * phase gap ever reached, fixed or reverted, PASSING or FAILING, was 98 ms —
 * never once near 200 ms. 150 ms sits with margin on both sides of that split:
 * 52 ms above the measured noise ceiling, and 50 ms below the delay a lost
 * race (or a reintroduced one) actually produces — which is deterministic,
 * not marginal: Forge either skips the sleep entirely or takes the full
 * 200 ms, so a real regression fails this bound by a wide margin, not a
 * narrow one. A sleep between the two sends was never an acceptable fix
 * (settled, do not reopen); this is a test-tolerance change, not that.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=/tmp/claude-1000/S \
 *   pnpm exec vitest run apps/server/src/play/endturn.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { TYPE } from './visibility.js';
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
			if (obj._type === TYPE.game && phase?.v !== undefined) out.push({ phase: phase.v, t });
		}
	}
	return out;
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'an End Turn click passes its phases under 150 ms apart (well short of the 200 ms pacing sleep), and the pacing is back afterwards',
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
				for (const g of gaps) expect(g, `gaps: ${JSON.stringify(gaps)}`).toBeLessThan(150);

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

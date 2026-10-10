/**
 * Two clicks that reach Forge at once must not run side by side, against real
 * Forge.
 *
 * Main's run 38013980995 (forge-jvm): a driver sent two `selectCard`s for the same
 * Raging Goblin within 1 ms. Forge's server ran each on its own background thread
 * (`GameProtocolHandler.channelRead` → `FThreads.invokeInBackgroundThread`), so two
 * `InputPassPriority.onCardSelected` ran side by side on one game; a view's property
 * map was left unserializable, and every later `getAbilityToPlay` failed to encode
 * (`RemoteClient: Network encode error … ArrayIndexOutOfBoundsException: Index 214
 * out of bounds for length 214`, 3378 times) — the Goblin never reached the stack.
 * A browser can do the same with two quick clicks.
 *
 * OPEN BUG — no fix in the fork yet, so this test is `it.fails`. Two attempts were
 * measured and withdrawn:
 *   - 7ddd4daa ran a connection's acts in order on one thread; a payment inside a
 *     payment (a Signet's own {1}) then waited for an OK queued behind the thread it
 *     held, and the seat froze (`e2e/w68-pay`).
 *   - 373191af turned away a click that arrived while another was still being
 *     taken; that also dropped a real click — a select sent the moment the previous
 *     click's ability question was answered (`combat-drag.jvm`: seat 0's Memnite,
 *     sent right after its land play, never cast). Correctness first.
 * The fix this needs takes every click and never runs two at once on one game; when
 * it lands, `it.fails` comes off.
 *
 * `scenarios/w52-s-signet.state`: seat 0 holds Raging Goblin and three Mountains.
 * Once Forge offers the Goblin, eight selects for it go out in one burst, and the
 * test answers nothing for two seconds. The first select Forge takes asks which
 * ability to play and waits for that answer, so it runs through the whole hold.
 * Forge's own log line for each call (`GameProtocolHandler`: "Protocol selectCard
 * processed in N ms (queued M ms)", written past 50 ms) says which others ran
 * through it beside it: side by side, they are PROCESSED through it. The corruption itself is a rare interleaving of
 * the side-by-side runs, so that count is what is asserted; then the cast must
 * reach the stack and the bridge's stderr carry no encode error.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/burst \
 *   pnpm exec vitest run apps/server/src/play/concurrent-select.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, idsOf, landPayer, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';
import { TYPE, type WireObj } from './visibility.js';

const title = available.ok
	? 'a burst of clicks reaches Forge one at a time, against real Forge'
	: `a burst of clicks reaches Forge one at a time, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Mountains', ['40 Mountain']), deck('Islands', ['40 Island'])];
const BURST = 8;

function stackIds(s: Scenario): number[] {
	const game = [...s.state(0).values()].find((o: WireObj) => o._type === TYPE.game);
	return idsOf(game, 'Stack');
}

/** The cards Forge offers seat 0 now: its last `setWeaklySelectable`, none after a `clearWeaklySelectable`. */
function offered(s: Scenario): number[] {
	const last = [...s.lines]
		.reverse()
		.find((l) => l.t === 'frame' && l.seat === 0 && /^(set|clear)WeaklySelectable$/.test(String((l.frame as { method?: unknown } | null)?.method)));
	const frame = (last as { frame?: unknown } | undefined)?.frame as { method: string; cards?: { id: number }[] } | undefined;
	return frame?.method === 'setWeaklySelectable' ? (frame.cards ?? []).map((c) => c.id) : [];
}

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

const HOLD_MS = 2_000;

describe.skipIf(!available.ok)(title, () => {
	it.fails(`${BURST} selects for one card in one burst: the cast reaches the stack, nothing fails to encode`, async () => {
		if (!available.ok) return;
		const s = await startScenario(available.config, { seed: 68, decks: DECKS, scenario: scenarioText('w52-s-signet') });
		try {
			await finishMulligan(s);
			await waitUntil(() => { s.answerAsks(); return s.zone(0, 'Hand').some((c) => c.name === 'Raging Goblin'); }, "seat 0's scripted Raging Goblin", 20_000, s);
			const goblin = s.zone(0, 'Hand').find((c) => c.name === 'Raging Goblin')!;
			await waitUntil(() => { s.answerAsks(); return offered(s).includes(goblin.id); }, 'Forge offers seat 0 the Goblin', 20_000, s);
			const burstAt = s.lines.length;
			for (let i = 0; i < BURST; i++) s.select(0, goblin.id);
			await new Promise((r) => setTimeout(r, HOLD_MS));
			const asked = s.lines
				.slice(burstAt)
				.filter((l) => l.t === 'frame' && l.seat === 0 && (l as { frame?: { kind?: unknown; method?: unknown } }).frame?.kind === 'ask' && (l as { frame?: { method?: unknown } }).frame?.method === 'getAbilityToPlay').length;
			const payLand = landPayer(s, 0);
			let reached = true;
			await waitUntil(() => { s.answerAsks(); payLand(); return stackIds(s).length > 0; }, "the Goblin on the stack after the burst", 30_000, s).catch(() => {
				reached = false;
			});
			const stderr = stderrOf(s);
			const errors = stderr.split('Network encode error').length - 1;
			const calls = [...stderr.matchAll(/Protocol selectCard processed in (\d+) ms \(queued (\d+) ms\)/g)].map((m) => ({ ran: Number(m[1]), queued: Number(m[2]) }));
			const ranThroughHold = calls.filter((c) => c.ran >= HOLD_MS * 0.75).length;
			console.log(
				`[burst] ${BURST} selects in one burst: ${ranThroughHold} ran through the ${HOLD_MS} ms hold (${calls.map((c) => `ran ${c.ran}/queued ${c.queued}`).join(', ')}); ${asked} getAbilityToPlay asked during it; the Goblin ${reached ? 'reached the stack' : 'NEVER reached the stack'}; ${errors} encode errors`,
			);
			expect(ranThroughHold, 'only the first select ran through the hold, none beside it').toBe(1);
			expect(errors, 'no view failed to encode').toBe(0);
			expect(reached, 'the cast reached the stack').toBe(true);
		} finally {
			await s.stop();
		}
	}, 180_000);
});

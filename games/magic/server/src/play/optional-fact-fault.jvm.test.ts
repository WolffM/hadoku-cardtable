/**
 * A state frame goes when one of the bridge's optional facts beside it cannot be read, against a
 * real bridge JVM.
 *
 * `lifePaying` reads every player's controller off a seat's thread while the game thread moves it:
 * Forge's `Player.getController` checks `controlledBy` is not empty and then reads its last entry, and
 * the game thread emptied it in between (a mind-control effect ending). The throw left `applyDelta`
 * before the frame was sent and before Forge's own client applied the packet, so the seat lost the
 * whole update, its damage with it, and Forge resynced it with a view that carries no hits
 * (combat-perf, aa-ai-beats). Provoked with the test-only `-Dcardtable.fault=life-throw`: every read
 * of the life being paid throws.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   CI=1 node_modules/.bin/vitest run games/magic/server/src/play/optional-fact-fault.jvm.test.ts
 */

import { describe, expect, it } from 'vitest';

import { available, deck, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? 'a state frame goes without an optional fact that cannot be read, against a real bridge'
	: `a state frame goes without an optional fact that cannot be read, against a real bridge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Mountain']), deck('Any B', ['40 Mountain'])];

describe.skipIf(!available.ok)(title, () => {
	it('every state frame still reaches the seat, carrying the life it was last told', async () => {
		if (!available.ok) return;
		const config = { ...available.config, jvmOpts: [...available.config.jvmOpts, '-Dcardtable.fault=life-throw'] };
		const s = await startScenario(config, { seed: 20261126, decks: DECKS, aiOpponent: true, skipOpening: true });
		try {
			await waitUntil(() => s.buttons(0)?.enable1 === true, "seat 0's first live bar", 90_000, s);
			const states = s.sent
				.filter((x) => x.seat === 0 && (x.envelope.frame.method === 'setGameView' || x.envelope.frame.method === 'applyDelta'))
				.map((x) => (x.envelope.frame as { payload?: { lifePaying?: unknown } }).payload);
			expect(states.length, 'seat 0 was sent its state frames').toBeGreaterThan(0);
			expect(states.every((p) => Array.isArray(p?.lifePaying) && p.lifePaying.length === 0), 'each carrying the life last told: none').toBe(true);
			expect(s.state(0).size, "seat 0's board was drawn").toBeGreaterThan(0);
			expect(s.stderr()).toMatch(/lifePaying could not be read \(java\.lang\.IllegalStateException: cardtable\.fault=life-throw/);
		} finally {
			await s.stop();
		}
	}, 150_000);
});

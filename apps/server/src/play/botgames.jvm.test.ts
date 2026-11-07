/**
 * A real bot game: two decks, a real bridge JVM from the same pool every match runs in, Forge's AI on
 * both seats, headless (`PlayBridge.java`'s `playHeadless`), and the result parsed the way a pod's
 * round reads it (`botgames.ts`'s `runBotGame`).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { runBotGame } from './botgames.js';
import { jvmHostConfig, jvmHostFactory, type JvmHostFactory } from './host.js';

const available = jvmHostConfig({ ...process.env, CARDTABLE_PLAY_WARM_JVM: '0' });
const title = available.ok ? 'a bot game, played out by two Forge AIs on a real bridge' : `a bot game, played out by two Forge AIs on a real bridge — SKIPPED: ${available.reason}`;

/** Quick to play out: every creature attacks into an empty board. */
const GOBLINS = '[metadata]\nName=Goblins\n[main]\n17 Mountain\n23 Raging Goblin\n';
const BEARS = '[metadata]\nName=Bears\n[main]\n17 Forest\n23 Grizzly Bears\n';

describe.skipIf(!available.ok)(title, () => {
	let pool: JvmHostFactory | null = null;
	afterEach(() => {
		pool?.close();
		pool = null;
	});

	it('plays a best of 3 to a winner by seat, each game timed, then lets its match go', async () => {
		if (!available.ok) return;
		pool = jvmHostFactory(available.config, { warm: false });
		const logs: Record<string, unknown>[] = [];
		const result = await runBotGame(pool, 'b-jvm-1', { names: ['Knight', 'Wizard'], decks: [GOBLINS, BEARS], bestOf: 3 }, { timeoutMs: 8 * 60_000, log: (e) => logs.push(e) });
		console.log(`[jvm] bot game: ${JSON.stringify(result)}`);
		expect(result.ok, JSON.stringify(result)).toBe(true);
		if (!result.ok) return;
		const [a, b] = result.wins;
		// First to two, or three games played when one was drawn.
		expect(Math.max(a, b) === 2 || result.gameMs.length === 3).toBe(true);
		expect(result.gameMs.length).toBeGreaterThanOrEqual(a + b);
		expect(result.gameMs.length).toBeLessThanOrEqual(3);
		expect(result.gameMs.every((ms) => ms > 0)).toBe(true);
		expect(logs.map((e) => e.evt)).toContain('bot-game-ended');
	}, 9 * 60_000);
});

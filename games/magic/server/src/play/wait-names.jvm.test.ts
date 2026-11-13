/**
 * A seat's "Waiting for {name}…" is composed from its view between updates, never in the middle of one.
 *
 * The seat composes its wait itself, 250 ms after the host's notice (`PlayBridge.java`'s
 * `SeatGui.awaitNextInput`). Forge's client applies an update that brings new objects by clearing
 * every object it already holds and refilling it (`NetworkGuiGame.createObjectOnly`, then
 * `applyPropertyMap`), so for the length of that update the view has no players and nameless ones.
 * A wait composed off the seat's own thread could land in that gap and find nobody to name, and
 * Forge then says "Waiting for opponent..." (`AbstractGuiGame.findWaitingForPlayerName`). On a loaded
 * claw the coin toss's first full update did exactly that (play.spec.ts, run 43185575454: bob read
 * "Waiting for opponent..." with alice deciding).
 *
 * `-Dcardtable.fault=slow-view` holds each such update 400 ms on the seat's thread before it starts,
 * as a loaded host does. The wait must come after the update, naming the player who won the toss.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=~/.cache/… \
 *   pnpm exec vitest run games/magic/server/src/play/wait-names.jvm.test.ts
 */

import { describe, expect, it } from 'vitest';

import { available, deck, startScenario, waitUntil } from './scenario.js';

const title = (t: string): string => (available.ok ? t : `${t} — SKIPPED: ${available.reason}`);

describe.skipIf(!available.ok)(title('a seat’s wait reads its view between updates, against real Forge'), () => {
	it('the coin toss loser’s wait comes after its first full update and names the winner', async () => {
		if (!available.ok) throw new Error('unreachable');
		const config = { ...available.config, jvmOpts: [...available.config.jvmOpts, '-Dcardtable.fault=slow-view'] };
		const names: [string, string] = ['Alice', 'Bob'];
		const s = await startScenario(config, {
			seed: 658,
			decks: [deck('wn-a', ['60 Mountain']), deck('wn-b', ['60 Forest'])],
			names,
		});
		try {
			const winner = (): number => [0, 1].find((seat) => /won the coin toss/.test(s.prompt(seat))) ?? -1;
			await waitUntil(() => winner() >= 0 && /^Waiting for /.test(s.prompt(1 - winner())), 'the toss and the loser’s wait', 60_000, s);
			const loser = 1 - winner();
			const frames = s.sent.filter((x) => x.seat === loser).map((x) => x.envelope.frame as unknown as Record<string, unknown>);
			const firstFull = frames.findIndex((f) => {
				const packet = (f.payload as { packet?: { newObjects?: Record<string, unknown> } } | undefined)?.packet;
				return f.method === 'applyDelta' && Object.keys(packet?.newObjects ?? {}).length > 0;
			});
			const firstWait = frames.findIndex((f) => f.method === 'showPromptMessage' && /^Waiting for /.test(String(f.message)));
			console.log(`[wait-names] loser ${String(loser)}: first full update #${String(firstFull)}, first wait #${String(firstWait)} ${JSON.stringify(frames[firstWait]?.message)}`);
			expect(firstFull, 'the loser was sent a full update').toBeGreaterThanOrEqual(0);
			expect(firstWait, 'the wait is composed after the update the seat was applying, not in the middle of it').toBeGreaterThan(firstFull);
			expect(frames[firstWait]?.message).toBe(`Waiting for ${names[1 - loser]!}...`);
		} finally {
			await s.stop();
		}
	}, 120_000);
});

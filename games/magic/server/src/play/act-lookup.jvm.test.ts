/**
 * A seat's act finds every card the seat has been shown, however far behind its view is.
 *
 * Node reads a card off a seat's frame and can name it in an act at once: the server's own
 * deciders do (an auto-pay's land, an auto-target), in the tick the frame arrives. The bridge
 * sends a seat's update to Node before Forge's client applies it (`PlayBridge.java`'s
 * `SeatGui.applyDelta`: the frame, then `super.applyDelta`), and the client's tracker gets an
 * update's new objects only in that apply, on the seat's `ui` thread. An act looked its cards up in
 * that tracker on the thread that read it from Node (`bridge-stdin`), so a card the update had just
 * brought was not there yet: `no card N in seat 0's view`, and the act was rejected. The same
 * lookup also read Forge's tracker, a plain hash table, while the seat's thread wrote to it.
 *
 * `-Dcardtable.fault=slow-apply` holds each update that brings new objects 2 s on the seat's
 * thread after it went to Node and before the client applies it, as a loaded host does. Raise the
 * Alarm's two Soldier tokens are new objects; the test clicks one as soon as Node is told of it.
 * The act must reach Forge, not be rejected.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=~/.cache/… \
 *   pnpm exec vitest run games/magic/server/src/play/act-lookup.jvm.test.ts
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, inOwnMain, scenarioText, startScenario, waitUntil } from './scenario.js';

const title = (t: string): string => (available.ok ? t : `${t} — SKIPPED: ${available.reason}`);

describe.skipIf(!available.ok)(title('a seat’s act reads its view on the seat’s own thread, against real Forge'), () => {
	it('a click on a token the seat was just shown waits for the seat to hold it, and is not rejected', async () => {
		if (!available.ok) throw new Error('unreachable');
		const config = { ...available.config, jvmOpts: [...available.config.jvmOpts, '-Dcardtable.fault=slow-apply'] };
		const s = await startScenario(config, {
			seed: 107,
			decks: [deck('al-a', ['40 Plains']), deck('al-b', ['40 Plains'])],
			scenario: scenarioText('fs-token-slot'),
		});
		try {
			await finishMulligan(s);
			await waitUntil(() => {
				s.answerAsks();
				return inOwnMain(s, 0, 1);
			}, 'seat 0’s first priority window', 90_000, s);
			const before = new Set(s.zone(0, 'Battlefield').map((c) => c.id));
			const raise = s.zone(0, 'Hand').find((c) => c.name === 'Raise the Alarm');
			if (raise === undefined) throw new Error('no Raise the Alarm in seat 0’s hand');
			s.select(0, raise.id);
			await waitUntil(() => {
				s.answerAsks();
				return s.zone(0, 'Battlefield').some((c) => !before.has(c.id));
			}, 'the Soldier tokens on seat 0’s battlefield', 30_000, s);
			const token = s.zone(0, 'Battlefield').find((c) => !before.has(c.id));
			if (token === undefined) throw new Error('unreachable: the wait found one');
			const from = s.lines.length;
			const clicks = (): number => (s.stderr().match(/Client sent GuiGameEvent \d+: selectCard /g) ?? []).length;
			const clicked = clicks();
			s.command({ t: 'act', seat: 0, frame: { kind: 'act', method: 'selectCard', card: { kind: 'card', id: token.id }, otherCardViewsToSelect: [], triggerEvent: null } });
			// Either the bridge refuses it, or the seat's client sends it to Forge (its own `Client sent` line).
			await waitUntil(() => s.lines.slice(from).some((l) => l.t === 'rejected') || clicks() > clicked, 'the click to be refused or sent to Forge', 30_000, s);
			const rejected = s.lines.slice(from).filter((l) => l.t === 'rejected').map((l) => (l as { message: string }).message);
			console.log(`[act-lookup] token ${String(token.id)} (${token.name}): rejected ${JSON.stringify(rejected)}`);
			expect(rejected, 'the act found the token the seat was shown').toEqual([]);
		} finally {
			await s.stop();
		}
	}, 180_000);
});

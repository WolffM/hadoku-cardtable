/**
 * The offer scan's controller swap, against real Forge: the AI must never make a play for a seat.
 *
 * yield.jvm.test.ts, run 42403314200: bob's second Bolt went to his graveyard and alice's life did not
 * move. Forge shows an input's offer on the event thread, later, while the game thread waits on the
 * input; the bridge's cost scan (`PlayBridge.java`'s `SeatController.heldBackByCost`) swaps the seat's
 * player's controller for an AI's while it prices the hand. An act that finished the input during
 * the scan let the game thread ask that player for its next decision, and the AI answered: alice's
 * Counterspell, cast for her. `SeatController.scanLock` makes every act wait out a scan in progress.
 *
 * Planted race: `-Dcardtable.scanDelayMs` holds the swap long, as a loaded host's slow scan does.
 * `scan-swap.state` gives alice Cancel she cannot pay, so every window of hers is scanned under the
 * swap; bob casts two Bolts at her back to back. Without the lock, the second is countered by the AI
 * (an `impersonated` line, Counterspell in alice's graveyard); with it, both hit.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=$HOME/.cache/cardtable-play-work/scan \
 *   pnpm exec vitest run apps/server/src/play/scan-swap.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';
import { deltaKey, DELTA_TYPE } from '@hadoku/forge-wire';

import { available, deck, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'the offer scan never lets the AI play for a seat, against real Forge'
	: `the offer scan never lets the AI play for a seat, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('S A', ['40 Island']), deck('S B', ['40 Mountain'])];
const ALICE = 0;
const BOB = 1;
const SCAN_DELAY_MS = 6_000;

function lifeOf(s: Scenario, seat: number): number {
	const player = s.state(seat).get(deltaKey(DELTA_TYPE.player, s.match.seats[seat]?.playerId ?? -1));
	return ((player?.Life as { v?: number } | undefined)?.v) ?? -1;
}

const bolts = (s: Scenario): number => s.zone(BOB, 'Graveyard').filter((c) => c.name === 'Lightning Bolt').length;

/** Bob casts a Bolt at alice; alice lets every window of hers through at once; until the Bolt is off the stack. */
async function boltAlice(s: Scenario, n: number): Promise<void> {
	const bolt = s.zone(BOB, 'Hand').find((c) => c.name === 'Lightning Bolt');
	if (bolt === undefined) throw new Error('no Lightning Bolt in bob’s hand');
	s.select(BOB, bolt.id);
	const aliceId = s.match.seats[ALICE]?.playerId as number;
	let targeted = false;
	let pressed = '';
	await waitUntil(
		() => {
			s.answerAsks();
			if (!targeted && /target/i.test(s.prompt(BOB))) {
				targeted = true;
				s.match.fromClient(BOB, { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: aliceId }, triggerEvent: null } as never);
			}
			const msg = s.prompt(ALICE);
			if (pressed !== msg && /^Priority: alice/.test(msg) && s.buttons(ALICE)?.enable1 === true) {
				pressed = msg;
				s.ok(ALICE);
			}
			const gone = s.zone(BOB, 'Graveyard').filter((c) => c.name === 'Lightning Bolt').length >= n;
			return gone && /^Stack: Empty$/m.test(s.prompt(BOB)) && s.buttons(BOB)?.enable1 === true;
		},
		`bob's Bolt #${n} off the stack`,
		60_000,
		s,
	);
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'two Bolts at alice while her offer scan holds a swapped controller: both hit, and nothing is cast for her',
		async () => {
			if (!available.ok) return;
			const config = { ...available.config, jvmOpts: [...available.config.jvmOpts, `-Dcardtable.scanDelayMs=${SCAN_DELAY_MS}`] };
			const s = await startScenario(config, { seed: 71, decks: DECKS, names: ['alice', 'bob'], scenario: scenarioText('scan-swap'), skipOpening: true });
			try {
				await waitUntil(() => /^Priority: bob/.test(s.prompt(BOB)) && s.buttons(BOB)?.enable1 === true, 'bob holds priority in his Main 1', 60_000, s);
				const before = lifeOf(s, ALICE);
				await boltAlice(s, 1);
				await boltAlice(s, 2);
				const acted = s.lines.filter((l) => l.t === 'impersonated');
				expect(acted, 'the AI made no play for a seat').toEqual([]);
				expect(s.zone(ALICE, 'Graveyard').map((c) => c.name), 'alice cast nothing').toEqual([]);
				expect(bolts(s), 'both Bolts resolved').toBe(2);
				expect(lifeOf(s, ALICE), 'both Bolts hit alice').toBe(before - 6);
			} finally {
				await s.stop();
			}
		},
		180_000,
	);
});

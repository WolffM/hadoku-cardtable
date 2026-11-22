/**
 * Karn Liberated's −14 restarts the game, against real Forge. The operator, 2026-11-21 (match
 * m-8032ceb08b5b): the ultimate "tried to work and then when laying out all the cards put me back
 * earlier in the game".
 *
 * Forge restarts a game by looping `GameAction.playGame` while the game is `RestartedByKarn`, and each
 * pass calls `startFirstTurn(first, startGameHook)`, so the bridge's start hook ran a second time: it
 * applied the room's scenario over the new game and subscribed the bridge's listeners again, which
 * sent every log line twice. Here the scenario's board is one the restarted game must not have.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run games/magic/server/src/play/karn-restart.jvm.test.ts --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, inOwnMain, passUntil, startScenario, waitUntil, type Scenario } from './scenario.js';

const title = available.ok
	? 'Karn Liberated’s ultimate restarts the game once, without the scenario, against real Forge'
	: `Karn Liberated’s ultimate restarts the game once, without the scenario, against real Forge — SKIPPED: ${available.reason}`;

const PLAINS = Array.from({ length: 20 }, () => 'Plains').join(';');

const STATE = [
	'turn=3',
	'activeplayer=human',
	'activephase=MAIN1',
	'humanlife=7',
	'ailife=9',
	'humanhand=',
	`humanlibrary=${PLAINS}`,
	'humanbattlefield=Karn Liberated|Counters:LOYALTY=14;Plains;Plains',
	'humangraveyard=',
	'aihand=',
	`ailibrary=${PLAINS}`,
	'aibattlefield=Grizzly Bears;Plains',
	'aigraveyard=',
].join('\n');

const ULTIMATE = /Restart the game/;
/** The opening's two questions; `finishMulligan` waits on both seats' prompts, and an AI seat has none. */
const OPENING = /keep your hand|play or draw/i;

/** Seat 0's life total, or the AI's: the one player in seat 0's view that is not seat 0 (an AI seat is never told its own id). */
function life(s: Scenario, who: 'me' | 'ai'): number {
	const mine = s.match.seats[0]?.playerId ?? -1;
	const obj = [...s.state(0).values()].find((o) => o._type === 1 && (who === 'me') === (o._id === mine));
	return (obj?.Life as { v?: number } | undefined)?.v ?? -1;
}

const names = (s: Scenario, seat: number, zone: 'Hand' | 'Battlefield', of?: number): string[] => s.zone(seat, zone, of).map((c) => c.name);

describe.skipIf(!available.ok)(title, () => {
	it.each([
		{ room: 'a scenario room (coin toss and mulligan first)', skipOpening: false },
		{ room: 'a board-state room (no opening)', skipOpening: true },
	])(
		'$room: the −14 starts a new game at 20 life with every card back in the libraries, and logs each line once',
		async ({ skipOpening }) => {
			if (!available.ok) return;
			const s = await startScenario(available.config, {
				seed: 1121,
				decks: [deck('Plains A', ['40 Plains']), deck('Plains B', ['40 Plains'])],
				aiOpponent: true,
				scenario: STATE,
				skipOpening,
				reply: (f) => (f.method === 'getAbilityToPlay' ? ((f.abilities as { label?: string }[]).find((a) => ULTIMATE.test(a.label ?? '')) ?? null) : undefined),
			});
			try {
				await waitUntil(
					() => {
						s.keepHands(OPENING);
						s.answerAsks();
						return inOwnMain(s, 0, 3) && names(s, 0, 'Battlefield').includes('Karn Liberated');
					},
					'seat 0 in its turn-3 main with Karn Liberated out',
					60_000,
					s,
				);
				expect(life(s, 'me')).toBe(7);
				expect(life(s, 'ai')).toBe(9);
				expect(names(s, 0, 'Battlefield', 1)).toContain('Grizzly Bears');

				const karn = s.zone(0, 'Battlefield').find((c) => c.name === 'Karn Liberated');
				if (karn === undefined) throw new Error('no Karn Liberated');
				const line = s.lines.length;
				s.select(0, karn.id);
				await passUntil(
					s,
					() => inOwnMain(s, 0, 1) && life(s, 'me') === 20,
					'the restarted game’s turn 1 to reach seat 0’s main',
					120_000,
				);

				expect(life(s, 'me'), 'seat 0 starts the new game at 20, not the scenario’s 7').toBe(20);
				expect(life(s, 'ai'), 'and so does the AI, not at the scenario’s 9').toBe(20);
				expect(names(s, 0, 'Battlefield'), 'Karn went back into the library with everything else').not.toContain('Karn Liberated');
				expect(names(s, 0, 'Battlefield', 1), 'the scenario’s Grizzly Bears are not put back').not.toContain('Grizzly Bears');
				expect(s.zone(0, 'Hand').length, 'seat 0 drew a new opening hand').toBe(7);

				await passUntil(s, () => inOwnMain(s, 0, 3), 'the restarted game’s turn 3', 120_000);
				const turnTwo = s.lines.slice(line).filter((l) => l.t === 'log' && l.players.some((p) => p.text !== null && /^Turn 2 \(/.test(p.text)));
				expect(turnTwo.length, 'the new game’s turn 2 is logged once, not once per start').toBe(1);
			} finally {
				await s.stop();
			}
		},
		240_000,
	);
});

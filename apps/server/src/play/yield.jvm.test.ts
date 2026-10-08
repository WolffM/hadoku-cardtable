/**
 * The operator: *"when it's the opponents turn the 'End turn' button should
 * turn to 'Auto Yield' meaning that we auto-pass on whatever the opponent
 * plays even if we did have a response even though the game would have
 * given us a chance … Auto Yield should only last for that turn."*
 *
 * Against a REAL Forge match: bob casts Lightning Bolt at alice while her
 * auto-yield is on and she holds Counterspell with two untapped Islands —
 * `DEFAULT_STOP_POLICY`'s own "nothing to do" rule would otherwise ask her
 * for real (`forgeFrames` is the precondition: Forge really does open that
 * window), and auto-yield hides it from her wire entirely. One turn later —
 * bob's NEXT turn, with nothing here re-arming or cancelling the override —
 * the SAME shape of window reaches her for real.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/yield.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, forgeFrames, inOwnMain, passUntil, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';
import { keyOf, TYPE } from './visibility.js';

const title = available.ok
	? 'Auto Yield hides a real response window, against real Forge'
	: `Auto Yield hides a real response window, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Y A', ['40 Mountain']), deck('Y B', ['40 Mountain'])];
const ALICE = 0;
const BOB = 1;

function lifeOf(s: Scenario, seat: number): number {
	const player = s.state(seat).get(keyOf(TYPE.player, s.match.seats[seat]?.playerId ?? -1));
	return ((player?.Life as { v?: number } | undefined)?.v) ?? -1;
}

/** Select bob's next Lightning Bolt, target alice, and wait for it to resolve. */
async function boltAlice(s: Scenario): Promise<void> {
	await waitUntil(
		() => {
			s.answerAsks();
			return s.zone(BOB, 'Hand').some((c) => c.name === 'Lightning Bolt');
		},
		'bob to hold a Lightning Bolt',
		20_000,
		s,
	);
	const bolt = s.zone(BOB, 'Hand').find((c) => c.name === 'Lightning Bolt');
	if (bolt === undefined) throw new Error('no Lightning Bolt in bob’s hand');
	s.select(BOB, bolt.id);
	const aliceId = s.match.seats[ALICE]?.playerId as number;
	let targeted = false;
	let alicePressed: string | null = null;
	await waitUntil(
		() => {
			s.answerAsks();
			if (!targeted && /target/i.test(s.prompt(BOB))) {
				targeted = true;
				s.match.fromClient(BOB, { kind: 'act', method: 'selectPlayer', player: { kind: 'player', id: aliceId }, triggerEvent: null } as never);
			}
			// Without auto-yield alice gets a REAL window here (the second half of
			// this test's own claim) and nothing else in this driver ever presses
			// for her — press it once per distinct prompt, same as a player who
			// looked and chose to let the spell through.
			const aliceMsg = s.prompt(ALICE);
			if (alicePressed !== aliceMsg && /^Priority: alice/.test(aliceMsg) && s.buttons(ALICE)?.enable1 === true) {
				alicePressed = aliceMsg;
				s.ok(ALICE);
			}
			return !s.zone(BOB, 'Hand').some((c) => c.id === bolt.id) && /^Stack: Empty$/m.test(s.prompt(BOB)) && s.buttons(BOB)?.enable1 === true;
		},
		"bob's Lightning Bolt at alice to resolve",
		30_000,
		s,
	);
}

/** Every `updateButtons` alice's OWN wire carried from send-index `sentFrom`. */
function aliceBars(s: Scenario, sentFrom: number): unknown[] {
	return s.sent.slice(sentFrom).filter((x) => x.seat === ALICE && x.envelope.frame.method === 'updateButtons');
}

describe.skipIf(!available.ok)(title, () => {
	it(
		"hides alice's response window while it is on, and stops hiding it once bob's turn comes round again",
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, {
				seed: 63,
				decks: DECKS,
				names: ['alice', 'bob'],
				scenario: scenarioText('w63-yield'),
			});
			try {
				await finishMulligan(s);
				// `setAutoYield` reads the match's CURRENT turn off alice's own
				// `SeatState.projector` (`visibility.ts`'s `turnNumber`, off a Game
				// delta); wait for that seat's own sync to have carried it at least
				// once, so arming the override is not racing its own precondition —
				// a real browser can never see "it's the other seat's turn" to even
				// draw the button before the server-side seat it is wired to already
				// knows the same fact, but this driver calls `setAutoYield` directly.
				await waitUntil(
					() => s.match.seats[ALICE]?.projector.turnNumber() !== null,
					"alice's own seat to know the match's current turn",
					20_000,
					s,
				);
				expect(s.match.setAutoYield(ALICE, true)).toEqual({ ok: true });

				const lineMark = s.lines.length;
				const sentMark = s.sent.length;
				const aliceLifeBefore = lifeOf(s, ALICE);
				await boltAlice(s);

				expect(lifeOf(s, ALICE), "bob's Bolt resolved for 3").toBe(aliceLifeBefore - 3);
				// The precondition, so the claim below is not vacuous: FORGE really
				// did open alice's own priority window with bob's spell on the
				// stack — `showPromptMessage` named for alice herself, the shape
				// `inOwnMain`'s own `Priority: <name>` check reads.
				const forgeSaidAlice = forgeFrames(s, ALICE, lineMark);
				const aliceOffered = forgeSaidAlice.some(
					(f) => f.method === 'showPromptMessage' && /^Priority: alice/.test(f.message ?? '') && /Stack: 1 to Resolve/.test(f.message ?? ''),
				);
				expect(aliceOffered, "Forge never gave alice a window with bob's spell on the stack").toBe(true);
				// The claim: none of that ever reached alice's own wire — not a
				// disabled correction, not a live bar, nothing.
				expect(aliceBars(s, sentMark), "alice's own wire carried a bar for bob's spell").toEqual([]);
				expect(
					s.logs.some((l) => l.evt === 'auto-passed' && l.seat === ALICE && l.why === 'auto-yield'),
					'the auto-passed log names why',
				).toBe(true);

				// One turn later: nothing here re-arms or cancels auto-yield — the
				// override expires on its own the moment the turn moves on.
				await passUntil(s, () => inOwnMain(s, ALICE, 2), "alice's own turn 2 main", 90_000);
				await passUntil(s, () => inOwnMain(s, BOB, 3), "bob's turn 3 main", 90_000);

				const sentMark2 = s.sent.length;
				const aliceLifeBefore2 = lifeOf(s, ALICE);
				await boltAlice(s);
				expect(lifeOf(s, ALICE), "bob's second Bolt resolved for 3").toBe(aliceLifeBefore2 - 3);
				expect(aliceBars(s, sentMark2).length, 'without auto-yield, alice’s own wire gets a real bar this time').toBeGreaterThan(0);
			} finally {
				await s.stop();
			}
		},
		180_000,
	);
});

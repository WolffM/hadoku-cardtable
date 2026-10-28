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

import { selfAnswer } from '@hadoku/shared';
import { deltaKey, DELTA_TYPE } from '@hadoku/forge-wire';

import { available, deck, finishMulligan, forgeFrames, inOwnMain, passUntil, scenarioText, startScenario, waitUntil, type Scenario } from './scenario.js';
import { onlyAnswer } from './auto.js';

const title = available.ok
	? 'Auto Yield hides a real response window, against real Forge'
	: `Auto Yield hides a real response window, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Y A', ['40 Mountain']), deck('Y B', ['40 Mountain'])];
const ALICE = 0;
const BOB = 1;

function lifeOf(s: Scenario, seat: number): number {
	const player = s.state(seat).get(deltaKey(DELTA_TYPE.player, s.match.seats[seat]?.playerId ?? -1));
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
	// Resolved means in bob's graveyard. A Bolt gone from his hand with "Stack: Empty" in his prompt
	// is not enough: until Forge sends the next prompt, the one before the cast still says so.
	const boltsResolved = (): number => s.zone(BOB, 'Graveyard').filter((c) => c.name === 'Lightning Bolt').length;
	const resolvedBefore = boltsResolved();
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
			return boltsResolved() > resolvedBefore && /^Stack: Empty$/m.test(s.prompt(BOB)) && s.buttons(BOB)?.enable1 === true;
		},
		"bob's Lightning Bolt at alice to resolve",
		30_000,
		s,
	);
}

/**
 * Every window bar alice's OWN wire carried from send-index `sentFrom`. Not the bar of Forge's
 * "Waiting for bob…" prompt: `AbstractGuiGame.awaitNextInput` draws that, OK and Cancel both off,
 * when no input of alice's has opened 250 ms after her last one closed. It is the waiting state, not
 * a window, and whether it falls inside the Bolt is the host's speed (runs 38707045761, 38962592446,
 * 39002879818, 39024892576: alice's wire seq 17, a dead OK | Cancel).
 */
function aliceBars(s: Scenario, sentFrom: number): unknown[] {
	let prompt = '';
	return s.sent.filter((x, i) => {
		if (x.seat !== ALICE) return false;
		const f = x.envelope.frame as { method: string; message?: string };
		if (f.method === 'showPromptMessage') prompt = f.message ?? '';
		return i >= sentFrom && f.method === 'updateButtons' && !/^Waiting for /.test(prompt);
	});
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

	/*
	 * The precedence of the seat's two own preferences, against a real match: Auto Yield
	 * outranks full control. The operator, 2026-10-14, in full control with a stack item held:
	 * *"auto-yield should work even for things already on the stack."* Pressing it is the seat's
	 * word for this turn; full control is a standing "ask me". The SAME seat with BOTH on at
	 * once is the one case synthetic frames cannot stand in for.
	 */
	it(
		"auto-yield passes bob's Bolt for alice even with full control also on — her word for this turn wins",
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
				await waitUntil(
					() => s.match.seats[ALICE]?.projector.turnNumber() !== null,
					"alice's own seat to know the match's current turn",
					20_000,
					s,
				);
				// Both on, same seat, same turn — the order they were set in must not matter.
				expect(s.match.setAutoYield(ALICE, true)).toEqual({ ok: true });
				expect(s.match.setFullControl(ALICE, true)).toEqual({ ok: true });

				const lineMark = s.lines.length;
				const sentMark = s.sent.length;
				const aliceLifeBefore = lifeOf(s, ALICE);
				await boltAlice(s);

				expect(lifeOf(s, ALICE), "bob's Bolt resolved for 3").toBe(aliceLifeBefore - 3);
				const forgeSaidAlice = forgeFrames(s, ALICE, lineMark);
				const aliceOffered = forgeSaidAlice.some(
					(f) => f.method === 'showPromptMessage' && /^Priority: alice/.test(f.message ?? '') && /Stack: 1 to Resolve/.test(f.message ?? ''),
				);
				expect(aliceOffered, "Forge never gave alice a window with bob's spell on the stack").toBe(true);
				// The claim: the yield passed that window under full control — no live bar reached alice's
				// wire (full control still forwards Forge's dead bars, which ask nothing).
				const live = aliceBars(s, sentMark).filter((x) => {
					const f = (x as { envelope: { frame: { enable1?: boolean; enable2?: boolean } } }).envelope.frame;
					return f.enable1 === true || f.enable2 === true;
				});
				expect(live, "alice's own wire carried no live bar for bob's spell").toEqual([]);
				expect(
					s.logs.some((l) => l.evt === 'auto-passed' && l.seat === ALICE && l.why === 'auto-yield'),
					'the window was passed for the yield',
				).toBe(true);
			} finally {
				await s.stop();
			}
		},
		180_000,
	);
});

/*
 * S6, wave 64 — does the browser's `selfAnswer` (`@hadoku/shared`) ever answer something the server's `onlyAnswer`
 * would not? Against real Forge, not a hand-typed fixture: a Counterspell
 * targeting a real Memnite on the stack (`w49-a-counterspell-opponent.state`,
 * already a committed scenario — the same shape wave 32's own measurement
 * named for Mana Leak, `docs/planning/wave32-evidence/q17-holding-priority.md`
 * §Q7: a cast's own target question is `min: 0` — Forge lets the caster
 * decline a target by cancelling the cast — so `onlyAnswer`'s "one option,
 * `min === 1`" arm never fires here, by design: answering it server-side
 * would also answer an unrelated optional "you may sacrifice a creature"
 * question the same shape. The client-side rule is narrower on purpose — ONE
 * stack-item option, never any other `getChoices` shape — which is exactly
 * what makes it safe to answer where the server's general rule must not.
 */
const title6 = available.ok
	? 'S6: selfAnswer answers the one case onlyAnswer must leave, against real Forge'
	: `S6: selfAnswer answers the one case onlyAnswer must leave, against real Forge — SKIPPED: ${available.reason}`;

describe.skipIf(!available.ok)(title6, () => {
	it(
		"a real \"Select target spell\" ask is min 0 (onlyAnswer leaves it); selfAnswer answers it anyway",
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, {
				seed: 49,
				decks: [deck('S6 A', ['40 Mountain']), deck('S6 B', ['40 Mountain'])],
				names: ['alice', 'bob'],
				scenario: scenarioText('w49-a-counterspell-opponent'),
			});
			try {
				await finishMulligan(s);
				const memnite = await (async () => {
					await waitUntil(() => {
						s.answerAsks();
						return s.zone(0, 'Hand').some((c) => c.name === 'Memnite');
					}, 'alice to hold Memnite', 20_000, s);
					const card = s.zone(0, 'Hand').find((c) => c.name === 'Memnite');
					if (card === undefined) throw new Error('no Memnite in alice’s hand');
					return card;
				})();
				s.select(0, memnite.id);
				await waitUntil(() => {
					s.answerAsks();
					return /Stack: 1 to Resolve/.test(s.prompt(1)) && s.buttons(1)?.enable1 === true;
				}, 'bob to hold priority with Memnite on the stack', 20_000, s);
				const counterspell = s.zone(1, 'Hand').find((c) => c.name === 'Counterspell');
				if (counterspell === undefined) throw new Error('no Counterspell in bob’s hand');
				const askedBefore = s.asks.length;
				s.select(1, counterspell.id);
				await waitUntil(() => {
					s.answerAsks();
					return s.asks.slice(askedBefore).some((a) => (a as unknown as { method?: string }).method === 'getChoices');
				}, 'the "Select target spell" ask', 20_000, s);
				const ask = s.asks.slice(askedBefore).find((a) => (a as unknown as { method?: string }).method === 'getChoices') as unknown as {
					method: string;
					message: string;
					min: number;
					max: number;
					choices: { key: string; ref: { kind: string; id: number } | null }[];
				};

				// Counterspell's own wording ("Select target card") differs from Mana
				// Leak's ("Select target spell") — the SHAPE is what S6 is about, not
				// the sentence.
				expect(ask.message).toMatch(/^Select target/);
				expect(ask.choices).toHaveLength(1);
				expect(ask.choices[0]?.ref?.kind).toBe('stackItem');
				// The whole of S6's premise: it is NOT a one-answer ask by `onlyAnswer`'s
				// own rule (`min === 1` required for its "one option" arm).
				expect(ask.min, 'a real cast’s own target question is optional — the caster can always cancel').toBe(0);
				expect(onlyAnswer(ask as never)).toBeNull();

				// The claim: `selfAnswer` (the browser's rule, `@hadoku/shared`)
				// answers it anyway — the one case this file's header describes.
				const clientAnswer = selfAnswer(ask as never);
				expect(clientAnswer, 'selfAnswer must answer a lone stack-item target').not.toBeNull();
				expect(clientAnswer?.method).toBe('getChoices');
				expect(clientAnswer?.reply).toEqual([ask.choices[0]?.key]);
			} finally {
				await s.stop();
			}
		},
		60_000,
	);
});

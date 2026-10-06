/**
 * Wave 34 §S4 — the repeated `getAbilityToPlay` ask, chased to its cause and
 * pinned here.
 *
 * `wave34-evidence/s1-full-control.md` and `s2-ponder.md` (lane S) and
 * `g2-full-control-ponder.md` (lane G) all measured the same symptom: casting
 * a single-ability hand card under Full Control asks `getAbilityToPlay`
 * twice (sometimes a third ask was SEEN, but — see the evidence doc this
 * lane added, `wave34-evidence/s4-repeated-ask.md` — that third ask was
 * always for a DIFFERENT host card, a land being tapped for mana, never a
 * genuine third repeat of the SAME ask) before the cast proceeds to mana
 * payment. None of them could say WHY without instrumenting a real match.
 *
 * This lane did: a temporary stack-trace + live-`InputQueue` probe (removed
 * before this file was committed) against `lone-spell.state` proved, directly
 * off a running JVM:
 *
 *  - Round 1 fires while this seat's `InputQueue.getInput()` is
 *    `InputPassPriority` — the click's own `onCardSelected`.
 *  - Round 2 fires with NO `act` of any kind in between, and this seat's
 *    `InputQueue.getInput()` is already `null` by then — not a new `Input`,
 *    not the same one re-entering. That rules out a duplicate `selectCard`, a
 *    reply that resolved to null/ABORTED, and "a different Input re-entering"
 *    (the brief's hypotheses a/b/c) directly, not by inference.
 *  - Reading forge-game's source for the gap an `Input`-free round could come
 *    from lands on `PlaySpellAbility.chooseOptionalAdditionalCosts`
 *    (`forge-game/src/main/java/forge/game/player/PlaySpellAbility.java:140-
 *    152`): called unconditionally, right after `playChosenSpellAbility`
 *    receives the chosen ability, with `GameActionUtil.getAdditionalCostSpell`
 *    (`forge-game/.../GameActionUtil.java:567-589`), which returns a
 *    singleton list holding the SAME ability unless the card has Forge's
 *    `AlternateAdditionalCost` keyword. Neither Mana Leak, Memnite, nor Ponder
 *    has it — so this call asks `getAbilityToPlay(hostCard, [sameAbility])`
 *    again, every time, for every spell.
 *  - The same probe, run through Mana Leak's own mana payment (tapping an
 *    Island), found the SAME shape is possible for a mana ability too
 *    (`InputPayManaOfCostPayment`'s own ability-activation path also ends in
 *    `PlaySpellAbility.playSpellAbility`) — but did NOT reproduce for a plain
 *    basic land in a clean run with no overlapping clicks; what looked like a
 *    third round for a land in an earlier, messier probe run was this lane's
 *    OWN test script re-selecting an already-tapped land before its local
 *    state caught up (the exact "script's own bug" shape G's evidence warned
 *    about), confirmed because the cleaner rerun paid the full cost in
 *    exactly one ask per land with no repeat at all.
 *
 * Conclusion: hypothesis (d), "something else" — a genuine, Forge-internal,
 * NON-Input call site that is reached unconditionally after every ability
 * selection. Not a bug in `match.ts`, `auto.ts`, `PlayBridge.java`, or
 * `LiveBoard.tsx`/`rules.ts` (G's lane already proved the render/answer path
 * is correct). It cannot be fixed in Forge (`forge/` is pinned, read-only).
 *
 * The fix landed here (`auto.ts`'s `repeatedAbilityToPlay`, dispatched from
 * `match.ts`'s `onFrame` AHEAD of the full-control gate) does not change
 * Forge's behaviour — it recognises Forge's second, already-answered question
 * for what it is and answers it the same way, so the PLAYER sees the ask
 * exactly once regardless of how many times Forge's own engine asks it.
 *
 *   CARDTABLE_FORGE_JAR=… CARDTABLE_FORGE_RES=… CARDTABLE_PLAY_WORK_DIR=… \
 *   pnpm exec vitest run apps/server/src/play/scenario-ability-repeat.jvm.test.ts \
 *     --pool=forks --poolOptions.forks.singleFork=true
 */

import { describe, expect, it } from 'vitest';

import { available, deck, finishMulligan, landPayer, scenarioText, startScenario, waitUntil } from './scenario.js';

const title = available.ok
	? 'the repeated getAbilityToPlay ask, under Full Control, against real Forge'
	: `the repeated getAbilityToPlay ask, under Full Control, against real Forge — SKIPPED: ${available.reason}`;

const DECKS: [string, string] = [deck('Any A', ['40 Mountain']), deck('Any B', ['40 Mountain'])];

/** Every `getAbilityToPlay` ask ever SENT to `seat` for `hostCardId` — frames a repeat would have to appear in (it never does, now). */
function abilityAsksFor(s: Awaited<ReturnType<typeof startScenario>>, seat: number, hostCardId: number): unknown[] {
	return s.sent
		.filter((x) => x.seat === seat)
		.map((x) => x.envelope.frame as unknown as { kind?: string; method?: string; hostCard?: { id?: number } })
		.filter((f) => f.kind === 'ask' && f.method === 'getAbilityToPlay' && f.hostCard?.id === hostCardId);
}

describe.skipIf(!available.ok)(title, () => {
	it(
		'Mana Leak over Memnite: exactly one getAbilityToPlay ask, then mana payment',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, {
				seed: 7,
				decks: DECKS,
				scenario: scenarioText('lone-spell'),
				reply: (f) => {
					if (f.method !== 'getChoices') return undefined;
					const choices = f.choices as { key: string }[];
					return /target/i.test(String(f.message)) && choices[0] !== undefined ? [choices[0].key] : undefined;
				},
			});
			try {
				await finishMulligan(s);
				const memnite = await waitUntil(() => {
					s.answerAsks();
					return s.zone(1, 'Hand').some((c) => c.name === 'Memnite');
				}, "seat 1's hand to reflect Memnite", 20_000, s).then(() => s.zone(1, 'Hand').find((c) => c.name === 'Memnite'));
				if (memnite === undefined) throw new Error('no Memnite in hand');
				s.select(1, memnite.id);
				await waitUntil(() => {
					s.answerAsks();
					return /Stack: 1 to Resolve/.test(s.prompt(0)) && s.buttons(0)?.enable1 === true;
				}, 'seat 0 to be given priority with the spell on the stack', 20_000, s);

				const outcome = s.match.setFullControl(0, true);
				expect(outcome.ok).toBe(true);

				const leak = s.zone(0, 'Hand').find((c) => c.name === 'Mana Leak');
				if (leak === undefined) throw new Error('no Mana Leak in hand');

				s.select(0, leak.id);

				// Drive the cast through: answer the one getAbilityToPlay ask the
				// client actually sees, the target question, and tap Islands for the
				// Pay Mana Cost window — exactly what a Full Control player does.
				// Mana Leak is {1}{U}: two lands, one at a time (`landPayer`).
				const payLand = landPayer(s, 0);
				await waitUntil(() => {
					s.answerAsks();
					payLand();
					return /Stack: 2 to Resolve/.test(s.prompt(0));
				}, "Mana Leak to reach the stack (Stack: 2 to Resolve)", 30_000, s);

				// The claim: the CLIENT only ever saw ONE getAbilityToPlay ask for
				// Mana Leak's own host card, not two. Forge's own second round
				// (`chooseOptionalAdditionalCosts`) must never have reached `s.sent`
				// at all — it was answered server-side, ahead of the wire.
				const asks = abilityAsksFor(s, 0, leak.id);
				expect(asks).toHaveLength(1);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);

	it(
		'Ponder: exactly one getAbilityToPlay ask, then the order ask and the shuffle confirm reach the client',
		async () => {
			if (!available.ok) return;
			const s = await startScenario(available.config, { seed: 11, decks: DECKS, scenario: scenarioText('ponder') });
			try {
				await finishMulligan(s);
				await waitUntil(() => {
					s.answerAsks();
					return /Stack: Empty/m.test(s.prompt(0)) && s.buttons(0)?.enable1 === true;
				}, "seat 0's own uncontested main phase", 20_000, s);

				const outcome = s.match.setFullControl(0, true);
				expect(outcome.ok).toBe(true);

				const ponder = s.zone(0, 'Hand').find((c) => c.name === 'Ponder');
				if (ponder === undefined) throw new Error('no Ponder in hand');

				s.select(0, ponder.id);

				// Under Full Control, nothing auto-passes this seat's own priority
				// (`match.ts`'s `maybeAutoPass` gates on `fullControl` same as
				// autopay) — so once Ponder is paid for and sitting on the stack,
				// THIS seat has to press OK itself before it resolves and asks
				// anything. Press it once, the first time the stack shows exactly
				// Ponder waiting and the button is live.
				let passedOwnPriority = false;
				const payLand = landPayer(s, 0);
				await waitUntil(() => {
					s.answerAsks();
					payLand();
					if (
						!/Pay Mana Cost/.test(s.prompt(0)) &&
						!passedOwnPriority &&
						/Stack: 1 to Resolve/.test(s.prompt(0)) &&
						s.buttons(0)?.enable1 === true
					) {
						passedOwnPriority = true;
						s.ok(0);
					}
					return s.asks.some((a) => a.method === 'order');
				}, 'the order ask to reach the client', 30_000, s);

				const asks = abilityAsksFor(s, 0, ponder.id);
				expect(asks).toHaveLength(1);

				await waitUntil(() => {
					s.answerAsks();
					return /shuffle/i.test(s.prompt(0));
				}, 'the shuffle confirm to reach the client', 20_000, s);
			} finally {
				await s.stop();
			}
		},
		120_000,
	);
});

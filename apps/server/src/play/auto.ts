/**
 * Whether the player is interrupted — as a POLICY, not as a pile of branches.
 *
 * Wave 19 lane C wrote this file; waves 20 and 22 each answered a new operator
 * request by adding a regex over Forge's prose and a branch beside it. Wave 24
 * §E replaces that with a model, under the operator's own rule (2026-09-27):
 *
 * > *"it's super important that we dont bandaid fix these things, especially the
 * > shortcutting logic. this is gonna keep stacking higher … its gonna get super
 * > messy if we handroll too much of this in custom if statements."*
 *
 * ## The model, in four parts
 *
 * 1. **A stop preference** is a named field of {@link StopPolicy}. Every field
 *    is either a Forge `FPref.YIELD_*` value or a Forge `skipPhases` set — the
 *    exact Forge mechanism each one maps to is in the field's own doc, on the
 *    interface below. **Nothing here translates the policy to Forge's own
 *    `YieldUpdate` frames**: wave 64 §S deleted `toYieldUpdates` (S2), the
 *    function that used to do it, because nothing could call it — the bridge's
 *    `sendYieldUpdate` act takes a trigger decision only (see "What the next
 *    wave must add" below) —
 *    and a translation with no caller is not a safety net, it is a second copy
 *    of the mapping table that can drift from the one the fields themselves
 *    carry.
 * 2. **{@link PromptFacts} are structured facts** about one window: a
 *    `PhaseType`, whose turn it is, whether the stack is empty, Forge's
 *    actionable multiset, the cost being paid. No prose.
 * 3. **{@link readPromptFacts} is the ONE named adapter.** It is the only place
 *    in this file — and the only place above the wire — that reads Forge's
 *    human-readable prompt. It exists because the bridge does not yet send these
 *    facts structurally; see "What the next wave must add" below. **Nothing
 *    above it matches a string.**
 * 4. **{@link decideStop} and {@link decidePay} are pure over facts and the
 *    policy.** They contain no pattern, no card name and no phase spelling. A
 *    new shortcut request is a new POLICY VALUE, not a new branch here.
 *
 * Wave 64 §S deleted the three one-line `autoPassReason`/`autoPayReason`/
 * `autoCancelReason` wrappers that used to stand between `match.ts` and these
 * functions (S5): both files are this lane's now, so `match.ts` computes
 * {@link readPromptFacts} ONCE per gate and calls {@link decideStop},
 * {@link decidePay} and {@link answerability} directly on the one result,
 * instead of each gate re-deriving facts through its own wrapper.
 *
 * ## A stop is a PHASE the player picked, not a card they happen to hold
 *
 * Wave 28, and it is the one thing in this file a player can feel. Until
 * 2026-09-28 {@link DEFAULT_STOP_POLICY} carried `skipNonStopPhases: 'never'`,
 * so a phase outside the stop set was passed only when *Forge itself* said the
 * seat could do nothing there. The consequence, which the operator hit on their
 * own upkeep: *"the game auto-stopped on my upkeep because i have tragic slip
 * avaliable and i could use it on my own minion … it reveals information about
 * whats in my hand … it's stopping everywhere, super annoying."*
 *
 * **That is an information leak, and it is the reason this changed — the
 * annoyance is only the symptom.** A stop conditioned on what the seat could do
 * is a stop conditioned on what the seat HOLDS: every extra window the table
 * watches you sit in narrows what your hand can be. A stop at a FIXED phase
 * tells the table nothing, because it happens whether your hand is Tragic Slip
 * or seven lands. The shortcut model cannot know what a card is — that is the
 * whole point of {@link PromptFacts} — but it can stop asking a question whose
 * *timing* is the answer.
 *
 * So {@link DEFAULT_STOP_POLICY} adopted Arena's own stop set **wholesale**,
 * not just its `skipNonStopPhases`. That was a real choice and the reason is
 * arithmetic rather than taste: `'always'` on top of the old stop sets
 * (`['MAIN1','MAIN2']` and `[]`) would have left the seat with **no window at all
 * on the opponent's turn**, so a held instant could never be cast — the operator
 * asked for fewer stops, not for fewer options, and a policy that cannot cast
 * Tragic Slip on anybody's turn is worse than one that asks too often. Arena's
 * stop set is the conventional answer to exactly that trade: your own main
 * phases and your declare-attackers step (which is also where item 6's attack
 * control has to happen), the opponent's declare-blockers step and end step.
 * Three windows instead of thirteen, and the three that matter.
 *
 * The behaviour it replaced is still reachable and still tested, under the name
 * it now deserves: {@link EVERY_PRIORITY_POLICY}. It is there so the change is
 * reversible and so a suite can pin the difference — not so a suite can dodge
 * re-aiming to it.
 *
 * ## Full control is a POLICY, not a bypass
 *
 * {@link FULL_CONTROL_POLICY} makes every phase a stop phase, refuses to pass a
 * stack window, refuses to pass for want of actions, asks every payment, leaves
 * a cost Forge cannot pay for the player to cancel, and asks the order of
 * simultaneous triggers. It never asks a question with one answer: an ask
 * {@link onlyAnswer} answers, and the cost confirm of the ability the seat just
 * chose ({@link chosenCostConfirm}), are answered in every mode.
 * `match.ts` also gates on the seat's `fullControl` flag, so the escape hatch
 * holds at both levels: the flag short-circuits before the seat's policy is
 * read at all, and setting the policy to {@link FULL_CONTROL_POLICY} reaches
 * the same place the long way round — item 5's "it clears the yields, so every
 * stop comes back" is true of the flag today; it will also be true of the
 * policy value once something maps it to Forge's own `YieldUpdate` frames (see
 * "What the next wave must add" below).
 *
 * ## The rule the whole file still obeys
 *
 * **We implement no rules.** Every decision is either a case where *Forge
 * itself* left exactly one possibility, or a case Forge's own client decides the
 * same way, cited. Nothing here decides what is legal. And where an ask is not a
 * question at all but a REVEAL, it stays: a shortcut may remove a question,
 * never information.
 *
 * **When in doubt the player is asked.** A stop they did not want is an
 * annoyance; a stop they did not get is a lost game. Every unclassified window
 * is a stop.
 *
 * ## What the next wave must add, outside this lane
 *
 * - `apps/server/src/play/bridge/PlayBridge.java` — `act()`'s `sendYieldUpdate`
 *   case takes the `triggerDecision` arm only (an optional trigger's "Always",
 *   `Match.setTriggerDecision`), so nothing this file computes can reach Forge yet.
 *   `IGameController.sendYieldUpdate(YieldUpdate)` exists
 *   (`IGameController.java:84-86`) and routes to `applyYieldUpdate`. **No
 *   function here turns a {@link StopPolicy} into those frames any more**
 *   (wave 64 §S deleted the unreachable `toYieldUpdates`, S2) — writing one is
 *   this bullet's job once the bridge has somewhere to send it, from the
 *   mapping table on {@link StopPolicy}'s own fields.
 * - `PlayBridge.java:1172` — `isUiSetToSkipPhase` returns a hardcoded `false`,
 *   and our GUI is not a `RemoteClientGuiGame`, so
 *   `PlayerControllerHuman.isUiSetToSkipPhase` asks the GUI rather than the
 *   `YieldController`. Until that delegates to
 *   `getYieldController().isSkippingPhase(turnPlayer, phase)`, a `SkipPhase`
 *   envelope is inert on our bridge.
 * - **The per-seat `StopPolicy` this list used
 *   to ask for landed in wave 26 §E**: `SeatState.policy`, set through
 *   `Match.setStopPolicy`, and every decision below is asked of THAT seat's
 *   policy rather than of {@link DEFAULT_STOP_POLICY}. Nothing yet lets a
 *   PLAYER choose one — there is no wire message for it, and that is still
 *   true. What wave 27 §C added is the hatch BESIDE that: a name
 *   ({@link NAMED_STOP_POLICIES}) read off the environment by
 *   `socket.ts`'s `CARDTABLE_PLAY_STOP_POLICY` and handed to every new match's
 *   seats through `MatchDeps.stopPolicy`. Unset in production, exactly like
 *   `CARDTABLE_PLAY_SEED`; it exists so a spec and a screenshot of a live
 *   payment can be taken from outside the process.
 * - `apps/server/src/play/host.ts` — `FORGE_PREFERENCES` does not set
 *   `UI_SHOW_AUTOTAP_PREVIEW`, so Forge's auto-tap PLAN never reaches us and
 *   {@link PromptFacts.plannedSources} is empty in production. Wave 25 §D
 *   measured that against a real Forge. Turning it on is a one-line edit there
 *   and it widens `'auto'` to #22's two-source case; it does NOT close item 6,
 *   for the reason {@link StopPolicy.unambiguousPayment} records.
 * - The bridge names no set of "cards that can pay THIS cost". `InputPayMana`
 *   knows it (`autoPayManaSources`, `InputPayMana.java:438-452`) and Forge's own
 *   desktop UI reads it through `getActivateAction`; neither is on our wire. That
 *   set, sent as a payment window's `setSelectables`, is what would let `'auto'`
 *   answer item 6 without anything here knowing what red mana is.
 * - `packages/forge-wire/src/{envelope,examples,index}.ts` — `sendYieldUpdate`
 *   is modelled in `tier-b.ts` (`SendYieldUpdateSchema`) but is deliberately NOT
 *   in `TIER_B_METHODS`: `envelope.test.ts` pins the census at 23 Tier B methods
 *   and 41 required, and that file is not this lane's.
 */

import { PHASE_TYPES, REPLY_SCHEMAS, type ClientFrame, type PhaseType, type ServerFrame, type ZoneType } from '@hadoku/forge-wire';
import { LIFE_PAYMENT, oneAbility, onlyCombatDamage } from '@hadoku/shared';
import { copyTargets, type SpellCopy } from './spell-copiers.js';

/** An ask that admits exactly one answer, and why. */
export interface AutoAnswer {
	callId: string;
	method: string;
	result: unknown;
	/** A short, logged reason — never shown as prose in the UI. */
	why: string;
}

/**
 * What one prompt's reply still owes Forge's later questions (a scry's groups, a modal spell's
 * modes): `answer` replies to the next of them, or is null when `frame` is none of them.
 */
export interface Owed {
	why: string;
	answer(frame: Extract<ServerFrame, { kind: 'ask' }>): { result: unknown; owed: Owed | null } | null;
}

/** An {@link Owed} from what is `left` of a reply and how one later question is answered from it; null when nothing is left. */
export function owing<L>(why: string, left: L | null, next: (frame: Extract<ServerFrame, { kind: 'ask' }>, left: L) => { result: unknown; left: L | null } | null): Owed | null {
	if (left === null) return null;
	return {
		why,
		answer: (frame) => {
			const paid = next(frame, left);
			return paid === null ? null : { result: paid.result, owed: owing(why, paid.left, next) };
		},
	};
}

function ok(callId: string, method: string, result: unknown, why: string): AutoAnswer | null {
	// A malformed auto-answer must never reach the bridge: it would be refused a
	// hop later with no player to blame. Fall through to asking instead.
	const schema = (REPLY_SCHEMAS as Record<string, { safeParse(v: unknown): { success: boolean } }>)[method];
	if (schema === undefined || !schema.safeParse(result).success) return null;
	return { callId, method, result, why };
}

/* ── The policy: every stop preference, in one place ──────────────────── */

/**
 * How much of a mana payment Forge settles for the player.
 *
 * Every value presses Forge's own Auto button and nothing else, so
 * `ComputerUtilMana.payManaCost` — Forge's payer, not ours — decides how the
 * sources are tapped (`InputPayMana.java:377-386`). What the values differ on is
 * WHEN that press is allowed:
 *
 *  - `'ask'` — never. Every payment is the player's to click.
 *  - `'auto'` — only where the wire PROVES nothing was left out: one offered
 *    source, or Forge's own auto-tap plan accounting for every offered source.
 *    See {@link decidePay}.
 *  - `'forgeAuto'` — whenever Forge's own Auto button is live, which is Forge
 *    saying `getManaSourcesToPayCost` found a payment
 *    (`InputPayMana.java:402-407`, `:438-452`). This is the value item 6 asks
 *    for and it is **not** the default; {@link StopPolicy.unambiguousPayment}
 *    records why.
 */
export type PaymentPreference = 'ask' | 'auto' | 'forgeAuto';

/** Where {@link StopPolicy.skipNonStopPhases} applies. */
export type SkipScope = 'never' | 'theirTurn' | 'always';

/**
 * The player's stop preferences. **This is the model.**
 *
 * Each field names a Forge concept, and {@link toYieldUpdates} maps it to the
 * `YieldUpdate` arm that carries it:
 *
 * | field | Forge |
 * | --- | --- |
 * | `stopOnMyTurn` / `stopOnTheirTurn` | the COMPLEMENT of `YieldController.skipPhases` (`YieldController.java:105-113`), carried by `YieldUpdate.SkipPhase` |
 * | `skipNonStopPhases` | whether a `skipPhases` set is sent at all |
 * | `passWhenNothingToDo` | `FPref.YIELD_AUTO_PASS_NO_ACTIONS` — APINA, `YieldController.isAutoPassingNoActions` (`:569-573`) |
 * | `interruptsRestoreStops` | `FPref.YIELD_AUTO_PASS_RESPECTS_INTERRUPTS` (`:507-518`) |
 * | `passStackWindows` | `YieldController.setAutoPassUntilStackEmpty` as a standing preference, carried by `YieldUpdate.StackYield` |
 * | `unambiguousPayment` | `FPref.UI_SHOW_AUTOTAP_PREVIEW` — the pref that puts Forge's own auto-tap PLAN on our wire, which is what makes "unambiguous" provable |
 * | `unpayableCost` | Forge's own `Auto` button being DEAD, which is `ensureAutoPayManaSources` finding no payment (`InputPayMana.java:402-407`) |
 */
export interface StopPolicy {
	/** Phases the player wants priority in on their OWN turn, with an empty stack. */
	readonly stopOnMyTurn: readonly PhaseType[];
	/** Phases the player wants priority in on any OTHER player's turn. */
	readonly stopOnTheirTurn: readonly PhaseType[];
	/**
	 * Phases on any OTHER player's turn that hold priority **only when the seat has a
	 * real play there** — the {@link PromptFacts.nonManaSources} test the attack and
	 * block windows use: an affordable instant or non-mana ability, never a land or
	 * rock offered for its mana. With nothing to do the phase is skipped like any
	 * other outside {@link stopOnTheirTurn}. Kept windows log `play-stop`.
	 *
	 * The operator, 2026-10-13: *"End step always stop if something can be used. on
	 * by default it should be checked on in the settings, and it can be turned
	 * off."* — the opponent's End step, the classic window for a held instant. This
	 * is a stop conditioned on what the seat holds, which the file header explains
	 * wave 28 refused for what it tells the table; the operator chose the window
	 * over that leak, and the settings checkbox (`socket.ts`'s
	 * `forge:stop-preference`) takes `END_OF_TURN` out of this set for a seat that
	 * would rather not. It replaced wave 30's unconditional End step stop
	 * (`stopOnTheirTurn`), which held a seat with nothing to do.
	 */
	readonly stopWithPlayOnTheirTurn: readonly PhaseType[];
	/**
	 * {@link stopWithPlayOnTheirTurn} for the seat's OWN turn: phases that hold its priority
	 * with an empty stack only when it has a real play there. Kept windows log `play-stop`.
	 *
	 * A combat step in either set holds only in a combat somebody attacked in
	 * ({@link PromptFacts.attackers}): Forge opens Declare Attackers whether or not anything
	 * attacks, and an instant held for a combat has nothing to answer in an empty one.
	 *
	 * The operator, 2026-10-14: *"wasn't given priority in blockers even though they could
	 * activate quirion. actually it happened again, my opponent attacked and i had swords to
	 * plowshares in my hand, it never gave me priority in combat."* The defender's Declare
	 * Attackers was outside every stop set, its Declare Blockers stop is dropped for a seat with
	 * no creature ({@link skipEmptyBlockStop}), and the attacker's own Declare Blockers was outside
	 * {@link stopOnMyTurn} — each skipped as `skip-phase` before the play test was ever read.
	 */
	readonly stopWithPlayOnMyTurn: readonly PhaseType[];
	/**
	 * Whether a phase outside the stop sets is passed **regardless of what the
	 * seat could do there** — Forge's `skipPhases`, and the whole of item #20.
	 *
	 * `'never'` is wave 20's behaviour: only a window Forge itself said is empty
	 * is passed. `'theirTurn'` and `'always'` are Arena's model.
	 */
	readonly skipNonStopPhases: SkipScope;
	/** Pass a window where Forge named nothing actionable (APINA). */
	readonly passWhenNothingToDo: boolean;
	/** An interrupt (an opponent's spell, an attack, a reveal) restores the stops. */
	readonly interruptsRestoreStops: boolean;
	/** Pass a priority window with something ON the stack and nothing to do (#5). */
	readonly passStackWindows: boolean;
	/**
	 * How a payment Forge can settle with no choice left is handled (#6, #22).
	 *
	 * **`'forgeAuto'` is the default as of 2026-09-27**, by the operator, having
	 * been shown the trade. Wave 25 §D added the value and left it unadopted; the
	 * finding behind that caution still stands and is worth keeping, because it is
	 * why the strict values cannot close item 6 on their own.
	 *
	 * Forge's payment-mode actionable set is *every card in five zones with a
	 * playable mana ability* (`PlayerControllerHuman.pushActionableCards`, the
	 * payment branch at `:1565-1573`; `cardHasPlayableManaAbility` `:1594-1599`;
	 * the zones at `:1533-1535`) — **not** the cards that can pay THIS cost. So
	 * one Mountain and one Island for `{R}` (ONE payment) and two Mountains for
	 * `{R}` (TWO) reach us as the same facts: two sources, and a one-card plan
	 * that leaves one of them out. Nothing on this wire tells them apart, and
	 * deciding that an Island cannot pay red is a rule — which this file
	 * implements none of.
	 *
	 * So the choice was never "be cleverer"; it was whose auto-tap decides. The
	 * operator's answer, on item 6 (*"there is only one red mana source on my
	 * battlefield, why is galvanic blast asking me how to pay?"*): Forge's.
	 * `'forgeAuto'` presses Forge's own Auto whenever Forge has it live, which is
	 * Forge saying it found a payment — so an ambiguous cost is settled by Forge's
	 * plan rather than asked. `FULL_CONTROL_POLICY` keeps `'ask'`, which is the
	 * escape, and `'auto'` remains for a policy that wants provable-only.
	 *
	 * **Pre-tapping is unaffected**, and that is a property of WHEN this fires
	 * rather than a case handled here: mana floated before a cast is already in
	 * Forge's pool when the payment input opens, Forge applies the pool first, and
	 * Auto covers only what is left. The pool is `PlayerView.Mana` on the wire and
	 * nothing in our UI draws it yet — see the board.
	 */
	readonly unambiguousPayment: PaymentPreference;
	/**
	 * What becomes of a cost **Forge itself says cannot be paid** (item 7).
	 *
	 * `'cancel'` presses Forge's own Cancel, the only live answer such a window
	 * has; `'ask'` leaves the player to press it. See {@link answerability} and
	 * {@link PromptFacts.noWayToPay}.
	 */
	readonly unpayableCost: 'ask' | 'cancel';
	/**
	 * Skip the Declare Blockers stop when this seat controls no creature (Q10).
	 *
	 * The operator, 2026-10-01: *"no creatures, no block."* A stop at the opponent's
	 * Declare Blockers step is there so the seat can block, and a seat with no
	 * creature cannot. w28 refused condition-driven stops because a stop that fires
	 * only when something is castable leaks a HAND; this condition leaks only *"I have
	 * no creatures"*, which is on the battlefield for everyone to read
	 * ({@link PromptFacts.creatures}). Summoning sickness does not enter into it: a
	 * summoning-sick creature can block, so it counts.
	 *
	 * Full control keeps the stop, as it keeps every stop.
	 */
	readonly skipEmptyBlockStop: boolean;
	/**
	 * A phase outside the stop sets is NOT skipped when a permanent the seat
	 * controls has an ability activatable now that is restricted to this phase
	 * (wave 52 §S A).
	 *
	 * The operator, 2026-10-06: *"i have a creature (Augur of Skulls) that has
	 * 'Sacrifice .... Play this ability only during your upkeep' i would expect
	 * the shortcutter not to skip past my upkeep."* `skipNonStopPhases: 'always'`
	 * passed that upkeep every turn, and the ability can be used nowhere else.
	 * This does not reopen wave 28's rule: the fact
	 * ({@link PromptFacts.phaseRestricted}) names battlefield permanents only, so
	 * the stop tells the table nothing it cannot read off the board. A held
	 * instant still never stops a phase, and neither does an ability that works in
	 * every phase (Augur's own regenerate), or every phase would stop again.
	 *
	 * Full control keeps every stop anyway.
	 */
	readonly stopForPhaseAbility: boolean;
	/**
	 * The seat's own Beginning of Combat is NOT skipped when it controls a
	 * permanent that can make itself a creature now and attack ({@link PromptFacts.animates}).
	 *
	 * The operator, 2026-10-23: *"is it possible to try and detect when a player
	 * has a man-land or a man-artifact they need to activate in the beginning of
	 * combat step? at the moment the game auto-progresses through this and
	 * doesn't give the player a chance to activate their lands"*. A man-land
	 * animated in Main 1 meets the opponent's sorcery-speed answers; Beginning of
	 * Combat is where it is animated. Like {@link StopPolicy.stopForPhaseAbility}, the fact
	 * names battlefield permanents only, and a held instant still stops nothing.
	 */
	readonly stopToAnimate: boolean;
	/**
	 * The Declare Attackers stop IS the declaration (T3).
	 *
	 * The operator, 2026-10-03: *"theres an extra ok after declare attackers which
	 * doesn't make sense."* `stopOnMyTurn` names COMBAT_DECLARE_ATTACKERS so the seat
	 * gets Forge's attack input. Once that input closes, Forge gives the same seat
	 * priority in the same step, and that window was stopped AGAIN as "a stop
	 * phase" with nothing offered — a second OK with nothing in it
	 * (`wave36-evidence/e3-extra-ok.md`). With this on, the post-declaration
	 * priority window is judged by {@link passWhenNothingToDo} like any other
	 * window: it passes when nothing but mana sources is actionable, and still stops when
	 * a spell could be cast — a pump after attackers are declared is real play.
	 * Regressed once (the operator, 2026-10-12: *"theres ALWAYS a second 'next phase'
	 * click required"*): a land offered for its mana with an unaffordable animation
	 * beside it (Celestial Colonnade) counted as a play until the bridge's `manaOnly`
	 * asked Forge's own affordability test ({@link SeatNotes.manaOnlyIds}).
	 * The attack input itself is not a priority window, so it is never pressed for.
	 *
	 * Full control keeps the stop, as it keeps every stop.
	 */
	readonly attackStopIsTheDeclaration: boolean;
	/**
	 * The Declare Blockers stop IS the declaration — the non-active seat's own
	 * mirror of {@link attackStopIsTheDeclaration}.
	 *
	 * Playtest 8, the operator, 2026-10-05: *"had to click twice for declaring
	 * blockers? probably not a bug but just make sure."* It was a bug: Forge
	 * gives the defender ordinary priority in the SAME `COMBAT_DECLARE_BLOCKERS`
	 * step right after the block is assigned, and that window was held open
	 * unconditionally — `isStopPhase` names the phase, so nothing but
	 * {@link skipEmptyBlockStop} (a DIFFERENT seat shape: no creature at all) ever
	 * let it go, regardless of what the seat could do there. A defender with
	 * nothing castable still had to press OK a second time for no reason —
	 * confirmed against a real Forge match holding nothing (`w46-block-stop.
	 * match.jvm.test.ts`'s idle variant).
	 *
	 * With this on, the DECLARATION ITSELF is untouched and is never passed —
	 * it is a `getChoices`-style `other` window, not a `Priority:` one, so
	 * `decideStop`'s own `window !== 'priority'` guard already refuses it before
	 * this field is ever read. Only the ordinary priority window that follows is
	 * judged by {@link passWhenNothingToDo} like any other window, same as the
	 * attack step: it passes when nothing but mana sources is actionable, and still
	 * stops when a spell could be cast — a held instant is cast exactly where it
	 * always was, the moment after blocks are locked in (confirmed: the reactive
	 * variant, holding Lightning Bolt and a Mountain, still stops).
	 *
	 * Full control keeps the stop, as it keeps every stop.
	 */
	readonly blockStopIsTheDeclaration: boolean;
	/**
	 * Pass priority after casting: a window whose top-of-stack item the seat itself
	 * activated is passed whatever the seat could do (Q17).
	 *
	 * The operator, twice (the first list's item 12, then Q17, 2026-10-01): *"holding
	 * priority on my own spells is weird, why is that still happening?"* Forge gives
	 * priority back to the caster, and a stack window was passed only when Forge named
	 * nothing castable (`passWhenNothingToDo`) — so with a second instant in hand and
	 * an untapped land the caster sat at its own spell until it clicked OK. That is
	 * the leak wave 28 removed from the phases, still standing on the stack: a stop
	 * conditioned on what the seat could do is conditioned on what it HOLDS, and every
	 * cast was telling the table whether the hand held another response. Arena passes
	 * the caster's priority on, and a held response is what full control is for.
	 *
	 * An item the OPPONENT put on the stack is untouched: responding to it is the
	 * point of a held instant, and that window is still a stop when the seat has one.
	 * Full control keeps every stop. See `docs/planning/wave32-evidence/q17-holding-priority.md`.
	 */
	readonly passOwnSpell: boolean;
	/**
	 * {@link passOwnSpell}'s one exception: the seat's own spell is kept when Forge
	 * offers it a card that copies spells and the spell is a target for it
	 * (`copy-available`, {@link PromptFacts.spellCopiers}).
	 *
	 * The operator, 2026-10-19: *"for instant cards that copy spells like lutri and
	 * others of that nature can we default to having the player hold priority after
	 * casting any spell that is a valid target for those? (assuming the copy spell is
	 * playable)"* — passing the caster's priority on its own spell skips the only
	 * moment Twincast, Lutri or Dualcaster Mage can be played. It is the leak Q17
	 * removed, brought back for this one shape at the operator's choice.
	 */
	readonly holdForSpellCopy: boolean;
	/**
	 * How the order of simultaneous abilities and replacement effects is settled
	 * (Q8). *"Select order for simultaneous abilities"* is Forge's
	 * `getGui().order(...)` (`PlayerControllerHuman.java:2309-2313`, `:2136`), and
	 * it is the only `order` ask Forge sends with the remember-this checkbox.
	 *
	 *  - `'forge'` answers it with the order Forge itself offered (its own
	 *    `activePlayerSAs` order), unremembered, so a trigger pile does not stop the
	 *    game every time.
	 *  - `'ask'` puts it to the player, which is what full control is for.
	 */
	readonly orderSimultaneous: 'ask' | 'forge';
}

/**
 * What a seat gets **unless something set it another one** — a seat carries its
 * own policy since wave 26 §E (`match.ts`, `SeatState.policy`), and this is the
 * value it starts from.
 *
 * It was behaviour-identical to waves 20 and 22 until 2026-09-27, when the
 * operator moved `unambiguousPayment` to `'forgeAuto'` (item 6), and it took
 * Arena's stop set on 2026-09-28 (wave 28, item 5) for the reason the file
 * header gives: **a stop conditioned on what the seat could do is a stop
 * conditioned on what the seat holds.** The suites that assert a payment is the
 * PLAYER's to click name {@link STRICT_PAYMENT_POLICY} on their seats instead of
 * riding on this default; the ones that want a stop in every priority window
 * name {@link EVERY_PRIORITY_POLICY}.
 */
export const DEFAULT_STOP_POLICY: StopPolicy = {
	// #7, wave 20: *"dont auto-pass peoples turns"* — the entry to your own main
	// phase is where the player is entitled to look at the board. Wave 28 adds
	// declare-attackers, because with `skipNonStopPhases: 'always'` below it is
	// the ONLY window an attack can be declared in (item 6's attack control).
	stopOnMyTurn: ['MAIN1', 'MAIN2', 'COMBAT_DECLARE_ATTACKERS'],
	// Wave 28, item 5: not empty, and that is the whole care in THAT change — with
	// `'always'` and an empty set the seat gets no window on the opponent's turn
	// at all, so a held instant could never be cast. Declare-blockers is where it
	// is cast against an attack; wave 28 also held the end step open as a second
	// window, for the same reason.
	//
	// Wave 30, item 2 removes `END_OF_TURN`: *"i played a land and clicked 'end
	// turn' and the phase counter stopped at endstep… it always waits on opponent
	// at endstep now, that wasn't happening before and it's not a desired
	// behavior."* The window for a held instant came back on 2026-10-13 as
	// `stopWithPlayOnTheirTurn` below, which holds the End step only when the
	// seat has a play there. `COMBAT_DECLARE_BLOCKERS` stays: the operator objected to the
	// END-STEP wait specifically, and blocking IS a decision a seat must make —
	// the DECLARATION is never passed, whatever it holds (it is not even a
	// `Priority:` window). The ordinary priority window Forge opens right after
	// the block is a DIFFERENT thing, and wave 46 §C found it was stopping
	// unconditionally too, with nothing to do there — see
	// `blockStopIsTheDeclaration`, the non-active seat's mirror of
	// `attackStopIsTheDeclaration` just below. The escape the operator named
	// is `FULL_CONTROL_POLICY`, which still keeps every stop.
	stopOnTheirTurn: ['COMBAT_DECLARE_BLOCKERS'],
	// AF28, 2026-10-13. *"End step always stop if something can be used."* The
	// settings checkbox moves it (`socket.ts`'s `forge:stop-preference`).
	stopWithPlayOnTheirTurn: ['COMBAT_DECLARE_ATTACKERS', 'COMBAT_DECLARE_BLOCKERS', 'END_OF_TURN'],
	// The attacker's window after blocks, for a pump or an untap (Quirion Ranger).
	stopWithPlayOnMyTurn: ['COMBAT_DECLARE_BLOCKERS'],
	// Item 5, wave 28: *"upkeep stops like this should not happen unless in full
	// control mode. it's stopping everywhere, super annoying."* — and the leak
	// argument above, which is the part that outlives the annoyance.
	skipNonStopPhases: 'always',
	passWhenNothingToDo: true,
	interruptsRestoreStops: true,
	// #5, wave 20: *"ridiculous. just resolve it"*.
	passStackWindows: true,
	// #6, wave 20: *"Preordain asks how to tap lands with ONE land in play"*, and
	// item 6, wave 25: *"why is galvanic blast asking me how to pay?"* — which
	// only `'forgeAuto'` closes, for the reason the field's doc gives. Operator's
	// choice, 2026-09-27, having been shown what it costs.
	unambiguousPayment: 'forgeAuto',
	// Item 7, wave 25: *"it's confusing i have to click 'cancel' to not pay
	// manaleak when i dont even have enough mana"*.
	unpayableCost: 'cancel',
	// Q10, wave 32. *"no creatures, no block."*
	skipEmptyBlockStop: true,
	// Wave 52 §S A. *"i would expect the shortcutter not to skip past my upkeep."*
	stopForPhaseAbility: true,
	stopToAnimate: true,
	attackStopIsTheDeclaration: true,
	// Wave 46 §C. *"had to click twice for declaring blockers?"*
	blockStopIsTheDeclaration: true,
	// Q17, wave 32. *"holding priority on my own spells is weird."*
	passOwnSpell: true,
	// 2026-10-19. *"hold priority after casting any spell that is a valid target"* for a copier.
	holdForSpellCopy: true,
	// Q8, wave 32. Ordering is a full-control thing: Forge's own order unless asked.
	orderSimultaneous: 'forge',
};

/**
 * The default, with payments handed back to the player wherever the WIRE does
 * not prove the choice was made for them — `'auto'`, which was the default
 * until 2026-09-27.
 *
 * It is a named value rather than a spelled-out object because two callers need
 * exactly it and for the same reason: a seat that wants to CLICK its own lands.
 * `auto.test.ts` keeps every strict case of {@link decidePay} under it, and
 * `apps/ui/src/play/live/board-play.jvm.test.ts` runs its seats under it so
 * that step 3 — two Mountains untapped, one `{R}` to pay — is still a real
 * choice and is still paid by a click on a land. Under
 * {@link DEFAULT_STOP_POLICY} Forge's Auto settles that before a click can
 * happen, which is the whole point of the default and is why the strict value
 * has to stay reachable PER SEAT ({@link StopPolicy.unambiguousPayment}).
 */
export const STRICT_PAYMENT_POLICY: StopPolicy = {
	...DEFAULT_STOP_POLICY,
	unambiguousPayment: 'auto',
};

/**
 * The stop behaviour that was the default until 2026-09-28: a stop in **every**
 * priority window Forge did not itself call empty.
 *
 * A named value for the same reason {@link STRICT_PAYMENT_POLICY} is one — a
 * superseded default has to stay reachable, or "revert the change and watch the
 * test go red" is not a thing anyone can do. Wave 20's stop set, and
 * `skipNonStopPhases: 'never'`, which is what makes "could the seat do something
 * here" decide a stop again. That reading is exactly the leak the header
 * describes, so this is a value to pin a difference against, not one to run a
 * table on.
 */
export const EVERY_PRIORITY_POLICY: StopPolicy = {
	...DEFAULT_STOP_POLICY,
	stopOnMyTurn: ['MAIN1', 'MAIN2'],
	stopOnTheirTurn: [],
	skipNonStopPhases: 'never',
};

/**
 * The escape hatch, exact: every stop comes back.
 *
 * Every phase on every turn is a stop phase, a stack window is not passed, a
 * window with nothing to do is not passed, a payment is not pressed, a cost
 * Forge cannot pay is not cancelled for the player, and simultaneous triggers
 * are the player's to order. An ask with one legal reply is still answered:
 * one possible answer is no question in any mode (the operator, 2026-10-19).
 */
export const FULL_CONTROL_POLICY: StopPolicy = {
	stopOnMyTurn: PHASE_TYPES,
	stopOnTheirTurn: PHASE_TYPES,
	stopWithPlayOnTheirTurn: [],
	stopWithPlayOnMyTurn: [],
	skipNonStopPhases: 'never',
	passWhenNothingToDo: false,
	interruptsRestoreStops: true,
	passStackWindows: false,
	unambiguousPayment: 'ask',
	unpayableCost: 'ask',
	skipEmptyBlockStop: false,
	stopForPhaseAbility: true,
	stopToAnimate: true,
	attackStopIsTheDeclaration: false,
	blockStopIsTheDeclaration: false,
	passOwnSpell: false,
	holdForSpellCopy: true,
	orderSimultaneous: 'ask',
};

/**
 * `policy` with the End step stop for a play ({@link StopPolicy.stopWithPlayOnTheirTurn})
 * on or off, every other field untouched — the settings checkbox, `forge:stop-preference`.
 * The same object back when it already agrees, so a caller can skip a no-op.
 */
export function withEndStepStop(policy: StopPolicy, on: boolean): StopPolicy {
	if (policy.stopWithPlayOnTheirTurn.includes('END_OF_TURN') === on) return policy;
	const rest = policy.stopWithPlayOnTheirTurn.filter((p) => p !== 'END_OF_TURN');
	return { ...policy, stopWithPlayOnTheirTurn: on ? [...rest, 'END_OF_TURN'] : rest };
}

/**
 * The policies a NAME can select — the whole of what wave 27 §C added here.
 *
 * Wave 26 §E made the policy per-seat (`match.ts`, `SeatState.policy`), and
 * nothing outside a unit test could choose one: the values above are module
 * constants, so selecting `STRICT_PAYMENT_POLICY` meant importing it. That is
 * why nobody could screenshot a live payment — under
 * {@link DEFAULT_STOP_POLICY} Forge's own Auto answers the payment before a
 * browser is shown it.
 *
 * So: a name, resolved by {@link namedStopPolicy}, which is what
 * `socket.ts`'s `CARDTABLE_PLAY_STOP_POLICY` hatch carries. This is the
 * SELECTOR and nothing else — it re-plumbs nothing, it adds no field to
 * {@link StopPolicy}, and every value in it already existed above.
 *
 * A `Map` and not an object literal, and that is not a style choice: a
 * plain-object registry looked up with `reg[name]` answers `'toString'` and
 * `'constructor'` with `Object.prototype`'s own members, so a typo'd
 * environment variable could hand a FUNCTION to a seat as its policy. A `Map`
 * has no prototype chain to walk.
 *
 * `'arena'` names {@link DEFAULT_STOP_POLICY} directly (S1, wave 64): the two
 * were ever only one value under two names — wave 24 §E wrote
 * `ARENA_STOP_POLICY` as its own constant, and wave 28 made `DEFAULT_STOP_POLICY`
 * equal to it rather than ever diverging — so there was no second VALUE for a
 * second export to carry. The alias stays reachable (the wire name must not
 * stop answering to a name it once did), just with no module constant behind it.
 *
 * **Narrowed, wave 64 §S (S3).** `'everyPriority'` and `'fullControl'` used to
 * resolve here too. Neither had a documented reason to be chosen from an
 * ENVIRONMENT: `'fullControl'` is {@link FULL_CONTROL_POLICY}, the policy
 * VALUE, and selecting it this way is a second route to exactly what
 * `SeatState.fullControl` already gives — the per-seat escape hatch, set over
 * the wire by the player, which `match.ts` checks *ahead of* a seat's policy on
 * every gate. Nothing in `docs/` names a reason an operator would reach for the
 * env hatch instead of the wire flag, so that route is gone; the flag is the
 * one path. `'everyPriority'` had no documented env-side use either — the
 * suites that still want wave 20's behaviour (`auto.test.ts`,
 * `apps/ui/src/play/live/*.jvm.test.ts`) import {@link EVERY_PRIORITY_POLICY}
 * directly, never through this hatch. Both constants are still exported and
 * still pinned by those suites; only the env NAME is gone, so
 * `CARDTABLE_PLAY_STOP_POLICY` answers to exactly the names a documented
 * operator path uses — `default`, `strictPayment`, `arena` — same as before
 * for all three, and loud (`stop-policy-unknown`) for the two it dropped.
 */
export const NAMED_STOP_POLICIES: ReadonlyMap<string, StopPolicy> = new Map<string, StopPolicy>([
	['default', DEFAULT_STOP_POLICY],
	['strictPayment', STRICT_PAYMENT_POLICY],
	['arena', DEFAULT_STOP_POLICY],
]);

/** The names {@link namedStopPolicy} answers to, for a refusal that can say so. */
export const STOP_POLICY_NAMES: readonly string[] = [...NAMED_STOP_POLICIES.keys()];

/**
 * The policy this name selects, or null when it names none.
 *
 * Null rather than a throw and rather than a silent fall back to the default:
 * the caller is a hatch read off an environment, and an environment with a
 * typo in it must be able to SAY so (`socket.ts` logs `stop-policy-unknown`)
 * rather than quietly playing under the default the operator was trying to
 * move off.
 */
export function namedStopPolicy(name: string | undefined | null): StopPolicy | null {
	if (name === undefined || name === null) return null;
	return NAMED_STOP_POLICIES.get(name.trim()) ?? null;
}

/* ── Asks Forge left one legal reply to ──────────────────────────────── */

/**
 * The single answer this ask admits, or null when the choice is real.
 *
 * Read each case as "Forge left one possibility", never as "this is the good
 * play". `confirm`, `showConfirmDialog`, `showInputDialog`, `assignGenericAmount`
 * and `sideboard` are never auto-answered: each is a real question. Combat damage
 * is answered only when Forge's own facts in the ask leave one division
 * (`@hadoku/shared`'s `onlyCombatDamage`): a trampler blocked by a creature
 * that needs every point of it. There is no
 * prose in here and there never was — the rules are bounds arithmetic.
 *
 * A one-ability `getAbilityToPlay` is answered with that ability, by `@hadoku/shared`'s
 * `oneAbility` (a land card's offer off the battlefield is the seat's own). Forge asks it
 * for every trigger it puts on the stack (`PlaySpellAbility.
 * chooseOptionalAdditionalCosts`, reached from `orderAndPlaySimultaneousSa`),
 * with the trigger as the only option, and a trigger nobody clicked is not the
 * player's question. The one offer `match.ts` keeps from this rule is the one
 * the seat's own click opened: the browser answers that one (`@hadoku/shared`'s
 * `selfAnswer`) so it can SAY what was played. Payment
 * never produces a one-ability offer: `InputPayMana.activateCard` plays a
 * single mana ability without asking (`InputPayMana.java:101-106`) and only
 * calls `getAbilityToPlay` for two or more — which is #6, and which
 * {@link decidePay} removes by pressing Auto before the land is ever clicked.
 *
 * An ask in which nothing may be chosen (`max <= 0`) never reaches this: it is
 * a reveal, answered and shown by `match.ts` before any ask is opened.
 */
export function onlyAnswer(frame: ServerFrame, policy: StopPolicy = DEFAULT_STOP_POLICY): AutoAnswer | null {
	if (frame.kind !== 'ask') return null;
	const callId = frame.callId;
	switch (frame.method) {

		case 'getChoices': {
			const keys = frame.names ?? frame.choices.map((c) => c.key);
			if (frame.min === keys.length && frame.max >= keys.length) {
				return ok(callId, frame.method, keys, 'every option had to be chosen');
			}
			if (keys.length === 1 && frame.min === 1) return ok(callId, frame.method, keys, 'one option');
			return null;
		}

		case 'chooseSingleEntityForEffect':
			return frame.optionList.length === 1 && !frame.isOptional
				? ok(callId, frame.method, frame.optionList[0], 'one option, not optional')
				: null;

		case 'chooseEntitiesForEffect':
			return frame.min === frame.optionList.length && frame.max >= frame.optionList.length
				? ok(callId, frame.method, frame.optionList, 'every option had to be chosen')
				: null;

		case 'showOptionDialog':
			return frame.options.length === 1 ? ok(callId, frame.method, 0, 'one button') : null;

		case 'getAbilityToPlay': {
			const only = oneAbility(frame);
			return only === null ? null : ok(callId, frame.method, only, 'one ability');
		}

		case 'assignCombatDamage': {
			const only = onlyCombatDamage(frame);
			return only === null ? null : ok(callId, frame.method, only, 'one legal division: the blockers need all of it');
		}

		case 'order': {
			// One item that must be placed has exactly one arrangement. With any
			// slack (`remainingObjectsMax > 0`) leaving it unplaced is a second
			// answer, so that stays a question.
			const all = [...frame.sourceChoices, ...frame.destChoices];
			if (all.length === 1 && frame.remainingObjectsMax === 0 && all[0] !== undefined) {
				return ok(callId, frame.method, { ordered: [all[0].key], rememberDecision: false }, 'one item, no slack');
			}
			// Q8: "Select order for simultaneous abilities" (and for replacement
			// effects) is the only `order` Forge asks WITH the remember checkbox
			// (`PlayerControllerHuman.java:2309-2313`, `:2136`; the library, damage
			// and cost orderings pass none). The list it hands over is already in
			// FORGE's own order (`activePlayerSAs`), and answering with it unchanged is
			// what Forge itself does when it gets no choice (`chosen == null` → the
			// same list), so this takes the order Forge offered and asks about no more.
			// Exactly one side holds the items: the first-time ask carries them all in
			// `sourceChoices`, the re-order ask in `destChoices`.
			if (policy.orderSimultaneous === 'forge' && frame.showRememberCheckbox && frame.remainingObjectsMin === 0) {
				const side =
					frame.destChoices.length === 0 ? frame.sourceChoices : frame.sourceChoices.length === 0 ? frame.destChoices : null;
				if (side !== null && side.length > 0) {
					return ok(callId, frame.method, { ordered: side.map((c) => c.key), rememberDecision: false }, "Forge's own order");
				}
			}
			return null;
		}

		default:
			return null;
	}
}

/**
 * Wave 34 §S4 — Forge's own answer to a `getAbilityToPlay` it is re-asking
 * itself, not the player.
 *
 * The offer a seat's own click opened is answered by the browser, not by
 * {@link onlyAnswer} (its own comment says why). Behind it sits a genuine Forge
 * quirk, confirmed against a real jar: casting ANY single ability — a spell, an activated ability, even
 * tapping a land for mana — sends `getAbilityToPlay` TWICE, with the SAME
 * host card and the SAME one ability both times, from TWO different places:
 * once from whichever `Input` read the click (`InputPassPriority.
 * onCardSelected`, `InputPayManaOfCostPayment`'s mana-ability path), and a
 * second time, unconditionally, from forge-game's own `PlaySpellAbility.
 * chooseOptionalAdditionalCosts` — called in the gap BETWEEN two Inputs
 * (measured directly off a live match's own `InputQueue`: this seat's active
 * Input is already `null` by the second round, not a new `Input` instance —
 * ruling out "a different Input re-entering"), to offer an alternate
 * additional cost almost no card has. No act, no reply, no retry of ours
 * sits between the two rounds. Full trace in
 * `docs/planning/wave34-evidence/s4-repeated-ask.md`.
 *
 * That second round is not a new decision for the player to make: it is
 * Forge re-asking the one it already has the answer to. Pure over `last`
 * (`SeatState.lastAbilityToPlay`, the host card + ability id this seat was
 * just given an answer for) and the frame — answers a `getAbilityToPlay`
 * offering exactly that one ability again, with that same ability,
 * regardless of policy or full control, because collapsing it removes no
 * decision the player could have made differently. A DIFFERENT host card (a
 * land's own mana ability, offered once and never repeated in the same
 * trace) never matches, so this never reaches past the one ask it exists for.
 */
export function repeatedAbilityToPlay(
	frame: ServerFrame,
	last: { hostCard: number; abilityId: number } | null,
): AutoAnswer | null {
	if (frame.kind !== 'ask' || frame.method !== 'getAbilityToPlay' || last === null) return null;
	if (frame.abilities.length !== 1) return null;
	const only = frame.abilities[0];
	if (only === undefined || frame.hostCard.id !== last.hostCard || only.id !== last.abilityId) return null;
	return ok(frame.callId, frame.method, only, 'forge re-asked its own already-answered getAbilityToPlay');
}

/* ── What a seat was last told ───────────────────────────────────────── */

/** What a seat was last told, as far as the stop decisions are concerned. */
export interface SeatNotes {
	/** This seat's Forge `PlayerView` id, once `openView` has named it. */
	playerId: number | null;
	/** The latest `showPromptMessage` for this seat. */
	prompt: ServerFrame | null;
	/** The latest `updateButtons` for this seat. */
	buttons: ServerFrame | null;
	/**
	 * Forge's actionable MULTISET from `setWeaklySelectable`: a set (possibly
	 * empty) is an answer, `null` is "Forge has not said" (never said, or
	 * cleared). Duplicates are Forge's own weighting and are load-bearing — see
	 * {@link PromptFacts.plannedSources}.
	 */
	actionable: readonly number[] | null;
	/** Asks this seat has open. A seat with a question is not idle. */
	openAsks: number;
	/**
	 * How many creatures this seat's own battlefield holds; null when not known
	 * (`SeatProjector.creatureCount`). Optional so a caller with no board — the
	 * unit suites — says nothing, which reads as "ask".
	 */
	creatures?: number | null;
	/** The player id that activated the top stack item, or null (`SeatProjector.stackTopActivator`). */
	stackTopActivator?: number | null;
	/** The top stack item's core types when it is a SPELL, else null (`SeatProjector.stackTopSpellTypes`). */
	stackTopTypes?: readonly string[] | null;
	/**
	 * For each `actionable` id that copies spells from where it sits, the copies it
	 * offers (`spell-copiers.ts`, off Forge's own scripts). Ids that copy nothing are absent.
	 */
	spellCopiers?: ReadonlyMap<number, readonly SpellCopy[]>;
	/**
	 * The ids among `actionable` that are no play — the bridge's
	 * `setWeaklySelectable.manaOnly`: offered for their mana (or a mana tap's
	 * undo) with no non-mana ability the seat can take now, read off Forge's own
	 * abilities and Forge's own affordability test, never the card's type. A
	 * Forest, a Signet, a Celestial Colonnade whose animation the seat cannot pay
	 * for are in it; a Ghost Quarter or a fetchland is not (its sacrifice ability
	 * is a real play). The ONE fact
	 * {@link PromptFacts.nonManaSources} filters by. Undefined (an older frame,
	 * or the bridge could not read it) filters nothing, which keeps the stop.
	 */
	manaOnlyIds?: ReadonlySet<number>;
	/**
	 * The bridge's `setWeaklySelectable.phaseRestricted` (wave 52 §S A): this
	 * seat's offered permanents with an ability restricted to the current phase.
	 */
	phaseRestrictedIds?: readonly number[];
	/** The bridge's `setWeaklySelectable.animates`: this seat's offered permanents that can make themselves a creature that could attack. */
	animatesIds?: readonly number[];
	/** The bridge's `setWeaklySelectable.attackers`: creatures attacking in the current combat, 0 outside one. */
	attackers?: number;
}

/* ── The structured facts the decisions are made on ──────────────────── */

/** Which of Forge's inputs this seat is sitting in, as far as we can tell. */
export type StopWindow = 'priority' | 'payment' | 'other';

/**
 * One window, as facts. **No prose, no spellings, no card names.**
 *
 * This is what {@link decideStop} and {@link decidePay} see, and it is what a
 * bridge that sent structured frames would send directly.
 */
export interface PromptFacts {
	/** Forge's input, classified. `'other'` is always a stop. */
	readonly window: StopWindow;
	/** Forge's own `PhaseType`, never its display spelling. Null when unknown. */
	readonly phase: PhaseType | null;
	/**
	 * The phase as Forge's UI spells it. **For the line the seat is shown, never
	 * for a decision** — `decideStop` returns it, it does not read it.
	 */
	readonly phaseLabel: string | null;
	/** The priority player and the turn player are the same: it is this seat's turn. */
	readonly myTurn: boolean;
	readonly stackEmpty: boolean;
	/** Both the prompt and the buttons are addressed to this seat's own player. */
	readonly mine: boolean;
	/** Forge's button 1 is live — the button a pass or a payment would press. */
	readonly confirmLive: boolean;
	/** The mana cost this payment is for, verbatim in Forge's braces. */
	readonly cost: string | null;
	/** This payment offers a NON-mana alternative (life), so it has two answers. */
	readonly alternativePayment: boolean;
	/**
	 * The floating pool pays this cost more than one way (`PlayBridge.java`'s `poolChoice`): which
	 * mana to spend is the player's (the operator, 2026-10-21), so Forge's Auto, which would pick
	 * for them, is never pressed over it.
	 */
	readonly poolChoice: boolean;
	/**
	 * **Forge says this cost cannot be paid** — item 7.
	 *
	 * Forge's payment input enables its own `Auto` button ONLY once
	 * `ensureAutoPayManaSources` has found a payment for the cost that is left
	 * (`InputPayMana.updateMessage`, `InputPayMana.java:402-407`, over
	 * `ComputerUtilMana.getManaSourcesToPayCost` at `:438-452`). So a payment
	 * window whose Auto is DEAD is Forge saying it found none. What Forge still
	 * offers to click there does not change that: the payment highlight is every
	 * card that pays some part of it (`InputPayMana.paysWith`), and part of a cost
	 * is no payment.
	 */
	readonly noWayToPay: boolean;
	/** Forge's button 2 is live — in a payment, its Cancel, live for exactly an optional payment (`InputPayMana.java:389-395`). */
	readonly cancelLive: boolean;
	/**
	 * The distinct cards Forge said this seat could click. Null is "has not said".
	 *
	 * **Not "the cards that can pay this cost".** In a payment window this is
	 * `pushActionableCards`' payment branch: every card in Hand, Battlefield,
	 * Graveyard, Exile or Command with ANY playable mana ability
	 * (`PlayerControllerHuman.java:1533-1535`, `:1565-1573`, `:1594-1599`). An
	 * Island is in it while `{R}` is being paid. Wave 25 §D measured that against
	 * a real Forge — one Mountain and one Island for `{R}` arrives as two sources
	 * — and it is why {@link StopPolicy.unambiguousPayment} cannot close item 6
	 * from this set alone.
	 */
	readonly sources: readonly number[] | null;
	/**
	 * {@link sources}, minus every card that is no play (`SeatNotes.manaOnlyIds`):
	 * what is left is what the seat could actually do. Decided per ABILITY, never
	 * per card type: a land with a non-mana ability the seat can take (Ghost
	 * Quarter, Rishadan Port, a fetchland, a man-land it can pay for) stays in,
	 * exactly as an affordable instant in hand would.
	 * `decideStop`'s "nothing left to do, pass" check reads THIS, never `sources`:
	 * Forge offers every untapped land and mana rock through the SAME actionable
	 * set at ordinary priority, so "the set is non-empty" does not mean "there is a
	 * real decision" — on a normal turn with any land untapped, `sources` is almost
	 * never empty. Tapping for mana is never, by itself, a reason to hold priority.
	 * `sources` itself and `plannedSources` stay on the RAW set:
	 * a land IS a legitimate payment source, and a payment decision must still see it.
	 */
	readonly nonManaSources: readonly number[] | null;
	/**
	 * This seat's permanents with an ability activatable now that is restricted
	 * to this phase (`SeatNotes.phaseRestrictedIds`); empty when none or unknown.
	 * Read only by {@link StopPolicy.stopForPhaseAbility}.
	 */
	readonly phaseRestricted: readonly number[];
	/**
	 * This seat's permanents that are not a creature now and can make themselves
	 * one that could attack — a man-land, a Vehicle's Crew (`SeatNotes.animatesIds`);
	 * empty when none or unknown. Read only by {@link StopPolicy.stopToAnimate}.
	 */
	readonly animates: readonly number[];
	/**
	 * The subset Forge's OWN auto-tap plan names.
	 *
	 * `pushActionableCards` raises a planned card to strength 2 by sending it
	 * twice (`PlayerControllerHuman.java:1580-1589`), gated on
	 * `FPref.UI_SHOW_AUTOTAP_PREVIEW`. So a repeat in the multiset is Forge
	 * saying "Auto would tap this one" — which is what makes a two-source
	 * payment provably unambiguous (#22). With the pref off nothing repeats and
	 * this is empty, which costs only the wider case.
	 */
	readonly plannedSources: readonly number[];
	/** Asks this seat has open. */
	readonly openAsks: number;
	/**
	 * Creatures on this seat's own battlefield, or null when unknown. A fact off the
	 * board and not off the prompt; {@link StopPolicy.skipEmptyBlockStop} reads it.
	 */
	readonly creatures: number | null;
	/**
	 * The item on top of the stack was activated by THIS seat. False when the stack is
	 * empty, when the state does not say, and when it is somebody else's — a doubt is
	 * "not mine", which keeps the stop. Off the board, not the prompt.
	 */
	readonly stackTopMine: boolean;
	/** The top of the stack's core types when it is a spell; null when it is empty, an ability, or unknown. */
	readonly stackTopTypes: readonly string[] | null;
	/**
	 * The offered cards that copy spells, with the copies each offers — Forge's own
	 * `CopySpellAbility` scripts, never a list of ours. Read only by
	 * {@link StopPolicy.holdForSpellCopy}, which also requires the card to be in
	 * {@link nonManaSources}, Forge's own "this can be played now".
	 */
	readonly spellCopiers: ReadonlyMap<number, readonly SpellCopy[]>;
	/**
	 * Creatures attacking in the game's current combat, 0 outside one; null when the bridge has
	 * not said, which a combat play-stop reads as an attack (a doubt keeps).
	 */
	readonly attackers: number | null;
}

/* ── THE ONE ADAPTER ─────────────────────────────────────────────────── */

/*
 * Everything from here to the end of `readPromptFacts` reads Forge's
 * human-readable prompt, and it is the ONLY code in this file that does.
 *
 * `Priority: …`, `Turn: N (…)`, `Phase: …`, `Stack: Empty` are
 * `InputBase.getTurnPhasePriorityMessage` (`InputBase.java:130-152`), with the
 * bridge's language pinned to `en-US` (`PlayBridge.java:1432`). A locale change
 * stops the shortcuts rather than mis-firing them: no match, no facts, every
 * window a stop.
 *
 * `Turn:` may carry a day/night marker after the bracket (`  [Day]`), so the
 * owner is read out of the brackets rather than to end of line. `Priority:` is
 * anchored at the START of the message, not per line: Forge writes it first and
 * nowhere else, and a stack description that happened to contain the word must
 * not read as one.
 *
 * **This adapter is a stand-in for a bridge that does not yet speak facts.**
 * When `PlayBridge` carries `sendYieldUpdate` and delegates
 * `isUiSetToSkipPhase` to the `YieldController`, Forge decides and every pattern
 * below stops being consulted. Nothing new belongs here: a new shortcut is a
 * field of {@link StopPolicy}.
 */

/** Exported for `match.ts`'s `promptShape`: the same patterns, never a second copy. */
export const PRIORITY = /^Priority: ([^\n]*)/;
const TURN_OWNER = /^Turn: \d+ \(([^)]*)\)/m;
const STACK_EMPTY = /^Stack: Empty$/m;
const PHASE_LINE = /^Phase: (.+)$/m;

/** `Pay Mana Cost: {U}` — Forge's own payment line (`en-US.properties:1797`). */
export const PAY_MANA = /^Pay Mana Cost: (.+)$/m;

/**
 * Forge's own word for button 1 of the payment input
 * (`InputPayMana.updateButtons` → `lblAuto`, `en-US.properties:518`). Enabled
 * only once `ensureAutoPayManaSources` has found a payment
 * (`InputPayMana.java:402-407`), so the label and the enabled flag together are
 * Forge saying "this cost can be paid automatically".
 */
const AUTO_BUTTON = 'Auto';

/**
 * `PhaseType.nameForUi` → the constant, for all thirteen phases.
 *
 * `PhaseType.java:16-28` names each constant's localizer key and
 * `en-US.properties:2480-2492` gives each key's English. This table is the exact
 * inverse of those two, and it is what turns the one place that reads a phase
 * SPELLING into a place that produces a Forge enum — so no decision below ever
 * compares a string.
 */
export const PHASE_BY_UI_NAME: Readonly<Record<string, PhaseType>> = {
	'Untap step': 'UNTAP',
	'Upkeep step': 'UPKEEP',
	'Draw step': 'DRAW',
	'Main phase, precombat': 'MAIN1',
	'Beginning of Combat Step': 'COMBAT_BEGIN',
	'Declare Attackers Step': 'COMBAT_DECLARE_ATTACKERS',
	'Declare Blockers Step': 'COMBAT_DECLARE_BLOCKERS',
	'First Strike Damage Step': 'COMBAT_FIRST_STRIKE_DAMAGE',
	'Combat Damage Step': 'COMBAT_DAMAGE',
	'End of Combat Step': 'COMBAT_END',
	'Main phase, postcombat': 'MAIN2',
	'End step': 'END_OF_TURN',
	'Cleanup step': 'CLEANUP',
};

/** What a window with nothing known about it looks like: every field says "ask". */
const UNKNOWN_WINDOW: PromptFacts = {
	window: 'other',
	phase: null,
	phaseLabel: null,
	myTurn: false,
	stackEmpty: false,
	mine: false,
	confirmLive: false,
	cost: null,
	alternativePayment: false,
	poolChoice: false,
	noWayToPay: false,
	cancelLive: false,
	sources: null,
	nonManaSources: null,
	phaseRestricted: [],
	animates: [],
	plannedSources: [],
	openAsks: 0,
	creatures: null,
	stackTopMine: false,
	stackTopTypes: null,
	spellCopiers: new Map(),
	attackers: null,
};

/** Ids that appear more than once in Forge's weighted multiset, deduplicated. */
function repeated(ids: readonly number[]): number[] {
	const seen = new Set<number>();
	const twice = new Set<number>();
	for (const id of ids) {
		if (seen.has(id)) twice.add(id);
		seen.add(id);
	}
	return [...twice];
}

/**
 * Forge's frames for this seat, as {@link PromptFacts}. **The only prose reader.**
 *
 * Returns {@link UNKNOWN_WINDOW}'s shape whenever it cannot tell — which reads
 * as "ask the player" at every decision below.
 */
export function readPromptFacts(notes: SeatNotes): PromptFacts {
	const prompt = notes.prompt;
	const buttons = notes.buttons;
	if (prompt === null || prompt.method !== 'showPromptMessage') return { ...UNKNOWN_WINDOW, openAsks: notes.openAsks };
	if (buttons === null || buttons.method !== 'updateButtons') return { ...UNKNOWN_WINDOW, openAsks: notes.openAsks };

	const message = prompt.message;
	const mine =
		notes.playerId !== null && prompt.player.id === notes.playerId && buttons.owner.id === notes.playerId;

	const priority = PRIORITY.exec(message)?.[1];
	const owner = TURN_OWNER.exec(message)?.[1];
	const phaseLabel = PHASE_LINE.exec(message)?.[1] ?? null;
	const cost = PAY_MANA.exec(message)?.[1]?.trim() ?? null;

	// A payment window is Forge's payment input: it names a mana cost AND its
	// button 1 is Forge's own Auto. A priority window's button 1 is "OK".
	const window: StopWindow =
		cost !== null && buttons.label1 === AUTO_BUTTON ? 'payment' : priority !== undefined ? 'priority' : 'other';

	const all = notes.actionable;
	const manaOnly = notes.manaOnlyIds;
	return {
		window,
		phase: phaseLabel === null ? null : (PHASE_BY_UI_NAME[phaseLabel] ?? null),
		phaseLabel,
		myTurn: priority !== undefined && owner !== undefined && priority === owner,
		stackEmpty: STACK_EMPTY.test(message),
		mine,
		confirmLive: buttons.enable1 === true,
		cost,
		// Life is a second way to pay, and not a mana source: a prompt offering it has more than one payment however few lands are out.
		alternativePayment: LIFE_PAYMENT.test(message),
		poolChoice: prompt.poolChoice !== undefined,
		noWayToPay: window === 'payment' && buttons.enable1 !== true,
		cancelLive: buttons.enable2 === true,
		sources: all === null ? null : [...new Set(all)],
		nonManaSources: all === null ? null : [...new Set(all)].filter((id) => !(manaOnly?.has(id) ?? false)),
		phaseRestricted: notes.phaseRestrictedIds ?? [],
		animates: notes.animatesIds ?? [],
		plannedSources: all === null ? [] : repeated(all),
		openAsks: notes.openAsks,
		creatures: notes.creatures ?? null,
		stackTopMine: notes.playerId !== null && notes.stackTopActivator === notes.playerId,
		stackTopTypes: notes.stackTopTypes ?? null,
		spellCopiers: notes.spellCopiers ?? new Map(),
		attackers: notes.attackers ?? null,
	};
}

/* ── The decisions: pure over facts and the policy ───────────────────── */

/** Whether the player asked to hold priority in this phase on this turn. */
export function isStopPhase(policy: StopPolicy, facts: PromptFacts): boolean {
	if (facts.phase === null) return false;
	const stops = facts.myTurn ? policy.stopOnMyTurn : policy.stopOnTheirTurn;
	return stops.includes(facts.phase);
}

/**
 * Whether a phase outside the stop sets is skipped outright on this turn.
 *
 * **A phase we could not IDENTIFY is never skipped**, and wave 28 is when that
 * started to matter: `skipNonStopPhases: 'always'` is the default now, so a
 * label the adapter cannot map would otherwise pass every window it appears in.
 * `PHASE_BY_UI_NAME` covers all thirteen of Forge's spellings (`auto.test.ts`
 * pins that), so `phase === null` means Forge is saying something we have never
 * seen — which is the file's "when in doubt the player is asked", not a phase
 * the player asked to skip. The window still reaches
 * {@link StopPolicy.passWhenNothingToDo} below, so Forge's own "nothing here"
 * still passes it.
 */
function skipsThisTurn(policy: StopPolicy, facts: PromptFacts): boolean {
	if (facts.phase === null) return false;
	if (policy.skipNonStopPhases === 'always') return true;
	if (policy.skipNonStopPhases === 'theirTurn') return !facts.myTurn;
	return false;
}

/**
 * Declare Blockers, and this seat has no creature to block with (Q10).
 *
 * Only a COUNT of zero qualifies. Unknown (null) is a stop, as every doubt is.
 */
function blockStopIsEmpty(policy: StopPolicy, facts: PromptFacts): boolean {
	return policy.skipEmptyBlockStop && facts.phase === 'COMBAT_DECLARE_BLOCKERS' && facts.creatures === 0;
}

/** The seat's own Declare Attackers step after the attack input: the stop was the declaration ({@link StopPolicy.attackStopIsTheDeclaration}). */
function attackStopIsDone(policy: StopPolicy, facts: PromptFacts): boolean {
	return policy.attackStopIsTheDeclaration && facts.myTurn && facts.phase === 'COMBAT_DECLARE_ATTACKERS';
}

/**
 * The non-active seat's own Declare Blockers step after the block input: the
 * stop was the declaration ({@link StopPolicy.blockStopIsTheDeclaration}) —
 * the mirror of {@link attackStopIsDone}.
 *
 * Requires a KNOWN, non-zero creature count: a seat with no creature never saw
 * a block-select input at all (there was nothing to declare), and that shape
 * is {@link blockStopIsEmpty}'s alone to answer — unconditionally, never a
 * function of what else the seat holds (Q10's own invariant). Unknown (null)
 * is left to the ordinary stop-phase check below, same as every other doubt.
 */
function blockStopIsDone(policy: StopPolicy, facts: PromptFacts): boolean {
	return (
		policy.blockStopIsTheDeclaration && !facts.myTurn && facts.phase === 'COMBAT_DECLARE_BLOCKERS' && (facts.creatures ?? 0) > 0
	);
}

const COMBAT_STEPS: ReadonlySet<PhaseType> = new Set<PhaseType>([
	'COMBAT_DECLARE_ATTACKERS',
	'COMBAT_DECLARE_BLOCKERS',
	'COMBAT_FIRST_STRIKE_DAMAGE',
	'COMBAT_DAMAGE',
	'COMBAT_END',
]);

/**
 * An empty-stack window in a phase that stops for a real play on this turn
 * ({@link StopPolicy.stopWithPlayOnMyTurn}, {@link StopPolicy.stopWithPlayOnTheirTurn}) — a
 * combat step only in a combat somebody attacked in.
 */
function playStopPhase(policy: StopPolicy, facts: PromptFacts): boolean {
	if (!facts.stackEmpty || facts.phase === null) return false;
	if (!(facts.myTurn ? policy.stopWithPlayOnMyTurn : policy.stopWithPlayOnTheirTurn).includes(facts.phase)) return false;
	return !(COMBAT_STEPS.has(facts.phase) && facts.attackers === 0);
}

/** The seat's own Beginning of Combat, with a permanent it can make into an attacker ({@link StopPolicy.stopToAnimate}). */
function animateNow(policy: StopPolicy, facts: PromptFacts): boolean {
	return policy.stopToAnimate && facts.myTurn && facts.phase === 'COMBAT_BEGIN' && facts.animates.length > 0;
}

/** A permanent the seat controls can be used now and only in this phase ({@link StopPolicy.stopForPhaseAbility}). */
function phaseAbilityNow(policy: StopPolicy, facts: PromptFacts): boolean {
	return policy.stopForPhaseAbility && facts.phaseRestricted.length > 0;
}

/**
 * Which rule decided a priority window — the `rule` on the server's
 * `prompt-forwarded`/`auto-passed` log lines, so "why was I stopped here?" is
 * read off the log rather than reconstructed from the facts.
 *
 * Kept: `open-ask`, `not-mine`, `dead-bar`, `not-priority` (the entry guards);
 * `stop-phase` (a phase the policy stops in); `stack-held` (`passStackWindows`
 * off); `every-window` (`passWhenNothingToDo` off); `no-answer` (Forge has not
 * said what the seat can do); `has-play` (it can do something —
 * {@link StopJudgement.plays} names the cards); `play-stop` (the same, in a
 * phase that stops only for a play — {@link StopPolicy.stopWithPlayOnTheirTurn});
 * `copy-available` (the seat's own spell, held for a copier — {@link StopPolicy.holdForSpellCopy}).
 * Passed: `skip-phase`, `own-spell`, `nothing-to-do`.
 */
export type StopRule =
	| 'open-ask'
	| 'not-mine'
	| 'dead-bar'
	| 'not-priority'
	| 'stop-phase'
	| 'stack-held'
	| 'every-window'
	| 'no-answer'
	| 'has-play'
	| 'play-stop'
	| 'copy-available'
	| 'skip-phase'
	| 'own-spell'
	| 'nothing-to-do';

export interface StopJudgement {
	/** The phase label to pass, or null when the player must be asked. */
	readonly pass: string | null;
	readonly rule: StopRule;
	/** For `has-play`, `play-stop` and `copy-available` (the copiers alone): the offered cards that are a play ({@link PromptFacts.nonManaSources}). */
	readonly plays?: readonly number[];
}

/**
 * The cards Forge says the seat can play now ({@link PromptFacts.nonManaSources}) with a
 * copy that can target the spell on top of the stack ({@link StopPolicy.holdForSpellCopy}).
 */
function copiersFor(facts: PromptFacts): number[] {
	const types = facts.stackTopTypes;
	if (types === null || facts.nonManaSources === null) return [];
	const spell = { types, mine: facts.stackTopMine };
	return facts.nonManaSources.filter((id) => facts.spellCopiers.get(id)?.some((copy) => copyTargets(copy, spell)) ?? false);
}

const keep = (rule: StopRule): StopJudgement => ({ pass: null, rule });
const pass = (facts: PromptFacts, rule: StopRule): StopJudgement => ({ pass: facts.phaseLabel ?? 'priority', rule });

/**
 * Whether to pass a priority window, and the rule that decided it.
 *
 * Pure. There is no pattern in here and no phase spelling: every branch reads a
 * {@link PromptFacts} field or a {@link StopPolicy} field. Keeping is the safe
 * answer and every doubt keeps.
 */
export function judgeStop(facts: PromptFacts, policy: StopPolicy): StopJudgement {
	// A seat with a question open is not idle, and a window that is not this
	// seat's, or whose button is dead, is not ours to press.
	if (facts.openAsks > 0) return keep('open-ask');
	if (!facts.mine) return keep('not-mine');
	if (!facts.confirmLive) return keep('dead-bar');
	// Anything we could not classify — a mulligan, a confirm, a declare step — is
	// a stop. This is where "when in doubt, ask" lives.
	if (facts.window !== 'priority') return keep('not-priority');

	if (facts.stackEmpty) {
		// The post-declaration priority window of the seat's own attack step, and
		// the non-active seat's own priority window right after a block is
		// assigned, are not "think" stops like Main 1 (T3): both fall through to
		// the nothing-to-do rule below, so each passes only when the seat has a play.
		if (!attackStopIsDone(policy, facts) && !blockStopIsDone(policy, facts)) {
			// The phase the player asked to hold priority in. Nothing below overrides it —
			// except the one stop that exists only so a creature can block (Q10).
			if (isStopPhase(policy, facts) && !blockStopIsEmpty(policy, facts)) return keep('stop-phase');
			// Forge's `skipPhases`: a phase outside the stop set goes past whatever the
			// seat could have done there (#20) — unless a permanent on the table can be
			// used in this phase and no other (w52 §S A), or the phase stops for a play
			// (AF28), each of which falls through to the nothing-to-do rule.
			if (skipsThisTurn(policy, facts) && !phaseAbilityNow(policy, facts) && !animateNow(policy, facts) && !playStopPhase(policy, facts)) return pass(facts, 'skip-phase');
		}
	} else if (!policy.passStackWindows) {
		return keep('stack-held');
	} else if (policy.passOwnSpell && facts.stackTopMine) {
		// Q17: the seat's own spell, back at the caster. Forge hands the caster
		// priority and this hands it on — unless a playable card copies it (see both fields).
		const copiers = policy.holdForSpellCopy ? copiersFor(facts) : [];
		if (copiers.length > 0) return { pass: null, rule: 'copy-available', plays: copiers };
		return pass(facts, 'own-spell');
	}

	if (!policy.passWhenNothingToDo) return keep('every-window');
	// Forge has not answered "what can this seat do" — never pass on silence. An
	// EMPTY set is Forge saying "nothing"; `clearWeaklySelectable` is "no answer".
	if (facts.nonManaSources === null) return keep('no-answer');
	// `nonManaSources`, not `sources`: Forge offers every untapped land and mana
	// rock in the SAME actionable set at ordinary priority, and a card offered
	// with no play beside its mana is never, by itself, a reason to hold priority —
	// see the field.
	if (facts.nonManaSources.length > 0) return { pass: null, rule: playStopPhase(policy, facts) ? 'play-stop' : 'has-play', plays: facts.nonManaSources };
	return pass(facts, 'nothing-to-do');
}

/** {@link judgeStop}'s answer alone: the phase label to pass, or null when the player must be asked. */
export function decideStop(facts: PromptFacts, policy: StopPolicy): string | null {
	return judgeStop(facts, policy).pass;
}

/**
 * The cost to settle by pressing Forge's own Auto, or null when the player must
 * choose. Pure, as above.
 *
 * Two shapes count as "no choice left", and both are Forge's own arithmetic:
 *
 *  - **One source.** One source is one payment (#6).
 *  - **Every source Forge offered is one Forge's auto-tap plan would tap** (#22,
 *    *"Stoneforge Mystic waited for a click on Plains when there was only one
 *    way to pay"* — `{1}{W}` off two lands is two sources and one assignment).
 *    A source left OUT of the plan means the plan had a choice to make, and that
 *    choice is the player's.
 *
 * Both shapes are `'auto'`'s, and both read {@link PromptFacts.sources} — which
 * is Forge's actionable HIGHLIGHT set, not the cards that can pay this cost. That
 * is item 6's whole story, and `'forgeAuto'` is the value that stops asking about
 * it; {@link StopPolicy.unambiguousPayment} carries the evidence.
 *
 * **Asked only of a payment for the seat's own cast or activation**
 * ({@link Payment.own}): choosing the spell was choosing to pay for it. Every
 * other payment is a decision in itself and is the player's whatever the
 * policy says — a cost another player's spell puts on theirs (Izzet Charm,
 * Mana Leak, Daze: pay, or let it be countered), a trigger's "you may pay", a
 * ward cost. The operator, 2026-10-11, of an Izzet Charm the server paid: *"i
 * never said it should auto pay for it, that decision should have been
 * surfaced to me."* Such a payment is still cancelled for them when Forge says
 * it cannot be paid at all ({@link answerability}): that leaves no decision.
 */
export function decidePay(facts: PromptFacts, policy: StopPolicy): string | null {
	if (facts.openAsks > 0) return null;
	if (!facts.mine) return null;
	if (facts.window !== 'payment') return null;
	if (!facts.confirmLive) return null;
	if (facts.cost === null) return null;
	if (facts.alternativePayment) return null;
	if (facts.poolChoice) return null;
	if (policy.unambiguousPayment === 'ask') return null;
	// A live Auto is Forge saying it found a payment for what is left. That alone
	// is what `'forgeAuto'` presses on; the two shapes below are the narrower
	// `'auto'`, which presses only where the wire proves nothing was left out.
	if (policy.unambiguousPayment === 'forgeAuto') return facts.cost;
	if (facts.sources === null || facts.sources.length === 0) return null;
	if (facts.sources.length === 1) return facts.cost;
	if (facts.plannedSources.length === 0) return null;
	const planned = new Set(facts.plannedSources);
	return facts.sources.every((id) => planned.has(id)) ? facts.cost : null;
}

/**
 * The one rule: **no question reaches a seat that it cannot answer** (the operator,
 * 2026-10-26: *"how can we unify the behavior better so that we don't soft lock?"*).
 *
 * Every question Forge puts to a seat goes through here before the seat sees it —
 * an ask frame (`match.ts`'s `openAsk`) and a payment window (`decideWindow`).
 * What "answerable" means for each, and what Forge's own legal answer is when it
 * is not:
 *
 * | question | answerable when | not answerable → Forge's own answer |
 * | --- | --- | --- |
 * | payment (`InputPayMana`) | Auto is live (`ensureAutoPayManaSources` found a payment, `InputPayMana.java:402-407`), or life can pay (Phyrexian), or the floating pool chooses | optional (Cancel live, `!mandatory`, `:389-395`): Cancel — the unpaid branch ("you may pay", "unless pays", an attack tax: that attacker does not attack, `PhaseHandler.java:578-583`) |
 * | `getChoices`, `chooseEntitiesForEffect` | as many options as its minimum | fewer: every option, which is Forge's own clamp of the minimum (`InputSelectEntitiesFromList.java:46`) |
 * | `chooseSingleEntityForEffect` | one option, or optional | none and optional: no pick (null), Forge's own answer to an empty list (`PlayerControllerHuman.chooseSingleEntityForEffect`) |
 * | `getAbilityToPlay` | one ability | none: no pick (null), Forge's "play nothing" |
 * | `showOptionDialog` | one option | none: not classified (no index is legal) |
 * | `confirm`, `showConfirmDialog` | always: both answers are live | — |
 * | `order`, `assignCombatDamage`, `assignGenericAmount`, `showInputDialog`, `sideboard` and the rest | not classified: forwarded as today, logged `ask-unclassified` |
 *
 * A payment with Auto dead and Cancel dead is not classified either: Forge left no
 * press, and that is Forge's to answer, not ours to drop.
 *
 * Nothing here computes whether a cost can be paid — that is Forge's rule, and its
 * dead Auto is the answer. **Not** the actionable set: in a payment window that is
 * every card a click would pay SOMETHING with (`InputPayMana.paysWith`), so one
 * Mountain is in it for {2}, a payment it cannot finish. A tap toward a payment that
 * cannot be finished is no answer.
 *
 * Pure. Policy is the caller's: whether the server presses a payment's Cancel is
 * {@link StopPolicy.unpayableCost}, and full control keeps the question.
 */
export type Answerability =
	| { readonly verdict: 'answerable' }
	| { readonly verdict: 'unclassified' }
	| {
			readonly verdict: 'unanswerable';
			/** The question had a decline (a payment's Cancel, an optional pick) rather than a forced answer. */
			readonly optional: boolean;
			/** The ask's reply, for an ask; a payment is answered by Forge's own Cancel instead. */
			readonly answer: { readonly t: 'reply'; readonly result: unknown } | { readonly t: 'cancel-payment' };
			/** A short, logged reason. */
			readonly why: string;
	  };

/** One question a seat is about to be put. */
export type Question =
	| { readonly kind: 'ask'; readonly frame: Extract<ServerFrame, { kind: 'ask' }> }
	| { readonly kind: 'payment'; readonly facts: PromptFacts };

const ANSWERABLE: Answerability = { verdict: 'answerable' };
const UNCLASSIFIED: Answerability = { verdict: 'unclassified' };

function forced(method: string, result: unknown, optional: boolean, why: string): Answerability {
	const schema = (REPLY_SCHEMAS as Record<string, { safeParse(v: unknown): { success: boolean } }>)[method];
	// A reply the bridge would refuse is no answer: the question goes to the seat as today.
	if (schema === undefined || !schema.safeParse(result).success) return UNCLASSIFIED;
	return { verdict: 'unanswerable', optional, answer: { t: 'reply', result }, why };
}

export function answerability(q: Question): Answerability {
	if (q.kind === 'payment') {
		const f = q.facts;
		if (f.window !== 'payment' || f.cost === null) return UNCLASSIFIED;
		if (f.confirmLive || f.alternativePayment || f.poolChoice) return ANSWERABLE;
		return f.noWayToPay && f.cancelLive ? { verdict: 'unanswerable', optional: true, answer: { t: 'cancel-payment' }, why: `nothing can pay ${f.cost}` } : UNCLASSIFIED;
	}
	const frame = q.frame;
	switch (frame.method) {
		case 'getChoices': {
			const keys = frame.names ?? frame.choices.map((c) => c.key);
			return frame.min > keys.length ? forced(frame.method, keys, false, `${keys.length} option(s) for a minimum of ${frame.min}`) : ANSWERABLE;
		}
		case 'chooseEntitiesForEffect':
			return frame.min > frame.optionList.length
				? forced(frame.method, frame.optionList, false, `${frame.optionList.length} option(s) for a minimum of ${frame.min}`)
				: ANSWERABLE;
		case 'chooseSingleEntityForEffect':
			if (frame.optionList.length > 0) return ANSWERABLE;
			return frame.isOptional ? forced(frame.method, null, true, 'no option') : UNCLASSIFIED;
		case 'getAbilityToPlay':
			return frame.abilities.length > 0 ? ANSWERABLE : forced(frame.method, null, true, 'no ability');
		case 'showOptionDialog':
			return frame.options.length > 0 ? ANSWERABLE : UNCLASSIFIED;
		case 'confirm':
		case 'showConfirmDialog':
			return ANSWERABLE;
		default:
			return UNCLASSIFIED;
	}
}

/**
 * Wave 52 §S B — Yes to a cost confirm for the ability the seat just chose, or
 * null when the confirm is the player's. In every mode, full control included.
 *
 * The operator, 2026-10-06: *"after selecting the creature, and then selecting
 * the sacrifice ability it AGAIN asks me if i want to sacrifice the augur of
 * skulls. thats a redundant ask."* — and 2026-10-19, in full control: *"when
 * tapping black lotus why does it ask me if i want to sacrifice? of course i do,
 * i tapped it."* Forge asks through `InputConfirm`
 * (`HumanCostDecision.java:1295-1310` → `PlayerControllerHuman.confirmPayment`
 * → `InputConfirm.confirm`), which reaches us as a `showPromptMessage` with
 * `card: null` plus a Yes/No `updateButtons`; the bridge names the ability the
 * confirm belongs to (`confirmAbility`, `PlayBridge.java`'s `confirmAbility`).
 *
 * `chosen` is the ability this seat picked from `getAbilityToPlay` since its
 * last priority window (`match.ts`'s `SeatState.chosenAbility`, cleared at every
 * `Priority:` prompt). They must be the same host card and the same ability: the
 * player already said "this one" and Forge is asking again whether to pay for
 * it. An optional trigger's "may" is the same shape and is a real game choice:
 * it names its trigger, never the chosen activation, so it is still asked; so
 * is a confirm with no ability on it.
 */
export function chosenCostConfirm(notes: SeatNotes, chosen: { hostCard: number; abilityId: number } | null): string | null {
	if (chosen === null || notes.openAsks > 0) return null;
	const prompt = notes.prompt;
	const buttons = notes.buttons;
	if (prompt === null || prompt.method !== 'showPromptMessage' || prompt.confirmAbility === undefined) return null;
	if (buttons === null || buttons.method !== 'updateButtons' || buttons.enable1 !== true) return null;
	if (notes.playerId === null || prompt.player.id !== notes.playerId || buttons.owner.id !== notes.playerId) return null;
	const { hostCard, abilityId } = prompt.confirmAbility;
	if (hostCard.id !== chosen.hostCard || abilityId !== chosen.abilityId) return null;
	return 'the seat chose this ability just before';
}

/** Why {@link onlySacrifice} picked, as the `auto-picked` log line names it. */
export const ONLY_SACRIFICE = 'the only legal sacrifice';

/**
 * Whether a `setSelectables` leaves no choice: every card it offers must be taken (`min` = `max` =
 * the number of cards) and no player is offered. Forge sends the set before its input is open, so
 * the set cannot say what the pick is for; the server holds such a set until the prompt after it
 * says ({@link onlySacrifice}), and sends it on ahead of that prompt when the pick is the seat's.
 */
export function forcedSet(selectables: ServerFrame): boolean {
	if (selectables.method !== 'setSelectables') return false;
	const { cards, min, max } = selectables;
	return min > 0 && min === max && cards.length === min && (selectables.players ?? []).length === 0;
}

/**
 * The pick of what to sacrifice when there is only one way to make it, or null when the pick is
 * the seat's. The operator, 2026-10-20, on Tinker asking "Select artifact to sacrifice (1 left)" with
 * Mishra's Bauble the only artifact: *"it's a bad question because there is only one target"* —
 * and the ruling: *"yes, auto-pick the only legal sacrifice, bone shards too."*
 *
 * The operator's scope, 2026-10-20: a sacrifice COST of a spell the seat casts or an ability it
 * activates (Tinker, Bone Shards), and a sacrifice EFFECT it must obey (an edict, "each player
 * sacrifices a creature") — whenever the choice is forced. The bridge names both from the open
 * input itself (`PlayBridge.java`'s `sacrificeAsked`: Forge's cost-payment stack for a cost, the
 * input's ability for an effect), never from the prompt's words. A target, a discard, an "unless"
 * cost, a trigger's cost and a "you may sacrifice" (its `min` is 0) are never forced picks of
 * this kind, so they are still asked. For a cost, the seat already chose to cast or activate;
 * Forge's Cancel there only takes that back, as with the cost confirm {@link chosenCostConfirm}
 * answers.
 *
 * It answers only when the set it must take is all there is: `min` = `max` = the number of cards
 * offered, read from the open input, and the same cards the held `setSelectables` offered. The act
 * selects them all at once; Forge's own `InputSelectManyBase.refresh` presses OK once the last is
 * selected (`hasAllTargets`).
 */
export function onlySacrifice(notes: SeatNotes, selectables: ServerFrame | null): Extract<ClientFrame, { kind: 'act' }> | null {
	if (notes.openAsks > 0 || selectables === null || !forcedSet(selectables) || selectables.method !== 'setSelectables') return null;
	const prompt = notes.prompt;
	if (prompt === null || prompt.method !== 'showPromptMessage' || notes.playerId === null || prompt.player.id !== notes.playerId) return null;
	const sacrifice = prompt.selection?.sacrifice;
	if (prompt.selection?.targets !== false || sacrifice === undefined) return null;
	if (sacrifice.min !== sacrifice.max || sacrifice.cards.length !== sacrifice.min) return null;
	const ids = sacrifice.cards.map((c) => c.id);
	const offered = new Set(selectables.cards.map((c) => c.id));
	if (ids.length !== offered.size || !ids.every((id) => offered.has(id))) return null;
	const [first, ...others] = sacrifice.cards;
	if (first === undefined) return null;
	return { kind: 'act', method: 'selectCard', card: first, otherCardViewsToSelect: others, triggerEvent: null };
}

/**
 * The zones a seat can search with no consequence beyond the card it takes: its own hand.
 * Searching a library is not one — it shuffles, and "searched a library" triggers fire — so a
 * No there is a real choice. Only zones proven against the real engine belong here.
 */
const FREE_TO_SEARCH: ReadonlySet<ZoneType> = new Set<ZoneType>(['Hand']);

/**
 * Yes to Forge's "Search your hand?" before an optional search's card choice, or null when
 * that question is the seat's. The operator, 2026-10-16: *"why does aether vial say 'Search
 * your hand? Yes/No' when i tap it? obviously i want to activate it if i tapped it."*
 *
 * Forge asks it before every optional hidden-zone ChangeZone
 * (`ChangeZoneEffect.changeHiddenOriginResolve`); the bridge names it (`confirmAbility.search`).
 * A No gains the seat nothing exactly when the card choice after a Yes lets it pick nothing
 * (`mayChooseNothing`) and searching has no effect of its own: every zone is one of
 * {@link FREE_TO_SEARCH} and it is the seat's own. With nothing that matches, Forge's choice
 * after the Yes is empty and asks nothing at all.
 */
export function freeSearchConfirm(notes: SeatNotes): string | null {
	if (notes.openAsks > 0) return null;
	const { prompt, buttons } = notes;
	if (prompt === null || prompt.method !== 'showPromptMessage') return null;
	const search = prompt.confirmAbility?.search;
	if (search === undefined || !search.mayChooseNothing) return null;
	if (buttons === null || buttons.method !== 'updateButtons' || buttons.enable1 !== true) return null;
	if (notes.playerId === null || prompt.player.id !== notes.playerId || buttons.owner.id !== notes.playerId) return null;
	if (search.player.id !== notes.playerId || !search.origin.every((z) => FREE_TO_SEARCH.has(z))) return null;
	return `searching its own ${search.origin.join(', ').toLowerCase()} costs nothing, and the choice after may be none`;
}

/**
 * "You hold priority, in your own main phase, with an empty stack" — the entry
 * to a turn's main phase, which {@link DEFAULT_STOP_POLICY} never passes (#7).
 *
 * Kept because `auto.jvm.test.ts` counts those windows with it. It is now a
 * question about the POLICY rather than a rule of its own: a main phase is a
 * stop because `stopOnMyTurn` says so.
 */
export function isOwnMainPhaseEntry(message: string, policy: StopPolicy = DEFAULT_STOP_POLICY): boolean {
	const facts = readPromptFacts({
		playerId: 0,
		prompt: {
			kind: 'notify',
			method: 'showPromptMessage',
			player: { kind: 'player', id: 0 },
			message,
			card: null,
		} as ServerFrame,
		buttons: {
			kind: 'notify',
			method: 'updateButtons',
			owner: { kind: 'player', id: 0 },
			label1: 'OK',
			label2: '',
			enable1: true,
			enable2: false,
			focus1: true,
		} as ServerFrame,
		actionable: null,
		openAsks: 0,
	});
	return facts.window === 'priority' && facts.stackEmpty && isStopPhase(policy, facts);
}

/* ── What a cast paid ────────────────────────────────────────────────── */

/**
 * The cost this prompt is asking for, or null when it is not a payment prompt.
 *
 * `match.ts` uses this to track a payment's lifetime (#8), which is a record of
 * what happened rather than a decision about whether to interrupt — so it reads
 * the same line the adapter does, through the adapter's own pattern.
 */
export function paymentCost(message: string): string | null {
	return PAY_MANA.exec(message)?.[1]?.trim() ?? null;
}

/** One payment, while it is being made. */
export interface Payment {
	cost: string;
	/**
	 * The payment follows this seat's own cast or activation: the seat chose the
	 * ability it pays for, so it already chose to pay, and Forge's Auto may be
	 * pressed for it ({@link decidePay}). Fixed when the payment opens — a land
	 * the seat taps by hand inside it is a choice of its own and changes nothing.
	 */
	own: boolean;
	/** The prompt without its cost line: which payment this is, as the cost goes down with each tap. */
	head: string;
	/** The card the payment is for, off the prompt; null when it names none. */
	card: number | null;
	/** Auto was pressed in this payment, by the server or the seat: Forge is paying it. */
	autoPressed: boolean;
}


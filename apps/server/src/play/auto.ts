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
 *    is either a Forge `FPref.YIELD_*` value or a Forge `skipPhases` set, so the
 *    whole policy can be handed to Forge verbatim — {@link toYieldUpdates} is
 *    that translation, and it emits nothing but `YieldUpdate` arms Forge's own
 *    `YieldController.apply` already consumes
 *    (`forge-gui/.../gamemodes/match/YieldController.java:365-393`).
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
 * `autoPassReason` and `autoPayReason` keep their names and signatures because
 * `match.ts` calls them and this lane does not own `match.ts`; each is now three
 * lines — read the facts, ask the policy.
 *
 * ## Full control is a POLICY, not a bypass
 *
 * {@link FULL_CONTROL_POLICY} makes every phase a stop phase, refuses to pass a
 * stack window, refuses to pass for want of actions, asks every payment, leaves
 * a cost Forge cannot pay for the player to cancel, and answers no bounds ask.
 * `match.ts` also gates on the seat's `fullControl` flag,
 * so the escape hatch holds at both levels (the flag short-circuits before the
 * seat's policy is read at all, and setting the policy to
 * {@link FULL_CONTROL_POLICY} reaches the same place the long way round), and
 * `toYieldUpdates` of it emits the
 * frames that CLEAR Forge's yields (`clearMarker`, `stackYield false`,
 * `setAutoPassUntilEndOfTurn false`, `setDisableYields true`, and `skipPhase
 * false` for all thirteen phases on every player) — item 5's "it clears the
 * yields, so every stop comes back", as data.
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
 * - `apps/server/src/play/bridge/PlayBridge.java` — `act()`'s switch has no
 *   `sendYieldUpdate` case, so nothing this file computes can reach Forge yet.
 *   `IGameController.sendYieldUpdate(YieldUpdate)` exists
 *   (`IGameController.java:84-86`) and routes to `applyYieldUpdate`.
 * - `PlayBridge.java:1172` — `isUiSetToSkipPhase` returns a hardcoded `false`,
 *   and our GUI is not a `RemoteClientGuiGame`, so
 *   `PlayerControllerHuman.isUiSetToSkipPhase` asks the GUI rather than the
 *   `YieldController`. Until that delegates to
 *   `getYieldController().isSkippingPhase(turnPlayer, phase)`, a `SkipPhase`
 *   envelope is inert on our bridge.
 * - `apps/server/src/play/match.ts` — the act that ships `toYieldUpdates` on
 *   `openView`, and a `lastAnsweredAsk` note on `SeatNotes` (see
 *   {@link StopPolicy.costConfirm}). **The per-seat `StopPolicy` this list used
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

import { PHASE_TYPES, REPLY_SCHEMAS, type PhaseType, type ServerFrame, type YieldUpdate } from '@hadoku/forge-wire';

/** An ask that admits exactly one answer, and why. */
export interface AutoAnswer {
	callId: string;
	method: string;
	result: unknown;
	/** A short, logged reason — never shown as prose in the UI. */
	why: string;
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
 * | `costConfirm` | `AutoYieldStore` per-ability auto-yield, `YieldUpdate.SetDisableYields` / `CardAutoYield` |
 * | `answerOneAnswerAsks` | ours: the bounds arithmetic in {@link onlyAnswer} |
 */
export interface StopPolicy {
	/** Phases the player wants priority in on their OWN turn, with an empty stack. */
	readonly stopOnMyTurn: readonly PhaseType[];
	/** Phases the player wants priority in on any OTHER player's turn. */
	readonly stopOnTheirTurn: readonly PhaseType[];
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
	 * has; `'ask'` leaves the player to press it. See {@link decideCancel} and
	 * {@link PromptFacts.noWayToPay}.
	 */
	readonly unpayableCost: 'ask' | 'cancel';
	/**
	 * Whether a cost confirm on an activation the player themselves chose is put
	 * to them (#16).
	 *
	 * `'ask'` is the only value this file can act on today, and that is a finding
	 * rather than a preference: Forge asks through `InputConfirm`
	 * (`HumanCostDecision.java:1295-1301` → `PlayerControllerHuman.confirmPayment`
	 * `:2061-2080` → `InputConfirm.confirm`), which reaches us as a
	 * `showPromptMessage` with `card: null` plus a Yes/No `updateButtons` — the
	 * `CostPart` and the `SpellAbility` are both dropped at that seam. Nothing on
	 * our wire tells a cost confirm apart from an OPTIONAL-TRIGGER confirm, which
	 * is a real game choice, so the window stays a stop. See the evidence doc.
	 */
	readonly costConfirm: 'ask' | 'accept';
	/** Whether an ask Forge left exactly one legal reply to is answered (w19). */
	readonly answerOneAnswerAsks: boolean;
}

/**
 * What a seat gets **unless something set it another one** — a seat carries its
 * own policy since wave 26 §E (`match.ts`, `SeatState.policy`), and this is the
 * value it starts from.
 *
 * It was behaviour-identical to waves 20 and 22 until 2026-09-27, when the
 * operator moved `unambiguousPayment` to `'forgeAuto'` (item 6). The suites that
 * assert a payment is the PLAYER's to click name {@link STRICT_PAYMENT_POLICY}
 * on their seats instead of riding on this default;
 * {@link ARENA_STOP_POLICY} is the value that changes the stop set.
 */
export const DEFAULT_STOP_POLICY: StopPolicy = {
	// #7, wave 20: *"dont auto-pass peoples turns"* — the entry to your own main
	// phase is where the player is entitled to look at the board.
	stopOnMyTurn: ['MAIN1', 'MAIN2'],
	stopOnTheirTurn: [],
	skipNonStopPhases: 'never',
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
	costConfirm: 'ask',
	answerOneAnswerAsks: true,
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
 * Item #20 — *"stopping at every priority point when there is something to
 * do"* — as a POLICY VALUE, which is the whole point of the model.
 *
 * Arena's own stop set: your main phases and your declare-attackers step; the
 * opponent's declare-blockers step and end step. Every other phase is passed
 * whether or not the seat could have done something there, which is what stops
 * a held instant turning every step of the opponent's turn into a click.
 *
 * Not the default, and the reason is recorded rather than hidden: turning it on
 * changes what `e2e/play.spec.ts` and `apps/ui/src/play/live/*.jvm.test.ts`
 * observe, and wave 24 lane E may edit none of those three.
 */
export const ARENA_STOP_POLICY: StopPolicy = {
	...DEFAULT_STOP_POLICY,
	stopOnMyTurn: ['MAIN1', 'MAIN2', 'COMBAT_DECLARE_ATTACKERS'],
	stopOnTheirTurn: ['COMBAT_DECLARE_BLOCKERS', 'END_OF_TURN'],
	skipNonStopPhases: 'always',
};

/**
 * The escape hatch, exact: every stop comes back.
 *
 * Every phase on every turn is a stop phase, a stack window is not passed, a
 * window with nothing to do is not passed, a payment is not pressed, a cost
 * Forge cannot pay is not cancelled for the player, and an ask with one legal
 * reply is still asked.
 */
export const FULL_CONTROL_POLICY: StopPolicy = {
	stopOnMyTurn: PHASE_TYPES,
	stopOnTheirTurn: PHASE_TYPES,
	skipNonStopPhases: 'never',
	passWhenNothingToDo: false,
	interruptsRestoreStops: true,
	passStackWindows: false,
	unambiguousPayment: 'ask',
	unpayableCost: 'ask',
	costConfirm: 'ask',
	answerOneAnswerAsks: false,
};

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
 * `'fullControl'` is {@link FULL_CONTROL_POLICY}, the policy VALUE — not
 * `SeatState.fullControl`, the per-seat escape hatch, which short-circuits
 * ahead of any policy and is set over the wire by the player.
 *
 * A `Map` and not an object literal, and that is not a style choice: a
 * plain-object registry looked up with `reg[name]` answers `'toString'` and
 * `'constructor'` with `Object.prototype`'s own members, so a typo'd
 * environment variable could hand a FUNCTION to a seat as its policy. A `Map`
 * has no prototype chain to walk.
 */
export const NAMED_STOP_POLICIES: ReadonlyMap<string, StopPolicy> = new Map<string, StopPolicy>([
	['default', DEFAULT_STOP_POLICY],
	['strictPayment', STRICT_PAYMENT_POLICY],
	['arena', ARENA_STOP_POLICY],
	['fullControl', FULL_CONTROL_POLICY],
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
 * play". `confirm`, `showConfirmDialog`, `showInputDialog`, the two assignments
 * and `sideboard` are never auto-answered: each is a real question. There is no
 * prose in here and there never was — the rules are bounds arithmetic.
 *
 * `getAbilityToPlay` is not here. A one-ability offer of it IS answered, but on
 * the BROWSER side, by `autoAnswer` in `apps/ui/src/play/prompts/rules.ts`,
 * because the shortcut must be able to SAY what it played and the offer's label
 * is resolved on that side. Keeping the case in ONE place means keeping it
 * there. Payment never produces a one-ability offer anyway:
 * `InputPayMana.activateCard` plays a single mana ability without asking
 * (`InputPayMana.java:101-106`) and only calls `getAbilityToPlay` for two or
 * more — which is #6, and which {@link decidePay} removes by pressing Auto
 * before the land is ever clicked.
 */
export function onlyAnswer(frame: ServerFrame, policy: StopPolicy = DEFAULT_STOP_POLICY): AutoAnswer | null {
	if (!policy.answerOneAnswerAsks) return null;
	if (frame.kind !== 'ask') return null;
	const callId = frame.callId;
	switch (frame.method) {

		case 'getChoices': {
			const keys = frame.choices.map((c) => c.key);
			// `max <= 0` is Forge REVEALING a list, not asking about it
			// (`rules.ts` `choiceBounds`, `GuiChoose.reveal`). Its one legal answer
			// is `[]`, and answering it would take the reveal away from the player.
			// A shortcut may remove a question; it may never remove information.
			if (frame.max <= 0) return null;
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
			// As above: a non-positive `max` is a reveal, and stays on screen.
			return frame.max > 0 && frame.min === frame.optionList.length && frame.max >= frame.optionList.length
				? ok(callId, frame.method, frame.optionList, 'every option had to be chosen')
				: null;

		case 'showOptionDialog':
			return frame.options.length === 1 ? ok(callId, frame.method, 0, 'one button') : null;

		case 'order': {
			// One item that must be placed has exactly one arrangement. With any
			// slack (`remainingObjectsMax > 0`) leaving it unplaced is a second
			// answer, so that stays a question.
			const all = [...frame.sourceChoices, ...frame.destChoices];
			return all.length === 1 && frame.remainingObjectsMax === 0 && all[0] !== undefined
				? ok(callId, frame.method, { ordered: [all[0].key], rememberDecision: false }, 'one item, no slack')
				: null;
		}

		default:
			return null;
	}
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
	 * **Forge says this cost cannot be paid** — item 7.
	 *
	 * Forge's payment input enables its own `Auto` button ONLY once
	 * `ensureAutoPayManaSources` has found a payment for the cost that is left
	 * (`InputPayMana.updateMessage`, `InputPayMana.java:402-407`, over
	 * `ComputerUtilMana.getManaSourcesToPayCost` at `:438-452`). So a payment
	 * window whose Auto is DEAD is Forge saying it found none — and if Forge also
	 * named nothing for the seat to click (`pushActionableCards` sent an EMPTY
	 * set, `PlayerControllerHuman.java:1565-1573`), there is nothing the player
	 * could tap toward it either. Cancel is then the only live answer, and it is
	 * Forge's own: `updateButtons` leaves button 2 enabled for exactly that
	 * (`InputPayMana.java:389-395`, `!mandatory`).
	 *
	 * False whenever Forge has not said — a cleared set is "no answer", never
	 * "nothing" — and false while Forge DID offer something clickable, because
	 * then the window still has an act in it and a shortcut may not remove one.
	 */
	readonly noWayToPay: boolean;
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

const PRIORITY = /^Priority: ([^\n]*)/;
const TURN_OWNER = /^Turn: \d+ \(([^)]*)\)/m;
const STACK_EMPTY = /^Stack: Empty$/m;
const PHASE_LINE = /^Phase: (.+)$/m;

/** `Pay Mana Cost: {U}` — Forge's own payment line (`en-US.properties:1797`). */
const PAY_MANA = /^Pay Mana Cost: (.+)$/m;

/**
 * Life is a second way to pay, and it is not a mana source
 * (`InputPayManaOfCostPayment.getMessage`, `en-US.properties:1799-1801`), so a
 * prompt offering it has more than one payment however few lands are out.
 */
const LIFE_INSTEAD = /^Click on your life total to pay life for /m;

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
	noWayToPay: false,
	sources: null,
	plannedSources: [],
	openAsks: 0,
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
	return {
		window,
		phase: phaseLabel === null ? null : (PHASE_BY_UI_NAME[phaseLabel] ?? null),
		phaseLabel,
		myTurn: priority !== undefined && owner !== undefined && priority === owner,
		stackEmpty: STACK_EMPTY.test(message),
		mine,
		confirmLive: buttons.enable1 === true,
		cost,
		alternativePayment: LIFE_INSTEAD.test(message),
		noWayToPay: window === 'payment' && buttons.enable1 !== true && all !== null && all.length === 0,
		sources: all === null ? null : [...new Set(all)],
		plannedSources: all === null ? [] : repeated(all),
		openAsks: notes.openAsks,
	};
}

/* ── The decisions: pure over facts and the policy ───────────────────── */

/** Whether the player asked to hold priority in this phase on this turn. */
export function isStopPhase(policy: StopPolicy, facts: PromptFacts): boolean {
	if (facts.phase === null) return false;
	const stops = facts.myTurn ? policy.stopOnMyTurn : policy.stopOnTheirTurn;
	return stops.includes(facts.phase);
}

/** Whether a phase outside the stop sets is skipped outright on this turn. */
function skipsThisTurn(policy: StopPolicy, facts: PromptFacts): boolean {
	if (policy.skipNonStopPhases === 'always') return true;
	if (policy.skipNonStopPhases === 'theirTurn') return !facts.myTurn;
	return false;
}

/**
 * The phase label to pass, or null when the player must be asked.
 *
 * Pure. There is no pattern in here and no phase spelling: every branch reads a
 * {@link PromptFacts} field or a {@link StopPolicy} field. Null is the safe
 * answer and every doubt returns it.
 */
export function decideStop(facts: PromptFacts, policy: StopPolicy): string | null {
	// A seat with a question open is not idle, and a window that is not this
	// seat's, or whose button is dead, is not ours to press.
	if (facts.openAsks > 0) return null;
	if (!facts.mine) return null;
	if (!facts.confirmLive) return null;
	// Anything we could not classify — a mulligan, a confirm, a declare step — is
	// a stop. This is where "when in doubt, ask" lives.
	if (facts.window !== 'priority') return null;

	if (facts.stackEmpty) {
		// The phase the player asked to hold priority in. Nothing below overrides it.
		if (isStopPhase(policy, facts)) return null;
		// Forge's `skipPhases`: a phase outside the stop set goes past whatever the
		// seat could have done there (#20).
		if (skipsThisTurn(policy, facts)) return facts.phaseLabel ?? 'priority';
	} else if (!policy.passStackWindows) {
		return null;
	}

	if (!policy.passWhenNothingToDo) return null;
	// Forge has not answered "what can this seat do" — never pass on silence. An
	// EMPTY set is Forge saying "nothing"; `clearWeaklySelectable` is "no answer".
	if (facts.sources === null || facts.sources.length > 0) return null;
	return facts.phaseLabel ?? 'priority';
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
 */
export function decidePay(facts: PromptFacts, policy: StopPolicy): string | null {
	if (facts.openAsks > 0) return null;
	if (!facts.mine) return null;
	if (facts.window !== 'payment') return null;
	if (!facts.confirmLive) return null;
	if (facts.cost === null) return null;
	if (facts.alternativePayment) return null;
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
 * The cost to abandon by pressing Forge's own Cancel, or null when the player
 * must press it themselves. Pure, as above.
 *
 * Item 7, the operator, 2026-09-27: *"it's confusing i have to click 'cancel' to
 * not pay manaleak when i dont even have enough mana. this is very silly it
 * should just happen automatically if i dont have enough mana."*
 *
 * **Nothing here computes whether the cost can be paid** — that is a rule, and
 * this file implements none. {@link PromptFacts.noWayToPay} is FORGE's answer:
 * its own Auto is dead, so `ensureAutoPayManaSources` found no payment
 * (`InputPayMana.java:402-407`), and it named nothing clickable, so there is no
 * act in the window either. One live button is left, and taking the only answer
 * Forge left is what every other decision in this file does.
 *
 * {@link PromptFacts.alternativePayment} stays in front of it: a cost payable
 * with life has a second answer however few lands are out, and Forge's Auto is
 * dead for that one too (`en-US.properties:1799-1801`).
 */
export function decideCancel(facts: PromptFacts, policy: StopPolicy): string | null {
	if (facts.openAsks > 0) return null;
	if (!facts.mine) return null;
	if (facts.window !== 'payment') return null;
	if (facts.cost === null) return null;
	if (facts.alternativePayment) return null;
	if (policy.unpayableCost !== 'cancel') return null;
	return facts.noWayToPay ? facts.cost : null;
}

/* ── What `match.ts` calls ───────────────────────────────────────────── */

/**
 * The phase this seat would be passing, or null when it must be asked.
 *
 * Kept for `match.ts`, which this lane does not own. Read the facts, ask the
 * policy — there is nothing else in here.
 */
export function autoPassReason(notes: SeatNotes, policy: StopPolicy = DEFAULT_STOP_POLICY): string | null {
	return decideStop(readPromptFacts(notes), policy);
}

/** The cost this seat's payment answers itself, or null when it must be asked. */
export function autoPayReason(notes: SeatNotes, policy: StopPolicy = DEFAULT_STOP_POLICY): string | null {
	return decidePay(readPromptFacts(notes), policy);
}

/**
 * The cost this seat's payment abandons itself, or null when it must be asked
 * (item 7). Read the facts, ask the policy — as above.
 */
export function autoCancelReason(notes: SeatNotes, policy: StopPolicy = DEFAULT_STOP_POLICY): string | null {
	return decideCancel(readPromptFacts(notes), policy);
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

/* ── The policy as Forge's own frames ────────────────────────────────── */

/** A `PlayerRefSchema` value — `{ kind: 'player', id }`. */
export interface PlayerRef {
	readonly kind: 'player';
	readonly id: number;
}

/** The seat a policy is being declared for, and the other players at the table. */
export interface YieldSeat {
	readonly me: PlayerRef;
	readonly others: readonly PlayerRef[];
}

/**
 * The policy as `YieldUpdate` frames — **Forge's state, not ours**.
 *
 * Every frame is an arm of Forge's own sealed `YieldUpdate`
 * (`YieldUpdate.java:16-58`) and is applied by `YieldController.apply`
 * (`:365-393`), so pushing this is how the player's preferences become the
 * thing FORGE decides from. The order matters: the transient yields are cleared
 * first, then the standing preferences, then the per-phase skips.
 *
 * `costConfirm` maps only as far as `setDisableYields`: Forge's
 * `confirmPayment` does not consult the auto-yield store at all (unlike
 * `confirmTrigger`, which does — `PlayerControllerHuman.confirmTrigger` reads
 * `getTriggerDecision(wrapper.yieldKey())`), so there is no arm that carries
 * "stop asking me to sacrifice the land I just tapped". That is #16's finding.
 *
 * Nothing calls this yet, and that is the honest state of the lane: the bridge
 * has no `sendYieldUpdate` act. The frames are pinned against the wire schema
 * in `packages/forge-wire/src/tier-b.test.ts` and against Forge's arm list in
 * `auto.test.ts`.
 */
export function toYieldUpdates(policy: StopPolicy, seat: YieldSeat): YieldUpdate[] {
	const out: YieldUpdate[] = [];

	// Clear every transient yield first: a policy push is a full reset, and this
	// is what makes FULL_CONTROL_POLICY "clears the yields, so every stop comes
	// back" (`YieldController.clearActiveYieldAndDispatch`, `:406-428`).
	out.push({ update: 'clearMarker', player: seat.me });
	out.push({ update: 'stackYield', player: seat.me, active: false, respectsInterrupts: false });
	out.push({ update: 'setAutoPassUntilEndOfTurn', player: seat.me, active: false });
	out.push({ update: 'setDisableYields', disabled: policy.costConfirm === 'ask' });

	// The standing preferences. `YieldController.getStringPref` reads an override
	// before FModel (`:90-93`), so a `setYieldPref` wins on the host's proxy.
	const pref = (name: string, value: string): YieldUpdate => ({ update: 'setYieldPref', pref: name, value });
	out.push(pref('YIELD_AUTO_PASS_NO_ACTIONS', String(policy.passWhenNothingToDo)));
	out.push(pref('YIELD_AUTO_PASS_RESPECTS_INTERRUPTS', String(policy.interruptsRestoreStops)));
	// #22's enabler: with the preview on, `pushActionableCards` sends the cards
	// Forge's own Auto would tap TWICE, which is what makes a two-source payment
	// provably unambiguous (`PlayerControllerHuman.java:1580-1589`).
	out.push(pref('UI_SHOW_AUTOTAP_PREVIEW', String(policy.unambiguousPayment !== 'ask')));

	// The per-phase skips: the complement of the stop sets, one frame per
	// (turn player, phase) pair, exactly as `YieldUpdate.SkipPhase` carries it.
	const scope = policy.skipNonStopPhases;
	const sides: { player: PlayerRef; stops: readonly PhaseType[]; skipping: boolean }[] = [
		{ player: seat.me, stops: policy.stopOnMyTurn, skipping: scope === 'always' },
		...seat.others.map((player) => ({
			player,
			stops: policy.stopOnTheirTurn,
			skipping: scope === 'always' || scope === 'theirTurn',
		})),
	];
	for (const side of sides) {
		for (const phase of PHASE_TYPES) {
			out.push({
				update: 'skipPhase',
				turnPlayer: side.player,
				phase,
				skip: side.skipping && !side.stops.includes(phase),
			});
		}
	}
	return out;
}

/* ── What a cast paid ────────────────────────────────────────────────── */

/** Forge's braces are a WotC symbol set; our own text says the letters (`lookup.ts` `plainRulesText`). */
export function plainCost(cost: string): string {
	return cost.replace(/\{T\}/g, 'Tap').replace(/\{Q\}/g, 'Untap').replace(/\{([^}]{1,5})\}/g, '$1');
}

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
	/** Cards that tapped while the payment prompt was up, in the order they tapped. */
	tapped: { id: number; name: string }[];
}

/**
 * The line a finished payment leaves behind: *"paid U — Volcanic Island"*.
 *
 * A cast must never look free (`#8`). This is a state, not prose: the cost, and
 * the cards that paid it. A payment nothing tapped for (mana already in the
 * pool, a free spell) says only what was paid.
 */
export function paymentLine(payment: Payment): string {
	const cost = plainCost(payment.cost);
	if (payment.tapped.length === 0) return `paid ${cost}`;
	return `paid ${cost} — ${payment.tapped.map((c) => c.name).join(', ')}`;
}

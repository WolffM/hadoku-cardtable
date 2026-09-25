/**
 * Questions with one answer, and stops with nothing to do.
 *
 * Wave 19, lane C. Everything here is a **pure** decision over one frame or one
 * seat's latest notes; `match.ts` is what acts on it, and `fullControl` on a
 * seat turns the whole file off for that seat.
 *
 * ## The rule the whole file obeys
 *
 * **We implement no rules.** Every decision below is either
 *
 *  - a case where *Forge itself* left exactly one possibility (a one-element
 *    option list, a `min === max === list.length` bound), so answering is
 *    arithmetic rather than judgement; or
 *  - a case Forge's **own** client already decides the same way, cited.
 *
 * Nothing here decides what is legal. Where the choice is real — `confirm`,
 * damage assignment, two mana abilities that both pay — the ask goes to the
 * player untouched. And where an ask is not a question at all but a REVEAL
 * (`getChoices` with `max <= 0`, `manipulateCardList` with nothing movable),
 * it also stays: a shortcut may remove a question, never information.
 *
 * ## Auto-answer (`onlyAnswer`)
 *
 * The rules are bounds arithmetic: a list where every option must be taken, a
 * single option with a floor of one, one arrangement with no slack. Each is a
 * case where Forge left exactly one legal reply, so answering it is arithmetic
 * rather than judgement — and a REVEAL is never answered even when it has one
 * (`getChoices` with `max <= 0`), because dismissing it would take information
 * off the screen.
 *
 * The operator's *"choosing what color mana to add when tapping land"* (#7)
 * turns out to be already Forge's to answer, not ours: a basic land is never a
 * question (`InputPayMana.java:102-106` plays the only ability without
 * asking), two colours on a dual IS a real question, and Forge's auto-tap pays
 * without consulting anyone. What our capture actually carried was nine
 * one-ability `getAbilityToPlay` asks from CLICKING a card — see the note on
 * the switch below for why those stay.
 *
 * ## Auto-pass (`autoPassReason`)
 *
 * Forge answers "does this seat have a legal action right now" itself, and
 * since lane B's `setWeaklySelectable` the answer is on our wire:
 * `PlayerControllerHuman.chooseSpellAbilityToPlay` runs
 * `AvailableActions.collectActionable` at every priority and
 * `pushActionableCards` pushes the result (`PlayerControllerHuman.java:1658-1670`,
 * `:1550-1590`), so a priority stop where the seat can do nothing arrives as
 * `setWeaklySelectable { cards: [] }`. An **empty** set is Forge saying "nothing";
 * `clearWeaklySelectable` is Forge saying "no answer", and we never pass on that.
 *
 * So: priority, for this seat, OK enabled, no ask open, and Forge's actionable
 * set present and empty → pass.
 *
 * ### Wave 20 refined it twice, from the operator's second session
 *
 * **The stack flows (#5).** The `Stack: Empty` requirement is GONE. A priority
 * window with a spell on the stack and nothing this seat can do is exactly the
 * window that made a creature need two humans to click OK — *"ridiculous. just
 * resolve it"*. Passing it changes nothing about WHEN the stack resolves:
 * resolution still needs successive passes under Forge's rules. What changes is
 * that a pass with no legal action behind it is sent without asking.
 *
 * **Turns stop (#7).** *"dont auto-pass peoples turns"*. Entry to your OWN main
 * phase — you hold priority, the turn is yours, and the stack is empty — is
 * always a stop, whatever Forge says is actionable. That is the one place the
 * file does not read Forge's answer, and it is not a rule about the game: it is
 * where the player is entitled to look at the board. `Priority: X` and
 * `Turn: N (X)` naming the same player is how the message says "your turn"
 * (`InputBase.java:134-136`); `Phase: Main phase, …` is `PhaseType.MAIN1` /
 * `MAIN2`'s `nameForUi` (`en-US.properties:2483,2490`).
 *
 * The two compose: your own main phase stops, and a window in it with something
 * ON the stack is a stack window, not an entry, so a creature you just cast
 * still resolves without a click.
 *
 * **A consequence worth knowing about.** When both seats pass immediately, an
 * uncontested spell's passage through the stack can be coalesced away before
 * either browser is told: measured over a whole recorded game in
 * `e2e/play.spec.ts`, one seat was sent no GameView `Stack`, no card in the
 * `Stack` zone, and no `… to Resolve.` prompt at all — the card went from hand
 * to battlefield in one delta. That is the operator's *"just resolve it"* taken
 * to its limit, and it is why the e2e proof counts BUTTONS rather than watching
 * the stack. A board that wants to SHOW the spell resolving cannot rely on the
 * stack being observable.
 *
 * ## Auto-pay (`autoPayReason`)
 *
 * Forge's payment input owns a button of its own: `InputPayMana.updateButtons`
 * labels button 1 **"Auto"** (`lblAuto`, `en-US.properties:518`) and enables it
 * only once `ensureAutoPayManaSources` has found sources that can pay the
 * remaining cost (`InputPayMana.java:397-407,436-449`). Pressing it runs
 * `ComputerUtilMana.payManaCost` — **Forge's own payer**, not ours
 * (`InputPayMana.java:580-592`).
 *
 * So "a payment with exactly one legal payment answers itself" (#6, *"Preordain
 * asks how to tap lands with ONE land in play"*) is: the payment prompt is up,
 * Forge's Auto is enabled, and Forge named exactly ONE source to pay from. One
 * source is one payment, and pressing Auto is Forge choosing how to tap it.
 *
 * In payment mode the actionable set is every card of this seat's with a
 * playable mana ability (`PlayerControllerHuman.pushActionableCards`, payment
 * branch), so its size is the number of sources the seat could click. Two
 * sources are a real choice of which to tap and stay a stop.
 *
 * **Deliberately narrower than it could be.** Forge also computes the exact
 * plan Auto would use (`getAutoTapPreviewViews`) and `pushActionableCards`
 * raises those cards to weight 2 by sending them twice — which would settle
 * "every source Forge offers is one Auto would tap" for two sources as well.
 * That weighting is not on our wire: `UI_SHOW_AUTOTAP_PREVIEW` is off in
 * `PlayBridge.bootForge` (only `UI_SHOW_ACTIONABLE_HIGHLIGHTS` is set), so the
 * set arrives unweighted and one source is all we can prove. Turning the
 * preview on is how this widens, and it is a change to the bridge, not here.
 *
 * Without this, item 6 plays out as: the seat clicks its one land, and because
 * a dual land has two mana abilities that both `canPlay`,
 * `InputPayMana.onCardSelected` asks `getAbilityToPlay` with two
 * (`InputPayMana.java:101-106`) — "choose ability to play", for a tap with one
 * possible outcome. Pressing Auto first means the land is never clicked and the
 * question never exists.
 *
 * The prompt text is Forge's own (`InputBase.getTurnPhasePriorityMessage`,
 * `InputBase.java:130-152`) and the bridge pins the language to `en-US`
 * (`PlayBridge.java:1342`), so matching `Priority:` / `Stack:` / `Empty` is
 * reading Forge's answer, not guessing at one. A locale change would stop the
 * auto-pass rather than mis-fire it: no match, no pass.
 */

import { REPLY_SCHEMAS, type ServerFrame } from '@hadoku/forge-wire';

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

/**
 * The single answer this ask admits, or null when the choice is real.
 *
 * Read each case as "Forge left one possibility", never as "this is the good
 * play". `confirm`, `showConfirmDialog`, `showInputDialog`, the two assignments
 * and `sideboard` are never auto-answered: each is a real question.
 *
 * `getAbilityToPlay` is not here, and wave 20 did not move it here. A
 * one-ability offer of it IS answered now — item 4, *"one choice shouldn't
 * require this dialog at all"* — but on the BROWSER side, by `autoAnswer` in
 * `apps/ui/src/play/prompts/rules.ts`. The reason is the one w19 gave for
 * excluding it: the shortcut must be able to SAY what it played, and the offer's
 * label is resolved on that side (`lookup.ts`'s `withAbilityLabels`, over the
 * `label` the bridge now sends — four of four carried one in wave 20's capture,
 * `fixtures/w20-turn-flow.json`). Keeping the case in ONE place means keeping it
 * there rather than in both.
 *
 * Payment never produces a one-ability offer anyway: `InputPayMana.activateCard`
 * plays a single mana ability without asking (`InputPayMana.java:101-106`) and
 * only calls `getAbilityToPlay` for two or more — which is item 6, and which
 * `autoPayReason` removes by pressing Auto before the land is ever clicked.
 */
export function onlyAnswer(frame: ServerFrame): AutoAnswer | null {
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

/** What a seat was last told, as far as the auto-pass is concerned. */
export interface SeatNotes {
	/** This seat's Forge `PlayerView` id, once `openView` has named it. */
	playerId: number | null;
	/** The latest `showPromptMessage` for this seat. */
	prompt: ServerFrame | null;
	/** The latest `updateButtons` for this seat. */
	buttons: ServerFrame | null;
	/**
	 * Forge's actionable set from `setWeaklySelectable`: a set (possibly empty)
	 * is an answer, `null` is "Forge has not said" (never said, or cleared).
	 */
	actionable: readonly number[] | null;
	/** Asks this seat has open. A seat with a question is not idle. */
	openAsks: number;
}

/*
 * `Priority: …`, `Turn: N (…)`, `Phase: …`, `Stack: Empty`, as
 * `InputBase.getTurnPhasePriorityMessage` writes them (`InputBase.java:130-152`)
 * with the bridge's language pinned to `en-US` (`PlayBridge.java:1390`). A
 * locale change stops the shortcuts rather than mis-firing them: no match, no
 * pass.
 *
 * `Turn:` may carry a day/night marker after the bracket (`  [Day]`), so the
 * owner is read out of the brackets rather than to end of line. `Priority:` is
 * anchored at the START of the message, not per line: Forge writes it first and
 * nowhere else, and a stack description that happened to contain the word must
 * not read as one.
 */
const PRIORITY = /^Priority: ([^\n]*)/;
const TURN_OWNER = /^Turn: \d+ \(([^)]*)\)/m;
const STACK_EMPTY = /^Stack: Empty$/m;
const MAIN_PHASE = /^Phase: Main phase/m;
const PHASE = /^Phase: (.+)$/m;

/**
 * "You hold priority, in your own main phase, with an empty stack" — the entry
 * to a turn's main phase, which is never passed for the player (#7).
 *
 * The priority line names its recipient (`InputPassPriority`'s owner IS the
 * priority player; everyone else is told "Waiting for …"), so the two names
 * matching is the message saying the turn is this seat's.
 */
export function isOwnMainPhaseEntry(message: string): boolean {
	if (!MAIN_PHASE.test(message)) return false;
	if (!STACK_EMPTY.test(message)) return false;
	const priority = PRIORITY.exec(message)?.[1];
	const owner = TURN_OWNER.exec(message)?.[1];
	return priority !== undefined && owner !== undefined && priority === owner;
}

/**
 * The phase this seat would be passing, or null when it must be asked.
 *
 * Null is the safe answer and every doubt returns it: a stop the player did not
 * want is an annoyance, a stop they did not get is a lost game.
 */
export function autoPassReason(notes: SeatNotes): string | null {
	if (notes.openAsks > 0) return null;
	if (notes.playerId === null) return null;
	const prompt = notes.prompt;
	const buttons = notes.buttons;
	if (prompt === null || prompt.method !== 'showPromptMessage') return null;
	if (buttons === null || buttons.method !== 'updateButtons') return null;
	// Both must be addressed to this seat's own player, and OK must be live.
	if (prompt.player.id !== notes.playerId || buttons.owner.id !== notes.playerId) return null;
	if (buttons.enable1 !== true) return null;
	if (!PRIORITY.test(prompt.message)) return null;
	// A turn is never auto-passed (#7). Nothing below this line can override it.
	if (isOwnMainPhaseEntry(prompt.message)) return null;
	// Forge has not answered "what can this seat do" — never pass on silence.
	if (notes.actionable === null || notes.actionable.length > 0) return null;
	return PHASE.exec(prompt.message)?.[1] ?? 'priority';
}

/** Forge's braces are a WotC symbol set; our own text says the letters (`lookup.ts` `plainRulesText`). */
export function plainCost(cost: string): string {
	return cost.replace(/\{T\}/g, 'Tap').replace(/\{Q\}/g, 'Untap').replace(/\{([^}]{1,5})\}/g, '$1');
}

/** `Pay Mana Cost: {U}` — Forge's own payment line (`InputPayMana.java`, `lblPayManaCost`). */
const PAY_MANA = /^Pay Mana Cost: (.+)$/m;

/** The cost this prompt is asking for, or null when it is not a payment prompt. */
export function paymentCost(message: string): string | null {
	return PAY_MANA.exec(message)?.[1]?.trim() ?? null;
}

/**
 * Forge's own word for button 1 of the payment input
 * (`InputPayMana.updateButtons` → `lblAuto`, `en-US.properties:518`). Enabled
 * only when `ensureAutoPayManaSources` found a payment, so the label and the
 * enabled flag together are Forge saying "this cost can be paid automatically".
 */
const AUTO_BUTTON = 'Auto';

/**
 * Life is a second way to pay, and it is not a mana source
 * (`InputPayManaOfCostPayment.getMessage`, `en-US.properties:1799-1801`), so a
 * prompt offering it has more than one payment however few lands are out.
 */
const LIFE_INSTEAD = /^Click on your life total to pay life for /m;

/**
 * The cost this seat's payment answers itself, or null when it must be asked.
 *
 * See the module header. One source is one payment; the press is Forge's own
 * Auto button, so `ComputerUtilMana` — not this file — decides how that source
 * is tapped. Null on every doubt.
 */
export function autoPayReason(notes: SeatNotes): string | null {
	if (notes.openAsks > 0) return null;
	if (notes.playerId === null) return null;
	const prompt = notes.prompt;
	const buttons = notes.buttons;
	if (prompt === null || prompt.method !== 'showPromptMessage') return null;
	if (buttons === null || buttons.method !== 'updateButtons') return null;
	if (prompt.player.id !== notes.playerId || buttons.owner.id !== notes.playerId) return null;
	// Forge's Auto, live. A priority window's button 1 is "OK", never this.
	if (buttons.enable1 !== true || buttons.label1 !== AUTO_BUTTON) return null;
	const cost = paymentCost(prompt.message);
	if (cost === null) return null;
	if (LIFE_INSTEAD.test(prompt.message)) return null;
	// Forge has not said what can pay — never press on silence.
	if (notes.actionable === null) return null;
	const sources = new Set(notes.actionable);
	if (sources.size !== 1) return null;
	return cost;
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

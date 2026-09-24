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
 * So: priority, for this seat, stack empty, OK enabled, no ask open, and Forge's
 * actionable set present and empty → pass. That is the settled default — *stop
 * only where you have a legal action*, not Arena's "stop at your own main phases
 * regardless".
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
 * `getAbilityToPlay` is not here on purpose. A one-ability ask of it is always
 * "you clicked this card" — payment never produces one, because Forge's own
 * `InputPayMana.activateCard` plays a single mana ability without asking
 * (`InputPayMana.java:102-106`) and only calls `getAbilityToPlay` for two or
 * more — so the player's click should stay visible. Forge's desktop client
 * does auto-return the only ability (`CMatchUI.java:1017-1024`); our reason to
 * differ is that a browser button needs a label, and ability labels are not on
 * the wire (`lookup.ts` has recorded the gap since Wave 17 — the bridge must
 * send them). Until they exist, a silent auto-play would cast a spell the
 * button could not name.
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

/** `Priority: …` / `Stack: Empty`, as `InputBase.getTurnPhasePriorityMessage` writes them. */
const PRIORITY = /^Priority: /;
const STACK_EMPTY = /^Stack: Empty$/m;
const PHASE = /^Phase: (.+)$/m;

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
	if (!STACK_EMPTY.test(prompt.message)) return null;
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

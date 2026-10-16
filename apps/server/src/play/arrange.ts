/**
 * A scry or a surveil is one prompt.
 *
 * Forge asks a scry of two or more cards as TWO questions
 * (`PlayerControllerHuman.arrangeForScry`): `many(...)` — an `order` with
 * every looked-at card in `sourceChoices`, nothing placed, any number
 * allowed (`remainingObjectsMin === remainingObjectsMax === -1`,
 * `AbstractGuiGame.many`) — for the cards to put on the BOTTOM; then, when
 * two or more are left, a second `order` (all of them, every one placed) for
 * the order of the TOP. `arrangeForSurveil` is the same pair with the
 * graveyard in place of the bottom. A scry of one is a Top/Bottom bar, one
 * question already, and never reaches here.
 *
 * The operator: *"we should be able to finish a scry trigger in a single
 * prompt"*. So the first `order` goes to the seat with `rest` set — the
 * cards left in `sourceChoices` are a group of their own, going back on top
 * of the library, and the reply orders it too — and the second `order` is
 * answered here from that same reply, never shown. Where the first group
 * goes (under the library, or into the graveyard) is the ask's own
 * `destination`, which the bridge sets.
 *
 * Forge's caption for the first question (`lblCardsToPutOnTheBottom`,
 * `lblCardsToPutInTheGraveyard`) is the only thing that tells a scry's
 * `many` from any other `many` of cards; the shape is checked as well, so a
 * caption alone never opens the fold. The follow-up is recognised by shape
 * alone: the very next ask to the same seat, an `order` of exactly the cards
 * the reply left on top, with every one to be placed.
 */

import type { ChoiceOption, ServerFrame } from '@hadoku/forge-wire';

import type { AutoAnswer } from './auto.js';

type OrderAsk = Extract<ServerFrame, { kind: 'ask'; method: 'order' }>;

/** Forge's captions for the first question of a scry and of a surveil. */
const ARRANGEMENTS: ReadonlySet<string> = new Set(['Cards to put on the bottom', 'Cards to put in the graveyard']);

/**
 * Where the cards a scry or surveil leaves go: back on top of the library, the
 * group's first card highest — `GameAction.scry` and `Player.surveil` reverse
 * the top group and put each card on top in turn.
 */
const BACK_ON_TOP = { zone: 'library', end: 'top', first: 'top' } as const;

const cardIdOf = (c: ChoiceOption): number | null => (c.ref !== null && c.ref.kind === 'card' ? c.ref.id : null);

/**
 * The first question of a scry or surveil, as the seat is asked it: the same
 * ask with the cards it leaves a group of their own, going back on top and
 * ordered by the reply's `rest`. Null for any other ask.
 */
export function arrangeAsk(frame: Extract<ServerFrame, { kind: 'ask' }>): OrderAsk | null {
	if (frame.method !== 'order' || frame.rest !== undefined) return null;
	if (!ARRANGEMENTS.has(frame.top)) return null;
	const shaped =
		frame.remainingObjectsMin === -1 &&
		frame.remainingObjectsMax === -1 &&
		frame.destChoices.length === 0 &&
		frame.sourceChoices.length > 1 &&
		frame.sourceChoices.every((c) => cardIdOf(c) !== null) &&
		!frame.sideboardingMode &&
		!frame.showRememberCheckbox;
	return shaped ? { ...frame, rest: BACK_ON_TOP } : null;
}

/**
 * The card ids the reply left on top, in the order the seat gave them: the
 * reply's `rest` where it names exactly the cards left, Forge's own order of
 * them otherwise (a reply that did not order them took the order it was shown).
 */
export function restOrder(ask: OrderAsk, reply: { ordered: readonly string[]; rest?: readonly string[] }): number[] {
	const placed = new Set(reply.ordered);
	const left = ask.sourceChoices.filter((c) => !placed.has(c.key));
	const byKey = new Map(left.map((c) => [c.key, c]));
	const given = reply.rest ?? [];
	const ordered = given.length === left.length && new Set(given).size === left.length && given.every((k) => byKey.has(k)) ? given.map((k) => byKey.get(k)!) : left;
	return ordered.map((c) => cardIdOf(c)!);
}

/**
 * Forge's second question answered from the first one's reply: its keys in
 * the order `rest` gave. Null when `frame` is not that question.
 */
export function answerRest(frame: Extract<ServerFrame, { kind: 'ask' }>, rest: readonly number[]): { ordered: string[]; rememberDecision: false } | null {
	if (frame.method !== 'order' || frame.remainingObjectsMax !== 0 || frame.destChoices.length !== 0) return null;
	if (frame.sourceChoices.length !== rest.length) return null;
	const keyOf = new Map<number, string>();
	for (const c of frame.sourceChoices) {
		const id = cardIdOf(c);
		if (id === null) return null;
		keyOf.set(id, c.key);
	}
	if (!rest.every((id) => keyOf.has(id))) return null;
	return { ordered: rest.map((id) => keyOf.get(id)!), rememberDecision: false };
}

/**
 * Cards entering the battlefield together, every one the same card: their
 * order is no choice. Forge asks the controller to order any two or more
 * permanents one effect puts onto the battlefield
 * (`GameActionUtil.orderCardsByTheirOwners` → `PlayerControllerHuman.
 * orderMoveToZoneList`, `PlayerControllerHuman.java:1137`), so the six
 * Mountains Splendid Reclamation returns are six identical items to arrange.
 * Every arrangement of them is the same one: Forge's own order answers it.
 *
 * Read off the ask's own items — each a card, each labelled with the same name
 * once its instance id (`Mountain (128)`) is set aside. Only the battlefield's
 * caption opens this: a library, graveyard or damage order is still the
 * seat's, and so is a battlefield order of two different cards.
 */
export function sameCardsOrder(frame: Extract<ServerFrame, { kind: 'ask' }>): AutoAnswer | null {
	if (frame.method !== 'order' || frame.title !== 'Choose order of cards to put onto the battlefield') return null;
	if (frame.remainingObjectsMax !== 0 || frame.destChoices.length !== 0 || frame.showRememberCheckbox || frame.sideboardingMode) return null;
	const items = frame.sourceChoices;
	if (items.length < 2 || !items.every((c) => cardIdOf(c) !== null)) return null;
	const name = (c: ChoiceOption): string => c.label.replace(/ \(\d+\)$/, '');
	const first = name(items[0]!);
	if (!items.every((c) => name(c) === first)) return null;
	return { callId: frame.callId, method: frame.method, result: { ordered: items.map((c) => c.key), rememberDecision: false }, why: 'every card the same' };
}

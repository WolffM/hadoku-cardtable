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
 * cards left in `sourceChoices` are a group of their own, "Cards on top",
 * and the reply orders it too — and the second `order` is answered here from
 * that same reply, never shown.
 *
 * Forge's caption for the first question (`lblCardsToPutOnTheBottom`,
 * `lblCardsToPutInTheGraveyard`) is the only thing that tells a scry's
 * `many` from any other `many` of cards; the shape is checked as well, so a
 * caption alone never opens the fold. The follow-up is recognised by shape
 * alone: the very next ask to the same seat, an `order` of exactly the cards
 * the reply left on top, with every one to be placed.
 */

import type { ChoiceOption, ServerFrame } from '@hadoku/forge-wire';

type OrderAsk = Extract<ServerFrame, { kind: 'ask'; method: 'order' }>;

/** Forge's caption for the first question → the two groups the seat sees. */
const ARRANGEMENTS: ReadonlyMap<string, { top: string; rest: string }> = new Map([
	['Cards to put on the bottom', { top: 'Cards on bottom', rest: 'Cards on top' }],
	['Cards to put in the graveyard', { top: 'Cards in graveyard', rest: 'Cards on top' }],
]);

const cardIdOf = (c: ChoiceOption): number | null => (c.ref !== null && c.ref.kind === 'card' ? c.ref.id : null);

/**
 * The first question of a scry or surveil, as the seat is asked it: the same
 * ask with its two groups named, the top one ordered by the reply's `rest`.
 * Null for any other ask.
 */
export function arrangeAsk(frame: Extract<ServerFrame, { kind: 'ask' }>): OrderAsk | null {
	if (frame.method !== 'order' || frame.rest !== undefined) return null;
	const names = ARRANGEMENTS.get(frame.top);
	if (names === undefined) return null;
	const shaped =
		frame.remainingObjectsMin === -1 &&
		frame.remainingObjectsMax === -1 &&
		frame.destChoices.length === 0 &&
		frame.sourceChoices.length > 1 &&
		frame.sourceChoices.every((c) => cardIdOf(c) !== null) &&
		!frame.sideboardingMode &&
		!frame.showRememberCheckbox;
	return shaped ? { ...frame, top: names.top, rest: names.rest } : null;
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

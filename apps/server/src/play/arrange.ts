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
 *
 * A `Dig` is the same family: it asks which of the cards it looked at go to
 * its first zone (`chooseEntitiesForEffect`, `DigEffect.java:351`), then the
 * order of each group going into a library (`orderMoveToZoneList`). Jace, the
 * Mind Sculptor's fateseal was a "Choose card(s) to put on the bottom of …"
 * grid (the operator, 2026-10-19: *"it would be nice if it were just two zones
 * 'top' and 'bottom' and i can drag between them"*). The bridge says where
 * both groups go (`dig`), so the seat is asked one `order` of every card looked
 * at, the chosen group its answer and the rest its `rest`; Forge is sent the
 * chosen cards, and its order questions after it are answered from the same
 * reply (`pendingOrders`, `answerPending`).
 */

import type { ChoiceOption, ServerFrame } from '@hadoku/forge-wire';

import type { AutoAnswer } from './auto.js';

type OrderAsk = Extract<ServerFrame, { kind: 'ask'; method: 'order' }>;
type DigAsk = Extract<ServerFrame, { kind: 'ask'; method: 'chooseEntitiesForEffect' }>;
type Destination = NonNullable<OrderAsk['destination']>;
type OrderReply = { ordered: readonly string[]; rememberDecision: boolean; rest?: readonly string[] };

/**
 * A group of cards the seat already ordered in one prompt, for an `order`
 * Forge asks about them later: their ids in the reply's order, and which way
 * that order runs (`OrderDestinationSchema`'s `first`).
 */
export interface PendingOrder {
	readonly ids: readonly number[];
	readonly first: Destination['first'];
}

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
 * A `Dig`'s question, as the seat is asked it: one `order` of every card it
 * looked at, in Forge's order, all of them in the `rest` group to start with;
 * the answer is the chosen group, as many as Forge's `min`..`max`. A looked-at
 * card Forge does not offer (a `ChangeValid` it fails) is `locked` in the rest.
 * Its `question` is the action the dig's own text asks for (`digQuestion`), or
 * Forge's own question when the text has none to read.
 * Null for any other ask, and for a dig whose looked-at cards are not sent.
 */
export function digAsk(frame: Extract<ServerFrame, { kind: 'ask' }>): OrderAsk | null {
	if (frame.method !== 'chooseEntitiesForEffect' || frame.dig === undefined || frame.delayedReveal === null) return null;
	const looked = frame.delayedReveal.cards;
	const seen = new Set(looked.map((c) => c.id));
	const offered = new Set<number>();
	for (const r of frame.optionList) {
		if (r.kind !== 'card' || !seen.has(r.id)) return null;
		offered.add(r.id);
	}
	if (looked.length === 0 || offered.size === 0) return null;
	const n = looked.length;
	return sheetAsk(frame, frame.title, frame.dig.text, {
		remainingObjectsMin: n - frame.max,
		remainingObjectsMax: n - frame.min,
		sourceChoices: looked.map((c) => ({ key: digKey(c.id), label: '', ref: c })),
		destination: frame.dig.chosen,
		rest: frame.dig.rest,
		...(offered.size < n && { locked: looked.filter((c) => !offered.has(c.id)).map((c) => digKey(c.id)) }),
	});
}

/**
 * The one `order` a seat is shown in place of a question Forge asks in parts (a dig's, a
 * per-type pick's): `sheet`'s cards and groups under Forge's `title`, asking the action the
 * card's `text` names (`digQuestion`), or `title` when the text has none to read.
 */
export function sheetAsk(
	frame: Extract<ServerFrame, { kind: 'ask' }>,
	title: string,
	text: string | undefined,
	sheet: Pick<OrderAsk, 'remainingObjectsMin' | 'remainingObjectsMax' | 'sourceChoices' | 'destination' | 'rest' | 'locked' | 'oneEach'>,
): OrderAsk {
	return {
		kind: 'ask',
		callId: frame.callId,
		...(frame.source !== undefined && { source: frame.source }),
		method: 'order',
		title,
		top: title,
		destChoices: [],
		referenceCard: null,
		sideboardingMode: false,
		showRememberCheckbox: false,
		...sheet,
		question: (text === undefined ? null : digQuestion(text)) ?? title,
	};
}

/**
 * A look clause: the dig's "look at the top three cards of your library", "reveal a number of
 * cards from the top of your library", "exile the top card of that player's library".
 */
const LOOK = /\b(?:look|looks|reveal|reveals|exile|exiles)\b(?: at)?(?: [^\s.,;]+){0,6}? top\b[^.;]*?\b(?:library|libraries)\b/gi;

/** A sentence that says where cards go. */
const MOVES = /\b(?:hand|graveyard|library|libraries|battlefield|exile|exiles|exiled)\b/i;

/**
 * What a `Dig`'s text asks the seat to do with the cards it looked at, in the card's own words:
 * the sentences after its (last) look clause, through the last one that moves a card. The
 * operator, 2026-10-20, on Dragonlord Ojutai's sheet: *"ideally we just keep the action the player
 * has to take. "Put one of them into your hand and the rest on the bottom of your library in any
 * order.""* The look itself is what the sheet's cards already show, and what the text says before
 * it (a trigger's condition, a cost) or after the action (a life loss, "Then shuffle") is not the
 * decision. A clause that runs on to the action ("…, then exile any number of them") gives the
 * action; one that says what its number is ("…, where X is …") does not. Reminder text goes, and so
 * does an "If you do," that hangs on an optional look. Null when the text has no look clause, or
 * no action after it.
 */
export function digQuestion(text: string): string | null {
	const plain = text
		.replace(/\s*\([^)]*\)/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	const look = [...plain.matchAll(LOOK)].at(-1);
	if (look === undefined) return null;
	let after = plain.slice(look.index + look[0].length);
	const runsOn = /^(?:,? (?:then|and) |, (?!where\b))/i.exec(after);
	if (runsOn !== null) after = after.slice(runsOn[0].length);
	else {
		const end = after.search(/\.(?: |$)/);
		if (end === -1) return null;
		after = after.slice(end + 1);
	}
	const sentences = after.trim().replace(/^(?:if you do|then),? /i, '').match(/[^.]+(?:\.|$)/g) ?? [];
	let last = sentences.length - 1;
	while (last >= 0 && !MOVES.test(sentences[last]!)) last--;
	const action = sentences.slice(0, last + 1).join('').trim();
	return action === '' ? null : action[0]!.toUpperCase() + action.slice(1);
}

const digKey = (id: number): string => `d${id}`;

/**
 * Forge's answer to a `Dig`'s question from the reply to its `digAsk`: the
 * chosen cards, as the entity refs Forge offered.
 */
export function digAnswer(ask: DigAsk, reply: OrderReply): DigAsk['optionList'] {
	const byKey = new Map(ask.optionList.map((r) => [digKey(r.id), r]));
	return reply.ordered.flatMap((key) => byKey.get(key) ?? []);
}

/** The card ids of one group of a reply, in the reply's order. */
function groupIds(ask: OrderAsk, keys: readonly string[]): number[] {
	const byKey = new Map([...ask.sourceChoices, ...ask.destChoices].map((c) => [c.key, cardIdOf(c)]));
	return keys.flatMap((k) => {
		const id = byKey.get(k);
		return id === undefined || id === null ? [] : [id];
	});
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
 * The groups of a one-prompt reply whose order Forge has still to ask for: of
 * two or more cards, going to a zone with an order. A scry's or a surveil's
 * answer is its chosen group's order already, so only its rest is asked about;
 * a dig's chosen cards are an unordered pick, so both of its groups are
 * (`DigEffect.java:363-370,428-433`).
 */
export function pendingOrders(ask: OrderAsk, reply: OrderReply, dig: boolean): PendingOrder[] {
	const groups: [readonly number[], Destination | undefined][] = [
		...(dig ? [[groupIds(ask, reply.ordered), ask.destination] as [readonly number[], Destination | undefined]] : []),
		[restOrder(ask, reply), ask.rest],
	];
	return groups.filter(([ids, to]) => ids.length > 1 && to !== undefined && to.zone !== 'hand' && to.zone !== 'exile').map(([ids, to]) => ({ ids, first: to!.first }));
}

/**
 * A later `order` Forge asks about one of `pending`'s groups, answered from it:
 * its keys in the group's order, turned round when this question reads its
 * answer the other way up (its own `destination.first`). Null when `frame` is
 * no such question; `left` is what is still pending after it.
 */
export function answerPending(
	frame: Extract<ServerFrame, { kind: 'ask' }>,
	pending: readonly PendingOrder[],
): { result: { ordered: string[]; rememberDecision: false }; left: PendingOrder[] } | null {
	if (frame.method !== 'order' || frame.remainingObjectsMax !== 0 || frame.destChoices.length !== 0) return null;
	const keyOf = new Map<number, string>();
	for (const c of frame.sourceChoices) {
		const id = cardIdOf(c);
		if (id === null) return null;
		keyOf.set(id, c.key);
	}
	const at = pending.findIndex((p) => p.ids.length === keyOf.size && p.ids.every((id) => keyOf.has(id)));
	if (at === -1) return null;
	const group = pending[at]!;
	const turned = frame.destination?.first !== undefined && group.first !== undefined && frame.destination.first !== group.first;
	const ids = turned ? [...group.ids].reverse() : group.ids;
	return { result: { ordered: ids.map((id) => keyOf.get(id)!), rememberDecision: false }, left: pending.filter((_, i) => i !== at) };
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

/**
 * "For each card type, you may put a card of that type …" is one prompt.
 *
 * Forge resolves it as a `RepeatEach` over card types (`RepeatEachEffect.java:132`): it asks the
 * seat a card type (`chooseSomeType`, a `getChoices` of the types left), then a card of that type
 * (an optional `ChooseCard`), once per type. Atraxa, Grand Unifier asked seven times over; the
 * operator, 2026-10-20: *"would be much better if we just showed all 7 cards and let me pick all of
 * them at once rather than one at a time"*.
 *
 * The bridge marks the first type question with the whole of it (`eachType`, `PlayBridge.java`'s
 * `eachTypeOf`): every card a turn could offer and the types it could fill, where picked cards go
 * and where the rest go. The seat is asked one `order` of those cards, Hand and the rest's zone,
 * with the types as the answer's limits (`oneEach`: one card per type, a card filling one type).
 * Forge is sent the first type; every later type and card question is answered here from the same
 * reply (`nextEachType`), never shown. A later question the reply did not foresee is shown to the
 * seat like any other.
 */

import { oneEachFit, type ServerFrame } from '@hadoku/forge-wire';

import { digQuestion } from './arrange.js';

type Ask = Extract<ServerFrame, { kind: 'ask' }>;
type ChoicesAsk = Extract<ServerFrame, { kind: 'ask'; method: 'getChoices' }>;
type OrderAsk = Extract<ServerFrame, { kind: 'ask'; method: 'order' }>;

/** One card type, in the order Forge will be told it, and the card the reply put in for it (null: none). */
interface Step {
	readonly type: string;
	readonly card: number | null;
}

/**
 * What the seat's one reply still owes Forge: the types not yet named, and the card for the type
 * named last (`undefined` once Forge has asked for it).
 */
export interface EachTypeLeft {
	readonly steps: readonly Step[];
	readonly card: number | null | undefined;
}

const sheetKey = (id: number): string => `t${id}`;

/** The seat's question for a per-type pick's first type question: one sheet of every card. Null for any other ask. */
export function eachTypeAsk(frame: Ask): OrderAsk | null {
	if (frame.method !== 'getChoices' || frame.eachType === undefined || frame.max !== 1) return null;
	const { cards, chosen, rest, text } = frame.eachType;
	const types = frame.choices.map((c) => c.label);
	const oneEach = types
		.map((type) => ({ type, keys: cards.filter((c) => c.types.includes(type)).map((c) => sheetKey(c.card.id)) }))
		.filter((t) => t.keys.length > 0);
	if (oneEach.length === 0) return null;
	const n = cards.length;
	return {
		kind: 'ask',
		callId: frame.callId,
		...(frame.source !== undefined && { source: frame.source }),
		method: 'order',
		title: frame.message,
		top: frame.message,
		remainingObjectsMin: Math.max(0, n - oneEach.length),
		remainingObjectsMax: n,
		sourceChoices: cards.map((c) => ({ key: sheetKey(c.card.id), label: c.name, ref: c.card })),
		destChoices: [],
		referenceCard: null,
		sideboardingMode: false,
		showRememberCheckbox: false,
		destination: chosen,
		rest,
		oneEach,
		question: (text === undefined ? null : digQuestion(text)) ?? frame.message,
	};
}

/**
 * Forge's answer to its first type question from the seat's reply to the sheet, and what the reply
 * still owes; null when the reply's cards cannot each fill a type of their own. The types the reply
 * filled go first, so Forge's later questions all have the card they ask for.
 */
export function firstEachType(ask: ChoicesAsk, sheet: OrderAsk, ordered: readonly string[]): { result: string[]; left: EachTypeLeft } | null {
	const fill = oneEachFit(sheet.oneEach ?? [], ordered)?.fill;
	if (fill === undefined) return null;
	const idOf = new Map(sheet.sourceChoices.flatMap((c) => (c.ref !== null && c.ref.kind === 'card' ? [[c.key, c.ref.id] as const] : [])));
	const steps: Step[] = ask.choices.map((c) => ({ type: c.label, card: idOf.get(fill.get(c.label) ?? '') ?? null }));
	steps.sort((a, b) => Number(b.card !== null) - Number(a.card !== null));
	const [first, ...later] = steps;
	const key = ask.choices.find((c) => c.label === first!.type)!.key;
	return { result: [key], left: { steps: later, card: first!.card } };
}

/**
 * A later question of the same pick answered from what the reply still owes: a card question with
 * the card for the type named last (none: declined), a type question with the next type. The last
 * type is never asked: a card question then is that type's. Null when
 * `frame` is not that question; `left` is null once the reply owes nothing.
 */
export function nextEachType(frame: Ask, owed: EachTypeLeft): { result: unknown; left: EachTypeLeft | null } | null {
	const done = (l: EachTypeLeft): EachTypeLeft | null => (l.steps.length === 0 && l.card === undefined ? null : l);
	// Forge names the last type itself, never asking (`AbstractGuiGame.one` over one choice).
	const left = owed.card === undefined && owed.steps.length === 1 && frame.method !== 'getChoices' ? { steps: [], card: owed.steps[0]!.card } : owed;
	if (left.card !== undefined && (frame.method === 'chooseSingleEntityForEffect' || frame.method === 'chooseEntitiesForEffect')) {
		const offered = frame.optionList.find((r) => r.kind === 'card' && r.id === left.card);
		const next = done({ steps: left.steps, card: undefined });
		if (frame.method === 'chooseSingleEntityForEffect') {
			if (left.card === null) return frame.isOptional ? { result: null, left: next } : null;
			return offered === undefined ? null : { result: offered, left: next };
		}
		if (left.card === null) return frame.min === 0 ? { result: [], left: next } : null;
		return offered === undefined || frame.max < 1 ? null : { result: [offered], left: next };
	}
	const [step, ...later] = left.steps;
	if (frame.method !== 'getChoices' || step === undefined || frame.max !== 1) return null;
	const choice = frame.choices.find((c) => c.label === step.type);
	if (choice === undefined || !frame.choices.every((c) => left.steps.some((s) => s.type === c.label))) return null;
	return { result: [choice.key], left: { steps: later, card: step.card } };
}

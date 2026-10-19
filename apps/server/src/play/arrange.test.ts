/**
 * A dig as one prompt (`./arrange.ts`): the seat is asked one `order` of every card the `Dig`
 * looked at, Forge is sent the chosen cards, and the order questions Forge asks after it are
 * answered from the same reply.
 */
import { describe, expect, it } from 'vitest';

import { REPLY_SCHEMAS, type ServerFrame } from '@hadoku/forge-wire';

import { answerPending, arrangeAsk, digAnswer, digAsk, pendingOrders } from './arrange.js';

type Ask = Extract<ServerFrame, { kind: 'ask' }>;
type DigAsk = Extract<Ask, { method: 'chooseEntitiesForEffect' }>;
type OrderAsk = Extract<Ask, { method: 'order' }>;

const card = (id: number) => ({ kind: 'card' as const, id });
const BOB = { kind: 'player' as const, id: 2 };

/** Jace, the Mind Sculptor's +2 on Bob: one card looked at, none or it to the bottom. */
const fateseal = (looked: number[], min = 0, max = looked.length): DigAsk => ({
	kind: 'ask',
	callId: 'c-dig',
	method: 'chooseEntitiesForEffect',
	title: 'Choose card(s) to put on the bottom of Bob library',
	optionList: looked.map(card),
	min,
	max,
	delayedReveal: { cards: looked.map(card), zones: ['Library'], owner: BOB, messagePrefix: 'Jace - Looking at cards in ' },
	dig: {
		chosen: { zone: 'library', end: 'bottom', first: 'top', owner: BOB },
		rest: { zone: 'library', end: 'top', first: 'top', owner: BOB },
	},
});

/** Forge's later order of some cards, as the bridge sends it. */
const followUp = (ids: number[], destination?: OrderAsk['destination']): OrderAsk => ({
	kind: 'ask',
	callId: 'c-order',
	method: 'order',
	title: 'Choose order of cards to put into the library',
	top: 'Closest to top',
	remainingObjectsMin: 0,
	remainingObjectsMax: 0,
	sourceChoices: ids.map((id, i) => ({ key: `s${i}`, label: `X (${id})`, ref: card(id) })),
	destChoices: [],
	referenceCard: null,
	sideboardingMode: false,
	showRememberCheckbox: false,
	...(destination !== undefined && { destination }),
});

describe('digAsk', () => {
	it('asks one order of every card looked at, all in the rest to start with, the chosen zone the answer', () => {
		const shown = digAsk(fateseal([71]))!;
		expect(shown.method).toBe('order');
		expect(shown.callId).toBe('c-dig');
		expect(shown.sourceChoices.map((c) => c.ref)).toEqual([card(71)]);
		expect(shown.destination).toEqual(fateseal([71]).dig!.chosen);
		expect(shown.rest).toEqual(fateseal([71]).dig!.rest);
		expect([shown.remainingObjectsMin, shown.remainingObjectsMax]).toEqual([0, 1]);
		expect(shown.locked).toBeUndefined();
	});

	it('bounds the answer by Forge’s min..max: Impulse takes exactly one', () => {
		const shown = digAsk({ ...fateseal([1, 2, 3, 4], 1, 1), dig: { chosen: { zone: 'hand' }, rest: { zone: 'library', end: 'bottom', first: 'top' } } })!;
		expect([shown.remainingObjectsMin, shown.remainingObjectsMax]).toEqual([3, 3]);
	});

	it('locks a looked-at card Forge does not offer (a ChangeValid it fails) into the rest', () => {
		const shown = digAsk({ ...fateseal([1, 2, 3], 0, 1), optionList: [card(2)] })!;
		expect(shown.locked).toEqual(['d1', 'd3']);
	});

	it('is no dig without the bridge’s zones, without the looked-at cards, or with an option it did not look at', () => {
		expect(digAsk({ ...fateseal([1]), dig: undefined })).toBeNull();
		expect(digAsk({ ...fateseal([1]), delayedReveal: null })).toBeNull();
		expect(digAsk({ ...fateseal([1]), optionList: [card(9)] })).toBeNull();
		expect(arrangeAsk(fateseal([1]))).toBeNull();
	});
});

describe('digAnswer', () => {
	it('drag top→bottom: Forge is sent that card, as the ref it offered', () => {
		const ask = fateseal([71]);
		const result = digAnswer(ask, { ordered: ['d71'], rememberDecision: false, rest: [] });
		expect(result).toEqual([card(71)]);
		expect(REPLY_SCHEMAS.chooseEntitiesForEffect.safeParse(result).success).toBe(true);
	});

	it('kept on top: Forge is sent no card', () => {
		expect(digAnswer(fateseal([71]), { ordered: [], rememberDecision: false, rest: ['d71'] })).toEqual([]);
	});
});

describe('the order questions after a dig', () => {
	const ask = digAsk(fateseal([1, 2, 3, 4]))!;
	const reply = { ordered: ['d4', 'd2'], rememberDecision: false, rest: ['d3', 'd1'] };

	it('keeps both groups of two or more, in the reply’s order', () => {
		expect(pendingOrders(ask, reply, true)).toEqual([
			{ ids: [4, 2], first: 'top' },
			{ ids: [3, 1], first: 'top' },
		]);
	});

	it('keeps no group of one card: Forge never asks the order of one', () => {
		expect(pendingOrders(ask, { ordered: ['d4'], rememberDecision: false, rest: ['d3', 'd1', 'd2'] }, true)).toEqual([{ ids: [3, 1, 2], first: 'top' }]);
	});

	it('a scry keeps only its top: its bottom group is its answer already', () => {
		expect(pendingOrders(ask, reply, false)).toEqual([{ ids: [3, 1], first: 'top' }]);
	});

	it('answers each later order of exactly a group’s cards, turned round when Forge reads it the other way', () => {
		const pending = pendingOrders(ask, reply, true);
		const top = answerPending(followUp([1, 3], { zone: 'library', end: 'top', first: 'top' }), pending)!;
		expect(top.result).toEqual({ ordered: ['s1', 's0'], rememberDecision: false });
		expect(top.left).toEqual([{ ids: [4, 2], first: 'top' }]);
		const bottom = answerPending(followUp([2, 4], { zone: 'library', end: 'bottom', first: 'bottom' }), top.left)!;
		expect(bottom.result, 'the highest of the bottom group last').toEqual({ ordered: ['s0', 's1'], rememberDecision: false });
		expect(bottom.left).toEqual([]);
	});

	it('leaves any other order alone', () => {
		const pending = pendingOrders(ask, reply, true);
		expect(answerPending(followUp([1, 2]), pending)).toBeNull();
		expect(answerPending(followUp([1, 2, 3]), pending)).toBeNull();
		expect(answerPending(fateseal([1, 3]), pending)).toBeNull();
	});
});

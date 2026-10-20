/**
 * A dig as one prompt (`./arrange.ts`): the seat is asked one `order` of every card the `Dig`
 * looked at, Forge is sent the chosen cards, and the order questions Forge asks after it are
 * answered from the same reply.
 */
import { describe, expect, it } from 'vitest';

import { REPLY_SCHEMAS, type ServerFrame } from '@hadoku/forge-wire';

import { answerPending, arrangeAsk, digAnswer, digAsk, digQuestion, pendingOrders } from './arrange.js';

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

describe('digQuestion', () => {
	const asks = (text: string) => expect(digQuestion(text));
	it('is the instruction after the look clause, wherever the clause stands in its sentence', () => {
		asks(
			'Whenever Dragonlord Ojutai deals combat damage to a player, look at the top three cards of your library. Put one of them into your hand and the rest on the bottom of your library in any order.',
		).toBe('Put one of them into your hand and the rest on the bottom of your library in any order.');
		asks('Look at the top four cards of your library. Put one of them into your hand and the rest on the bottom of your library in any order.').toBe(
			'Put one of them into your hand and the rest on the bottom of your library in any order.',
		);
		asks('Reveal the top five cards of your library. You may put a creature or enchantment card from among them into your hand. Put the rest into your graveyard.').toBe(
			'You may put a creature or enchantment card from among them into your hand. Put the rest into your graveyard.',
		);
	});
	it('reads past what the look clause says of its number, and an action joined to it by a comma', () => {
		asks('Look at the top X cards of your library, where X is the amount of mana spent to cast this spell. Put two of them into your hand and the rest on the bottom of your library in a random order.').toBe(
			'Put two of them into your hand and the rest on the bottom of your library in a random order.',
		);
		asks('Look at the top five cards of your library, put one of them into your hand, and exile the rest.').toBe('Put one of them into your hand, and exile the rest.');
		asks('Look at the top ten cards of your library, then exile any number of them and put the rest back on top of your library in any order.').toBe(
			'Exile any number of them and put the rest back on top of your library in any order.',
		);
	});
	it('starts at the last look, without the "If you do," that hangs on it', () => {
		asks('Look at the top four cards of your library. If this spell was bargained, look at the top eight cards of your library instead. Put two of them into your hand and the rest on the bottom of your library in a random order.').toBe(
			'Put two of them into your hand and the rest on the bottom of your library in a random order.',
		);
		asks('When Fertile Thicket enters, you may look at the top five cards of your library. If you do, reveal up to one basic land card from among them, then put that card on top of your library and the rest on the bottom in any order.').toBe(
			'Reveal up to one basic land card from among them, then put that card on top of your library and the rest on the bottom in any order.',
		);
	});
	it('ends at the last sentence that moves a card, and leaves out reminder text', () => {
		asks('Look at the top three cards of your library. Put two of them into your hand and the rest into your graveyard. You lose 2 life.').toBe('Put two of them into your hand and the rest into your graveyard.');
		asks('Look at the top seven cards of your library (reminder). Put two of them into your hand and the rest on the bottom of your library in any order.').toBe(
			'Put two of them into your hand and the rest on the bottom of your library in any order.',
		);
	});
	it('is null for a text with no look clause, or no action after it', () => {
		asks('Look at the top card of target player\'s library.').toBeNull();
		asks('Put the top card of your library on the bottom of your library.').toBeNull();
		asks('Look at the top card of target player\'s library. Activate only if you control two or more blue permanents.').toBeNull();
	});
});

describe('digAsk', () => {
	it("leads with the dig's action, Forge's own question where its text has none", () => {
		const ojutai = 'Whenever Dragonlord Ojutai deals combat damage to a player, look at the top three cards of your library. Put one of them into your hand and the rest on the bottom of your library in any order.';
		const dig = fateseal([1, 2, 3], 1, 1);
		expect(digAsk({ ...dig, dig: { ...dig.dig!, text: ojutai } })!.question).toBe('Put one of them into your hand and the rest on the bottom of your library in any order.');
		expect(digAsk({ ...dig, dig: { ...dig.dig!, text: "Look at the top card of target player's library." } })!.question).toBe(dig.title);
		expect(digAsk(dig)!.question).toBe(dig.title);
	});

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

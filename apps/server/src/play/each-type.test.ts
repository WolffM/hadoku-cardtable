/**
 * `each-type.ts`: Atraxa, Grand Unifier's "for each card type" is one sheet, and Forge's later type
 * and card questions are answered from its one reply.
 */
import type { ServerFrame } from '@hadoku/forge-wire';
import { describe, expect, it } from 'vitest';

import { eachTypeAsk, firstEachType, nextEachType, type EachTypeLeft } from './each-type.js';

type Ask = Extract<ServerFrame, { kind: 'ask' }>;
type ChoicesAsk = Extract<ServerFrame, { kind: 'ask'; method: 'getChoices' }>;

const card = (id: number) => ({ kind: 'card' as const, id });

/** Forge's type question over `types`; the first one carries the bridge's `eachType`. */
const typeAsk = (callId: string, types: string[], first = false): ChoicesAsk => ({
	kind: 'ask',
	callId,
	method: 'getChoices',
	message: 'Choose a card type',
	min: 1,
	max: 1,
	choices: types.map((label, i) => ({ key: `c${i}`, label, ref: null })),
	selected: [],
	...(first && {
		eachType: {
			// 1 an artifact creature, 2 an artifact, 3 a creature, 4 a land.
			cards: [
				{ card: card(1), name: 'Ornithopter', types: ['Artifact', 'Creature'] },
				{ card: card(2), name: 'Sol Ring', types: ['Artifact'] },
				{ card: card(3), name: 'Llanowar Elves', types: ['Creature'] },
				{ card: card(4), name: 'Forest', types: ['Land'] },
			],
			chosen: { zone: 'hand' as const },
			rest: { zone: 'library' as const, end: 'bottom' as const, first: 'top' as const },
			text: 'When Atraxa, Grand Unifier enters, reveal the top ten cards of your library. For each card type, you may put a card of that type from among the revealed cards into your hand. Put the rest on the bottom of your library in a random order.',
		},
	}),
});

const cardAsk = (callId: string, ids: number[]): Ask => ({
	kind: 'ask',
	callId,
	method: 'chooseSingleEntityForEffect',
	title: 'Choose a card ',
	optionList: ids.map(card),
	delayedReveal: null,
	isOptional: true,
});

describe('a per-type pick is one sheet', () => {
	const first = typeAsk('s0-5', ['Artifact', 'Creature', 'Land'], true);

	it('asks every card at once, Hand | Bottom, the types as the answer’s limits, the action as its question', () => {
		const sheet = eachTypeAsk(first)!;
		expect(sheet.method).toBe('order');
		expect(sheet.sourceChoices.map((c) => c.label)).toEqual(['Ornithopter', 'Sol Ring', 'Llanowar Elves', 'Forest']);
		expect(sheet.destination).toEqual({ zone: 'hand' });
		expect(sheet.rest).toEqual({ zone: 'library', end: 'bottom', first: 'top' });
		expect(sheet.oneEach).toEqual([
			{ type: 'Artifact', keys: ['t1', 't2'] },
			{ type: 'Creature', keys: ['t1', 't3'] },
			{ type: 'Land', keys: ['t4'] },
		]);
		expect(sheet.question).toBe(
			'For each card type, you may put a card of that type from among the revealed cards into your hand. Put the rest on the bottom of your library in a random order.',
		);
		expect(eachTypeAsk(typeAsk('s0-7', ['Artifact']))).toBeNull();
	});

	it('answers Forge’s type and card questions from the one reply, the filled types first, then declines the rest', () => {
		const sheet = eachTypeAsk(first)!;
		// The artifact creature fills Creature so that Sol Ring can fill Artifact.
		const one = firstEachType(first, sheet, ['t1', 't2'])!;
		const told: unknown[] = [one.result];
		let left: EachTypeLeft | null = one.left;
		const forge: Ask[] = [
			cardAsk('s0-6', [1, 2]),
			typeAsk('s0-7', ['Creature', 'Land']),
			cardAsk('s0-8', [1, 3]),
			// The last type, Land, Forge names itself.
			cardAsk('s0-10', [4]),
		];
		for (const frame of forge) {
			const next = nextEachType(frame, left!);
			expect(next, frame.callId).not.toBeNull();
			told.push(next!.result);
			left = next!.left;
		}
		expect(told).toEqual([['c0'], card(2), ['c0'], card(1), null]);
		expect(left).toBeNull();
	});

	it('an artifact creature picked before a creature is told to Forge as the artifact', () => {
		const one = firstEachType(first, eachTypeAsk(first)!, ['t1', 't3'])!;
		const told: unknown[] = [one.result];
		let left: EachTypeLeft | null = one.left;
		const forge: Ask[] = [cardAsk('s0-6', [1, 2]), typeAsk('s0-7', ['Creature', 'Land']), cardAsk('s0-8', [3]), cardAsk('s0-10', [4])];
		for (const frame of forge) {
			const next = nextEachType(frame, left!);
			expect(next, frame.callId).not.toBeNull();
			told.push(next!.result);
			left = next!.left;
		}
		expect(told).toEqual([['c0'], card(1), ['c0'], card(3), null]);
		expect(left).toBeNull();
	});

	it('every reply it accepts puts each card in a type of its own, one the card has', () => {
		const sheet = eachTypeAsk(first)!;
		const typesOf = new Map([
			[1, ['Artifact', 'Creature']],
			[2, ['Artifact']],
			[3, ['Creature']],
			[4, ['Land']],
		]);
		for (let mask = 1; mask < 16; mask++) {
			const ordered = [1, 2, 3, 4].filter((id) => mask & (1 << (id - 1))).map((id) => `t${id}`);
			const one = firstEachType(first, sheet, ordered);
			if (one === null) continue;
			const steps = [{ type: first.choices.find((c) => c.key === one.result[0])!.label, card: one.left.card }, ...one.left.steps];
			const placed = steps.filter((s) => s.card !== null);
			expect(placed.map((s) => `t${s.card}`).sort(), ordered.join()).toEqual([...ordered].sort());
			for (const s of placed) expect(typesOf.get(s.card!), ordered.join()).toContain(s.type);
			expect(new Set(steps.map((s) => s.type)).size).toBe(3);
		}
	});

	it('refuses a reply that puts two cards in for one type', () => {
		expect(firstEachType(first, eachTypeAsk(first)!, ['t2', 't1', 't3'])).toBeNull();
	});

	it('shows a question the reply did not foresee', () => {
		const one = firstEachType(first, eachTypeAsk(first)!, ['t4'])!;
		expect(nextEachType(cardAsk('s0-6', [2]), one.left)).toBeNull();
	});
});

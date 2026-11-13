import { describe, expect, it } from 'vitest';

import { fallbackFor } from './unparsed.js';

const name = (ref: { kind: string; id: number }) => (ref.kind === 'card' ? `Card ${ref.id}` : `${ref.kind} #${ref.id}`);

describe('fallbackFor: an unparsed ask as a pick of its whole answers', () => {
	it("a getChoices keeps its own keys, min and max, and answers with Forge's keys", () => {
		const fb = fallbackFor(
			{ kind: 'ask', callId: 'c', method: 'getChoices', message: 'Name a card', min: 1, max: 1, choices: [{ key: 'k1', label: 'Bolt' }, { key: 'k2', ref: { kind: 'card', id: 4 } }], extra: true },
			'c',
			name,
		)!;
		expect(fb.frame).toMatchObject({ method: 'getChoices', callId: 'c', message: 'Name a card', min: 1, max: 1 });
		expect(fb.frame.choices.map((c) => c.label)).toEqual(['Bolt', 'Card 4']);
		expect(fb.answer(['1'])).toEqual(['k2']);
	});

	it('a card-name ask stays a search over its names, each name its own key', () => {
		const fb = fallbackFor({ method: 'getChoices', message: 'Name a nonland card', min: 1, max: 1, choices: [], names: ['Elvish Mystic', 'Goblin Guide'], selected: [], stray: 1 }, 'c', name)!;
		expect(fb.frame).toMatchObject({ choices: [], names: ['Elvish Mystic', 'Goblin Guide'] });
		expect(fb.answer(['Goblin Guide'])).toEqual(['Goblin Guide']);
	});

	it('a single entity answers with the raw ref, and null only when the ask is optional', () => {
		const raw = { method: 'chooseSingleEntityForEffect', title: 'Target', optionList: [{ kind: 'card', id: 3 }, { kind: 'player', id: 1, odd: 1 }], isOptional: false };
		const fb = fallbackFor(raw, 'c', name)!;
		expect(fb.frame.min).toBe(1);
		expect(fb.frame.choices.map((c) => c.label)).toEqual(['Card 3', 'player #1']);
		expect(fb.answer(['1'])).toEqual({ kind: 'player', id: 1, odd: 1 });
		expect(fallbackFor({ ...raw, isOptional: true }, 'c', name)!.frame.min).toBe(0);
	});

	it('yes/no and option dialogs answer with a boolean and an index', () => {
		expect(fallbackFor({ method: 'confirm', question: 'Pay 2 life?' }, 'c', name)!.answer(['1'])).toBe(false);
		expect(fallbackFor({ method: 'showOptionDialog', options: ['A', 'B', 'C'] }, 'c', name)!.answer(['2'])).toBe(2);
	});

	it('a division lists its whole answers with each colour named', () => {
		const fb = fallbackFor(
			{ method: 'assignGenericAmount', target: [{ key: { target: 'manaColor', color: 8 }, amount: 2 }, { key: { target: 'manaColor', color: 16 }, amount: 2 }], amount: 2, atLeastOne: false },
			'c',
			name,
		)!;
		expect(fb.frame.choices.map((c) => c.label)).toEqual(['2 red', '1 red, 1 green', '2 green']);
	});

	it('has none for a method whose answer is not a pick among what the frame lists', () => {
		expect(fallbackFor({ method: 'order', sourceChoices: [] }, 'c', name)).toBeNull();
		expect(fallbackFor({ method: 'getChoices', choices: [{ label: 'no key' }] }, 'c', name)).toBeNull();
		expect(fallbackFor(null, 'c', name)).toBeNull();
	});
});

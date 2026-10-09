import { describe, expect, it } from 'vitest';
import { ArtPreloadSchema } from '@hadoku/shared';

import { artOf } from './art.js';

const alice = '[metadata]\nName=Alice\n[main]\n4 Lightning Bolt|M10\n20 Mountain\n2 Volcanic Hammer\n';
const bob = `[metadata]\nName=Bob\n[Main]\n4 Grizzly Bears\n18 Forest|M10\n[Sideboard]\n2 Naturalize|ONS\n`;

describe('the art a match tells each client to preload', () => {
	it('carries every card of BOTH decks, main and sideboard, once each, by name and set', () => {
		const cards = artOf({ seats: [{ name: 'a', ai: false, deck: alice }, { name: 'b', ai: false, deck: bob }] });
		expect(cards).toEqual(
			expect.arrayContaining([
				{ name: 'Lightning Bolt', set: 'M10' },
				{ name: 'Mountain', set: null },
				{ name: 'Volcanic Hammer', set: null },
				{ name: 'Grizzly Bears', set: null },
				{ name: 'Forest', set: 'M10' },
				{ name: 'Naturalize', set: 'ONS' },
			]),
		);
		expect(cards).toHaveLength(6);
		expect(ArtPreloadSchema.parse({ matchId: 'm1', cards }).cards).toHaveLength(6);
	});

	it('dedupes a card both decks hold', () => {
		const cards = artOf({ seats: [{ name: 'a', ai: false, deck: alice }, { name: 'b', ai: false, deck: alice }] });
		expect(cards.filter((c) => c.name === 'Lightning Bolt')).toHaveLength(1);
	});

	it('names nothing for a random precon, and every card a scenario places', () => {
		const scenario = 'turn=1\nhumanhand=Volcanic Hammer;Mountain\nhumanbattlefield=Mountain|Tapped:True\naibattlefield=Grizzly Bears\nailibrary=\n';
		const cards = artOf({ seats: [{ name: 'a', ai: false, deck: null }, { name: 'b', ai: false, deck: null }], scenario });
		expect(cards.map((c) => c.name).sort()).toEqual(['Grizzly Bears', 'Mountain', 'Volcanic Hammer']);
	});
});

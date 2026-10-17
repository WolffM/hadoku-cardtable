import { describe, expect, it } from 'vitest';
import { DeckColorsSchema } from '@hadoku/shared';

import { roomDeckCosts, seatDeckColors } from './deck-colors.js';
import type { MatchSpec } from './host.js';

const costs: Record<string, string> = { 'Lightning Bolt': '{R}', 'Grizzly Bears': '{1}{G}', 'Gut Shot': '{R/P}', Naturalize: '{1}{G}' };
const fixed = () => costs;

const red = '[metadata]\nName=Red\n[main]\n4 Lightning Bolt|M10\n20 Mountain\n';
const gruul = '[metadata]\nName=Gruul\n[Main]\n4 Lightning Bolt\n4 Grizzly Bears\n18 Forest|M10\n';
const splashSide = '[metadata]\nName=Side\n[main]\n4 Lightning Bolt\n[Sideboard]\n2 Naturalize\n';
const colourless = '[metadata]\nName=Rocks\n[main]\n4 Gut Shot\n20 Wastes\n';

describe("a seat's deck colours, for the match's music", () => {
	const spec = (deck: string | null): Pick<MatchSpec, 'seats'> => ({ seats: [{ name: 'a', ai: false, deck }, { name: 'b', ai: false, deck: gruul }] });

	it('folds the main deck the seat was started with, never the other seat’s', () => {
		expect(seatDeckColors(spec(red), 0, fixed)).toEqual(['R']);
		expect(seatDeckColors(spec(red), 1, fixed)).toEqual(['R', 'G']);
	});

	it('leaves the sideboard and Phyrexian mana out', () => {
		expect(seatDeckColors(spec(splashSide), 0, fixed)).toEqual(['R']);
		expect(seatDeckColors(spec(colourless), 0, fixed)).toEqual([]);
	});

	it('is null for a precon the server never saw', () => {
		expect(seatDeckColors(spec(null), 0, fixed)).toBeNull();
	});

	it('travels on the shared wire schema', () => {
		expect(DeckColorsSchema.safeParse({ matchId: 'm', colors: seatDeckColors(spec(red), 1, fixed) }).success).toBe(true);
		expect(DeckColorsSchema.safeParse({ matchId: 'm', colors: null }).success).toBe(true);
	});
});

describe('the costs a room folds against', () => {
	const era = { fixture: { manaCost: { 'Era Card': '{U}' } } };
	const library = { format: (id: string) => (id === 'era' ? era : undefined) };

	it("adds the era's costs, and a drafted pool's cube costs, to the library's", () => {
		const costsFor = roomDeckCosts(library, [{ name: 'Cube Card', manaCost: ['2', 'B'] }]);
		expect(costsFor('era')['Era Card']).toBe('{U}');
		expect(costsFor('era')['Lightning Bolt']).toBe('{R}');
		expect(costsFor('draft:cube')['Cube Card']).toBe('{2}{B}');
		expect(costsFor('era')['Cube Card']).toBeUndefined();
	});
});

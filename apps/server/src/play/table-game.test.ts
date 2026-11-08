import { describe, expect, it } from 'vitest';
import type { TableGameLive } from '@hadoku/shared';

import type { MatchSpec } from './host.js';
import { deckArtCard, seatDeck, tableGame, type TableGameSource } from './table-game.js';

const COSTS: Record<string, string> = { 'Goblin Matron': '{2}{R}', 'Goblin Lackey': '{R}', 'Siege-Gang Commander': '{3}{R}{R}', Counterspell: '{U}{U}' };
const costs = () => COSTS;
const dck = (name: string, main: string) => `[metadata]\nName=${name}\n[main]\n${main}\n`;

describe('deckArtCard', () => {
	const line = (name: string, count: number) => ({ card: { name }, count });

	it('is the most-played spell, the dearer on a tie, then the first by name — never a land', () => {
		expect(deckArtCard([line('Mountain', 20), line('Goblin Lackey', 4), line('Goblin Matron', 4)], COSTS)).toBe('Goblin Matron');
		expect(deckArtCard([line('Goblin Lackey', 4), line('Siege-Gang Commander', 2)], COSTS)).toBe('Goblin Lackey');
		expect(deckArtCard([line('Goblin Matron', 2), line('Goblin Lackey', 2)], COSTS)).toBe('Goblin Matron');
		expect(deckArtCard([line('Mountain', 20)], COSTS)).toBeNull();
	});
});

describe('seatDeck', () => {
	it('names the deck, folds its colours and picks its art from the .dck the seat was started with', () => {
		const spec: Pick<MatchSpec, 'seats'> = { seats: [{ name: 'a', ai: false, deck: dck('Goblins', '20 Mountain\n4 Goblin Matron\n4 Goblin Lackey') }, { name: 'b', ai: true, deck: null }] };
		expect(seatDeck(spec, 0, costs)).toEqual({ name: 'Goblins', colors: ['R'], art: 'Goblin Matron' });
		// A random Forge precon: the server never saw it.
		expect(seatDeck(spec, 1, costs)).toBeNull();
	});
});

describe('tableGame', () => {
	it('carries both seats’ decks and the game under way', () => {
		const live: TableGameLive = { turn: 7, active: 1, life: [14, 9], hand: [2, 4] };
		const match: TableGameSource = {
			spec: { seats: [{ name: 'a', ai: false, deck: dck('Goblins', '4 Goblin Matron') }, { name: 'b', ai: false, deck: dck('Draw-Go', '4 Counterspell') }] },
			live: () => live,
		};
		expect(tableGame(match, costs)).toEqual({
			decks: [
				{ name: 'Goblins', colors: ['R'], art: 'Goblin Matron' },
				{ name: 'Draw-Go', colors: ['U'], art: 'Counterspell' },
			],
			live,
		});
	});
});

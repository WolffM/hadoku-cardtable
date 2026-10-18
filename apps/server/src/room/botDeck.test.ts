import { describe, expect, it } from 'vitest';
import { parseDck } from '@hadoku/carddata/dck';
import { deckFromDeckFile, deckIssues, mainDeckSize } from '@hadoku/deck';
import type { DraftCard, ManaColor } from '@hadoku/shared';

import { BOT_DECK_SIZE, BOT_DECK_SPELLS, botBasics, botDeckText, botSpells } from './botDeck.ts';

let next = 0;
function card(colour: ManaColor | null, rarity: DraftCard['rarity'] = 'common', typeLine = 'Creature — Bear'): DraftCard {
	next += 1;
	return {
		cardId: `c${String(next).padStart(3, '0')}`,
		name: `Card ${next}`,
		manaCost: colour === null ? ['2'] : ['1', colour],
		manaValue: 2,
		colors: colour === null ? [] : [colour],
		typeLine,
		oracleText: '',
		setCode: 'TST',
		collectorNumber: String(next),
		rarity,
	};
}

/** A bot's 45: mostly red and green, a splash of blue, two colourless, three lands. */
function pool(): DraftCard[] {
	return [
		...Array.from({ length: 16 }, () => card('R')),
		...Array.from({ length: 14 }, () => card('G')),
		...Array.from({ length: 10 }, () => card('U', 'mythic')),
		card(null),
		card(null),
		...Array.from({ length: 3 }, () => card(null, 'common', 'Land')),
	];
}

describe("the AI's deck from a bot's drafted pool", () => {
	it('plays its two colours and colourless, never a third colour or a land as a spell', () => {
		const p = pool();
		const spells = botSpells(p);
		expect(spells).toHaveLength(BOT_DECK_SPELLS);
		// The blue mythics outscore every common on rarity alone; colour is what keeps them out.
		expect(spells.every((c) => c.colors.every((x) => x === 'R' || x === 'G'))).toBe(true);
		expect(spells.some((c) => /Land/.test(c.typeLine))).toBe(false);
	});

	it('fills to 40 with basics split by the colours the spells ask for', () => {
		const p = pool();
		const spells = botSpells(p);
		const basics = botBasics(spells, p);
		expect([...basics.keys()].sort()).toEqual(['Forest', 'Mountain']);
		expect([...basics.values()].reduce((a, b) => a + b, 0)).toBe(BOT_DECK_SIZE - BOT_DECK_SPELLS);
	});

	it('writes a legal 40-card .dck out of the pool, the same every time', () => {
		const p = pool();
		const text = botDeckText(p, 'Bot draft');
		const deck = deckFromDeckFile(parseDck(text));
		expect(mainDeckSize(deck)).toBe(BOT_DECK_SIZE);
		expect(deckIssues(deck)).toEqual([]);
		expect(botDeckText(p, 'Bot draft')).toBe(text);
	});

	it('still makes 40 cards out of a short pool', () => {
		const short = Array.from({ length: 5 }, () => card('W'));
		const deck = deckFromDeckFile(parseDck(botDeckText(short, 'Bot draft')));
		expect(mainDeckSize(deck)).toBe(BOT_DECK_SIZE);
		expect(botBasics(botSpells(short), short).get('Plains')).toBe(35);
	});
});

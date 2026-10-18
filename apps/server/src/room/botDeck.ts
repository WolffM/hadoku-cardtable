/**
 * The AI's deck at a pod table: built from a bot drafter's own pool.
 *
 * The one human of a pod of bots plays Forge's AI (`lobby.ts`'s `POD_AI`), and
 * a drafted room offers the AI no library deck — so it plays what a bot at the
 * same draft took, the way a person would build it: the two colours it drafted
 * most, its 23 best spells in them by the same score it picked with
 * (`scoreCard`, `@hadoku/draft`), and 17 basics split by the coloured mana
 * those spells ask for. Deterministic: every game of a series meets the same
 * deck.
 */

import { committedColours, scoreCard } from '@hadoku/draft';
import { basicLand, moveToMain, newDeck, setBasicLand, toDeckFile, writeDck, type Deck } from '@hadoku/deck';
import type { DraftCard, ManaColor } from '@hadoku/shared';

import { draftCardRequest, draftPoolEntries } from '../http/draftPool.js';

export const BOT_DECK_SPELLS = 23;
export const BOT_DECK_SIZE = 40;

const BASIC_OF: Record<ManaColor, string> = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };

function isLand(card: DraftCard): boolean {
	return /\bLand\b/.test(card.typeLine);
}

/** The pool's best castable spells: in its two colours (or colourless), best first. */
export function botSpells(pool: readonly DraftCard[]): DraftCard[] {
	const colours = committedColours(pool);
	return pool
		.filter((card) => !isLand(card) && card.colors.every((c) => colours.includes(c)))
		.map((card) => ({ card, score: scoreCard(card, pool) }))
		.sort((a, b) => b.score - a.score || a.card.cardId.localeCompare(b.card.cardId))
		.slice(0, BOT_DECK_SPELLS)
		.map((s) => s.card);
}

/** Basics to fill `size`, split by the coloured mana symbols the spells carry. */
export function botBasics(spells: readonly DraftCard[], pool: readonly DraftCard[], size = BOT_DECK_SIZE): Map<string, number> {
	const pips: Record<ManaColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
	for (const card of spells) {
		for (const token of card.manaCost) {
			for (const c of Object.keys(pips) as ManaColor[]) if (token.includes(c)) pips[c] += 1;
		}
	}
	let colours = (Object.keys(pips) as ManaColor[]).filter((c) => pips[c] > 0);
	if (colours.length === 0) {
		colours = committedColours(pool);
		for (const c of colours) pips[c] = 1;
	}
	if (colours.length === 0) {
		colours = ['W'];
		pips.W = 1;
	}
	const lands = Math.max(0, size - spells.length);
	const total = colours.reduce((n, c) => n + pips[c], 0);
	const counts = new Map<string, number>();
	let given = 0;
	for (const c of colours) {
		const n = Math.floor((lands * pips[c]) / total);
		counts.set(BASIC_OF[c], n);
		given += n;
	}
	// The rounding remainder goes to the colour with the most pips.
	const top = colours.reduce((a, b) => (pips[b] > pips[a] ? b : a));
	counts.set(BASIC_OF[top], (counts.get(BASIC_OF[top]) ?? 0) + lands - given);
	return counts;
}

/** The `.dck` text of a bot's deck from its drafted pool. */
export function botDeckText(pool: readonly DraftCard[], name: string): string {
	const spells = botSpells(pool);
	let deck: Deck = newDeck(name, draftPoolEntries(pool));
	for (const card of spells) deck = moveToMain(deck, draftCardRequest(card), 1);
	for (const [basic, count] of botBasics(spells, pool)) deck = setBasicLand(deck, basicLand(basic), count);
	return writeDck(toDeckFile(deck));
}

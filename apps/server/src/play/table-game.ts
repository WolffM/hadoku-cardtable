/*
 * A table's game, as the table card draws it (`docs/planning/table-card-plan.md`,
 * `@hadoku/shared`'s `TableGameSchema`): each seat's deck from the `.dck` the
 * match was started with, and while the game runs, where it stands — read off the
 * watcher's projector, which holds only what is on the table for everyone.
 *
 * A match's seats are its table's seats, in order: the series records Forge's
 * winning seat as the table seat (`room/series.ts`), and so does this.
 */
import { parseDck } from '@hadoku/carddata/dck';
import { manaValueOf } from '@hadoku/deck';
import type { TableGame, TableGameLive, TableSeatDeck } from '@hadoku/shared';

import { seatDeckColors, type DeckCosts } from './deck-colors.js';
import type { MatchSpec } from './host.js';

/**
 * The card whose art stands for a deck: its most-played spell, the dearer one
 * on a tie, then by name, so a re-read never flickers. A card with no cost in
 * the format's map is not a candidate, which is how lands are left out
 * (`deck-colors.ts`'s cost maps hold no land). A name, looked up for its art on
 * the screen that draws it — never a URL.
 */
export function deckArtCard(main: readonly { card: { name: string }; count: number }[], costs: Readonly<Record<string, string>>): string | null {
	let best: { name: string; count: number; value: number } | null = null;
	for (const entry of main) {
		const cost = costs[entry.card.name];
		if (cost === undefined) continue;
		const candidate = { name: entry.card.name, count: entry.count, value: manaValueOf(cost) };
		if (
			best === null ||
			candidate.count > best.count ||
			(candidate.count === best.count && (candidate.value > best.value || (candidate.value === best.value && candidate.name < best.name)))
		) {
			best = candidate;
		}
	}
	return best?.name ?? null;
}

/** `seat`'s deck as the card draws it, or null when the server never saw it (a random Forge precon). */
export function seatDeck(spec: Pick<MatchSpec, 'seats' | 'format'>, seat: number, costs: DeckCosts): TableSeatDeck | null {
	const text = spec.seats[seat]?.deck ?? null;
	if (text === null) return null;
	const deck = parseDck(text);
	const main = deck.sections.get('main') ?? [];
	return { name: deck.name ?? '', colors: seatDeckColors(spec, seat, costs) ?? [], art: deckArtCard(main, costs(spec.format)) };
}

/** What `tableGame` reads of a match. */
export interface TableGameSource {
	spec: Pick<MatchSpec, 'seats' | 'format'>;
	/** The game under way, or null once it is over. */
	live(): TableGameLive | null;
}

export function tableGame(match: TableGameSource, costs: DeckCosts): TableGame {
	return { decks: [seatDeck(match.spec, 0, costs), seatDeck(match.spec, 1, costs)], live: match.live() };
}

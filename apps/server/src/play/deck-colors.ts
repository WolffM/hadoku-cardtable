/*
 * A seat's deck colours, for `@hadoku/shared`'s `forge:deck-colors`: the match
 * plays the music of one of them. Folded off the match's own spec — the `.dck`
 * text the seat was started with, main deck only — by `@hadoku/deck`'s
 * `deckColorsByName`, the room screen's pips and the match stats' `colors`.
 *
 * Null for a seat whose deck this server never saw (a random Forge precon,
 * `deck: null`): the bridge picks it inside the JVM.
 */
import { parseDck } from '@hadoku/carddata/dck';
import { deckColorsByName, type DeckColor } from '@hadoku/deck';
import { LIBRARY_CARD_COSTS } from '@hadoku/deck/library';

import { draftIdOfPool } from '../room/lobby.js';
import type { MatchSpec } from './host.js';

/** Scryfall cost strings by card name, for a match's format. */
export type DeckCosts = (format: string | undefined) => Readonly<Record<string, string>>;

/**
 * The cost map a room's format folds a deck against: the library's, plus the
 * format's own era, or the cube's cards for a drafted pool. Built once per
 * format and kept.
 */
export function roomDeckCosts(library: { format(id: string): { fixture: { manaCost: Readonly<Record<string, string>> } } | undefined }, cube: readonly { name: string; manaCost: readonly string[] }[] | null): DeckCosts {
	const built = new Map<string, Readonly<Record<string, string>>>();
	return (format) => {
		if (format === undefined) return LIBRARY_CARD_COSTS;
		let costs = built.get(format);
		if (costs === undefined) {
			const era = library.format(format)?.fixture.manaCost;
			const drafted = draftIdOfPool(format) !== null && cube !== null ? Object.fromEntries(cube.map((c) => [c.name, c.manaCost.map((t) => `{${t}}`).join('')])) : {};
			costs = { ...LIBRARY_CARD_COSTS, ...era, ...drafted };
			built.set(format, costs);
		}
		return costs;
	};
}

/** The colours of the deck `seat` was started with, or null when the server never saw it. */
export function seatDeckColors(spec: Pick<MatchSpec, 'seats' | 'format'>, seat: number, costs: DeckCosts): DeckColor[] | null {
	const deck = spec.seats[seat]?.deck ?? null;
	if (deck === null) return null;
	const main = parseDck(deck).sections.get('main') ?? [];
	return deckColorsByName(
		main.map((e) => e.card.name),
		costs(spec.format),
	);
}

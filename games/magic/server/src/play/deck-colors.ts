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
import type { ForgeMatchSpec } from './forge-spec.js';

/** Scryfall cost strings by card name, for a match's format. */
export type DeckCosts = (format: string | undefined) => Readonly<Record<string, string>>;

/**
 * What `roomDeckCosts` needs off the server's card catalog (`pools/catalog.ts`'s `CardCatalog`):
 * every card's own cost, by name — the one source that has ALL of them, not just the ones a
 * catalogued library deck, an era's frozen pool, or the server's one DEFAULT cube happen to play.
 * A `DraftCard`'s own shape satisfies this; tests use a lighter fixture.
 */
export interface CatalogCosts {
	byName(name: string): { manaCost: readonly string[] } | null;
}

/** A card's Scryfall-style cost string from its token list (`['2','B']` → `'{2}{B}'`) — the one fold every source here shares. */
function costString(card: { manaCost: readonly string[] }): string {
	return card.manaCost.map((t) => `{${t}}`).join('');
}

/**
 * The cost map a room's format folds a deck against: the library's, plus the format's own era or
 * the DEFAULT cube's cards for a drafted pool — built once per format and kept — with the catalog
 * answering any name NONE of those cover (measured on the operator's own pod,
 * r-67759762d971: a drafted pool that is not the server's default cube missed `LIBRARY_CARD_COSTS`
 * for 40 of its 41 distinct cards, and `seatDeckColors` folded the deck to a single stray colour —
 * Qarsi Revenant's own — for every game that pod started). The catalog is the fallback, never the
 * override: a name the tables already answer keeps THEIR answer, so a library deck's committed
 * cost (which can differ printing to printing from Scryfall's own default) is unchanged.
 */
export function roomDeckCosts(
	library: { format(id: string): { fixture: { manaCost: Readonly<Record<string, string>> } } | undefined },
	cube: readonly { name: string; manaCost: readonly string[] }[] | null,
	catalog: CatalogCosts,
): DeckCosts {
	const built = new Map<string, Readonly<Record<string, string>>>();
	/** Every name `table` has no entry for answers from the catalog instead of plain absence. */
	const withCatalogFallback = (table: Readonly<Record<string, string>>): Readonly<Record<string, string>> =>
		new Proxy(table, {
			get(target, prop, receiver) {
				if (typeof prop !== 'string' || prop in target) return Reflect.get(target, prop, receiver);
				const card = catalog.byName(prop);
				return card === null ? undefined : costString(card);
			},
		});
	const libraryCosts = withCatalogFallback(LIBRARY_CARD_COSTS);
	return (format) => {
		if (format === undefined) return libraryCosts;
		let costs = built.get(format);
		if (costs === undefined) {
			const era = library.format(format)?.fixture.manaCost;
			const drafted = draftIdOfPool(format) !== null && cube !== null ? Object.fromEntries(cube.map((c) => [c.name, costString(c)])) : {};
			costs = withCatalogFallback({ ...LIBRARY_CARD_COSTS, ...era, ...drafted });
			built.set(format, costs);
		}
		return costs;
	};
}

/** The colours of the deck `seat` was started with, or null when the server never saw it. */
export function seatDeckColors(spec: Pick<ForgeMatchSpec, 'seats' | 'format'>, seat: number, costs: DeckCosts): DeckColor[] | null {
	const deck = spec.seats[seat]?.deck ?? null;
	if (deck === null) return null;
	const main = parseDck(deck).sections.get('main') ?? [];
	return deckColorsByName(
		main.map((e) => e.card.name),
		costs(spec.format),
	);
}

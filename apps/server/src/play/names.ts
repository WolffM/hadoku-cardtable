/*
 * A card-name ask, narrowed to the match's format.
 *
 * Forge's "name a card" (`PlayerControllerHuman.chooseSingleCardFace`) offers
 * every face of every card its predicate lets through — 33,659 for Cabal
 * Therapy's "nonland" — whatever the game is. A Legacy 2005 table has no use for
 * a name printed in 2020, so the seat is offered Forge's names that are legal in
 * the room's pool, plus every name in either seat's deck (a deck the pool does
 * not list still plays its own cards). Forge's own constraint stays: only
 * names Forge offered are ever offered.
 */

import { parseDck } from '@hadoku/carddata/dck';

import type { TablesLibrary } from '../http/library.js';
import { FREE_PICK, draftIdOfPool } from '../room/lobby.js';

/** Every card name a `.dck` text plays, main and sideboard. */
export function dckNames(dck: string): string[] {
	return [...parseDck(dck).sections.values()].flatMap((entries) => entries.map((entry) => entry.card.name));
}

/** Every name a card answers to as a Forge face: the whole name, and each half of `A // B`. */
export function faceNames(names: Iterable<string>): Set<string> {
	const out = new Set<string>();
	for (const name of names) {
		out.add(name);
		if (name.includes(' // ')) for (const half of name.split(' // ')) out.add(half);
	}
	return out;
}

/**
 * The format's names, one set per format id, built the first time a format is asked
 * for and kept. `pool` answers null for a format with no list (Free pick, an unknown
 * id): such a match is offered Forge's whole list.
 */
export function formatNameSets(pool: (format: string) => Iterable<string> | null): (format: string) => ReadonlySet<string> | null {
	const built = new Map<string, ReadonlySet<string> | null>();
	return (format) => {
		let names = built.get(format);
		if (names === undefined) {
			const listed = pool(format);
			names = listed === null ? null : faceNames(listed);
			built.set(format, names);
		}
		return names;
	};
}

/**
 * Forge's offered names that the format allows or a deck plays, in Forge's order.
 * No format list, or a list that keeps none of them, offers Forge's own list unchanged.
 */
export function namesForFormat(offered: readonly string[], format: ReadonlySet<string> | null, decks: ReadonlySet<string>): readonly string[] {
	if (format === null) return offered;
	const kept = offered.filter((name) => format.has(name) || decks.has(name));
	return kept.length === 0 ? offered : kept;
}

/**
 * A room's format id to its names: a frozen era's legal names, the cube for a drafted pool,
 * and every card the library's decks play on Free pick.
 */
export function roomFormatNames(library: Pick<TablesLibrary, 'decks' | 'format'>, cube: readonly { name: string }[] | null): (format: string) => ReadonlySet<string> | null {
	return formatNameSets((format) => {
		if (format === FREE_PICK) return library.decks.flatMap((deck) => dckNames(deck.text));
		if (draftIdOfPool(format) !== null) return cube?.map((card) => card.name) ?? null;
		return library.format(format)?.pool.legal ?? null;
	});
}

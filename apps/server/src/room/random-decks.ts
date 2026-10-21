/**
 * All Random's draw (the operator's ruling 4, 2026-10-21): a random era of the
 * chosen pool's family — of any family for Full — then a DIFFERENT random deck
 * from that one era for each player.
 *
 * The era comes from `randomFormat` (the same family-then-era draw a new room
 * opens on), so Standard's many years do not crowd out Modern and Legacy in
 * Full either. Only eras holding at least two library decks are drawn: one
 * deck cannot give two players different decks.
 *
 * Pure: `random` answers in [0, 1) and the catalog is handed in, so a test pins
 * both. The server passes `secureRandom` and its own `TablesLibrary`.
 */

import type { FormatFamily, TableDeck } from '../http/library.js';
import { randomFormat, type CatalogFormat, type FormatId } from './lobby.js';

/** Which eras All Random draws from: one family, or every family. */
export type RandomPool = FormatFamily | 'full';

export interface RandomCatalog {
	readonly formats: readonly CatalogFormat[];
	readonly decks: readonly Pick<TableDeck, 'id' | 'era'>[];
}

export interface RandomDraw {
	readonly era: FormatId;
	/** Two different library deck ids of `era`, seat 0's first. */
	readonly decks: readonly [string, string];
}

/** The eras `pool` can draw: its family's (every family's for Full), each holding at least two decks. */
export function randomEras(pool: RandomPool, catalog: RandomCatalog): CatalogFormat[] {
	const counts = new Map<string, number>();
	for (const d of catalog.decks) counts.set(d.era, (counts.get(d.era) ?? 0) + 1);
	return catalog.formats.filter((f) => (pool === 'full' || f.family === pool) && (counts.get(f.id) ?? 0) >= 2);
}

/** An era and two different decks from it, or null when no era of `pool` holds two. */
export function drawRandomDecks(random: () => number, pool: RandomPool, catalog: RandomCatalog): RandomDraw | null {
	const eras = randomEras(pool, catalog);
	if (eras.length === 0) return null;
	const era = randomFormat(random, eras);
	const ids = catalog.decks.filter((d) => d.era === era).map((d) => d.id);
	const first = Math.floor(random() * ids.length);
	// The second from the other n-1, so the two differ without a retry loop.
	let second = Math.floor(random() * (ids.length - 1));
	if (second >= first) second += 1;
	return { era, decks: [ids[first]!, ids[second]!] };
}

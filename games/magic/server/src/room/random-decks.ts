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

import type { RandomPool } from '@hadoku/shared';

import type { TableDeck } from '../http/library.js';
import { randomFormat, type CatalogFormat, type FormatId } from './lobby.js';

interface RandomCatalog {
	readonly formats: readonly CatalogFormat[];
	readonly decks: readonly Pick<TableDeck, 'id' | 'era'>[];
}

interface RandomDraw {
	readonly era: FormatId;
	/** Two different library deck ids of `era`, seat 0's first. */
	readonly decks: readonly [string, string];
}

/**
 * The eras `pool` can draw: its family's (every family's for Full), each
 * holding at least `min` decks. `min` defaults to 2 (two players need two
 * DIFFERENT decks of the same era); the tournament lock's single-player draw
 * (`drawRandomDeck`) passes 1, since one player needs only one.
 */
export function randomEras(pool: RandomPool, catalog: RandomCatalog, min = 2): CatalogFormat[] {
	const counts = new Map<string, number>();
	for (const d of catalog.decks) counts.set(d.era, (counts.get(d.era) ?? 0) + 1);
	return catalog.formats.filter((f) => (pool === 'full' || f.family === pool) && (counts.get(f.id) ?? 0) >= min);
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

/**
 * An era and ONE deck from it — the tournament lock's own draw
 * (`docs/planning/tournament-mode-plan.md`'s Design: All Random `locked`
 * deals "one deal per player at lock", reusing this draw's own logic rather
 * than `drawRandomDecks`'s pairwise one, which needs an era with two). Null
 * when no era of `pool` holds even one.
 */
export function drawRandomDeck(random: () => number, pool: RandomPool, catalog: RandomCatalog): { era: FormatId; deckId: string } | null {
	const eras = randomEras(pool, catalog, 1);
	if (eras.length === 0) return null;
	const era = randomFormat(random, eras);
	const ids = catalog.decks.filter((d) => d.era === era).map((d) => d.id);
	return { era, deckId: ids[Math.floor(random() * ids.length)]! };
}

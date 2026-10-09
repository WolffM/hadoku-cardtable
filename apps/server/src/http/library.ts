/**
 * The formats and decks a constructed match can be started from, read off disk
 * once at boot.
 *
 * ## Where they come from
 *
 * Both are Wave 7 lane D's, committed under `decks/` at the repo root:
 *
 *   - **formats** — `decks/pools/standard-<date>.generated.json`. Each is
 *     `standardPoolAt(date)` (Wave 6, `packages/carddata/src/formats`) run over
 *     the real card corpus and frozen, because that corpus is 183 MB, gitignored
 *     and not on the deploy host. So "pick a format" is "pick a date whose pool
 *     was frozen", and the list grows by running `build-pool-fixture.ts` for a
 *     new date — not by computing a pool on a request.
 *   - **decks** — `LIBRARY` in `@hadoku/deck/library`: a manifest of `.dck`
 *     files, each carrying its own name, format, date and citation.
 *
 * The files are enumerated from the catalog, and nothing is hardcoded here: a
 * new era appears in the picker with no edit to this module.
 *
 * ## Only the catalogued eras are offered — never every file in `decks/pools/`
 *
 * Wave 34 §D: this used to `readdirSync` the whole `decks/pools/` directory and
 * offer every `standard-<date>.generated.json` it found as a format — which is
 * how the operator once saw nine "eras" that were really one 18-month window,
 * including `2011-07-01`, a TEST fixture (`build-pool-fixture.ts`'s own header
 * says why it exists: to demonstrate the ban path on real data, not to be
 * played). A fixture that happens to sit in that directory for a test's sake
 * is not a format a room can be started in.
 *
 * So the set of dates offered is `[...new Set(library.map(c => c.date))]` —
 * exactly the catalogued collections' own dates, in the order `library` lists
 * them — and a pool file is read only for a date that appears there. A stray
 * fixture dropped into `decks/pools/` under an uncatalogued date is invisible
 * to the picker no matter what it is named; `rooms.test.ts`'s "a fixture pool
 * that is not catalogued never reaches the picker" proves it with exactly such
 * a file, in a temp fixture tree.
 *
 * ## A verdict, not a throw
 *
 * Same shape as `room/pool.ts` and `base-path.ts`: a deck or pool that will not
 * load is named in `faults` and left out, and the server keeps serving. A
 * broken deck file is an artifact to fix, and a process that will not boot over
 * one is a worse failure than a picker missing one entry — as long as the
 * missing entry is SAID somewhere, which is what `faults` and the boot log are.
 *
 * ## Wave 48 §U: a format's `id` is no longer always its date
 *
 * Standard, Modern and Legacy eras can snapshot the SAME date (§T lines the
 * three formats up year by year), so the id has to carry the family for
 * anything that is not Standard: `@hadoku/deck/library`'s `formatIdOf`
 * answers the bare date for `'standard'` and `<family>-<date>` otherwise, and
 * its two-arg `poolFixturePath(date, family)` reads
 * `decks/pools/<family>-<date>.generated.json` to match. Standard's own ids
 * are unchanged — every stored room and every e2e pinning a bare date (e.g.
 * `2016-07-22`) keeps working.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { FormatPool } from '@hadoku/deck';
import {
	LIBRARY,
	deckPath,
	formatIdOf,
	loadLibraryDeck,
	parsePoolFixture,
	poolFixturePath,
	poolFromFixture,
	type FormatFamily,
	type LibraryCollection,
	type LibraryDeck,
	type PoolFixture,
} from '@hadoku/deck/library';

export type { FormatFamily };

/** One format a match can be played in. `id` is `formatIdOf` of its collection. */
export interface TableFormat {
	readonly id: string;
	/** Which ruleset family this era belongs to — groups the picker's tabs. */
	readonly family: FormatFamily;
	readonly fixture: PoolFixture;
	readonly pool: FormatPool;
}

/** One library deck, with the exact text that will be handed to Forge. */
export interface TableDeck {
	readonly id: string;
	readonly collection: string;
	/** The format id of the era its collection was catalogued for — `formatIdOf`. */
	readonly era: string;
	readonly deck: LibraryDeck;
	/** The file, verbatim. What is validated is what is sent. */
	readonly text: string;
}

export interface TablesLibrary {
	/** In date order, oldest first. */
	readonly formats: readonly TableFormat[];
	/** In catalog order. */
	readonly decks: readonly TableDeck[];
	/** Every file that did not load, and why. Empty is healthy. */
	readonly faults: readonly string[];
	format(id: string): TableFormat | undefined;
	deck(id: string): TableDeck | undefined;
}

/**
 * Read every catalogued era's frozen pool, and every catalogued deck, under
 * `repoRoot`.
 *
 * `library` is injectable so a test can hand in a catalog that points at a
 * broken file, or at a shorter list of eras than production's; production
 * passes nothing and gets `LIBRARY`.
 */
export function loadTablesLibrary(
	repoRoot: string,
	library: readonly LibraryCollection[] = LIBRARY,
): TablesLibrary {
	const faults: string[] = [];

	// Exactly the catalogued eras' own (family, date) pairs — never a directory
	// scan. See the module doc for why: `decks/pools/` can hold a date no
	// collection claims (a test fixture, an in-progress era) and that date must
	// stay invisible to the picker no matter what file name it has. Keyed by
	// `formatIdOf`, not the bare date: Standard, Modern and Legacy can share a
	// date (§T lines them up year by year), and each still needs its own pool.
	const keys = new Map<string, { family: FormatFamily; date: string }>();
	for (const collection of library) {
		const id = formatIdOf(collection);
		if (!keys.has(id)) keys.set(id, { family: collection.family, date: collection.date });
	}
	const formats: TableFormat[] = [];
	for (const [id, { family, date }] of keys) {
		const path = join(repoRoot, poolFixturePath(date, family));
		try {
			const fixture = parsePoolFixture(JSON.parse(readFileSync(path, 'utf8')) as unknown);
			formats.push({ id, family, fixture, pool: poolFromFixture(fixture) });
		} catch (err) {
			faults.push(`${path}: ${(err as Error).message}`);
		}
	}

	const decks: TableDeck[] = [];
	for (const collection of library) {
		for (const entry of collection.decks) {
			const path = join(repoRoot, deckPath(collection, entry));
			try {
				const text = readFileSync(path, 'utf8');
				decks.push({ id: entry.id, collection: collection.id, era: formatIdOf(collection), deck: loadLibraryDeck(text), text });
			} catch (err) {
				faults.push(`${path}: ${(err as Error).message}`);
			}
		}
	}

	const formatById = new Map(formats.map((f) => [f.id, f]));
	const deckById = new Map(decks.map((d) => [d.id, d]));
	return {
		formats,
		decks,
		faults,
		format: (id) => formatById.get(id),
		deck: (id) => deckById.get(id),
	};
}

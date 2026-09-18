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
 * The files are enumerated from the catalog and from the pools directory, and
 * nothing is hardcoded here: a new collection or a new frozen pool appears in
 * the picker with no edit to this module.
 *
 * ## A verdict, not a throw
 *
 * Same shape as `room/pool.ts` and `base-path.ts`: a deck or pool that will not
 * load is named in `faults` and left out, and the server keeps serving. A
 * broken deck file is an artifact to fix, and a process that will not boot over
 * one is a worse failure than a picker missing one entry — as long as the
 * missing entry is SAID somewhere, which is what `faults` and the boot log are.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { FormatPool } from '@hadoku/deck';
import {
	LIBRARY,
	deckPath,
	loadLibraryDeck,
	parsePoolFixture,
	poolFromFixture,
	type LibraryCollection,
	type LibraryDeck,
	type PoolFixture,
} from '@hadoku/deck/library';

/** One format a match can be played in. `id` is the pool's date. */
export interface TableFormat {
	readonly id: string;
	readonly fixture: PoolFixture;
	readonly pool: FormatPool;
}

/** One library deck, with the exact text that will be handed to Forge. */
export interface TableDeck {
	readonly id: string;
	readonly collection: string;
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

/** `standard-2011-07-01.generated.json` → `2011-07-01`. */
const POOL_FILE = /^standard-(\d{4}-\d{2}-\d{2})\.generated\.json$/;

/**
 * Read every frozen pool and every catalogued deck under `repoRoot`.
 *
 * `library` is injectable so a test can hand in a catalog that points at a
 * broken file; production passes nothing and gets `LIBRARY`.
 */
export function loadTablesLibrary(
	repoRoot: string,
	library: readonly LibraryCollection[] = LIBRARY,
): TablesLibrary {
	const faults: string[] = [];

	const formats: TableFormat[] = [];
	const poolsDir = join(repoRoot, 'decks', 'pools');
	let poolFiles: string[] = [];
	try {
		poolFiles = readdirSync(poolsDir).filter((f) => POOL_FILE.test(f)).sort();
	} catch (err) {
		faults.push(`${poolsDir}: ${(err as Error).message}`);
	}
	for (const file of poolFiles) {
		const path = join(poolsDir, file);
		try {
			const fixture = parsePoolFixture(JSON.parse(readFileSync(path, 'utf8')) as unknown);
			formats.push({ id: fixture.date, fixture, pool: poolFromFixture(fixture) });
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
				decks.push({ id: entry.id, collection: collection.id, deck: loadLibraryDeck(text), text });
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

/**
 * The compact card catalog: one `DraftCard` per known card name, generated
 * offline by `packages/carddata/src/cli/build-catalog.ts` from the Scryfall
 * sync (`cards.jsonl`) and indexed here at boot. It answers "what are this
 * card's gameplay fields" for any name a source hands it that did not come
 * with its own text — a Cube Cobra import (`cubecobra.ts` keeps only `name`
 * and `scryfall_id`, never oracle text) or a set-cube source (wave 74, names
 * only).
 *
 * Verdict-style, not a throw: a missing or malformed catalog file is a
 * reported fault and the server keeps serving (same discipline as
 * `room/pool.ts`'s `loadPool`); every `byName` lookup then answers `null`,
 * which is the honest "no text for this name" and is exactly what the
 * playability verdict's `missingText` is built from.
 *
 * `byName` tries only the two keys `@hadoku/carddata`'s own `resolve.ts`
 * tries for a bare-name reference (`normaliseName`, then `foldName`) — see
 * `build-catalog.ts`'s header for why the fold is not re-derived here. The
 * catalog file's `aliases` map already resolved every weaker spelling (a
 * front face, an accent-folded name) to its canonical key at build time.
 *
 * ## `byPrinting` and `swap` (wave 74 §G)
 *
 * `byPrinting(set, collectorNumber)` answers from the SAME one-printing-
 * per-name data `byName` does — `build-catalog.ts` keeps exactly one chosen
 * printing per card (paper preferred; see its header), never every printing
 * a card has ever had. So `byPrinting` is a best-effort index over that one
 * printing per card, built here at load time from the `setCode` +
 * `collectorNumber` the file already carries: it answers a realistic
 * booster's own printing when the catalog's canonical pick happens to be
 * that set, and otherwise misses. Wave 74 §E's realistic-pack mapping is
 * written to fall back to `byName` on a miss — this never grows the catalog
 * file's shape, so `build-catalog.ts` needed no behaviour change.
 *
 * `swap(path?)` reloads the file at `path` (or the path this catalog was
 * built from, if omitted) and, only on a successful parse, replaces the
 * live lookup data in place — every holder of this `CardCatalog` object
 * (readers hold the object, never its internal map) sees the swap with no
 * reload of their own and no restart. A fault (missing file, malformed
 * JSON) is logged and the OLD data keeps serving, same discipline as the
 * initial load.
 */

import { readFileSync } from 'node:fs';
import { foldName, normaliseName } from '@hadoku/carddata';
import { DraftCardSchema, type DraftCard } from '@hadoku/shared';
import { jsonLogger } from '../log.js';

export interface CardCatalog {
	byName(name: string): DraftCard | null;
	/** Best-effort: only the catalog's one chosen printing per card is indexed. Callers fall back to `byName`. */
	byPrinting(set: string, collectorNumber: string): DraftCard | null;
	/**
	 * Reload from `path` (default: the path this catalog was built from) and,
	 * on success, swap the live data in place. Returns `true` on a swap,
	 * `false` on a fault (the old data keeps serving).
	 */
	swap(path?: string): boolean;
}

interface CatalogFile {
	/** Canonical name key -> the full card, re-validated against `DraftCardSchema` on load. */
	cards: Record<string, unknown>;
	/** Any other key (front-face, folded, folded-front-face) -> the canonical key above. */
	aliases: Record<string, unknown>;
}

interface CatalogState {
	cards: Map<string, DraftCard>;
	aliases: Map<string, string>;
	printings: Map<string, DraftCard>;
}

const log = jsonLogger('cardtable-pools');

const EMPTY_STATE: CatalogState = { cards: new Map(), aliases: new Map(), printings: new Map() };

/** `setCode` is already uppercased by `build-catalog.ts`; uppercase here too so a caller's case never misses. */
function printingKey(setCode: string, collectorNumber: string): string {
	return `${setCode.toUpperCase()}#${collectorNumber}`;
}

/** Parse one catalog file into lookup state, or `null` on a reported fault (never throws). */
function parseCatalogState(path: string): CatalogState | null {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, 'utf8'));
	} catch (err) {
		log({ evt: 'catalog-load-failed', path, detail: (err as Error).message });
		return null;
	}

	if (typeof raw !== 'object' || raw === null) {
		log({ evt: 'catalog-load-failed', path, detail: 'not an object' });
		return null;
	}
	const file = raw as Partial<CatalogFile>;

	const cards = new Map<string, DraftCard>();
	const printings = new Map<string, DraftCard>();
	let rejected = 0;
	if (typeof file.cards === 'object' && file.cards !== null) {
		for (const [key, value] of Object.entries(file.cards)) {
			const parsed = DraftCardSchema.safeParse(value);
			if (parsed.success) {
				cards.set(key, parsed.data);
				printings.set(printingKey(parsed.data.setCode, parsed.data.collectorNumber), parsed.data);
			} else {
				rejected++;
			}
		}
	}

	const aliases = new Map<string, string>();
	if (typeof file.aliases === 'object' && file.aliases !== null) {
		for (const [key, value] of Object.entries(file.aliases)) {
			if (typeof value === 'string') aliases.set(key, value);
		}
	}

	log({ evt: 'catalog-loaded', path, cards: cards.size, aliases: aliases.size, printings: printings.size, rejected });

	return { cards, aliases, printings };
}

/**
 * Load the catalog `build-catalog` writes. Synchronous, because this runs
 * once at boot and an async boot would only move the same failure somewhere
 * less visible (same reasoning as `loadPool`'s header).
 *
 * `DraftCardSchema` re-parses every entry even though the file was produced by
 * our own pipeline — the D13 control at the last point before a card can reach
 * a payload: the schema has no image field, so anything that should not be
 * there is dropped here rather than discovered by a UI re-validating what the
 * server sent it.
 */
export function loadCardCatalog(path: string): CardCatalog {
	let state = parseCatalogState(path) ?? EMPTY_STATE;

	return {
		byName(name: string): DraftCard | null {
			for (const key of [normaliseName(name), foldName(name)]) {
				const direct = state.cards.get(key);
				if (direct !== undefined) return direct;
				const canonical = state.aliases.get(key);
				if (canonical !== undefined) {
					const hit = state.cards.get(canonical);
					if (hit !== undefined) return hit;
				}
			}
			return null;
		},

		byPrinting(set: string, collectorNumber: string): DraftCard | null {
			return state.printings.get(printingKey(set, collectorNumber)) ?? null;
		},

		swap(nextPath: string = path): boolean {
			const next = parseCatalogState(nextPath);
			if (next === null) {
				log({ evt: 'catalog-swap-faulted', path: nextPath });
				return false;
			}
			state = next;
			log({ evt: 'catalog-swapped', path: nextPath, cards: next.cards.size, aliases: next.aliases.size, printings: next.printings.size });
			return true;
		},
	};
}

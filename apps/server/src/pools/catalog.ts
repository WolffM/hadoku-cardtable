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
 */

import { readFileSync } from 'node:fs';
import { foldName, normaliseName } from '@hadoku/carddata';
import { DraftCardSchema, type DraftCard } from '@hadoku/shared';
import { jsonLogger } from '../log.js';

export interface CardCatalog {
	byName(name: string): DraftCard | null;
}

interface CatalogFile {
	/** Canonical name key -> the full card, re-validated against `DraftCardSchema` on load. */
	cards: Record<string, unknown>;
	/** Any other key (front-face, folded, folded-front-face) -> the canonical key above. */
	aliases: Record<string, unknown>;
}

const log = jsonLogger('cardtable-pools');

const EMPTY_CATALOG: CardCatalog = { byName: () => null };

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
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, 'utf8'));
	} catch (err) {
		log({ evt: 'catalog-load-failed', path, detail: (err as Error).message });
		return EMPTY_CATALOG;
	}

	if (typeof raw !== 'object' || raw === null) {
		log({ evt: 'catalog-load-failed', path, detail: 'not an object' });
		return EMPTY_CATALOG;
	}
	const file = raw as Partial<CatalogFile>;

	const cards = new Map<string, DraftCard>();
	let rejected = 0;
	if (typeof file.cards === 'object' && file.cards !== null) {
		for (const [key, value] of Object.entries(file.cards)) {
			const parsed = DraftCardSchema.safeParse(value);
			if (parsed.success) cards.set(key, parsed.data);
			else rejected++;
		}
	}

	const aliases = new Map<string, string>();
	if (typeof file.aliases === 'object' && file.aliases !== null) {
		for (const [key, value] of Object.entries(file.aliases)) {
			if (typeof value === 'string') aliases.set(key, value);
		}
	}

	log({ evt: 'catalog-loaded', path, cards: cards.size, aliases: aliases.size, rejected });

	return {
		byName(name: string): DraftCard | null {
			for (const key of [normaliseName(name), foldName(name)]) {
				const direct = cards.get(key);
				if (direct !== undefined) return direct;
				const canonical = aliases.get(key);
				if (canonical !== undefined) {
					const hit = cards.get(canonical);
					if (hit !== undefined) return hit;
				}
			}
			return null;
		},
	};
}

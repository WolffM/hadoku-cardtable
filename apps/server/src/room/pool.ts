/**
 * Reading one `{cube,size,cards}` file — a cube, in the shape every one of
 * them is written: the UI's single bundled pool once, and now any of the 8
 * shortlisted cube files under `apps/server/pools/cubes/` (wave 73 §A, built
 * by `packages/carddata/src/cli/build-pool.ts`'s `--out-dir=`), each a
 * `PoolSource` a room's plan can name by file stem
 * (`packages/shared/src/pool.ts`'s `CubeSummary.id`).
 *
 * The engine takes cards, not a cube name — `createDraft`'s `packs` has no
 * opinion about where they came from. This is the one place that answers
 * that question for the server, and it answers it from a file on disk rather
 * than by reaching into another workspace member's module graph: `apps/ui`
 * bundles the same file shape for its in-process source, and the two must
 * not become a build-order dependency on each other.
 *
 * ## A verdict, not a throw
 *
 * Same shape as `base-path.ts`: a missing or malformed pool is reported and the
 * server keeps serving, because the alternative is a process that will not boot
 * and a monitoring probe that cannot say why. A draft simply cannot be created
 * without a pool, so `join` answers `unknown-draft` and the reason is in the
 * boot log.
 *
 * ## Every card is re-parsed
 *
 * `DraftCardSchema` runs over each entry even though the file was produced by
 * our own pipeline. It is the D13 control at the last point before a card can
 * reach a payload: the schema has no image field, so an `image_uris` that
 * somehow got into the file is dropped here rather than discovered by a UI
 * that re-validates what the server sent it.
 */

import { readFileSync } from 'node:fs';
import { DraftCardSchema, type CubeMeta, type DraftCard } from '@hadoku/shared';

export interface CubePool {
	/** Descriptive, for the `state` envelope. */
	meta: CubeMeta;
	cards: DraftCard[];
}

export type PoolLoad =
	| { ok: true; pool: CubePool; detail: string }
	| { ok: false; reason: 'missing' | 'malformed'; detail: string };

interface RawPoolFile {
	cube?: unknown;
	size?: unknown;
	cards?: unknown;
}

/**
 * Read and validate the pool file. Synchronous, because this runs once at boot
 * and an async boot would only move the same failure somewhere less visible.
 */
export function loadPool(path: string): PoolLoad {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (err) {
		return {
			ok: false,
			reason: 'missing',
			detail: `${path}: ${(err as Error).message}`,
		};
	}

	let raw: RawPoolFile;
	try {
		raw = JSON.parse(text) as RawPoolFile;
	} catch (err) {
		return { ok: false, reason: 'malformed', detail: `${path}: ${(err as Error).message}` };
	}

	if (typeof raw.cube !== 'string' || raw.cube === '' || !Array.isArray(raw.cards)) {
		return {
			ok: false,
			reason: 'malformed',
			detail: `${path}: expected { cube: string, size: number, cards: [] }`,
		};
	}

	const cards: DraftCard[] = [];
	for (let i = 0; i < raw.cards.length; i++) {
		const parsed = DraftCardSchema.safeParse(raw.cards[i]);
		if (!parsed.success) {
			return {
				ok: false,
				reason: 'malformed',
				detail: `${path}: card ${i} is not a DraftCard — ${parsed.error.issues[0]?.message ?? 'unknown'}`,
			};
		}
		cards.push(parsed.data);
	}

	if (cards.length === 0) {
		return { ok: false, reason: 'malformed', detail: `${path}: the cube is empty` };
	}

	// `size` on the file is the cube's declared size; the count of cards that
	// actually parsed is what the pod will be dealt from. Report the real one —
	// a declared 540 over 47 cards is exactly the kind of mismatch that reads as
	// a working cube until the third pack runs out.
	return {
		ok: true,
		pool: { meta: { name: raw.cube, size: cards.length }, cards },
		detail: `${raw.cube}: ${cards.length} cards`,
	};
}

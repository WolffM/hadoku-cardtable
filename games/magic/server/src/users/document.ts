/**
 * What Magic keeps about one person in the per-person store (`@hadoku/game-server/users/store`):
 *
 *   favourites  the decks they starred, by deck id, with when
 *   decks       per deck id, when they last played it (stamped by the server at match end)
 *   built       the decks they built from nothing, by `built:<uuid>`
 *   art         their art rules: "always use oldest art", and a hand pick per card name
 *
 * A deck id is the one the match stats already use: `draft:<podId>` for a drafted deck,
 * `built:<uuid>` for a built one, a library deck's catalog id otherwise. The Library screen keys
 * its tiles by the same ids.
 *
 * Settled by the operator, 2026-11-23 (`docs/planning/wave125-2026-11-23.md`). The browser reaches
 * a document only through `http/me.ts`, and only the caller's own.
 */

import { z } from 'zod';
import { normaliseName } from '@hadoku/carddata';
import type { UserDocShape } from '@hadoku/game-server/users/store';

/** A built deck's `.dck` text, at most (wave 125 contract). */
export const BUILT_DCK_MAX_BYTES = 16 * 1024;
/** Built decks one person may keep. */
export const BUILT_DECKS_MAX = 200;
export const BUILT_NAME_MAX = 60;
export const BUILT_ID_PREFIX = 'built:';

export const BuiltDeckDocSchema = z.object({
	name: z.string().min(1).max(BUILT_NAME_MAX),
	format: z.string().min(1).max(64),
	dck: z.string().max(BUILT_DCK_MAX_BYTES),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type BuiltDeckDoc = z.infer<typeof BuiltDeckDocSchema>;

export const ArtRulesSchema = z.object({
	oldest: z.boolean(),
	/** Normalised card name (`normaliseName`) → the Scryfall id of the printing they picked. */
	picks: z.record(z.string(), z.string()),
});
export type ArtRules = z.infer<typeof ArtRulesSchema>;

export const MagicUserDocSchema = z.object({
	favourites: z.record(z.string(), z.number()).default({}),
	decks: z.record(z.string(), z.object({ lastPlayedAt: z.number() })).default({}),
	built: z.record(z.string(), BuiltDeckDocSchema).default({}),
	art: ArtRulesSchema.default({ oldest: false, picks: {} }),
});
export type MagicUserDoc = z.infer<typeof MagicUserDocSchema>;

export function emptyMagicUserDoc(): MagicUserDoc {
	return { favourites: {}, decks: {}, built: {}, art: { oldest: false, picks: {} } };
}

/** Art picks keyed the way every reader looks them up. */
export function normalisePicks(picks: Readonly<Record<string, string>>): Record<string, string> {
	return Object.fromEntries(Object.entries(picks).map(([name, id]) => [normaliseName(name), id]));
}

/** `a` with `b`'s entries added where `a` has none. */
const under = <V>(a: Record<string, V>, b: Record<string, V>): Record<string, V> => ({ ...b, ...a });

/**
 * An account merge. The kept account (`into`) wins every conflict: its favourites, built decks and
 * picks stay, the merged-away account's are added beside them. A deck both played keeps the later
 * stamp, since "last played" is a fact about either. "Always oldest" stays the kept account's.
 */
export function mergeMagicUserDocs(from: MagicUserDoc, into: MagicUserDoc): MagicUserDoc {
	const decks = under(into.decks, from.decks);
	for (const [id, { lastPlayedAt }] of Object.entries(from.decks)) {
		const kept = into.decks[id];
		if (kept !== undefined && lastPlayedAt > kept.lastPlayedAt) decks[id] = { lastPlayedAt };
	}
	return {
		favourites: under(into.favourites, from.favourites),
		decks,
		built: under(into.built, from.built),
		art: { oldest: into.art.oldest, picks: under(into.art.picks, from.art.picks) },
	};
}

export const MAGIC_USER_DOC: UserDocShape<MagicUserDoc> = {
	empty: emptyMagicUserDoc,
	parse: (raw) => MagicUserDocSchema.parse(raw),
	merge: mergeMagicUserDocs,
};

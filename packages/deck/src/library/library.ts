/*
 * A deck in the library: a prebuilt deck that also says where its list came
 * from.
 *
 * ## Why a citation is part of the model and not a README line
 *
 * A historical decklist is a transcription of somebody else's record, and
 * transcriptions are wrong sometimes. The only thing that makes a wrong one
 * fixable is knowing which record it was transcribed FROM, so the citation
 * travels in the file, next to the cards, and `loadLibraryDeck` refuses a deck
 * that has none. A library of untraceable lists is a library of folklore.
 *
 * ## The two keys are Forge's, not ours
 *
 * `prebuilt.ts` had to invent `Format` and `Effective` because Forge's
 * `DeckFileHeader` has no key for either. It does have keys for these two:
 *
 *   public static final String SOURCE_URL = "Source URL";
 *     -- forge-core/src/main/java/forge/deck/io/DeckFileHeader.java:42
 *   public static final String COMMENT = "Comment";
 *     -- DeckFileHeader.java:52
 *
 * Both are round-tripped by Forge itself — `DeckSerializer.serializeDeck`
 * writes them at :52 and :56, `DeckFileHeader` reads `SOURCE_URL` back at :87 —
 * and both are already in `dck-write.ts`'s `FORGE_METADATA_KEYS`, so the writer
 * spells them correctly with no help. Inventing a third key when the format
 * already has the right one would have been a worse file for no gain.
 *
 * `Source URL` carries the URL. `Comment` carries the sentence a human needs to
 * check it: the event, the player, the finish. The URL alone is a link that
 * could rot; the comment alone is unverifiable; together they survive one of
 * the two going missing.
 *
 * ## No filesystem, same as the rest of the package
 *
 * `loadLibraryDeck` takes text, exactly as `loadPrebuiltDeck` does, because
 * this package is bundled into the browser. `catalog.ts` names the files and
 * the caller reads them. Nor does anything here import
 * `@hadoku/carddata/formats`: that subpath reaches `resolve.ts`, which imports
 * `node:fs`, `node:readline` and `node:path` (resolve.ts:32-34), so it is
 * node-only despite being pure card data. The pool therefore stays an argument
 * on the caller's side of the boundary — `pool-fixture.ts` rebuilds one from
 * plain JSON with no carddata import at all.
 */

import type { DeckIssue } from '../deck.ts';
import type { FormatPool } from '../format.ts';
import {
  loadPrebuiltDeck,
  prebuiltIssues,
  PrebuiltDeckError,
  type PrebuiltDeck,
  type PrebuiltDeckOverrides,
} from '../prebuilt.ts';

/** Forge's own metadata key for where a deck came from (DeckFileHeader.java:42). */
export const LIBRARY_SOURCE_KEY = 'Source URL';
/** Forge's own free-text key (DeckFileHeader.java:52). We use it for provenance. */
export const LIBRARY_PROVENANCE_KEY = 'Comment';
/**
 * The archetype and the player, each its own key, as the selection names them
 * (`build-library.ts`). Ours, not Forge's: Forge's `Player` key means "a deck
 * for the AI" (DeckFileHeader.java), so the player is the `Pilot`.
 */
export const LIBRARY_ARCHETYPE_KEY = 'Archetype';
export const LIBRARY_PILOT_KEY = 'Pilot';

/** A prebuilt deck that can be traced back to the record it was copied from. */
export interface LibraryDeck extends PrebuiltDeck {
  /** Where the list came from, as a URL. Forge's `Source URL`. */
  readonly citation: string;
  /** Event, player and finish in one line. Forge's `Comment`. */
  readonly provenance: string;
  /** What the deck is, without who played it: `Goggles Ramp`. */
  readonly archetype: string;
  /** Who played it: `Aleksa Telaron`. */
  readonly pilot: string;
}

/** Thrown when a `.dck` is not a usable library deck. */
export class LibraryDeckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibraryDeckError';
  }
}

/** Anything a library deck's file does not have to say for itself. */
export interface LibraryDeckOverrides extends PrebuiltDeckOverrides {
  readonly citation?: string;
  readonly provenance?: string;
  readonly archetype?: string;
  readonly pilot?: string;
}

/**
 * Read a library deck out of `.dck` text.
 *
 * Everything `loadPrebuiltDeck` requires, plus a citation, a provenance line,
 * an archetype and a pilot. Every missing field
 * are named in one message rather than the first, for the same reason
 * `loadPrebuiltDeck` does it: the fix is an edit to the file and the message
 * should say which lines to add.
 *
 * A `PrebuiltDeckError` from the inner load is re-thrown as a
 * `LibraryDeckError` with its message intact, so a caller has one error type to
 * catch and still sees every fault the inner loader found.
 */
export function loadLibraryDeck(text: string, overrides: LibraryDeckOverrides = {}): LibraryDeck {
  let prebuilt: PrebuiltDeck;
  try {
    prebuilt = loadPrebuiltDeck(text, overrides);
  } catch (error) {
    if (error instanceof PrebuiltDeckError) throw new LibraryDeckError(error.message);
    throw error;
  }

  const citation =
    overrides.citation ?? prebuilt.file.metadata.get(LIBRARY_SOURCE_KEY.toLowerCase()) ?? '';
  const provenance =
    overrides.provenance ?? prebuilt.file.metadata.get(LIBRARY_PROVENANCE_KEY.toLowerCase()) ?? '';
  const archetype =
    overrides.archetype ?? prebuilt.file.metadata.get(LIBRARY_ARCHETYPE_KEY.toLowerCase()) ?? '';
  const pilot = overrides.pilot ?? prebuilt.file.metadata.get(LIBRARY_PILOT_KEY.toLowerCase()) ?? '';

  const missing: string[] = [];
  if (citation.trim().length === 0) {
    missing.push(`a citation (metadata key \`${LIBRARY_SOURCE_KEY}\`)`);
  }
  if (provenance.trim().length === 0) {
    missing.push(`a provenance line (metadata key \`${LIBRARY_PROVENANCE_KEY}\`)`);
  }
  if (archetype.trim().length === 0) {
    missing.push(`an archetype (metadata key \`${LIBRARY_ARCHETYPE_KEY}\`)`);
  }
  if (pilot.trim().length === 0) {
    missing.push(`a pilot (metadata key \`${LIBRARY_PILOT_KEY}\`)`);
  }
  if (missing.length > 0) {
    throw new LibraryDeckError(
      `library deck ${JSON.stringify(prebuilt.name)} needs ${missing.join(', and ')}`,
    );
  }

  return { ...prebuilt, citation, provenance, archetype, pilot };
}

/**
 * Every way this library deck fails the pool it is handed — which card, and
 * why. Empty means legal.
 *
 * A thin pass-through to `prebuiltIssues`, and deliberately so: the library
 * does not get its own legality rules. It exists so a caller reads one function
 * name and so this file is the only place a future library-specific check would
 * go.
 */
export function libraryIssues(deck: LibraryDeck, pool: FormatPool): DeckIssue[] {
  return prebuiltIssues(deck, pool);
}

/**
 * Whether the pool a caller supplied is the one this deck names, or a sentence
 * saying how they differ.
 *
 * This is NOT folded into `libraryIssues`. `DeckIssueKind` is a closed union
 * about cards and counts (deck.ts:193-211) and "you validated against the wrong
 * format" is not a fault in the deck at all — it is a fault in the call. Mixing
 * the two would let a caller who passed the wrong pool read a wall of
 * `not-in-pool` issues as a broken decklist, which is precisely the wrong
 * diagnosis and precisely the one this repo's brief warns about.
 */
export function libraryPoolMismatch(deck: LibraryDeck, pool: FormatPool): string | null {
  if (pool.name === deck.format) return null;
  return `deck ${JSON.stringify(deck.name)} is built for ${JSON.stringify(deck.format)} as of ${deck.date}, but the pool supplied is ${JSON.stringify(pool.name)}`;
}

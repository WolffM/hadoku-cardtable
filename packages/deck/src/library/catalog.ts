/*
 * What is in the deck library, and where the files are.
 *
 * ## Why the catalog holds paths and not decks
 *
 * `@hadoku/deck` cannot read a file — it is bundled into the browser and has no
 * node builtins, which is the rule `index.ts` states for the whole package. So
 * the catalog is a manifest: it names the files, and whoever has a filesystem
 * (a test, a build step) or a fetch (the UI) reads them and hands the text to
 * `loadLibraryDeck`. That is the same shape `prebuilt.ts` chose and for the same
 * reason.
 *
 * ## Why so little is in here
 *
 * Each entry carries an id and a filename and nothing else. Name, format, date,
 * citation and provenance all live in the `.dck` file's own `[metadata]`
 * section, so there is exactly one copy of each fact and the file is the copy.
 * A catalog that also listed the player and the finish would be a second copy
 * free to drift from the first, and the drift would be invisible.
 *
 * What the collection-level rows DO carry — `format`, `date`, `source` — is
 * carried on purpose, because it is checkable: `library.test.ts` asserts every
 * deck file in a collection agrees with its collection's row, so a deck filed
 * under the wrong format fails the build rather than sitting there wrong.
 */

/** One deck file in a collection. */
export interface LibraryEntry {
  /** Stable id, used in reports and test names. */
  readonly id: string;
  /** File name inside the collection's directory. */
  readonly file: string;
}

/** A set of decks that share a format, a date and an event. */
export interface LibraryCollection {
  readonly id: string;
  /** Directory under {@link DECKS_ROOT}, relative to the repo root. */
  readonly directory: string;
  /** Human name of the event or source the decks came from. */
  readonly event: string;
  /** The format as Forge names it. Every deck's `Format` key must match. */
  readonly format: string;
  /** `YYYY-MM-DD`. Every deck's `Effective` key must match. */
  readonly date: string;
  /** Where the collection as a whole came from. */
  readonly source: string;
  readonly decks: readonly LibraryEntry[];
}

/** The repo-root-relative directory the library lives in. */
export const DECKS_ROOT = 'decks';

/**
 * Pro Tour Paris 2011, the Standard portion — the complete Top 8.
 *
 * Chosen because it is a **complete, closed set** rather than a hand-picked
 * eight: "the Top 8 of one event" has an unambiguous membership test, so nobody
 * has to wonder which decks were left out or why. It is also the format this
 * repo's own tooling can say the most about — the snapshot in force is
 * `Standard (MBS)`, effective 2011-02-04, and the very next rotation row
 * (2011-07-01) bans two cards that four of these eight decks play, which makes
 * the library its own regression test for the ban path.
 *
 * Four of the eight are the same archetype. That is not sampling laziness; it
 * is what that Top 8 was. Caw-Blade broke out at this tournament.
 */
export const PT_PARIS_2011_STANDARD: LibraryCollection = {
  id: 'pt-paris-2011-standard',
  directory: `${DECKS_ROOT}/standard-2011-02-13-pt-paris`,
  event: 'Pro Tour Paris 2011, Standard portion, Top 8',
  format: 'Standard (MBS)',
  date: '2011-02-13',
  source: 'https://www.mtgtop8.com/event?e=1016&f=ST',
  decks: [
    { id: 'pt-paris-2011-1-ben-stark', file: '1-ben-stark-mystic-caw-go.dck' },
    { id: 'pt-paris-2011-2-paul-rietzl', file: '2-paul-rietzl-boros-landfall.dck' },
    { id: 'pt-paris-2011-3-vincent-lemoine', file: '3-vincent-lemoine-boros-landfall.dck' },
    { id: 'pt-paris-2011-4-naoki-nakada', file: '4-naoki-nakada-mystic-caw-go.dck' },
    { id: 'pt-paris-2011-5-nico-bohny', file: '5-nico-bohny-fauna-quest.dck' },
    { id: 'pt-paris-2011-6-tom-martell', file: '6-tom-martell-mystic-caw-go.dck' },
    { id: 'pt-paris-2011-7-shintaro-ishimura', file: '7-shintaro-ishimura-mystic-caw-go.dck' },
    { id: 'pt-paris-2011-8-patrick-chapin', file: '8-patrick-chapin-tezzeret-control.dck' },
  ],
};

/** Every collection in the library. */
export const LIBRARY: readonly LibraryCollection[] = [PT_PARIS_2011_STANDARD];

/**
 * Where a deck's file is, relative to the repo root.
 *
 * A function rather than a field so the collection's directory is written once.
 * Always `/`-separated: these are repo paths, not host paths, and the caller
 * joins them with whatever its platform wants.
 */
export function deckPath(collection: LibraryCollection, entry: LibraryEntry): string {
  return `${collection.directory}/${entry.file}`;
}

/** Every deck file in the library, repo-root-relative, in catalog order. */
export function libraryDeckPaths(library: readonly LibraryCollection[] = LIBRARY): string[] {
  return library.flatMap((c) => c.decks.map((d) => deckPath(c, d)));
}

/**
 * The pool fixture for a collection, relative to the repo root.
 *
 * One fixture per collection date, named after the date rather than the
 * collection, because two collections from the same Standard share a pool and
 * regenerating it twice would be two chances to disagree.
 */
export function poolFixturePath(date: string): string {
  return `${DECKS_ROOT}/pools/standard-${date}.generated.json`;
}

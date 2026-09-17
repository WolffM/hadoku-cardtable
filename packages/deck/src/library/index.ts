/*
 * @hadoku/deck/library — real decks from a real past Standard, and the pool to
 * check them against.
 *
 * Four modules:
 *
 *   1. `catalog.ts` — what is in the library and where the files are. Paths
 *      only: this package cannot read a file, so the caller does.
 *   2. `library.ts` — a `.dck` plus the format, the date AND the citation,
 *      loaded from text. `prebuilt.ts` with provenance attached, using Forge's
 *      own `Source URL` and `Comment` keys rather than inventing new ones.
 *   3. `pool-fixture.ts` — a Standard pool frozen to JSON and thawed back into
 *      a `FormatPool`. This is what makes the tests hermetic: the 183 MB corpus
 *      is gitignored and absent in CI, so the pool is computed once against the
 *      real cards and committed under `decks/pools/`.
 *   4. `library.test.ts` — the standing check, against those fixtures.
 *
 * And three node scripts that nothing imports, each with its own header:
 * `build-library.ts` (transcribes the decks from their source),
 * `build-pool-fixture.ts` (freezes the pools from the real corpus) and
 * `validate-library.ts` (the real-corpus measurement, run by hand).
 *
 * Nothing exported here imports `@hadoku/carddata/formats`. That subpath is
 * node-only — `standard.ts:69` imports `resolve.ts`, which imports `node:fs`,
 * `node:readline` and `node:path` (resolve.ts:32-34) — and this package is
 * bundled into the browser. The pool therefore crosses the boundary as data,
 * which is the same rule `format.ts` already holds one level down.
 */

export {
  DECKS_ROOT,
  LIBRARY,
  PT_PARIS_2011_STANDARD,
  deckPath,
  libraryDeckPaths,
  poolFixturePath,
  type LibraryCollection,
  type LibraryEntry,
} from './catalog.ts';

export {
  LIBRARY_PROVENANCE_KEY,
  LIBRARY_SOURCE_KEY,
  LibraryDeckError,
  libraryIssues,
  libraryPoolMismatch,
  loadLibraryDeck,
  type LibraryDeck,
  type LibraryDeckOverrides,
} from './library.ts';

export {
  PoolFixtureError,
  fixtureFromStandardPool,
  parsePoolFixture,
  poolFromFixture,
  type PoolFixture,
  type StandardPoolLike,
} from './pool-fixture.ts';

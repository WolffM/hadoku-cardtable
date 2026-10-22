/*
 * @hadoku/deck — turning a pool of cards into something you can play or export.
 *
 * Four files, in dependency order:
 *
 *   1. `deck.ts` — the pool → deck model. Maindeck, sideboard, basic lands, and
 *      the two rules a cube deck actually has (40 cards, and you drafted it).
 *      Also `DeckIssue`, the shape every check in this package reports in.
 *   2. `dck-write.ts` — a `.dck` writer, the inverse of `@hadoku/carddata`'s
 *      `parseDck`. Every rule cites the Forge source it came from, same as the
 *      parser does.
 *   3. `format.ts` — constructed legality against a **supplied** card pool:
 *      which cards are not in it, which are banned, which are over the copy
 *      limit, and why. It never looks a format up; the pool is an argument.
 *   4. `prebuilt.ts` — a prebuilt deck: a `.dck` plus the format and date it was
 *      built for, loaded from text, validated against a pool, and written back
 *      byte-identical.
 *
 * The package is pure string and set work. It has no filesystem access and no
 * node builtins, because it is bundled into the browser: anything that needs a
 * file takes the file's text as an argument instead.
 *
 * That is also why every non-test file here imports `@hadoku/carddata/dck` and
 * not `@hadoku/carddata`. The root barrel re-exports the Scryfall ingest, which
 * is node-only, and pulling it into a DOM-lib program fails to typecheck on
 * `Readable.fromWeb` (`scryfall/bulk.ts:200`, TS2345) — so importing the barrel
 * from here reds `apps/ui`'s typecheck even though nothing in this package ever
 * calls it. The `./dck` subpath is the parser alone and has no node builtins.
 * Test files are node programs and use the barrel freely.
 */

export {
  BASIC_LAND_NAMES,
  LIMITED_MIN_MAIN_DECK_SIZE,
  basicLand,
  cardKey,
  deckFromDeckFile,
  deckIssues,
  deckProblems,
  isBasicLand,
  mainDeckSize,
  mergeEntries,
  moveToMain,
  moveToSideboard,
  newDeck,
  poolFromDeckFile,
  poolOf,
  setBasicLand,
  sideboardSize,
  toDeckFile,
  totalCards,
  type Deck,
  type DeckIssue,
  type DeckIssueKind,
} from './deck.ts';

export { cardRequestOf, poolEntries, type DraftedPrinting } from './draft-pool.ts';

export {
  DckWriteError,
  FORGE_METADATA_KEYS,
  FORGE_SECTION_NAMES,
  composeCardLine,
  composeCardRequest,
  dckSpelling,
  writeDck,
  type ArtIndexPolicy,
  type DckSpelling,
  type EmptySectionPolicy,
  type WriteDckOptions,
} from './dck-write.ts';

export {
  CONSTRUCTED_LIMITS,
  formatIssues,
  formatPoolFromEntries,
  isLegalIn,
  type FormatPool,
} from './format.ts';

export {
  DECK_COLORS,
  POOL_COLORS,
  deckColorsByName,
  foldDeckColors,
  manaTokensOf,
  type DeckColor,
} from './colors.ts';

export {
  PREBUILT_DATE_KEY,
  PREBUILT_FORMAT_KEY,
  PrebuiltDeckError,
  loadPrebuiltDeck,
  prebuiltDeck,
  prebuiltIssues,
  prebuiltToDeck,
  writePrebuiltDeck,
  type PrebuiltDeck,
  type PrebuiltDeckOverrides,
} from './prebuilt.ts';

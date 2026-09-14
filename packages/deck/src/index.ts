/*
 * @hadoku/deck — turning a drafted pool into something you can play or export.
 *
 * Two halves:
 *
 *   1. `deck.ts` — the pool → deck model. Maindeck, sideboard, basic lands, and
 *      the two rules a cube deck actually has (40 cards, and you drafted it).
 *      No format legality engine; see the file header for why that is a
 *      decision rather than an omission.
 *   2. `dck-write.ts` — a `.dck` writer, the inverse of `@hadoku/carddata`'s
 *      `parseDck`. Every rule cites the Forge source it came from, same as the
 *      parser does.
 */

export {
  BASIC_LAND_NAMES,
  LIMITED_MIN_MAIN_DECK_SIZE,
  basicLand,
  cardKey,
  deckProblems,
  isBasicLand,
  mainDeckSize,
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
} from './deck.ts';

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

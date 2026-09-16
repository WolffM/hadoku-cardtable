/*
 * Constructed formats.
 *
 * Today this is Standard, as of a date. The operator's goal is to "recreate
 * standard formats from years past", and the load-bearing word is *past*: a
 * pool derived from `legalities.standard` is a pool as of the last Scryfall
 * sync, which is the wrong answer for every date but one. `standard.ts` has the
 * argument in full.
 *
 * Nothing here reads a file or knows a path. Every entry point takes the card
 * corpus as an argument, so the 183 MB gitignored cache stays a caller's
 * problem and these modules stay testable in CI without it.
 *
 * This subtree is not re-exported from `@hadoku/carddata`'s root yet — import
 * `./formats/index.ts` directly. That is deliberate and not an oversight: the
 * root barrel belongs to another lane this wave.
 */

export {
  // The table, and where every row came from.
  STANDARD_HISTORY,
  SANCTIONED_MATCHES_NEWEST,
  FIRST_EFFECTIVE,
  LAST_EFFECTIVE,
  // Asking.
  standardFormatAt,
  standardPoolAt,
  standardRotations,
  isStandardLegalAt,
  // The corpus, as an argument.
  buildPrintingIndex,
  type StandardSnapshot,
  type StandardFormat,
  type StandardFormatOptions,
  type StandardUnsupported,
  type UnsupportedReason,
  type Rotation,
  type PrintingIndex,
  type PrintingIndexOptions,
  type PoolCard,
  type StandardPool,
  type StandardPoolOptions,
  type LegalityAnswer,
} from './standard.ts';

/*
 * Dispatching across Standard, Modern and Legacy by a `FormatFamily` string,
 * for callers that want "the pool for this family on this date" without a
 * three-way switch of their own — `packages/deck/src/library/catalog.ts`'s
 * `LibraryCollection.family` is the caller this exists for (wave 48 §T).
 *
 * `standardFormatAt`/`standardPoolAt` are called through unchanged — this
 * file adds no behaviour to Standard, only a name for selecting it alongside
 * the other two.
 */

import {
  standardFormatAt,
  standardPoolAt,
  type StandardFormat,
  type StandardFormatOptions,
  type StandardPool,
  type StandardPoolOptions,
  type StandardUnsupported,
  type PrintingIndex,
} from './standard.ts';
import { modernFormatAt, modernPoolAt } from './modern.ts';
import { legacyFormatAt, legacyPoolAt } from './legacy.ts';
import type { FormatAnswer, FormatUnsupported, GenericFormatPool } from './generic-format.ts';

/** The three format families the deck library can draw a pool from. */
export type FormatFamily = 'standard' | 'modern' | 'legacy';

/**
 * The format in force for `family` on `date`, or a refusal.
 *
 * Standard's own `StandardFormat`/`StandardUnsupported` types are richer by
 * nothing Modern/Legacy's `FormatAnswer`/`FormatUnsupported` lack in shape —
 * both carry `effective`, `setList`, `banned`, etc. — so a caller that only
 * wants the common fields can treat the result uniformly regardless of which
 * union member it got.
 */
export function formatAtFamily(
  family: FormatFamily,
  date: string,
  options: StandardFormatOptions = {},
): StandardFormat | FormatAnswer | StandardUnsupported | FormatUnsupported {
  switch (family) {
    case 'standard':
      return standardFormatAt(date, options);
    case 'modern':
      return modernFormatAt(date, options);
    case 'legacy':
      return legacyFormatAt(date, options);
  }
}

/**
 * The card pool for `family` on `date`, or a refusal. `standardPoolAt` is
 * called through unchanged for `'standard'`; Modern and Legacy go through
 * `generic-format.ts`'s `poolAt` over their own transcribed history.
 */
export function formatPoolAt(
  family: FormatFamily,
  date: string,
  index: PrintingIndex,
  options: StandardPoolOptions = {},
): StandardPool | GenericFormatPool | StandardUnsupported | FormatUnsupported {
  switch (family) {
    case 'standard':
      return standardPoolAt(date, index, options);
    case 'modern':
      return modernPoolAt(date, index, options);
    case 'legacy':
      return legacyPoolAt(date, index, options);
  }
}

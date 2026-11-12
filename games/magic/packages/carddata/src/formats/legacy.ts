/*
 * "Was this card Legacy-legal on a date?"
 *
 * Legacy does not rotate — it is "every paper set ever" plus a ban list — but
 * the ban list and the growing set list still change dated file by dated
 * file, so the same transcribe-don't-derive approach applies as Modern's:
 * `legacy-history.generated.ts` is transcribed from Forge's
 * `Archived/Legacy/*.txt` by `gen-format-history.ts`, and this module is thin
 * wiring over `generic-format.ts`'s engine.
 *
 * Legacy began September 2004 (wave 48, Settled), so 2005 is its first power
 * summer; the transcribed table reaches back to 1996 for completeness and for
 * `formatAt`'s binary search.
 */

import { LEGACY_HISTORY, LEGACY_SANCTIONED_MATCHES_NEWEST } from './legacy-history.generated.ts';
import type { LegacySnapshot } from './legacy-history.generated.ts';
import {
  formatAt,
  poolAt,
  type FormatAnswer,
  type FormatAtOptions,
  type FormatUnsupported,
  type GenericFormatPool,
  type GenericPoolAtOptions,
} from './generic-format.ts';
import type { PrintingIndex } from './standard.ts';

export { LEGACY_HISTORY, LEGACY_SANCTIONED_MATCHES_NEWEST };
export type { LegacySnapshot };

export function legacyFormatAt(
  date: string,
  options: FormatAtOptions = {},
): FormatAnswer | FormatUnsupported {
  return formatAt(LEGACY_HISTORY, date, options);
}

export function legacyPoolAt(
  date: string,
  index: PrintingIndex,
  options: GenericPoolAtOptions = {},
): GenericFormatPool | FormatUnsupported {
  return poolAt(LEGACY_HISTORY, date, index, options);
}

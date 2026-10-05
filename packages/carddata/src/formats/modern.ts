/*
 * "Was this card Modern-legal on a date?"
 *
 * Modern does not rotate — it is "every set since 8th Edition" plus a ban
 * list — but the ban list and the growing set list still change dated file
 * by dated file, exactly the way Standard's rotation does, so the same
 * transcribe-don't-derive approach applies: `modern-history.generated.ts` is
 * transcribed from Forge's `Archived/Modern/*.txt` by `gen-format-history.ts`,
 * and this module is thin wiring over `generic-format.ts`'s engine.
 *
 * Modern was created August 2011 (wave 48, Settled); `Archived/Modern/2011-*`
 * files predate the format's play and are not a power-summer era, though the
 * transcribed table still carries them for completeness and for `formatAt`'s
 * binary search.
 */

import { MODERN_HISTORY, MODERN_SANCTIONED_MATCHES_NEWEST } from './modern-history.generated.ts';
import type { ModernSnapshot } from './modern-history.generated.ts';
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

export { MODERN_HISTORY, MODERN_SANCTIONED_MATCHES_NEWEST };
export type { ModernSnapshot };

/** The earliest date the transcribed Modern history can answer for. */
export const MODERN_FIRST_EFFECTIVE: string = MODERN_HISTORY[0].effective;
/** The latest date the transcribed Modern history can answer for without guessing. */
export const MODERN_LAST_EFFECTIVE: string = MODERN_HISTORY[MODERN_HISTORY.length - 1].effective;

export function modernFormatAt(
  date: string,
  options: FormatAtOptions = {},
): FormatAnswer | FormatUnsupported {
  return formatAt(MODERN_HISTORY, date, options);
}

export function modernPoolAt(
  date: string,
  index: PrintingIndex,
  options: GenericPoolAtOptions = {},
): GenericFormatPool | FormatUnsupported {
  return poolAt(MODERN_HISTORY, date, index, options);
}

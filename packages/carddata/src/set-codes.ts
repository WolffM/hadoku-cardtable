/*
 * Translating Forge set codes into Scryfall set codes.
 *
 * A cube list writes `1 Stoneforge Mystic|PRM`. `PRM` is Forge's code for its
 * catch-all promo edition; Scryfall has no set called `PRM`. Across the 95
 * vendored cubes there are 375 distinct set codes and they are Forge's
 * vocabulary throughout, so this translation sits between every cube list and
 * every card lookup.
 *
 * The table is not ours. Forge declares the mapping itself, one
 * `ScryfallCode=` line per edition file, and `set-codes.generated.ts` is that
 * declaration extracted verbatim — see `cli/gen-set-codes.ts` for how, and for
 * how the one ambiguous key is resolved.
 */

import { FORGE_TO_SCRYFALL_SET } from './set-codes.generated.ts';

export { FORGE_TO_SCRYFALL_SET };

/**
 * The Scryfall set code for a Forge set code, or `null` if Forge's edition
 * data does not know that code.
 *
 * `null` is a real answer and the caller must handle it. Falling back to the
 * input would look like it worked and would then miss in the card cache with
 * no trace of *why*, which is exactly the silent-guess failure this package
 * refuses (see `resolve.ts`).
 */
export function toScryfallSetCode(forgeCode: string | null | undefined): string | null {
  if (forgeCode === null || forgeCode === undefined) return null;
  const trimmed = forgeCode.trim();
  if (trimmed.length === 0) return null;
  return FORGE_TO_SCRYFALL_SET.get(trimmed.toUpperCase()) ?? null;
}

/** Whether Forge's edition data recognises this set code at all. */
export function isKnownForgeSetCode(forgeCode: string): boolean {
  return FORGE_TO_SCRYFALL_SET.has(forgeCode.trim().toUpperCase());
}

/**
 * The pure half of `draft-sets.spec.ts`'s realistic-pack collation check — split out so
 * `draft-sets.test.ts` (`node --test`, no browser, no jar) can exercise it against a fixture
 * instead of only ever running it live against a real pack.
 *
 * ## Why a foil has to be set aside too, not just the DFC
 *
 * ISD's own recipe (`forge/forge-gui/res/editions/Innistrad.txt`):
 * `Booster=9 Common:!dfc, 3 Uncommon:!dfc, 1 RareMythic:!dfc, 1 dfc, 1 BasicLand`.
 *
 * Forge's `BoosterGenerator.getBoosterPack` (forge-core, `item/generation/BoosterGenerator.java`)
 * can ALSO add one foil card of any rarity, per the edition's own foil chance
 * (`CardEdition`'s `FoilChanceInBooster`, default ~21.43%, and `FoilAlwaysInCommonSlot`, default
 * true). When that default holds — as it does for ISD, which sets neither — the foil always
 * shrinks the COMMON slot by one to make room, REGARDLESS of what rarity the foil itself turns
 * out to be, then appends the foil card on top at the very end of the pack. A foil landing on
 * "Rare/Mythic" therefore does not touch the `RareMythic:!dfc` slot's own card at all: it is a
 * genuine 16th-card-sized extra riding on a common's vacated seat, so a pack can hold 2 non-DFC
 * rares/mythics (the slot's own, plus the foil) or 4 non-DFC uncommons (3 plus a foil uncommon) at
 * random — real packs, not a miscount, and not something a looser assertion should paper over.
 *
 * `BoosterCard.foil` (`apps/server/src/pools/forge.ts`) carries `PaperCard.isFoil()` off the jar,
 * `DraftCardSchema.foil` (`packages/shared/src/draft.ts`) carries it onto the wire. Setting the
 * foil-marked card aside — exactly as this file already sets the DFC aside — recovers the fixed
 * collation a paper pack also guarantees among what is left.
 */

export interface WireCard {
  name: string;
  rarity: string;
  faces?: unknown[];
  setCode: string;
  foil?: boolean;
}

export interface CollationCounts {
  /** Cards with another face — Forge's own double-faced slot never counts toward a rarity tally. */
  dfcCount: number;
  /** The foil `getBoosterPack` may append on top of a common's vacated slot — an extra card, of any rarity, set aside the same way. */
  foilCount: number;
  /** Rare/mythic among the cards that are neither a DFC nor the foil extra. */
  rareOrMythicCount: number;
  /** Uncommons among the cards that are neither a DFC nor the foil extra. */
  uncommonCount: number;
}

const isDfc = (card: WireCard): boolean => Array.isArray(card.faces) && card.faces.length > 0;
const isFoil = (card: WireCard): boolean => card.foil === true;

/** The pack's rarity collation, with the DFC and the (at most one) foil card both set aside first. */
export function collationCounts(entries: readonly WireCard[]): CollationCounts {
  const dfcs = entries.filter(isDfc);
  const foils = entries.filter(isFoil);
  const rest = entries.filter((e) => !isDfc(e) && !isFoil(e));
  return {
    dfcCount: dfcs.length,
    foilCount: foils.length,
    rareOrMythicCount: rest.filter((e) => e.rarity === 'rare' || e.rarity === 'mythic').length,
    uncommonCount: rest.filter((e) => e.rarity === 'uncommon').length,
  };
}

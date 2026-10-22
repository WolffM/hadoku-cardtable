/**
 * The pure half of `draft-sets.spec.ts`'s realistic-pack collation check — split out so
 * `draft-sets.test.ts` (`node --test`, no browser, no jar) can exercise it against a fixture
 * instead of only ever running it live against a real pack.
 *
 * ## What a realistic pack holds
 *
 * ISD's own recipe (`forge/forge-gui/res/editions/Innistrad.txt`):
 * `Booster=9 Common:!dfc, 3 Uncommon:!dfc, 1 RareMythic:!dfc, 1 dfc, 1 BasicLand`. Forge's
 * `BoosterGenerator.getBoosterPack` may also shrink a common slot for a foil of any rarity.
 * The pool service (`apps/server/src/play/bridge/PoolService.java`'s `draftPack`) leaves the
 * basic land and the foil out and tops the pack up to 15 with the set's commons — the operator,
 * 2026-10-22: "i dont like the land/foil being in the packs. lets make sure all packs are 15
 * cards" — so a drafted ISD pack is 10 commons, 3 uncommons, 1 rare/mythic and 1 DFC.
 *
 * The DFC is set aside before the rarities are counted: its slot draws from a sheet with no
 * rarity filter, so an uncommon DFC beside three uncommons is four "uncommon" cards and a right
 * pack. A foil or a basic land is counted, never set aside: the spec wants none of either.
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
  /** Foil cards: none, in a draft pack. */
  foilCount: number;
  /** Basic lands: none, in a draft pack. */
  basicCount: number;
  /** Rare/mythic among the cards that are not the DFC. */
  rareOrMythicCount: number;
  /** Uncommons among the cards that are not the DFC. */
  uncommonCount: number;
}

const BASICS = /^(Snow-Covered )?(Plains|Island|Swamp|Mountain|Forest|Wastes)$/;
const isDfc = (card: WireCard): boolean => Array.isArray(card.faces) && card.faces.length > 0;

/** The pack's rarity collation, the DFC set aside; its foils and basic lands, counted. */
export function collationCounts(entries: readonly WireCard[]): CollationCounts {
  const rest = entries.filter((e) => !isDfc(e));
  return {
    dfcCount: entries.length - rest.length,
    foilCount: entries.filter((e) => e.foil === true).length,
    basicCount: entries.filter((e) => BASICS.test(e.name)).length,
    rareOrMythicCount: rest.filter((e) => e.rarity === 'rare' || e.rarity === 'mythic').length,
    uncommonCount: rest.filter((e) => e.rarity === 'uncommon').length,
  };
}

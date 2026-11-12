/*
 * Alchemy is not in Cardtable (the operator, 2026-11-01: "i dont want to see
 * anything alchemy related anymore. i dont want to see alchemy sets, or
 * alchemy cards").
 *
 * Alchemy is Arena's digital-only design space, and it reaches us three ways:
 *
 *   - **Alchemy sets.** Scryfall types them `set_type: "alchemy"` (19 in the
 *     2026-11-01 `default_cards` sync, 1012 printings: the Y-sets, YMID
 *     through YFRA, plus HBG, "Alchemy Horizons: Baldur's Gate"). Forge has
 *     an edition for each, every one named "Alchemy …" and most with a draft
 *     booster, so without this they are offered as draft sets.
 *   - **An Arena-only set of Alchemy designs that Scryfall types otherwise.**
 *     J21, Jumpstart: Historic Horizons (`draft_innovation`): its 31 new
 *     cards are digital-only and use Alchemy's mechanics (perpetually, seek,
 *     conjure). That is the whole of `ALCHEMY_DESIGN_SETS`.
 *   - **Rebalanced cards,** "A-" versions of paper cards. Forge lists them in
 *     each edition's `[rebalanced]` section (26 editions); Scryfall marks them
 *     with `promo_types: ["rebalanced"]` and an `A-` collector number.
 *
 * A card is Alchemy when it has an Alchemy printing and no paper one: it was
 * only ever an Alchemy card. A paper card reprinted in an Alchemy set keeps
 * its paper printings and loses the Alchemy one. `A-Town` (Unknown Event, a
 * paper playtest card) is a real card that merely starts with "A-", which is
 * why a name alone never decides it.
 *
 * `resolve.ts`'s `buildCardIndex` applies this to every card it indexes, and
 * every card lookup in the repo goes through that index, so nothing downstream
 * of the catalog can show one.
 */

import type { GameplayCard } from './scryfall/project.ts';

/** Scryfall's `set_type` for Alchemy sets. */
const ALCHEMY_SET_TYPE = 'alchemy';

/** Arena-only sets of Alchemy designs that Scryfall types as something else (see the file header). */
const ALCHEMY_DESIGN_SETS: ReadonlySet<string> = new Set(['J21']);

/**
 * Every Alchemy set code known on 2026-11-01, Scryfall's and Forge's (Forge
 * also knows Alchemy: Innistrad as `Y22`). The rule is the type and the name;
 * this list answers for a bare code, where neither is at hand.
 */
const ALCHEMY_SET_CODES: ReadonlySet<string> = new Set([
  'Y22',
  'YMID',
  'YNEO',
  'YSNC',
  'YDMU',
  'YBRO',
  'YONE',
  'YMOM',
  'YWOE',
  'YLCI',
  'YMKM',
  'YOTJ',
  'YBLB',
  'YDSK',
  'YDFT',
  'YTDM',
  'YEOE',
  'YECL',
  'YSOS',
  'YFRA',
  'HBG',
  ...ALCHEMY_DESIGN_SETS,
]);

/** Scryfall names every Alchemy set "Alchemy: …" or "Alchemy Horizons: …"; Forge "Alchemy …". */
const ALCHEMY_SET_NAME = /^alchemy\b/i;

export interface SetIdentity {
  readonly code?: string | null;
  readonly name?: string | null;
  /** Scryfall's `set_type`, where known. */
  readonly type?: string | null;
}

/** Whether a set, by whatever of its code, name and Scryfall type the caller has, is an Alchemy set. */
export function isAlchemySet(set: SetIdentity): boolean {
  if (set.type === ALCHEMY_SET_TYPE) return true;
  if (typeof set.name === 'string' && ALCHEMY_SET_NAME.test(set.name.trim())) return true;
  return typeof set.code === 'string' && ALCHEMY_SET_CODES.has(set.code.trim().toUpperCase());
}

function str(card: GameplayCard, field: string): string | null {
  const value = card[field];
  return typeof value === 'string' ? value : null;
}

/** A rebalanced "A-" printing: Scryfall's own mark, its `A-` collector number, or a digital `A-` name. */
function isRebalanced(card: GameplayCard): boolean {
  const promoTypes = card['promo_types'];
  if (Array.isArray(promoTypes) && promoTypes.includes('rebalanced')) return true;
  if (str(card, 'collector_number')?.startsWith('A-') === true) return true;
  return card['digital'] === true && str(card, 'name')?.startsWith('A-') === true;
}

/** Whether this one printing is an Alchemy printing: in an Alchemy set, or rebalanced. */
export function isAlchemyPrinting(card: GameplayCard): boolean {
  return isRebalanced(card) || isAlchemySet({ code: str(card, 'set'), name: str(card, 'set_name'), type: str(card, 'set_type') });
}

/** Printings of one card share an Oracle id; a printing without one stands alone under its name. */
function cardKey(card: GameplayCard): string {
  return str(card, 'oracle_id') ?? `name:${str(card, 'name') ?? ''}`;
}

export interface AlchemySplit {
  /** Every printing that is not Alchemy, in input order. */
  readonly kept: GameplayCard[];
  /** The names of the cards dropped whole: an Alchemy printing and no paper one. Sorted, distinct. */
  readonly alchemyNames: string[];
  /** How many printings were dropped (Alchemy printings, and digital printings of an Alchemy card). */
  readonly dropped: number;
}

/**
 * Drop every Alchemy printing, and every printing of a card that is Alchemy
 * (an Alchemy printing and no paper one: its other digital printings, such as
 * Oracle of the Alpha's in MKM's bonus sheet, go too).
 */
export function withoutAlchemy(cards: Iterable<GameplayCard>): AlchemySplit {
  const all = [...cards];
  const hasAlchemy = new Set<string>();
  const hasPaper = new Set<string>();
  for (const card of all) {
    const key = cardKey(card);
    if (isAlchemyPrinting(card)) hasAlchemy.add(key);
    else if (card['digital'] !== true) hasPaper.add(key);
  }
  const kept: GameplayCard[] = [];
  const names = new Set<string>();
  let dropped = 0;
  for (const card of all) {
    const key = cardKey(card);
    const alchemyCard = hasAlchemy.has(key) && !hasPaper.has(key);
    if (isAlchemyPrinting(card) || alchemyCard) {
      dropped++;
      const name = str(card, 'name');
      if (alchemyCard && name !== null) names.add(name);
      continue;
    }
    kept.push(card);
  }
  return { kept, alchemyNames: [...names].sort(), dropped };
}

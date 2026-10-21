/**
 * How a set of cards is put in order and grouped, wherever this app draws one:
 * the draft's picks and the deck builder (its pool's sorts and its deck's
 * piles) read the same groups, so a card sits under the same heading on both.
 *
 * Two groupings: by MANA VALUE (one pile per value up to `MV_CAP`, higher
 * values joining the last, lands after all of them) and by COLOUR (the five
 * colours, multicolour, colourless, lands). Within a group, the other key
 * orders the cards, then the name.
 */

import { colorSymbolOf, type ColorSymbolId } from '../components/ColorSymbol.tsx';
import type { DraftCard } from '../draft/types.ts';

/** The highest mana-value pile; higher mana values join it. */
export const MV_CAP = 6;

export const isLandFace = (card: DraftCard): boolean => /\bLand\b/.test(card.typeLine);
export const isCreatureFace = (card: DraftCard): boolean => /\bCreature\b/.test(card.typeLine);

export type ColorGroup = ColorSymbolId | 'L';
const COLOR_GROUPS: readonly ColorGroup[] = ['W', 'U', 'B', 'R', 'G', 'M', 'C', 'L'];

export function colorGroupOf(card: DraftCard): ColorGroup {
  return isLandFace(card) ? 'L' : colorSymbolOf(card.colors);
}
export const colorRank = (card: DraftCard): number => COLOR_GROUPS.indexOf(colorGroupOf(card));
export const typeRank = (card: DraftCard): number => (isCreatureFace(card) ? 0 : isLandFace(card) ? 2 : 1);

export type GroupBy = 'mv' | 'color';
/** A group's id: a mana value ('0'…'6', the last holding everything higher), or a colour group; 'L' is the lands either way. */
export type GroupId = string;

const MV_GROUPS: readonly GroupId[] = [...Array.from({ length: MV_CAP + 1 }, (_, mv) => String(mv)), 'L'];

export function groupOf(card: DraftCard, by: GroupBy): GroupId {
  if (by === 'color') return colorGroupOf(card);
  return isLandFace(card) ? 'L' : String(Math.min(MV_CAP, card.manaValue));
}

export function groupIds(by: GroupBy): readonly GroupId[] {
  return by === 'mv' ? MV_GROUPS : COLOR_GROUPS;
}

const byName = (a: DraftCard, b: DraftCard): number => a.name.localeCompare(b.name);
const byMv = (a: DraftCard, b: DraftCard): number => a.manaValue - b.manaValue;
const byColor = (a: DraftCard, b: DraftCard): number => colorRank(a) - colorRank(b);
const byType = (a: DraftCard, b: DraftCard): number => typeRank(a) - typeRank(b);

export type SortKey = 'mv' | 'color' | 'type';
const ORDER: Record<SortKey, ReadonlyArray<(a: DraftCard, b: DraftCard) => number>> = {
  mv: [byMv, byColor, byName],
  color: [byColor, byMv, byName],
  type: [byType, byMv, byColor, byName],
};

/** `items` in `key`'s order, each read through `face`. */
export function sortCards<T>(items: readonly T[], key: SortKey, face: (item: T) => DraftCard): T[] {
  return [...items].sort((a, b) => {
    for (const f of ORDER[key]) {
      const r = f(face(a), face(b));
      if (r !== 0) return r;
    }
    return 0;
  });
}

/**
 * `items` in `by`'s groups, in the groups' order, each sorted by the other
 * key. Empty groups are left out unless `keepEmpty` (the deck's piles keep
 * every mana value, so a pile has a place to land in).
 */
export function groupCards<T>(items: readonly T[], by: GroupBy, face: (item: T) => DraftCard, keepEmpty = false): Array<[GroupId, T[]]> {
  const groups = new Map<GroupId, T[]>(groupIds(by).map((id) => [id, []]));
  for (const item of sortCards(items, by === 'mv' ? 'color' : 'mv', face)) groups.get(groupOf(face(item), by))!.push(item);
  return [...groups].filter(([, cards]) => keepEmpty || cards.length > 0);
}

/*
 * A cube card's related cards — its back face, the tokens it makes, a meld
 * card's partner and result — from `related.json` (`scripts/art/build-related.ts`).
 * Each is an art id `cardImageUrl` resolves like any card's.
 */

import table from './related.json' with { type: 'json' };

export interface RelatedCard {
  id: string;
  name: string;
  kind: 'back' | 'token' | 'meld';
}

const CARDS = (table as { cards: Record<string, RelatedCard[]> }).cards;

/** What belongs with this card, back face first; empty for a card with none. */
export function relatedCards(scryfallId: string | undefined): readonly RelatedCard[] {
  return scryfallId === undefined ? [] : (CARDS[scryfallId] ?? []);
}

/** Every related card's art id, for warming. */
export function allRelatedIds(): string[] {
  return Object.values(CARDS).flatMap((list) => list.map((r) => r.id));
}

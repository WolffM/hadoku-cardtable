/*
 * A cube card's related cards — its back face, the tokens it makes, a meld
 * card's partner and result — from `related.json` (`scripts/art/build-related.ts`).
 * Each is an art id `cardImageUrl` resolves like any card's.
 */

import table from './related.json' with { type: 'json' };
import type { CardFace, DraftCard } from './types.ts';

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

/**
 * The card with its related cards among its faces, after the ones it carries, so the inspector's
 * wheel turns to its tokens and meld cards as it does to a back face. A related card is art and a
 * name only, so that is all its face holds.
 */
export function withRelatedFaces(card: DraftCard): DraftCard {
  const faces = card.faces ?? [];
  const known = new Set(faces.map((f) => f.scryfallId));
  const extra = relatedCards(card.scryfallId).filter((r) => !known.has(r.id));
  if (extra.length === 0) return card;
  const added = extra.map(
    (r): CardFace => ({
      scryfallId: r.id,
      name: r.name,
      manaCost: [],
      manaValue: 0,
      colors: [],
      typeLine: r.kind === 'token' ? 'Token' : '',
      oracleText: '',
      setCode: '',
      collectorNumber: '',
      rarity: 'common',
    }),
  );
  return { ...card, faces: [...faces, ...added] };
}

/** Every related card's art id, for warming. */
export function allRelatedIds(): string[] {
  return Object.values(CARDS).flatMap((list) => list.map((r) => r.id));
}

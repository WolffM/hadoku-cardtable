/*
 * A card's related cards — its back face, the tokens it makes, a meld card's
 * partner and result. The back face is the card's own (`DraftCard.faces`, a
 * board card's from Forge); the rest is `related.json`
 * (`scripts/art/build-related.ts`), every card Scryfall knows, by name. Each is
 * an art id `cardImageUrl` resolves like any card's.
 */

import { BACK_FACE } from '@hadoku/carddata/art';

import table from './related.json' with { type: 'json' };
import type { CardFace, DraftCard } from './types.ts';

export interface RelatedCard {
  id: string;
  name: string;
  kind: 'back' | 'token' | 'meld';
}

const { parts: PARTS, cards: CARDS } = table as unknown as { parts: [string, string, 'token' | 'meld'][]; cards: Record<string, number[]> };

/** The tokens and meld cards that come with a card named `name`, by its front face's name. */
function madeBy(name: string): RelatedCard[] {
  return (CARDS[name.split(' // ')[0]!] ?? []).map((i) => {
    const [id, partName, kind] = PARTS[i]!;
    return { id, name: partName, kind };
  });
}

/** What belongs with this card, back face first; empty for a card with none. */
export function relatedCards(card: Pick<DraftCard, 'name' | 'faces'>): readonly RelatedCard[] {
  const backs = (card.faces ?? []).flatMap((f) => (f.scryfallId?.endsWith(BACK_FACE) ? [{ id: f.scryfallId, name: f.name, kind: 'back' as const }] : []));
  const known = new Set(backs.map((b) => b.name));
  return [...backs, ...madeBy(card.name).filter((r) => !known.has(r.name))];
}

/**
 * The card with its tokens and meld cards among its faces, after the ones it carries, so the
 * inspector's wheel turns to them as it does to a back face. A related card is art and a name only,
 * so that is all its face holds.
 */
export function withRelatedFaces(card: DraftCard): DraftCard {
  const faces = card.faces ?? [];
  // By id and by name: a board card's back face is Forge's, under its own id.
  const known = new Set([card.name, ...faces.flatMap((f) => [f.scryfallId, f.name])]);
  const extra = madeBy(card.name).filter((r) => !known.has(r.id) && !known.has(r.name));
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

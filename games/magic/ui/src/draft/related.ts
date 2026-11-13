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
  /** Its art id; absent for a token nothing prints (Jungle Patrol's Wood), drawn by its words alone. */
  id?: string;
  name: string;
  kind: 'back' | 'token' | 'meld';
  /** The card as a face: art id, name, and a token's type, P/T, colours and text where Forge's script gives them. */
  face: CardFace;
}

interface Part {
  id?: string;
  name: string;
  kind: 'token' | 'meld';
  typeLine?: string;
  pt?: string;
  colors?: CardFace['colors'];
  text?: string;
}

const { parts: PARTS, cards: CARDS } = table as unknown as { parts: Part[]; cards: Record<string, number[]> };

/** A related card as a face of the card it comes with. */
function faceOf(p: Part): CardFace {
  const [power, toughness] = p.pt?.split('/') ?? [];
  return {
    ...(p.id === undefined ? {} : { scryfallId: p.id }),
    name: p.name,
    manaCost: [],
    manaValue: 0,
    colors: p.colors ?? [],
    typeLine: p.typeLine ?? (p.kind === 'token' ? 'Token' : ''),
    oracleText: p.text ?? '',
    ...(power === undefined || toughness === undefined ? {} : { power, toughness }),
    setCode: '',
    collectorNumber: '',
    rarity: 'common',
  };
}

/** The tokens and meld cards that come with a card named `name`, by its front face's name. */
function madeBy(name: string): RelatedCard[] {
  return (CARDS[name.split(' // ')[0]!] ?? []).map((i) => {
    const p = PARTS[i]!;
    return { ...(p.id === undefined ? {} : { id: p.id }), name: p.name, kind: p.kind, face: faceOf(p) };
  });
}

/** What belongs with this card, back face first; empty for a card with none. */
export function relatedCards(card: Pick<DraftCard, 'name' | 'faces'>): readonly RelatedCard[] {
  const backs = (card.faces ?? []).flatMap((f) => (f.scryfallId?.endsWith(BACK_FACE) ? [{ id: f.scryfallId, name: f.name, kind: 'back' as const, face: f }] : []));
  const known = new Set(backs.map((b) => b.name));
  return [...backs, ...madeBy(card.name).filter((r) => !known.has(r.name))];
}

/**
 * The card with its tokens and meld cards among its faces, after the ones it carries, so the
 * inspector's wheel turns to them as it does to a back face.
 */
export function withRelatedFaces(card: DraftCard): DraftCard {
  const faces = card.faces ?? [];
  // By id and by name: a board card's back face is Forge's, under its own id.
  const known = new Set([card.name, ...faces.flatMap((f) => [f.scryfallId, f.name])]);
  const extra = madeBy(card.name).filter((r) => !(r.id !== undefined && known.has(r.id)) && !known.has(r.name));
  return extra.length === 0 ? card : { ...card, faces: [...faces, ...extra.map((r) => r.face)] };
}

/*
 * The related cards of the fan's card under the pointer, in a row just under it
 * (the operator, 2026-10-19: *"when hovering a transform card in fan mode, let's
 * show all the related cards below it in a line"*, *"tokens and meld results
 * too"*, and *"it should happen on hover not persistently show with the
 * selected card"*). Drawn
 * only once every one of their images has settled — a row that fills in a card
 * at a time is the flash the operator asked never to see — and only the ones
 * that decoded: a related card has no text tile to fall back on. Never in the
 * way: the picks under it still take the pointer.
 */

import { useEffect, useState, type CSSProperties } from 'react';

import { cardImageUrl } from '../draft/cardImage.ts';
import type { RelatedCard } from '../draft/related.ts';

/** Whether `url` loads and decodes; no `Image` that can decode (a non-DOM test) is a no. */
function decodes(url: string | null): Promise<boolean> {
  if (url === null || typeof Image === 'undefined' || typeof Image.prototype.decode !== 'function') return Promise.resolve(false);
  const img = new Image();
  img.src = url;
  return img.decode().then(
    () => true,
    () => false,
  );
}

export function RelatedRow({ cards, style }: { cards: readonly RelatedCard[]; style: CSSProperties }) {
  const key = cards.map((c) => c.id).join('|');
  const [drawn, setDrawn] = useState<{ key: string; cards: { card: RelatedCard; url: string }[] } | null>(null);
  useEffect(() => {
    let live = true;
    const list = cards.map((card) => ({ card, url: cardImageUrl(card.id) }));
    void Promise.all(list.map((c) => decodes(c.url))).then((ok) => {
      if (live) setDrawn({ key, cards: list.flatMap((c, i) => (ok[i] && c.url !== null ? [{ card: c.card, url: c.url }] : [])) });
    });
    return () => {
      live = false;
    };
    // `key` names the cards; the array itself is a fresh one each render.
  }, [key]);
  if (drawn === null || drawn.key !== key || drawn.cards.length === 0) return null;
  return (
    <div className="pack__related" data-testid="pack-related" style={style}>
      {drawn.cards.map(({ card, url }) => (
        <img key={card.id} className="pack__related-card" src={url} alt={card.name} title={card.name} data-kind={card.kind} draggable={false} />
      ))}
    </div>
  );
}

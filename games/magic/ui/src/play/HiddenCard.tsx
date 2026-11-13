import type { DraftCard } from '@hadoku/shared';

/**
 * A card this seat may not see (`BoardCard.hidden`, the stack's `StackEntry.sourceHidden`): its back
 * (`card.css`), at the card's own size. It is a `.card` so the inspector enlarges it like any face,
 * and it carries the tile's own id the same way. One drawing for every place a hidden card stands —
 * a zone and the stack alike.
 */
export function HiddenCard({ card }: { card: DraftCard }) {
  return <span className="card card-back" data-card-id={card.cardId} data-card-back="" role="img" aria-label={card.name} />;
}

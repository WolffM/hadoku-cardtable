/**
 * The pack, fanned for picking.
 *
 * The fan is a real fan: each card is rotated about a pivot below the row and
 * offset along an arc, so fifteen cards occupy roughly the width of six and the
 * leading edge of every one stays visible. Hovering or focusing a card lifts it
 * clear. That is the whole reason a draft interface fans rather than grids —
 * you are comparing fifteen things you can only pick one of.
 *
 * It is also unreadable on a narrow screen and awkward for a keyboard, so
 * "fan"/"grid" is a control rather than a breakpoint, and the grid is what the
 * tests read. Both render the same `CardTile`s in the same order.
 *
 * ## The shared inspector, without teaching it a second vocabulary
 *
 * Each slot carries a synthetic `data-card-id="w<n>"` of its own, matching
 * `play/inspect/index.ts`'s `TILE_ID` so hovering opens the same enlarged view
 * the board uses — that module may not be edited to recognise a drafted card's
 * real id (`c0`, `c1`, …), so the wrapper carries the convention and the
 * `CardTile` inside keeps its real one, which `onPick` and every test still
 * read. See `PoolView.tsx`'s header for the fuller version of this; `PodScreen`
 * is what mounts the inspector.
 */

import type { CSSProperties } from 'react';

import type { DraftCard } from '../draft/types.ts';
import { CardTile } from './CardTile.tsx';

export type PackLayout = 'fan' | 'grid';

export interface PackViewProps {
  cards: readonly DraftCard[];
  layout: PackLayout;
  onPick: (cardId: string) => void;
  disabled: boolean;
  /** Shown instead of the cards when there is nothing to pick from. */
  emptyNote: string;
}

/**
 * Where card `i` of `count` sits in the fan.
 *
 * Each slot is absolutely positioned at the container's centre line and then
 * pushed sideways and rotated, with the CSS `transform-origin` well below the
 * card so the rotation alone produces the arc. An explicit vertical offset on
 * top of that was the first attempt and it double-counted: the outer cards
 * dropped far enough to sit on top of the pool below.
 *
 * `STEP` is the visible sliver of each card. It is a constant rather than a
 * fraction of the container because the sliver has a job — it must show the
 * name — and that job does not get easier on a narrow screen. When the fan no
 * longer fits, the stylesheet falls back to the grid rather than squeezing it.
 */
const STEP = 56; // px between adjacent cards — the visible sliver
const MAX_SPREAD = 28; // total degrees across the whole fan

function fanStyle(i: number, count: number): CSSProperties {
  const spread = count <= 1 ? 0 : Math.min(MAX_SPREAD, count * 2.6);
  const angle = count <= 1 ? 0 : -spread / 2 + (i * spread) / (count - 1);
  const x = (i - (count - 1) / 2) * STEP;
  // Position goes out as custom properties, not as `transform`, so the
  // stylesheet keeps ownership of the transform: an inline transform would beat
  // the `:hover` rule and the lift would silently stop working.
  return {
    '--fan-x': `${x.toFixed(1)}px`,
    '--fan-a': `${angle.toFixed(2)}deg`,
    zIndex: i,
  } as CSSProperties;
}

export function PackView({ cards, layout, onPick, disabled, emptyNote }: PackViewProps) {
  if (cards.length === 0) {
    return (
      <div className="pack pack--empty" data-testid="pack">
        <p className="pack__note">{emptyNote}</p>
      </div>
    );
  }

  return (
    <div className={`pack pack--${layout}`} data-testid="pack" data-card-count={cards.length}>
      {cards.map((card, i) => (
        <div
          key={card.cardId}
          className="pack__slot"
          data-card-id={`w${i}`}
          style={layout === 'fan' ? fanStyle(i, cards.length) : undefined}
        >
          <CardTile card={card} onPick={onPick} disabled={disabled} pickRole="ui.draft-pick" />
        </div>
      ))}
    </div>
  );
}

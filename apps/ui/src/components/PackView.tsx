/**
 * The pack, fanned for picking.
 *
 * The fan is a real fan: each card is rotated about a pivot below the row and
 * offset along an arc, so fifteen cards occupy roughly the width of six and the
 * leading edge of every one stays visible. Hovering or focusing a card lifts it
 * clear. That is the whole reason a draft interface fans rather than grids —
 * you are comparing fifteen things you can only pick one of.
 *
 * The fan is measured, not guessed: `fanGeometry` sizes it to the box it is
 * drawn in (the top half of the draft), so it never spills sideways. Below
 * `FAN_MIN_WIDTH` it draws the grid. "fan"/"grid" is still a control, the grid
 * is what the tests read, and both render the same `CardTile`s in order.
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

import { useCallback, useRef, useState, type CSSProperties } from 'react';

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

/** A Magic card's width over its height (488 x 680). */
const CARD_RATIO = 488 / 680;
/** Room above the cards for the hover lift, and below for the arc's drop. */
const LIFT = 30;
const BOTTOM = 10;
/** The arc's drop at the ends, as a share of the card's height. */
const DROP = 0.06;
/** The visible share of each card: never less than a name's worth, never so much the cards stop overlapping. */
const MIN_SHOW = 0.17;
const MAX_SHOW = 0.62;
/** The largest a fanned card is drawn, however much room there is. */
const MAX_CARD_H = 400;
/** Below this width there is no readable fan: the grid. */
export const FAN_MIN_WIDTH = 480;

export interface FanGeometry {
  cardW: number;
  cardH: number;
  slots: { x: number; y: number; angle: number }[];
}

/**
 * The fan that fits a `width` x `height` box: the card as tall as the box
 * allows, each card offset from the next by as much as the width allows, and
 * every card's corners inside the box — the outermost card's rotation
 * included. The earlier fan stepped a fixed 56 px and rotated each card about
 * a point far below it, which swung the ends ~100 px further out: fifteen
 * cards drew ~1200 px wide in a ~650 px column, over the pool and off the
 * page.
 */
export function fanGeometry(count: number, width: number, height: number): FanGeometry {
  const mid = (count - 1) / 2;
  const maxAngle = count <= 1 ? 0 : Math.min(9, count * 0.6);
  const sin = Math.sin((maxAngle * Math.PI) / 180);
  // Tall as the box allows: the arc's drop and a tilted card's lower corner
  // (half its width times the tilt) both come out of the height.
  let cardH = Math.min(MAX_CARD_H, (height - LIFT - BOTTOM) / (1 + DROP + (CARD_RATIO / 2) * sin));
  let cardW = cardH * CARD_RATIO;
  let step = count <= 1 ? 0 : Math.min(cardW * MAX_SHOW, (width - cardW - 2 * cardH * sin) / (count - 1));
  if (count > 1 && step < cardW * MIN_SHOW) {
    // Not enough width for the tallest card: the card shrinks until it fits.
    cardW = width / (1 + MIN_SHOW * (count - 1) + (2 * sin) / CARD_RATIO);
    cardH = cardW / CARD_RATIO;
    step = cardW * MIN_SHOW;
  }
  const slots = Array.from({ length: count }, (_, i) => {
    const t = mid === 0 ? 0 : (i - mid) / mid;
    return { x: (i - mid) * step, y: t * t * cardH * DROP, angle: t * maxAngle };
  });
  return { cardW, cardH, slots };
}

/** The box the pack draws in, kept current. Zero until it has been measured. */
function useBox(): [(el: HTMLDivElement | null) => void, { width: number; height: number }] {
  const [box, setBox] = useState({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      const r = el.getBoundingClientRect();
      setBox((was) => (was.width === r.width && was.height === r.height ? was : { width: r.width, height: r.height }));
    };
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
    measure();
  }, []);
  return [ref, box];
}

export function PackView({ cards, layout, onPick, disabled, emptyNote }: PackViewProps) {
  const [measure, box] = useBox();
  if (cards.length === 0) {
    return (
      <div className="pack pack--empty" data-testid="pack" ref={measure}>
        <p className="pack__note">{emptyNote}</p>
      </div>
    );
  }

  // Unmeasured (the first frame, or a test environment) draws the grid: a fan
  // drawn at a guessed size is the overflow this replaced.
  const fan = layout === 'fan' && box.width >= FAN_MIN_WIDTH && box.height > 0 ? fanGeometry(cards.length, box.width, box.height) : null;
  const style = fan === null ? undefined : ({ '--fan-w': `${fan.cardW.toFixed(1)}px`, '--fan-h': `${fan.cardH.toFixed(1)}px` } as CSSProperties);

  return (
    <div className={`pack pack--${fan === null ? 'grid' : 'fan'}`} data-testid="pack" data-layout={layout} data-card-count={cards.length} ref={measure} style={style}>
      {cards.map((card, i) => {
        const slot = fan?.slots[i];
        return (
          <div
            key={card.cardId}
            className="pack__slot"
            data-card-id={`w${i}`}
            style={
              slot === undefined
                ? undefined
                : // Position goes out as custom properties, not as `transform`, so the
                  // stylesheet keeps ownership of the transform: an inline transform
                  // would beat the `:hover` rule and the lift would stop working.
                  ({ '--fan-x': `${slot.x.toFixed(1)}px`, '--fan-y': `${slot.y.toFixed(1)}px`, '--fan-a': `${slot.angle.toFixed(2)}deg`, zIndex: i } as CSSProperties)
            }
          >
            <CardTile card={card} onPick={onPick} disabled={disabled} pickRole="ui.draft-pick" />
          </div>
        );
      })}
    </div>
  );
}

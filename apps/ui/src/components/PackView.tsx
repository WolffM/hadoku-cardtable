/**
 * The pack, fanned for picking.
 *
 * The fan is an overlapped row: fifteen cards in the width of a few, the left
 * strip of every one showing. The card under the pointer (by its x, see
 * `fanFocusAt`) opens: its neighbours slide apart so it shows whole and rises.
 * That is the reason a draft fans rather than grids — you are comparing
 * fifteen things you can only pick one of.
 *
 * Both layouts are measured, not guessed: `fanGeometry` and `gridGeometry` size
 * the cards to the box they are drawn in, so neither spills nor scrolls. Below
 * `FAN_MIN_WIDTH` the fan draws the grid. "fan"/"grid" is still a control, the
 * grid is what the tests read, and both render the same `CardTile`s in order.
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

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

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
/** Room above the row for the focused card's rise, and below it. */
const LIFT = 22;
const BOTTOM = 8;
/** The visible share of each card: never less than a name's worth, never so much the cards stop overlapping. */
const MIN_SHOW = 0.17;
const MAX_SHOW = 0.62;
/** The largest a card is drawn, however much room there is. */
const MAX_CARD_H = 420;
/** Below this width there is no readable fan: the grid. */
export const FAN_MIN_WIDTH = 480;
const GRID_GAP = 10;

export interface FanGeometry {
  cardW: number;
  cardH: number;
  /** Centre to centre, unfocused. */
  step: number;
  /** Each card's centre, unfocused, from the box's centre line. */
  xs: number[];
}

/**
 * The fan that fits a `width` x `height` box: a straight row, overlapped, each
 * card showing its left strip, the card as tall as the box allows.
 *
 * The width reserves one card's worth of opening for the focused card (see
 * `fanSlots`), so the row never spills even with a card pulled open. An earlier
 * fan tilted each card about a point below it: the ends swung outward, the
 * corners of the cards behind poked above the ones in front, and the hovered
 * card, popped to the front, covered the next card's strip, so moving right
 * dragged across a whole card before anything changed.
 */
export function fanGeometry(count: number, width: number, height: number): FanGeometry {
  let cardH = Math.min(MAX_CARD_H, height - LIFT - BOTTOM);
  let cardW = cardH * CARD_RATIO;
  // The row with one gap opened: (count - 2) steps, plus two whole cards.
  const room = (w: number): number => (count <= 2 ? MAX_SHOW * w : (width - 2 * w) / (count - 2));
  let step = count <= 1 ? 0 : Math.min(cardW * MAX_SHOW, room(cardW));
  if (count > 1 && step < cardW * MIN_SHOW) {
    // Not enough width for the tallest card: the card shrinks until it fits.
    cardW = width / (2 + MIN_SHOW * Math.max(0, count - 2));
    cardH = cardW / CARD_RATIO;
    step = cardW * MIN_SHOW;
  }
  const mid = (count - 1) / 2;
  return { cardW, cardH, step, xs: Array.from({ length: count }, (_, i) => (i - mid) * step) };
}

/**
 * Each card's centre with `focus` pulled open: everything up to and including
 * it moves left half the hidden part of a card, everything after moves right
 * half, so the focused card shows whole and the row stays centred.
 */
export function fanSlots(geo: FanGeometry, focus: number | null): number[] {
  if (focus === null) return geo.xs;
  const open = Math.max(0, geo.cardW - geo.step) / 2;
  return geo.xs.map((x, i) => (i <= focus ? x - open : x + open));
}

/**
 * Which card the pointer is on, from its x across the box: the row cut into
 * one equal band per visible strip, measured on the UNFOCUSED row so opening a
 * card never moves the bands under the pointer. One band either way is one
 * card either way, left or right alike.
 */
export function fanFocusAt(geo: FanGeometry, x: number, width: number): number {
  const count = geo.xs.length;
  if (count <= 1) return 0;
  const left = width / 2 + geo.xs[0]! - geo.cardW / 2;
  return Math.max(0, Math.min(count - 1, Math.floor((x - left) / geo.step)));
}

/**
 * The grid that shows a whole pack in the box without scrolling: the column
 * count that makes the cards largest.
 */
export function gridGeometry(count: number, width: number, height: number): { cols: number; cardW: number } {
  let best = { cols: 1, cardW: 0 };
  for (let cols = 1; cols <= Math.max(1, count); cols++) {
    const rows = Math.ceil(count / cols);
    const byWidth = (width - (cols - 1) * GRID_GAP) / cols;
    const byHeight = ((height - (rows - 1) * GRID_GAP) / rows) * CARD_RATIO;
    const cardW = Math.min(byWidth, byHeight, MAX_CARD_H * CARD_RATIO);
    if (cardW > best.cardW) best = { cols, cardW };
  }
  return best;
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
  const [focus, setFocus] = useState<number | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      root.current = el;
      measure(el);
    },
    [measure],
  );
  // Unmeasured (the first frame, or a test environment) draws the plain grid: a
  // layout drawn at a guessed size is the overflow this replaced.
  const measured = box.width > 0 && box.height > 0;
  const fan = layout === 'fan' && measured && box.width >= FAN_MIN_WIDTH ? fanGeometry(cards.length, box.width, box.height) : null;
  const grid = fan === null && measured ? gridGeometry(cards.length, box.width, box.height) : null;
  const shown = fan === null || focus === null ? null : Math.min(focus, cards.length - 1);
  const xs = fan === null ? null : fanSlots(fan, shown);

  // The shared inspector opens on `pointerover`, which a browser sends when the
  // POINTER moves onto a card — not when the cards slide under a still pointer,
  // which is how the fan changes cards. So the focused card says it is hovered,
  // or the inspector keeps showing the card the pointer arrived on.
  useEffect(() => {
    if (shown === null || typeof PointerEvent === 'undefined') return;
    const card = root.current?.querySelector('.pack__slot[data-focused] [data-testid="card"]');
    card?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
  }, [shown]);

  if (cards.length === 0) {
    return (
      <div className="pack pack--empty" data-testid="pack" ref={attach}>
        <p className="pack__note">{emptyNote}</p>
      </div>
    );
  }

  const style =
    fan !== null
      ? ({ '--fan-w': `${fan.cardW.toFixed(1)}px`, '--fan-h': `${fan.cardH.toFixed(1)}px` } as CSSProperties)
      : grid !== null
        ? ({ '--grid-w': `${grid.cardW.toFixed(1)}px`, gridTemplateColumns: `repeat(${grid.cols}, var(--grid-w))` } as CSSProperties)
        : undefined;

  return (
    <div
      className={`pack pack--${fan === null ? 'grid' : 'fan'}`}
      data-testid="pack"
      data-layout={layout}
      data-card-count={cards.length}
      ref={attach}
      style={style}
      onPointerMove={fan === null ? undefined : (e) => setFocus(fanFocusAt(fan, e.clientX - e.currentTarget.getBoundingClientRect().left, box.width))}
      onPointerLeave={fan === null ? undefined : () => setFocus(null)}
    >
      {cards.map((card, i) => (
        <div
          key={card.cardId}
          className="pack__slot"
          data-card-id={`w${i}`}
          data-focused={shown === i ? '' : undefined}
          onFocus={fan === null ? undefined : () => setFocus(i)}
          style={
            xs === null
              ? undefined
              : // Position goes out as a custom property, not as `transform`, so the
                // stylesheet keeps ownership of the transform (the focused rise).
                ({ '--fan-x': `${xs[i]!.toFixed(1)}px`, zIndex: i } as CSSProperties)
          }
        >
          <CardTile card={card} onPick={onPick} disabled={disabled} pickRole="ui.draft-pick" />
        </div>
      ))}
    </div>
  );
}

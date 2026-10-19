/**
 * The pack, fanned for picking.
 *
 * The fan is an overlapped row: fifteen cards in the width of a few. One card
 * is open — on top, whole, risen: the middle one when a pack arrives, then the
 * card under the pointer (by its x, see `fanFocusAt`), or the next one along
 * with each notch of the wheel. Every other card shows the strip on its far
 * side; no card ever moves (`fanGeometry`).
 * That is the reason a draft fans rather than grids — you are comparing
 * fifteen things you can only pick one of.
 *
 * Both layouts are measured, not guessed: `fanGeometry` and `gridGeometry` size
 * the cards to the box they are drawn in, so neither spills nor scrolls. Below
 * `FAN_MIN_WIDTH` the fan draws the grid. "fan"/"grid" is still a control, the
 * grid is what the tests read, and both render the same `CardTile`s in order.
 *
 * ## The shared inspector, in the grid only
 *
 * The fan's open card is already full size, so an enlarged copy beside it is a
 * duplicate (the operator, 2026-10-19: *"i dont need the hover expand anymore"*):
 * only the grid's fitted tiles open the inspector. In the grid each slot carries
 * a synthetic `data-card-id="w<n>"` of its own, matching
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
/** Room above the row for the open card's rise, and below it. */
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
  /** Centre to centre. */
  step: number;
  /** Each card's centre from the box's centre line. Fixed: opening a card moves nothing. */
  xs: number[];
}

/**
 * The fan that fits a `width` x `height` box: a straight row of fixed places,
 * the card as tall as the box allows, each a step from the next.
 *
 * Opening a card moves no card — only the stacking changes (`fanLayer`): the
 * open card on top, the cards to its left under it from the left, the cards
 * to its right under it from the right. So the open card shows whole wherever
 * it is, the middle one sits in the middle, and every other card shows the
 * strip on its far side. The earlier fans either tilted each card about a
 * point below it (the ends swung out; corners poked above the card in front)
 * or slid the row apart to open a card (the open card sat off-centre, and the
 * row moved under the pointer).
 */
export function fanGeometry(count: number, width: number, height: number): FanGeometry {
  let cardH = Math.min(MAX_CARD_H, height - LIFT - BOTTOM);
  let cardW = cardH * CARD_RATIO;
  let step = count <= 1 ? 0 : Math.min(cardW * MAX_SHOW, (width - cardW) / (count - 1));
  if (count > 1 && step < cardW * MIN_SHOW) {
    // Not enough width for the tallest card: the card shrinks until it fits.
    cardW = width / (1 + MIN_SHOW * (count - 1));
    cardH = cardW / CARD_RATIO;
    step = cardW * MIN_SHOW;
  }
  const mid = (count - 1) / 2;
  return { cardW, cardH, step, xs: Array.from({ length: count }, (_, i) => (i - mid) * step) };
}

/** Card `i`'s stacking with `open` on top: the further from the open card, the lower. */
export function fanLayer(i: number, open: number, count: number): number {
  return count - Math.abs(i - open);
}

/**
 * Which card the pointer is on, from its x across the box: the card whose
 * place is nearest. Every place is one step from the next, so one step either
 * way is one card either way, left or right alike — and since places never
 * move, opening a card never moves the bands under the pointer.
 */
export function fanFocusAt(geo: FanGeometry, x: number, width: number): number {
  const count = geo.xs.length;
  if (count <= 1) return 0;
  return Math.max(0, Math.min(count - 1, Math.round((x - width / 2) / geo.step + (count - 1) / 2)));
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

/** Trackpad travel per card; any single wheel event this big is one mouse notch, one card. */
const WHEEL_STEP = 60;
/** How far the pointer moves after a wheel before it takes focus back. */
const POINTER_SLOP = 6;

export function PackView({ cards, layout, onPick, disabled, emptyNote }: PackViewProps) {
  const [measure, box] = useBox();
  /** The open card. `null` is the middle one: where a pack opens. */
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
  const shown = fan === null || cards.length === 0 ? null : Math.min(focus ?? Math.floor((cards.length - 1) / 2), cards.length - 1);

  // A new pack opens on its middle card.
  const packKey = cards.map((c) => c.cardId).join(',');
  useEffect(() => setFocus(null), [packKey]);

  /** Where the pointer was when the wheel last moved the focus; it takes focus back once it moves on. */
  const wheeledAt = useRef<{ x: number; y: number } | null>(null);

  // The wheel steps through the row: one notch, one card. Not React's onWheel,
  // which is passive and cannot stop the page under the pack scrolling instead.
  const fanOn = fan !== null;
  const count = cards.length;
  const wheelLeft = useRef(0);
  useEffect(() => {
    const el = root.current;
    if (!fanOn || el === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      let steps: number;
      if (Math.abs(delta) >= WHEEL_STEP || event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
        // A mouse wheel's notch arrives as one big event (100 px in one browser,
        // 120 or 3 lines in another): one notch is one card, whatever its size.
        steps = Math.sign(delta);
        wheelLeft.current = 0;
      } else {
        // A trackpad sends a stream of small ones: they add up.
        wheelLeft.current += delta;
        steps = Math.trunc(wheelLeft.current / WHEEL_STEP);
        wheelLeft.current -= steps * WHEEL_STEP;
      }
      if (steps === 0) return;
      wheeledAt.current = { x: event.clientX, y: event.clientY };
      setFocus((was) => Math.max(0, Math.min(count - 1, (was ?? Math.floor((count - 1) / 2)) + steps)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [fanOn, count]);

  // A click on a card that is not the open one opens it rather than picking it:
  // after the wheel the card under a still pointer need not be the open one, and
  // a pick is not undoable. Hover-then-click is still one click. Stable, because
  // `CardTile` is memoised on this prop.
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const pick = useCallback(
    (cardId: string) => {
      const at = cardsRef.current.findIndex((c) => c.cardId === cardId);
      if (shownRef.current !== null && at !== shownRef.current) setFocus(at);
      else onPick(cardId);
    },
    [onPick],
  );

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
      onPointerMove={
        fan === null
          ? undefined
          : (e) => {
              const w = wheeledAt.current;
              if (w !== null && Math.hypot(e.clientX - w.x, e.clientY - w.y) < POINTER_SLOP) return;
              wheeledAt.current = null;
              setFocus(fanFocusAt(fan, e.clientX - e.currentTarget.getBoundingClientRect().left, box.width));
            }
      }
    >
      {cards.map((card, i) => (
        <div
          key={card.cardId}
          className="pack__slot"
          data-card-id={fan === null ? `w${i}` : undefined}
          data-focused={shown === i ? '' : undefined}
          onFocus={fan === null ? undefined : () => setFocus(i)}
          style={
            fan === null || shown === null
              ? undefined
              : // Position goes out as a custom property, not as `transform`, so the
                // stylesheet keeps ownership of the transform (the open card's rise).
                ({ '--fan-x': `${fan.xs[i]!.toFixed(1)}px`, zIndex: fanLayer(i, shown, cards.length) } as CSSProperties)
          }
        >
          <CardTile card={card} onPick={fan === null ? onPick : pick} disabled={disabled} pickRole="ui.draft-pick" />
        </div>
      ))}
    </div>
  );
}

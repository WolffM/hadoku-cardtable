/**
 * The pack, fanned for picking.
 *
 * The fan is a short overlapped row scrolled through the pack: the open card —
 * on top, whole, risen, in the middle — and `FAN_SIDE` cards either side of it;
 * the rest are not drawn until the row is scrolled to them (the operator,
 * 2026-10-19: *"let's not display the entire stack all at once and instead hide
 * cards until they are scrolled to"*). The wheel and the arrow keys move the
 * open card one along, and the row slides with it. The pointer opens nothing by
 * passing over a card — that was too easy to misclick: a card that is not open
 * opens on a click, and is picked on the next. Enter picks the open card, or in
 * the grid the card under the pointer.
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
import { playRole } from '../sound/index.ts';
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
/** How many cards are drawn either side of the open one. */
export const FAN_SIDE = 3;
/** The row's places: the open card in the middle, `FAN_SIDE` either side. */
const FAN_SLOTS = 2 * FAN_SIDE + 1;
const GRID_GAP = 10;

export interface FanGeometry {
  cardW: number;
  cardH: number;
  /** Centre to centre. */
  step: number;
}

/**
 * The row that fits a `width` x `height` box: `FAN_SLOTS` places, the card as
 * tall as the box allows, each a step from the next. The open card is the
 * middle place whichever card it is, so the row is the same size for any pack.
 */
export function fanGeometry(width: number, height: number): FanGeometry {
  let cardH = Math.min(MAX_CARD_H, height - LIFT - BOTTOM);
  let cardW = cardH * CARD_RATIO;
  let step = Math.min(cardW * MAX_SHOW, (width - cardW) / (FAN_SLOTS - 1));
  if (step < cardW * MIN_SHOW) {
    // Not enough width for the tallest card: the card shrinks until it fits.
    cardW = width / (1 + MIN_SHOW * (FAN_SLOTS - 1));
    cardH = cardW / CARD_RATIO;
    step = cardW * MIN_SHOW;
  }
  return { cardW, cardH, step };
}

/** Card `i`'s place with `open` open: off the centre line by its distance from the open card, or not drawn past `FAN_SIDE`. */
export function fanX(geo: FanGeometry, i: number, open: number): number | null {
  return Math.abs(i - open) > FAN_SIDE ? null : (i - open) * geo.step;
}

/** Card `i`'s stacking with `open` on top: the further from the open card, the lower. */
export function fanLayer(i: number, open: number, count: number): number {
  return count - Math.abs(i - open);
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

/** A key pressed while typing somewhere is the field's, not the pack's. */
function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

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
  const fan = layout === 'fan' && measured && box.width >= FAN_MIN_WIDTH ? fanGeometry(box.width, box.height) : null;
  const grid = fan === null && measured ? gridGeometry(cards.length, box.width, box.height) : null;
  const shown = fan === null || cards.length === 0 ? null : Math.min(focus ?? Math.floor((cards.length - 1) / 2), cards.length - 1);

  // A new pack opens on its middle card.
  const packKey = cards.map((c) => c.cardId).join(',');
  useEffect(() => setFocus(null), [packKey]);

  // The fan's scroll sound (`ui.draft-scroll`, the operator, 2026-10-19: "need a
  // sound for when scrolling through a pack in 'fan' mode"): each step of the
  // open card along the same pack, however it moved. A new pack, its reset to
  // the middle, or the fan appearing, is not a step: only a card someone opened.
  const lastShown = useRef<{ pack: string; at: number } | null>(null);
  useEffect(() => {
    const was = lastShown.current;
    lastShown.current = shown === null ? null : { pack: packKey, at: shown };
    if (focus !== null && shown !== null && was !== null && was.pack === packKey && was.at !== shown) playRole('ui.draft-scroll');
  }, [focus, shown, packKey]);

  /** The grid's card under the pointer: what Enter picks there. */
  const [hovered, setHovered] = useState<number | null>(null);
  useEffect(() => setHovered(null), [packKey]);

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
  // The tile stays silent in the fan, so opening a card never sounds like taking it.
  const pick = useCallback(
    (cardId: string) => {
      const at = cardsRef.current.findIndex((c) => c.cardId === cardId);
      if (shownRef.current !== null && at !== shownRef.current) setFocus(at);
      else {
        playRole('ui.draft-pick');
        onPick(cardId);
      }
    },
    [onPick],
  );

  // Enter picks the open card (the grid: the one under the pointer); the arrows move along the row.
  const highlighted = fan === null ? hovered : shown;
  const highlightedRef = useRef(highlighted);
  highlightedRef.current = highlighted;
  useEffect(() => {
    if (disabled || count === 0) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || typing(event.target)) return;
      if (event.key === 'Enter') {
        const at = highlightedRef.current;
        const card = at === null ? undefined : cardsRef.current[at];
        if (card === undefined) return;
        event.preventDefault();
        onPick(card.cardId);
      } else if (fanOn && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        const by = event.key === 'ArrowLeft' ? -1 : 1;
        setFocus((was) => Math.max(0, Math.min(count - 1, (was ?? Math.floor((count - 1) / 2)) + by)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [disabled, count, fanOn, onPick]);

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
      onPointerLeave={fan === null ? () => setHovered(null) : undefined}
    >
      {cards.map((card, i) => {
        const x = fan === null || shown === null ? null : fanX(fan, i, shown);
        const off = fan !== null && x === null;
        return (
          <div
            key={card.cardId}
            className="pack__slot"
            data-card-id={fan === null ? `w${i}` : undefined}
            data-focused={shown === i ? '' : undefined}
            data-off={off ? '' : undefined}
            onFocus={fan === null || off ? undefined : () => setFocus(i)}
            onPointerEnter={fan === null ? () => setHovered(i) : undefined}
            style={
              x === null || shown === null
                ? undefined
                : // Position goes out as a custom property, not as `transform`, so the
                  // stylesheet keeps ownership of the transform (the open card's rise).
                  ({ '--fan-x': `${x.toFixed(1)}px`, zIndex: fanLayer(i, shown, cards.length) } as CSSProperties)
            }
          >
            <CardTile card={card} onPick={fan === null ? onPick : pick} disabled={disabled} pickRole={fan === null ? 'ui.draft-pick' : null} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * The pack, fanned for picking.
 *
 * The fan is a short overlapped row scrolled through the pack: seven cards, the
 * open one on top, whole and risen. A pack opens on its first card; the open
 * card sits in the middle of the row once it can, and the row stops at the
 * pack's ends (`fanStart`); the rest are not drawn until the row is scrolled to them (the operator,
 * 2026-10-19: *"let's not display the entire stack all at once and instead hide
 * cards until they are scrolled to"*). The wheel and the arrow keys move the
 * open card one along, and the row slides with it. The pointer opens nothing by
 * passing over a card — that was too easy to misclick: a card that is not open
 * opens on a click, and is picked on the next. Enter picks the open card. The
 * grid has a cursor of its own: the arrow keys move it a card along or a row up
 * and down, the pointer moves it to the card it is over, and Enter picks it.
 *
 * Both layouts are measured, not guessed: `fanGeometry` and `cardFit.ts`'s
 * `fitGrid` size the cards to the box they are drawn in, so neither spills nor
 * scrolls — the grid takes as many rows as gives the largest cards. Below
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

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import type { DraftCard } from '../draft/types.ts';
import { playRole } from '../sound/index.ts';
import { relatedCards } from '../draft/related.ts';
import { useArtLoaded } from '../draft/useArtLoaded.ts';
import { uiPx } from '../settings/ui-scale.ts';
import { CARD_RATIO, cssPx, fitGrid, useBox } from './cardFit.ts';
import { CardTile } from './CardTile.tsx';
import { RelatedRow, type RelatedPlace } from './RelatedRow.tsx';

export type PackLayout = 'fan' | 'grid';

export interface PackViewProps {
  cards: readonly DraftCard[];
  layout: PackLayout;
  /** Absent for a spectator watching a drafter: the cards browse, and nothing picks. */
  onPick?: (cardId: string) => void;
  disabled: boolean;
  /** Shown instead of the cards when there is nothing to pick from. */
  emptyNote: string;
}

/** Room above the row for the open card's rise, and below it. */
const LIFT = 22;
const BOTTOM = 8;
/** The visible share of each card: never less than a name's worth, never so much the cards stop overlapping. */
const MIN_SHOW = 0.17;
const MAX_SHOW = 0.62;
/** The largest a card is drawn, however much room there is, at 100%. */
export const MAX_CARD_H = 420;
/** Below this width there is no readable fan: the grid. */
export const FAN_MIN_WIDTH = 480;
/** A related card's size beside the open card's. */
const RELATED_SCALE = 0.8;
/** The gap between related cards, as `.pack__related` draws it. */
const RELATED_GAP = 8;
/** The open card's rise, as `.pack__slot[data-focused]` draws it. */
const RISE = 18;
/** From a card's bottom edge to its related row. */
const RELATED_DROP = 6;
/** How many cards are drawn either side of the open one. */
const FAN_SIDE = 3;
/** The row's places: the open card in the middle of them, `FAN_SIDE` either side, but at the pack's ends. */
const FAN_SLOTS = 2 * FAN_SIDE + 1;
/** The grid's gap until the stylesheet's own (`.pack--grid`, at the UI scale) can be read. */
const GRID_GAP = 10;

export interface FanGeometry {
  cardW: number;
  cardH: number;
  /** Centre to centre. */
  step: number;
}

/**
 * The row that fits a `width` x `height` box: `FAN_SLOTS` places, the card as
 * tall as the box allows, each a step from the next — the same size for any pack.
 */
export function fanGeometry(width: number, height: number, maxH = MAX_CARD_H): FanGeometry {
  let cardH = Math.min(maxH, height - LIFT - BOTTOM);
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

/**
 * The first of the `FAN_SLOTS` cards drawn with `open` open: the open card in
 * the middle, except near either end of the pack, where the row stops at the
 * pack's first or last card and the open card moves along it instead.
 */
function fanStart(open: number, count: number): number {
  return Math.max(0, Math.min(open - FAN_SIDE, count - FAN_SLOTS));
}

/** Card `i`'s place off the centre line with `open` open, or null for a card not drawn. A pack shorter than the row is centred. */
export function fanX(geo: FanGeometry, i: number, open: number, count: number): number | null {
  const slot = i - fanStart(open, count);
  const drawn = Math.min(count, FAN_SLOTS);
  return slot < 0 || slot >= drawn ? null : (slot - (drawn - 1) / 2) * geo.step;
}

/** Card `i`'s stacking with `open` on top: the further from the open card, the lower. */
export function fanLayer(i: number, open: number, count: number): number {
  return count - Math.abs(i - open);
}

/** The related row of card `at`, with `open` open, in the pack's coordinates: just under its bottom edge, from its left edge, kept inside the pack's width. */
export function relatedPlace(fan: FanGeometry, at: number, open: number, count: number, width: number, n: number): RelatedPlace {
  const w = fan.cardW * RELATED_SCALE;
  const row = n * w + Math.max(0, n - 1) * RELATED_GAP;
  const cardLeft = width / 2 + (fanX(fan, at, open, count) ?? 0) - fan.cardW / 2;
  const left = Math.max(0, Math.min(cardLeft, width - row));
  const top = LIFT + fan.cardH - (at === open ? RISE : 0) + RELATED_DROP;
  return { left, top, width: w };
}

/** Trackpad travel per card; any single wheel event this big is one mouse notch, one card. */
const WHEEL_STEP = 60;

/** A key pressed while typing somewhere is the field's, not the pack's. */
function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

export function PackView({ cards, layout, onPick, disabled: held, emptyNote }: PackViewProps) {
  const [measure, box, root] = useBox<HTMLDivElement>();
  // A new pack is drawn blank, and picks nothing, until all of its art can be drawn at once.
  const artLoaded = useArtLoaded(useMemo(() => cards.map((c) => c.scryfallId), [cards]));
  const disabled = held || !artLoaded;
  /** The open card, or the grid's cursor. `null` is the first in the fan: where a pack opens (the operator, 2026-10-19); in the grid, no cursor yet. */
  const [focus, setFocus] = useState<number | null>(null);
  // Unmeasured (the first frame, or a test environment) draws the plain grid: a
  // layout drawn at a guessed size is the overflow this replaced.
  const measured = box.width > 0 && box.height > 0;
  const maxH = uiPx(MAX_CARD_H, root);
  const fan = layout === 'fan' && measured && box.width >= FAN_MIN_WIDTH ? fanGeometry(box.width, box.height, maxH) : null;
  const grid = fan === null && measured ? fitGrid(cards.length, box, cssPx(root, 'column-gap', GRID_GAP), maxH * CARD_RATIO) : null;
  const shown = fan === null || cards.length === 0 ? null : Math.min(focus ?? 0, cards.length - 1);
  const cursor = fan !== null || focus === null || cards.length === 0 ? null : Math.min(focus, cards.length - 1);
  const cols = grid?.cols ?? 1;

  // The fan's first placement is drawn where it lands: its slots are laid out
  // once unmeasured, in the same frame, and would otherwise slide out from the
  // middle as the draft replaces its skeleton. Moves after it transition.
  const [placed, setPlaced] = useState(false);
  const fanned = fan !== null;
  useEffect(() => {
    if (!fanned) return setPlaced(false);
    const frame = requestAnimationFrame(() => setPlaced(true));
    return () => cancelAnimationFrame(frame);
  }, [fanned]);

  // A new pack opens on its first card.
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

  /** The card under the pointer: whose related cards the fan draws. */
  const [hovered, setHovered] = useState<number | null>(null);
  useEffect(() => setHovered(null), [packKey]);

  // The wheel steps through the row: one notch, one card. Not React's onWheel,
  // which is passive and cannot stop the page under the pack scrolling instead.
  const fanOn = fan !== null;
  const count = cards.length;
  const wheelLeft = useRef(0);
  useEffect(() => {
    const el = root;
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
      setFocus((was) => Math.max(0, Math.min(count - 1, (was ?? 0) + steps)));
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
      else if (onPick !== undefined) {
        playRole('ui.draft-pick');
        onPick(cardId);
      }
    },
    [onPick],
  );

  // Enter picks the open card, or the grid's cursor; the arrows move it.
  const highlighted = fan === null ? cursor : shown;
  /** A cursor the keys moved is brought into view; one the pointer moved already is. */
  const keyed = useRef(false);
  useEffect(() => {
    if (!keyed.current || cursor === null) return;
    keyed.current = false;
    root?.querySelector('.pack__slot[data-focused]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [cursor]);
  const highlightedRef = useRef(highlighted);
  highlightedRef.current = highlighted;
  useEffect(() => {
    if (disabled || count === 0) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || typing(event.target)) return;
      if (event.key === 'Enter') {
        const at = highlightedRef.current;
        const card = at === null ? undefined : cardsRef.current[at];
        if (card === undefined || onPick === undefined) return;
        event.preventDefault();
        onPick(card.cardId);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        keyed.current = true;
        const by = event.key === 'ArrowLeft' ? -1 : 1;
        setFocus((was) => (was === null && !fanOn ? 0 : Math.max(0, Math.min(count - 1, (was ?? 0) + by))));
      } else if (!fanOn && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        keyed.current = true;
        const by = event.key === 'ArrowUp' ? -cols : cols;
        // Past the top or bottom row the cursor stays put.
        setFocus((was) => (was === null ? 0 : was + by < 0 || was + by >= count ? was : was + by));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [disabled, count, fanOn, cols, onPick]);

  if (cards.length === 0) {
    return (
      <div className="pack pack--empty" data-testid="pack" ref={measure}>
        <p className="pack__note">{emptyNote}</p>
      </div>
    );
  }

  const hoveredCard = hovered === null ? undefined : cards[hovered];
  const related = fan === null || hovered === null || hoveredCard === undefined ? null : { at: hovered, cards: relatedCards(hoveredCard) };

  const style =
    fan !== null
      ? ({ '--fan-w': `${fan.cardW.toFixed(1)}px`, '--fan-h': `${fan.cardH.toFixed(1)}px` } as CSSProperties)
      : grid !== null
        ? ({ '--grid-w': `${grid.cardW.toFixed(1)}px`, gridTemplateColumns: `repeat(${grid.cols}, var(--grid-w))` } as CSSProperties)
        : undefined;

  return (
    <div
      // Unmeasured, it already wears the fan's box (no margin under it), so the first measure is the fan's own.
      className={`pack pack--${fan !== null || (layout === 'fan' && !measured) ? 'fan' : 'grid'}`}
      data-testid="pack"
      data-layout={layout}
      data-card-count={cards.length}
      data-art-pending={artLoaded ? undefined : ''}
      data-placed={fan !== null && placed ? '' : undefined}
      ref={measure}
      style={style}
      onPointerLeave={() => {
        setHovered(null);
        // The pointer's cursor goes with it: Enter never picks a card nobody is looking at.
        if (fan === null) setFocus(null);
      }}
    >
      {cards.map((card, i) => {
        const x = fan === null || shown === null ? null : fanX(fan, i, shown, cards.length);
        const off = fan !== null && x === null;
        return (
          <div
            key={card.cardId}
            className="pack__slot"
            data-card-id={fan === null ? `w${i}` : undefined}
            data-focused={highlighted === i ? '' : undefined}
            data-off={off ? '' : undefined}
            onFocus={off ? undefined : () => setFocus(i)}
            onPointerEnter={
              off
                ? undefined
                : () => {
                    setHovered(i);
                    if (fan === null) setFocus(i);
                  }
            }
            onPointerLeave={fan === null ? undefined : () => setHovered((was) => (was === i ? null : was))}
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
      {/* The hovered card's back face, tokens and meld cards, in a row under it. */}
      {fan !== null && shown !== null && related !== null && (
        <RelatedRow cards={related.cards} anchor={root} place={relatedPlace(fan, related.at, shown, cards.length, box.width, related.cards.length)} />
      )}
    </div>
  );
}

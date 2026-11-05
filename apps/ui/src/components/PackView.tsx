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
 * ## The shared inspector: the grid, and a fan nothing picks from
 *
 * The fan's open card is already full size, so an enlarged copy beside it is a
 * duplicate while picking (the operator, 2026-10-19: *"i dont need the hover
 * expand anymore"*): a picking fan shows the hovered card's back face and
 * tokens in its related row instead. A fan nothing picks from (Rally's sample
 * pack, a watcher's view of a drafter) is read, not picked, and its cards open
 * the shared inspector like the grid's (the operator, 2026-11-01, on the sample
 * pack: *"for fan view it's missing the hover to expand and mousewheel to show
 * transform cards"*). The inspector is then the one expanded view, so the
 * related row is not drawn, and a wheel notch the inspector spends turning an
 * open card's face does not also step the row.
 *
 * Each inspectable slot carries a synthetic `data-card-id="w<n>"` of its own,
 * matching `play/inspect/index.ts`'s `TILE_ID` so hovering opens the same
 * enlarged view the board uses — that module may not be edited to recognise a
 * drafted card's real id (`c0`, `c1`, …), so the wrapper carries the convention
 * and the `CardTile` inside keeps its real one, which `onPick` and every test
 * still read. See `PoolView.tsx`'s header for the fuller version of this; the
 * screen around the pack (`PodScreen`, `RallyEmbed`) mounts the inspector.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';

import type { DraftCard } from '../draft/types.ts';
import { playRole } from '../sound/index.ts';
import { relatedCards } from '../draft/related.ts';
import { useArtLoaded } from '../draft/useArtLoaded.ts';
import { uiPx } from '../settings/ui-scale.ts';
import { CARD_RATIO, cssPx, fitGrid, useBox } from './cardFit.ts';
import { CardTile } from './CardTile.tsx';
import { RelatedRow, type RelatedPlace } from './RelatedRow.tsx';

export type PackLayout = 'fan' | 'grid';

/** The same breakpoint `draft.css`'s own phone layout switches on — the one place both are spelled out. */
export const PHONE_MAX_WIDTH = 700;
const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;
/** A phone's grid is always two columns wide (the operator, 2026-11-02: "display two columns of cards instead of one") — kept here only for the Up/Down keyboard cursor's own column count; `draft.css`'s phone rules draw the columns themselves. */
const PHONE_GRID_COLS = 2;

function hasMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

function subscribePhone(onStoreChange: () => void): () => void {
  if (!hasMatchMedia()) return () => undefined;
  const mql = window.matchMedia(PHONE_QUERY);
  mql.addEventListener('change', onStoreChange);
  return () => mql.removeEventListener('change', onStoreChange);
}

function phoneSnapshot(): boolean {
  return hasMatchMedia() && window.matchMedia(PHONE_QUERY).matches;
}

/** No DOM, so no phone — the same fallback `play/portrait.ts`'s `usePortraitLayout` makes. */
function phoneServerSnapshot(): boolean {
  return false;
}

/**
 * Below `PHONE_MAX_WIDTH` the pack is sized in plain CSS (`draft.css`'s phone rules), not measured: see
 * that file's header for why. A host with no `matchMedia` (a bare test DOM) reports "not a phone".
 */
export function usePhoneLayout(): boolean {
  return useSyncExternalStore(subscribePhone, phoneSnapshot, phoneServerSnapshot);
}

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

/** The pack row's base: the row is the geometric mean of this and the draft's height (`packRowHeight`). */
const PACK_ROW_BASE = 210;
/**
 * The phone carousel's open card, as a share of the box's own width: solving `peek = (1 - f) / (2f)`
 * for the operator's "~15-20% of a card each side" at the middle of that range (2026-11-02, on the
 * rework: "the fan view should display properly one card in the middle and then two partial cards on
 * the left and right side") gives `f ≈ 0.74`, which this is. Paired with `PHONE_FAN_PAD_V` in
 * `phoneFanGeometry`'s "fits whichever is tighter" (box width vs. box height).
 */
const PHONE_FAN_WIDTH_FRAC = 0.74;
/** Room the carousel keeps above and below the open card for its focus shadow — no lift on a phone (`draft.css`'s phone rules), so far less than the desktop fan's `LIFT`/`BOTTOM`. */
const PHONE_FAN_PAD_V = 20;
/** The least the row under the pack keeps, at 100%. More when the pod's column beside the picks needs more at its smallest fit (`fitToWindow`). */
export const POOL_MIN_H = 250;

/**
 * The pack row's height in a draft body `height` CSS px tall, `unit` the UI scale: the fan's and the
 * grid's alike, so switching between them moves nothing else on the page.
 *
 * Browser zoom changes how many CSS px the window is, not what a CSS px asks for: a row sized as a
 * share of the window comes out the same on screen at any zoom (the operator, 2026-11-01: *"if
 * someone tries to zoom in or out, we allow the fan row to take more or less space and let the
 * cards get bigger/smaller"*). A row fixed in CSS px follows zoom fully, but is the same row on a
 * laptop and on a wide screen. The geometric mean of the two follows both: zoom in and the row
 * grows on screen by √zoom, and a taller window still gets a taller fan. Never taller than the
 * largest card needs, and never so tall the picks' row has less than `keep`.
 */
export function packRowHeight(height: number, unit = 1, keep = POOL_MIN_H * unit): number {
  return Math.max(0, Math.min(Math.sqrt(PACK_ROW_BASE * unit * height), (MAX_CARD_H + LIFT + BOTTOM) * unit, height - keep));
}

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

export interface PhoneFanCardSize {
  cardW: number;
  cardH: number;
}

/**
 * The phone carousel's open card, sized from the SAME real box the desktop fan measures (`useBox`) —
 * no `vw`/`vh` guess at the room's chrome around the pack (the operator's rework brief: "don't
 * hardcode for 390"). "Whichever is tighter": as tall as the box allows (`PHONE_FAN_PAD_V` the only
 * margin a non-lifting carousel needs), or `PHONE_FAN_WIDTH_FRAC` of the box's own width, whichever
 * comes out smaller — a short, wide box caps on height; a tall, narrow one caps on width, and the
 * peek either side (`draft.css`'s padding, `(100% - var(--fan-w)) / 2`) stays in the same ~15-20%
 * band either way.
 */
export function phoneFanGeometry(width: number, height: number, maxH = MAX_CARD_H): PhoneFanCardSize {
  const byHeight = Math.max(0, Math.min(maxH, height - PHONE_FAN_PAD_V)) * CARD_RATIO;
  const byWidth = width * PHONE_FAN_WIDTH_FRAC;
  const cardW = Math.min(byHeight, byWidth);
  return { cardW, cardH: cardW / CARD_RATIO };
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
  // A phone's grid draws no fit-to-box math at all — `draft.css`'s phone rules fix it at two columns,
  // the box's own width split evenly (the rework brief: a `fitGrid` box this narrow is the "fifteen
  // tiny cards" bug the box-height contract below reintroduces if nothing replaces it). The phone
  // fan's carousel IS measured, through the same `useBox` the desktop fan reads — `phoneFanGeometry`,
  // not `fanGeometry` (a different shape: one open card and two peeking neighbours, not an absolute
  // seven-wide row) — now that the box it measures is a real, page-layout-owned height (`--pack-row`),
  // not the self-referential one a flex column gave it (see `draft.css`'s phone rules for that history).
  // `desktopFan`/`desktopGrid` stay `null` on a phone (there is no desktop box-fit to feed them), which
  // is also what an UNMEASURED desktop frame looks like — `fanned` is the interactive truth (does the
  // fan's open/pick gesture apply right now), on a phone exactly `layout`, on a desktop only once real
  // geometry says so (an unmeasured frame behaves as the grid regardless of `layout`, same as before a
  // phone existed); `mode` is the className alone, which keeps the unmeasured frame's own skeleton class.
  const phone = usePhoneLayout();
  const desktopFan = !phone && layout === 'fan' && measured && box.width >= FAN_MIN_WIDTH ? fanGeometry(box.width, box.height, maxH) : null;
  const desktopGrid = !phone && desktopFan === null && measured ? fitGrid(cards.length, box, cssPx(root, 'column-gap', GRID_GAP), maxH * CARD_RATIO) : null;
  // The carousel's own geometry — measured the same way as the desktop fan's, just a different shape
  // (`phoneFanGeometry`'s header). `fanGeo` is the two merged into whichever one is live, for the style
  // below; `desktopFan` alone still gates the absolute-positioned row math further down, which only the
  // desktop fan ever uses.
  const phoneFan = phone && layout === 'fan' && measured ? phoneFanGeometry(box.width, box.height, maxH) : null;
  const fanGeo = desktopFan ?? phoneFan;
  const fanned = phone ? layout === 'fan' : desktopFan !== null;
  const mode: PackLayout = phone ? layout : !measured ? (layout === 'fan' ? 'fan' : 'grid') : fanned ? 'fan' : 'grid';
  const shown = !fanned || cards.length === 0 ? null : Math.min(focus ?? 0, cards.length - 1);
  const cursor = fanned || focus === null || cards.length === 0 ? null : Math.min(focus, cards.length - 1);
  const cols = phone ? PHONE_GRID_COLS : desktopGrid?.cols ?? 1;

  // The fan's first placement is drawn where it lands: its slots are laid out
  // once unmeasured, in the same frame, and would otherwise slide out from the
  // middle as the draft replaces its skeleton. Moves after it transition — a
  // phone's carousel has no transform to place, but the flag costs it nothing.
  const [placed, setPlaced] = useState(false);
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
  // A phone's carousel is scrolled, not stepped — see the scroll listener below,
  // which reads the position a wheel event would not otherwise move.
  //
  // Heard on the window, after the shared inspector (mounted on the document or the embed's shadow
  // root) has had the event: a notch the inspector spent turning an open card's face is spent, and
  // every other notch over the pack steps the row and scrolls nothing else. Deciding by the tile
  // under the pointer instead left notches nobody took — a tile with faces but no panel open on it —
  // and those scrolled Rally's dialog behind the fan (ohmusama, 2026-11-05).
  const wheelOn = desktopFan !== null;
  const count = cards.length;
  /** Nothing picks: the cards are read through the shared inspector, in either layout. */
  const browsing = onPick === undefined;
  const wheelLeft = useRef(0);
  useEffect(() => {
    const el = root;
    if (!wheelOn || el === null) return;
    const onWheel = (event: WheelEvent): void => {
      if (event.defaultPrevented || !event.composedPath().includes(el)) return;
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
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, [wheelOn, count]);

  // The phone carousel's own open card: not stepped, read off the real scroll position — the slot
  // nearest the row's own centre, wherever a swipe (or a momentum settle) left it. `requestAnimationFrame`
  // coalesces the storm of `scroll` events one swipe fires into one read per paint.
  //
  // `root` is in the dependency list, not just `phoneFanOn`: unlike the desktop fan/grid (whose own
  // "on" flags only ever turn true once `useBox` has already measured a box, which cannot happen before
  // `root` itself is set), `phoneFanOn` is true from the very FIRST render — before the ref callback has
  // run. An effect keyed on `phoneFanOn` alone mounted on that first render with `root` still `null`,
  // bailed out, and never ran again once `root` arrived a render later, because its own value never
  // changed again: the carousel scrolled but nothing ever read it. Caught by `w90c-pack-fan.phone.spec.ts`.
  const phoneFanOn = phone && fanned;
  useEffect(() => {
    const el = root;
    if (!phoneFanOn || el === null) return;
    let frame = 0;
    const onScroll = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const mid = el.getBoundingClientRect().left + el.clientWidth / 2;
        let best = 0;
        let bestDist = Infinity;
        el.querySelectorAll<HTMLElement>('.pack__slot').forEach((slot, i) => {
          const r = slot.getBoundingClientRect();
          const dist = Math.abs((r.left + r.right) / 2 - mid);
          if (dist < bestDist) {
            bestDist = dist;
            best = i;
          }
        });
        setFocus(best);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [phoneFanOn, root]);

  /**
   * A cursor the keys moved, or a phone carousel card opened from off-centre, is brought into view —
   * one the pointer moved (desktop) already is. Set before the `setFocus` that asks for it, read by the
   * effect below once that render lands. The phone carousel has no cursor (`cursor` is always `null`
   * there, fan or grid alike), but it has its own `shown` to bring into view the same way, centred
   * rather than merely scrolled to — a tap on a peeking neighbour moves it exactly as a swipe would,
   * through this app's OWN `scrollIntoView`, not whatever the tap's own auto-scroll left behind (which
   * is what opening a card used to race against here).
   */
  const keyed = useRef(false);

  // A click on a card that is not the open one opens it rather than picking it:
  // after the wheel the card under a still pointer need not be the open one, and
  // a pick is not undoable. Hover-then-click is still one click. Stable, because
  // `CardTile` is memoised on this prop.
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const phoneFannedRef = useRef(phone && fanned);
  phoneFannedRef.current = phone && fanned;
  /**
   * A click or a tap focuses the button it lands on — the platform's own doing, not this app's — and
   * on this host that `focus` event reaches `onFocus` BEFORE the click's own `onPick`/`pick` does,
   * which (through the unconditional `onFocus` below, there for Tab) opened whatever was tapped a step
   * early: by the time `pick` ran, `shown` already matched the tapped card, so a tap that should have
   * only OPENED a neighbour read as a second tap on an already-open one and picked it outright, after
   * one tap, not two. Set on the pointer's own down (bubbles up from the tile's button), read and
   * cleared by `onFocus`: a `focus` that follows a pointer down within the same gesture is that
   * side-effect, not a Tab key, and is skipped; one with no pointer down before it IS Tab, and still
   * moves `focus` the way it always did. Caught by `w90c-pack-fan.phone.spec.ts`.
   */
  const pointerFocusing = useRef(false);
  // The tile stays silent in the fan, so opening a card never sounds like taking it.
  const pick = useCallback(
    (cardId: string) => {
      const at = cardsRef.current.findIndex((c) => c.cardId === cardId);
      if (shownRef.current !== null && at !== shownRef.current) {
        if (phoneFannedRef.current) keyed.current = true;
        setFocus(at);
      } else if (onPick !== undefined) {
        playRole('ui.draft-pick');
        onPick(cardId);
      }
    },
    [onPick],
  );

  // Enter picks the open card, or the grid's cursor; the arrows move it.
  const highlighted = fanned ? shown : cursor;
  useEffect(() => {
    const at = cursor ?? (phone && fanned ? shown : null);
    if (!keyed.current || at === null) return;
    keyed.current = false;
    root?.querySelector('.pack__slot[data-focused]')?.scrollIntoView?.({ block: 'nearest', inline: phone && fanned ? 'center' : 'nearest' });
  }, [cursor, shown, phone, fanned]);
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
        setFocus((was) => (was === null && !fanned ? 0 : Math.max(0, Math.min(count - 1, (was ?? 0) + by))));
      } else if (!fanned && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        keyed.current = true;
        const by = event.key === 'ArrowUp' ? -cols : cols;
        // Past the top or bottom row the cursor stays put.
        setFocus((was) => (was === null ? 0 : was + by < 0 || was + by >= count ? was : was + by));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [disabled, count, fanned, cols, onPick]);

  if (cards.length === 0) {
    return (
      <div className="pack pack--empty" data-testid="pack" ref={measure}>
        <p className="pack__note">{emptyNote}</p>
      </div>
    );
  }

  const hoveredCard = hovered === null ? undefined : cards[hovered];
  // The related row is the desktop fan's hover feature: there is no hover on a phone, and no room
  // under a carousel card for one either.
  const related = desktopFan === null || browsing || hovered === null || hoveredCard === undefined ? null : { at: hovered, cards: relatedCards(hoveredCard) };

  const style =
    fanGeo !== null
      ? ({ '--fan-w': `${fanGeo.cardW.toFixed(1)}px`, '--fan-h': `${fanGeo.cardH.toFixed(1)}px` } as CSSProperties)
      : desktopGrid !== null
        ? ({ '--grid-w': `${desktopGrid.cardW.toFixed(1)}px`, gridTemplateColumns: `repeat(${desktopGrid.cols}, var(--grid-w))` } as CSSProperties)
        : undefined;

  return (
    <div
      className={`pack pack--${mode}`}
      data-testid="pack"
      data-layout={layout}
      data-card-count={cards.length}
      data-art-pending={artLoaded ? undefined : ''}
      data-placed={fanned && placed ? '' : undefined}
      ref={measure}
      style={style}
      onPointerLeave={() => {
        setHovered(null);
        // The pointer's cursor goes with it: Enter never picks a card nobody is looking at.
        if (!fanned) setFocus(null);
      }}
    >
      {cards.map((card, i) => {
        // Only the desktop fan's absolute-positioned row windows cards past `FAN_SIDE`; the phone
        // carousel and both grids draw every card, in a row or a scroller.
        const x = desktopFan === null || shown === null ? null : fanX(desktopFan, i, shown, cards.length);
        const off = desktopFan !== null && x === null;
        return (
          <div
            key={card.cardId}
            className="pack__slot"
            // Inspectable (the shared hover/long-press preview) in the grid, always — desktop or
            // phone — and in a BROWSING fan's on-screen cards; never a PICKING fan's, desktop or
            // phone, where the open card is already full size and the gesture is reserved for the
            // pick itself. `!fanned` (not `desktopFan === null`) is the "grid" test: `desktopFan` is
            // null for every phone card, fan included, so that test alone tagged a phone fan's cards
            // even while picking — the shared inspector's `document`-level `focusin`/long-press then
            // fired OVER the carousel, the giant enlarged card the operator's rework shot caught
            // (`w90c-pack-fan.phone.spec.ts`).
            data-card-id={!fanned || (browsing && !off) ? `w${i}` : undefined}
            data-focused={highlighted === i ? '' : undefined}
            data-off={off ? '' : undefined}
            onPointerDown={off ? undefined : () => (pointerFocusing.current = true)}
            onFocus={
              off
                ? undefined
                : () => {
                    // See `pointerFocusing`'s own comment: a pointer-down's own focus is the click's to
                    // handle, through `pick`/`onPick`, not this Tab-key path's.
                    if (pointerFocusing.current) {
                      pointerFocusing.current = false;
                      return;
                    }
                    setFocus(i);
                  }
            }
            onPointerEnter={
              off
                ? undefined
                : () => {
                    setHovered(i);
                    // A phone's carousel moves `focus` from the scroll position, not the pointer: a
                    // touch drag that passes over a neighbour must not steal the open card from under it.
                    if (!fanned) setFocus(i);
                  }
            }
            onPointerLeave={fanned ? () => setHovered((was) => (was === i ? null : was)) : undefined}
            style={
              x === null || shown === null
                ? undefined
                : // Position goes out as a custom property, not as `transform`, so the
                  // stylesheet keeps ownership of the transform (the open card's rise).
                  ({ '--fan-x': `${x.toFixed(1)}px`, zIndex: fanLayer(i, shown, cards.length) } as CSSProperties)
            }
          >
            <CardTile card={card} onPick={fanned ? pick : onPick} disabled={disabled} pickRole={fanned ? null : 'ui.draft-pick'} />
          </div>
        );
      })}
      {/* The hovered card's back face, tokens and meld cards, in a row under it. */}
      {desktopFan !== null && shown !== null && related !== null && (
        <RelatedRow cards={related.cards} anchor={root} place={relatedPlace(desktopFan, related.at, shown, cards.length, box.width, related.cards.length)} />
      )}
    </div>
  );
}

/** The share of a pick the rope burns through: its last third (the operator, 2026-10-30). */
const ROPE_SHARE = 1 / 3;

/**
 * The draft rope (wave 83 D3): a fuse along the top of the pack that burns down
 * through the last third of the pick. The time is the server's, sent as how
 * much was left when the envelope left it (`viewer.timer`); the page only
 * counts down from when it arrived, and the burn is a CSS animation whose delay
 * places it on that clock. `waiting` before the last third (drawn as nothing),
 * `burning` through it, `out` at zero — the server picks for the seat then.
 */
export function PickRope({ timer, pickKey }: { timer: { totalMs: number; msLeft: number }; pickKey: string }) {
  const burnMs = timer.totalMs * ROPE_SHARE;
  const [state, setState] = useState<'waiting' | 'burning' | 'out'>(timer.msLeft <= 0 ? 'out' : timer.msLeft <= burnMs ? 'burning' : 'waiting');
  useEffect(() => {
    const toBurn = timer.msLeft - burnMs;
    setState(timer.msLeft <= 0 ? 'out' : toBurn <= 0 ? 'burning' : 'waiting');
    const burn = toBurn > 0 ? setTimeout(() => setState('burning'), toBurn) : undefined;
    const out = timer.msLeft > 0 ? setTimeout(() => setState('out'), timer.msLeft) : undefined;
    return () => {
      clearTimeout(burn);
      clearTimeout(out);
    };
  }, [pickKey, timer.msLeft, burnMs]);
  // A negative delay starts the burn part-way through, where the server's clock already is.
  const style = { animationDuration: `${burnMs}ms`, animationDelay: `${timer.msLeft - burnMs}ms` } as CSSProperties;
  return (
    <div className="pick-rope" data-testid="pick-rope" data-state={state} aria-hidden="true">
      <div key={pickKey} className="pick-rope__fuse" style={style} />
    </div>
  );
}

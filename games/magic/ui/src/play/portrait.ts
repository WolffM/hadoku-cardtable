/**
 * The portrait switch (wave 89, Settled 1): a phone held upright gets the new
 * board; desktop and a phone held sideways keep today's, unchanged.
 *
 * The condition is exactly "viewport ≤ 600 CSS px wide AND taller than wide" —
 * `(orientation: portrait)` already means "taller than wide" (it is computed
 * from the viewport's own aspect ratio, not a sensor), so there is no second
 * check to keep in sync with it. No other breakpoint, and no user-agent
 * sniffing: a desktop window squeezed narrow and tall also gets this layout,
 * which is correct — the condition is the viewport's shape, not the device.
 *
 * `usePortraitLayout` is the one way anything in this tree learns the
 * viewport's shape. Mounting it is also what INSTALLS the switch: its
 * subscription sets `document.documentElement.dataset.layout = 'portrait'`
 * while the media query matches and deletes the attribute while it does not,
 * so `:root[data-layout="portrait"]` is live the moment `Board` mounts, and
 * every lane's CSS keys off that attribute from the first commit — B, C and D
 * never call this hook themselves. A host with no `matchMedia` (a bare test
 * DOM that has not called `ensureMatchMedia`, `../chrome/matchMedia.ts`)
 * reports "not portrait" and installs nothing, the same fallback
 * `play/motion.ts`'s `prefersReducedMotion` uses.
 */
import { useSyncExternalStore } from 'react';

/** Settled 1's condition, verbatim. */
export const PORTRAIT_MEDIA_QUERY = '(max-width: 600px) and (orientation: portrait)';

function hasMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

/** Sets or clears the switch `data-layout="portrait"` reads, nothing else — never reads it back. */
function applyLayoutAttribute(portrait: boolean): void {
  if (typeof document === 'undefined') return;
  if (portrait) document.documentElement.dataset.layout = 'portrait';
  else delete document.documentElement.dataset.layout;
}

/**
 * How many live subscribers currently want the attribute kept — a reference count, not a boolean,
 * because `useSyncExternalStore` calls `subscribe` once per mounted consumer. Today that is `Board`
 * alone, but the count is what makes a SECOND consumer safe later: the attribute is cleared only once
 * the LAST subscriber unsubscribes, never just because any one of them unmounted first.
 */
let activeSubscribers = 0;

function subscribe(onStoreChange: () => void): () => void {
  if (!hasMatchMedia()) return () => undefined;
  const mql = window.matchMedia(PORTRAIT_MEDIA_QUERY);
  activeSubscribers += 1;
  applyLayoutAttribute(mql.matches);
  const onChange = (): void => {
    applyLayoutAttribute(mql.matches);
    onStoreChange();
  };
  mql.addEventListener('change', onChange);
  return () => {
    mql.removeEventListener('change', onChange);
    activeSubscribers -= 1;
    /*
     * Settled 10: landscape, desktop, draft and the room screens are out of
     * scope and must never carry this attribute. `Board` unmounting (leaving
     * a match) is exactly how a player gets from "in a match, portrait" to
     * "back in the room" without a reload — and without this, the switch's
     * OWN listener going away left `data-layout="portrait"` on `<html>`
     * behind it, so the lobby inherited the match's layout.
     */
    if (activeSubscribers <= 0) applyLayoutAttribute(false);
  };
}

function getSnapshot(): boolean {
  if (!hasMatchMedia()) return false;
  return window.matchMedia(PORTRAIT_MEDIA_QUERY).matches;
}

/** Server/no-DOM snapshot: never portrait. */
function getServerSnapshot(): boolean {
  return false;
}

/**
 * Whether the board is in portrait layout right now, kept live across every
 * viewport change. Mounting this hook anywhere is what installs the switch
 * (see module doc) — `Board` calls it unconditionally, once, near its top.
 */
export function usePortraitLayout(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * The zoom contract (§A.5): A owns the board's zoom value and dispatches this
 * event on `window` whenever it changes; B's action-bar pill (`zoom-pill`)
 * reads it to draw the live percentage and to ask for it back to 1×. Nobody
 * else writes the board's zoom — a reader that wants to CHANGE it dispatches
 * through the board's own gesture (pinch, double-tap), not this event.
 */
export const ZOOM_EVENT = 'cardtable:zoom';

/** `CustomEvent<ZoomEventDetail>`'s `detail`, carried by every `cardtable:zoom` dispatch. */
export interface ZoomEventDetail {
  /** The board's current zoom factor: 1 is unzoomed, `ZOOM_MAX` is as far in as the board goes. */
  readonly zoom: number;
}

/** Settled 4's bounds: the minimum always shows 3 cards per lane row, the maximum is the prototype's own ceiling. */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 2.4;

/** `zoom`, kept inside `[ZOOM_MIN, ZOOM_MAX]` — the one place either bound is spelled out. */
export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/** Dispatched on `window` every time the board's own zoom value changes (see `ZOOM_EVENT`'s doc). */
export function dispatchZoomEvent(zoom: number): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ZoomEventDetail>(ZOOM_EVENT, { detail: { zoom } }));
}

/**
 * The other half of the zoom contract: B's `zoom-pill` asks the board for 1× by dispatching THIS
 * (no `detail` — there is nothing to say but "go back to 1") on `window`, rather than writing the
 * board's zoom itself. `Board.tsx`'s own pinch/double-tap installer (`usePortraitZoom`) is the one
 * listener for it, and answers by running the same focal-point-preserving `zoomTo` the gestures use,
 * anchored on the board's own centre, then telling `ZOOM_EVENT` the new value back out as usual.
 */
export const ZOOM_RESET_EVENT = 'cardtable:zoom-reset';

/**
 * The other zoom control besides pinch: the ⋯ sheet's − and + ask the board to step its zoom by
 * `detail.by` (a factor added to the current one), on `window` — the board's `usePortraitZoom` is
 * the one listener, and answers through the same centre-anchored `zoomTo` the reset uses.
 */
export const ZOOM_STEP_EVENT = 'cardtable:zoom-step';

/** `CustomEvent<ZoomStepDetail>`'s `detail`, carried by every `cardtable:zoom-step` dispatch. */
export interface ZoomStepDetail {
  readonly by: number;
}

/**
 * A count drawn in a chip's zone button: exact below 1000, then whole thousands, rounded down
 * (`1k`, `12k`), so a four-digit count is two glyphs and three buttons fit a 360px phone's chip. The
 * exact number stays in the button's accessible name.
 */
export function compactCount(n: number): string {
  return n < 1000 ? String(n) : `${Math.floor(n / 1000)}k`;
}

/** What `portraitLaneFit` reads off one permanents lane, every length in CSS px. */
export interface LaneGeometry {
  /** The lane's own content box, as `clientWidth`/`clientHeight` read it. */
  readonly width: number;
  readonly height: number;
  /** The lane's end padding, the gap between cards, and the next card's peek (`portrait.css`'s three tokens). */
  readonly pad: number;
  readonly gap: number;
  readonly peek: number;
  /** The room reserved above a resting card for a card that rises (`--portrait-rise`), and the board's zoom. */
  readonly rise: number;
  readonly zoom: number;
  /** How many piles the lane draws. */
  readonly count: number;
}

/** The ceiling a sparse lane's card grows to, as a multiple of the 3-across width. */
export const LANE_GROW_MAX = 1.25;
/** The smallest card two rows may draw, as a multiple of the 3-across width; under it the lane stays one row and scrolls. */
export const LANE_TWO_ROW_MIN = 0.62;
/** A lane wraps to two rows from this many piles. */
export const LANE_TWO_ROW_FROM = 5;

/**
 * How big a permanents lane draws its cards, as `k`, a multiple of the lane's 3-across width (the
 * `--card-w` formula in `portrait.css`, which this mirrors and only ever scales), and in how many
 * rows. A lane of one to three piles grows its cards to fill the lane's width and height, up to
 * `LANE_GROW_MAX`; a lane of four stays at 1 and scrolls; a lane of five or more wraps to two rows
 * when two rows still draw cards at least `LANE_TWO_ROW_MIN` of the 3-across width.
 */
export function portraitLaneFit(g: LaneGeometry): { k: number; rows: 1 | 2 } {
  const cw0 = ((g.width - 2 * g.pad - 2 * g.gap - g.peek) / 3) * g.zoom;
  if (cw0 <= 0 || g.count === 0) return { k: 1, rows: 1 };
  const tall = (h: number): number => (h * 63) / 88;
  const free = g.height - g.rise;
  if (g.count >= LANE_TWO_ROW_FROM) {
    const two = tall((free - g.gap) / 2);
    if (two >= cw0 * LANE_TWO_ROW_MIN) {
      const across = (g.width - 2 * g.pad - 3 * g.gap - g.peek) / 3.4;
      return { k: Math.min(two, across) / cw0, rows: 2 };
    }
  }
  if (g.count > 3) return { k: 1, rows: 1 };
  const byW = (g.width - 2 * g.pad - (g.count - 1) * g.gap) / g.count;
  const k = Math.min(tall(free) / cw0, byW / cw0, LANE_GROW_MAX);
  return { k: Math.max(1, k), rows: 1 };
}

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

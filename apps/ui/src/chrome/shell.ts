/**
 * What the page frame holds, as attributes on `.cardtable-chrome` (`chrome.css` keys its height and its
 * edges on them): `data-shell` names the screen's own shell while it is drawn — `fit` and `match` take
 * the window's height, `sound` too — and `data-room-frame` is there while watchparty's room frame is.
 *
 * Until 2026-10-23 the stylesheet asked the page itself (`.cardtable-chrome:has(.shell--match)`). A `:has()`
 * on the page's own root is checked again on every change anywhere under it, and answering it restyled
 * the whole page: in a six-creature attack, about thirty times in two seconds, 20,000 element matches
 * each time the board so much as marked a card (`e2e/combat-perf.spec.ts`'s selector stats). A screen
 * says so once, as it is drawn and as it goes.
 */
import { useCallback, type RefCallback } from 'react';

export type ChromeShell = 'fit' | 'match' | 'sound';

/** The frame `el` is drawn in: the app's own, or the embed's. */
const frameOf = (el: Element): Element | null => el.closest('.cardtable-chrome');

/**
 * Mark the page frame with `name`=`value` for as long as `el` is drawn. Several marking it at once (a
 * screen redrawn into a new element before the old one goes) each hold it; it goes with the last.
 */
function hold(el: Element, name: string, value: string): () => void {
  const frame = frameOf(el);
  if (frame === null) return () => undefined;
  const holders = HELD.get(frame) ?? new Map<string, number>();
  HELD.set(frame, holders);
  const key = `${name}=${value}`;
  holders.set(key, (holders.get(key) ?? 0) + 1);
  frame.setAttribute(name, value);
  return () => {
    const left = (holders.get(key) ?? 1) - 1;
    if (left > 0) holders.set(key, left);
    else {
      holders.delete(key);
      if (frame.getAttribute(name) === value) frame.removeAttribute(name);
    }
  };
}

const HELD = new WeakMap<Element, Map<string, number>>();

/** A screen's shell: a ref for its root element. Stable for a `kind`, so a redraw writes nothing. */
export function useChromeShell(kind: ChromeShell): RefCallback<HTMLElement> {
  return useCallback((el: HTMLElement | null) => (el === null ? undefined : hold(el, 'data-shell', kind)), [kind]);
}

/** Watchparty's room frame, drawn around a room's screens: a ref for the element that holds it. */
export function useRoomFrame(): RefCallback<HTMLElement> {
  return useCallback((el: HTMLElement | null) => (el === null ? undefined : hold(el, 'data-room-frame', '')), []);
}

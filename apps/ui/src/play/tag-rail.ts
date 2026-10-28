/**
 * The tag rail (`Board.tsx`'s `CardTags`): one row of chips right-aligned directly above the P/T
 * badge, which ends in a "+N" chip when the card is too narrow for the lot. The operator,
 * 2026-10-28: *"when a creature is turned sideways and has multiple keywords … eventually the
 * power/toughness is not visible anymore … we gotta make sure that always shows."* One row can
 * never reach the badge, whatever the card's height; only the width is left to fit, and that is
 * measured here.
 *
 * The room is the rail's own right edge (placed by `card.css`) to the right edge of whatever
 * else the card wears in the same band — its marks down the top-left, its counters and
 * relations along the bottom, a pile's copies count — so no chip is ever drawn over one. Boxes
 * are read from offsets, which a flyer's sway (a transform) does not move.
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** The gap between two chips, and between the rail and whatever it stops at (`card.css`). */
export const RAIL_GAP = 2;

/** The card's own inset on the left, where nothing stops the rail sooner. */
const EDGE = 2;

/** A "+N" chip's width before one has been drawn and measured. */
const MORE_GUESS = 18;

/** What the rail stops short of: everything else the card draws in its band. */
const OBSTACLES = ':scope > .board-card__marks > li, :scope > .board-card__counters > li, :scope > .board-card__relations > li, :scope > .board-card__copies';

/**
 * How many of a row's items (their widths, in order) are drawn in `room` px, the rest folded into
 * one `more`-wide chip after them. Null when every item fits; 0 when only the chip does; -1 when
 * not even the chip does, and the card draws no tag at all rather than one over another badge (the
 * list still says each, and the inspector shows the card whole).
 */
export function railFit(widths: readonly number[], room: number, more: number, gap = RAIL_GAP): number | null {
  const span = (n: number): number => widths.slice(0, n).reduce((sum, w) => sum + w, 0) + gap * Math.max(0, n - 1);
  if (span(widths.length) <= room + 0.5) return null;
  for (let k = widths.length - 1; k > 0; k--) if (span(k) + gap + more <= room + 0.5) return k;
  return more <= room + 0.5 ? 0 : -1;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** An element's layout box inside `card` (offsets, so untouched by a transform). */
function boxIn(el: HTMLElement, card: HTMLElement): Box {
  let left = 0;
  let top = 0;
  for (let at: HTMLElement | null = el; at !== null && at !== card; at = at.offsetParent as HTMLElement | null) {
    left += at.offsetLeft;
    top += at.offsetTop;
  }
  return { left, top, right: left + el.offsetWidth, bottom: top + el.offsetHeight };
}

/** The px the rail may span: from its right edge to the nearest other badge in its band. */
export function railRoom(rail: HTMLElement): number {
  const card = rail.parentElement;
  if (card === null) return 0;
  const own = boxIn(rail, card);
  let left = EDGE;
  for (const el of card.querySelectorAll<HTMLElement>(OBSTACLES)) {
    const b = boxIn(el, card);
    if (b.bottom > own.top && b.top < own.bottom && b.left < own.right) left = Math.max(left, b.right + RAIL_GAP);
  }
  return own.right - left;
}

/**
 * How many of the rail's items to draw (null: all of them; -1: none, nor the "+N" chip), for the
 * items named by `sig`.
 *
 * Every item is drawn once whenever the set changes, its width read, and the fit taken from those
 * widths from then on; the card's resize (turning, a narrower row) and every render (a mark or a
 * counter arriving) take it again. All in a layout effect, so a row that does not fit is never
 * painted. No `ResizeObserver` (a test DOM) means no layout: every item is drawn.
 */
export function useRailFit(rail: RefObject<HTMLElement | null>, sig: string): number | null {
  const [fit, setFit] = useState<{ sig: string; shown: number | null }>({ sig, shown: null });
  const [, resized] = useState(0);
  const widths = useRef<number[]>([]);
  const more = useRef(MORE_GUESS);
  const shown = fit.sig === sig ? fit.shown : null;

  useLayoutEffect(() => {
    const el = rail.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const items = [...el.children].filter((c): c is HTMLElement => c instanceof HTMLElement && !c.hasAttribute('data-more'));
    if (shown === null) widths.current = items.map((c) => c.offsetWidth);
    const chip = el.querySelector<HTMLElement>(':scope > [data-more]');
    if (chip !== null) more.current = chip.offsetWidth;
    const next = railFit(widths.current, railRoom(el), more.current);
    if (next !== shown || fit.sig !== sig) setFit({ sig, shown: next });
  });

  useEffect(() => {
    const card = rail.current?.parentElement;
    if (card == null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => resized((n) => n + 1));
    observer.observe(card);
    return () => observer.disconnect();
  }, [rail, sig]);

  return shown;
}

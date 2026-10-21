/**
 * Every area that draws cards draws them at the size its box allows, so no
 * area of cards ever scrolls (the operator, 2026-10-21: *"we need to
 * re-structure how the page is sized so that a scrollbar isn't needed"*).
 *
 * Two shapes cover every card area this app has:
 *
 *  - a GRID — cards side by side, wrapping into rows (the pack in grid mode,
 *    the deck builder's pool);
 *  - PILES — columns of overlapped cards, each showing its name strip, the last
 *    one whole (the draft's picks, the deck builder's mana-value piles). A pile
 *    taller than the box splits into side-by-side columns under its one head.
 *
 * Each shape has a pure "how tall at this card width" (`gridAt`, `pilesAt`);
 * `largestCard` finds the widest card at which every part fits. A screen
 * whose areas share one height (the deck builder's pool over its deck) hands
 * `largestCard` the sum of its parts, so the split between them follows what
 * each one holds instead of a fixed share.
 */

import { useCallback, useRef, useState } from 'react';

/** A Magic card's width over its height (488 x 680). */
export const CARD_RATIO = 488 / 680;
/** How much of a card a pile shows above the next one: its name strip, as a share of the card's width. */
export const PILE_PEEK = 0.205;
/** Never drawn narrower than this, whatever the box: below it a card is a sliver. */
export const MIN_CARD_W = 24;

export const cardHeightOf = (cardW: number): number => cardW / CARD_RATIO;

export interface Box {
  width: number;
  height: number;
}

export interface GridAt {
  cols: number;
  rows: number;
  /** The grid's height at this card width; `Infinity` when not one card fits across. */
  height: number;
}

/** `count` cards at `cardW` in a `width`-wide grid: as many to a row as fit, rows as many as that takes. */
export function gridAt(count: number, cardW: number, width: number, gap: number): GridAt {
  const fit = Math.floor((width + gap) / (cardW + gap));
  if (fit < 1) return { cols: 0, rows: 0, height: Infinity };
  if (count === 0) return { cols: fit, rows: 0, height: 0 };
  const cols = Math.min(fit, count);
  const rows = Math.ceil(count / cols);
  return { cols, rows, height: rows * cardHeightOf(cardW) + (rows - 1) * gap };
}

export interface PilesAt {
  /** Side-by-side columns each pile takes. */
  cols: number[];
  /** The most cards any one column holds. */
  perCol: number;
  /** The tallest column's height; `Infinity` when the piles do not fit across even one column each. */
  height: number;
}

/**
 * Piles of `piles[i]` cards at `cardW` in a `width`-wide row: one column each,
 * then every column the width has left goes, one at a time, to whichever pile
 * is tallest — so the tallest column is as short as the width allows.
 */
export function pilesAt(piles: readonly number[], cardW: number, width: number, gap: number): PilesAt {
  const fit = Math.floor((width + gap) / (cardW + gap));
  const cols = piles.map(() => 1);
  if (fit < piles.length) return { cols, perCol: 0, height: Infinity };
  const per = (i: number): number => Math.ceil(piles[i]! / cols[i]!);
  for (let spare = fit - piles.length; spare > 0; spare -= 1) {
    let tallest = -1;
    for (let i = 0; i < piles.length; i += 1) if (tallest < 0 || per(i) > per(tallest)) tallest = i;
    if (tallest < 0 || per(tallest) <= 1) break;
    cols[tallest]! += 1;
  }
  const perCol = piles.reduce((most, _, i) => Math.max(most, per(i)), 0);
  const cardH = cardHeightOf(cardW);
  return { cols, perCol, height: perCol === 0 ? 0 : cardH + (perCol - 1) * cardW * PILE_PEEK };
}

/**
 * The widest card, up to `maxW`, at which `fits` holds — to a tenth of a
 * pixel. A box too small for even `MIN_CARD_W` gets `MIN_CARD_W`.
 */
export function largestCard(fits: (cardW: number) => boolean, maxW: number): number {
  if (fits(maxW)) return maxW;
  let lo = MIN_CARD_W;
  let hi = maxW;
  if (!fits(lo)) return lo;
  while (hi - lo > 0.1) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return Math.floor(lo * 10) / 10;
}

export interface GridFit extends GridAt {
  cardW: number;
}

/** The largest cards at which `count` of them fit `box` as a grid. */
export function fitGrid(count: number, box: Box, gap: number, maxW: number): GridFit {
  const cardW = largestCard((w) => gridAt(count, w, box.width, gap).height <= box.height, maxW);
  return { cardW, ...gridAt(count, cardW, box.width, gap) };
}

export interface PilesFit extends PilesAt {
  cardW: number;
}

/** The largest cards at which piles of `piles[i]` cards fit `box`. */
export function fitPiles(piles: readonly number[], box: Box, gap: number, maxW: number): PilesFit {
  const cardW = largestCard((w) => pilesAt(piles, w, box.width, gap).height <= box.height, maxW);
  return { cardW, ...pilesAt(piles, cardW, box.width, gap) };
}

/** `items` cut into columns of `perCol`, in order. */
export function columnsOf<T>(items: readonly T[], cols: number): T[][] {
  const per = Math.max(1, Math.ceil(items.length / Math.max(1, cols)));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += per) out.push(items.slice(i, i + per));
  return out.length === 0 ? [[]] : out;
}

/** The box an element draws in, kept current. Zero until it has been measured (and in a test environment). */
export function useBox(): [(el: HTMLElement | null) => void, Box] {
  const [box, setBox] = useState<Box>({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      // The content box: what a child laid out inside the border and padding gets.
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const px = (...sides: string[]): number => sides.reduce((n, side) => n + (parseFloat(style.getPropertyValue(side)) || 0), 0);
      const width = r.width - px('padding-left', 'padding-right', 'border-left-width', 'border-right-width');
      const height = r.height - px('padding-top', 'padding-bottom', 'border-top-width', 'border-bottom-width');
      setBox((was) => (was.width === width && was.height === height ? was : { width, height }));
    };
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
    measure();
  }, []);
  return [ref, box];
}

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
 *
 * A COLUMN of controls (the draft's side column: the room's bar, the draft's,
 * the seats) is the same rule for what is not a card: it draws at the largest
 * scale at which its content fits its box (`fitScale`), by redefining the UI
 * scale's units inside it (`.fit-scale`, `styles.css`), so every length in it
 * shrinks together and nothing in it scrolls.
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react';

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

/**
 * A length the stylesheet gives `el` (`column-gap`, `margin-bottom`, …) in px
 * as drawn, so a fit follows the UI scale (`settings/ui-scale.ts` rewrites
 * every authored px); `fallback` before there is an element to ask.
 */
export function cssPx(el: Element | null | undefined, property: string, fallback: number): number {
  if (el == null) return fallback;
  const n = parseFloat(getComputedStyle(el).getPropertyValue(property));
  return Number.isFinite(n) ? n : fallback;
}

/** The height `el` takes in its column: its box and its vertical margins. */
export function outerHeight(el: Element | null | undefined, fallback: number): number {
  if (el == null) return fallback;
  return el.getBoundingClientRect().height + cssPx(el, 'margin-top', 0) + cssPx(el, 'margin-bottom', 0);
}

/** `items` cut into columns of `perCol`, in order. */
export function columnsOf<T>(items: readonly T[], cols: number): T[][] {
  const per = Math.max(1, Math.ceil(items.length / Math.max(1, cols)));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += per) out.push(items.slice(i, i + per));
  return out.length === 0 ? [[]] : out;
}

/** A fit column never draws its lengths smaller than this share of the UI scale; under it, it clips. */
export const MIN_FIT = 0.6;
const FIT_STEP = 0.01;

/**
 * The scale a column draws at so its content fits `available`: `content` is
 * how tall it measured drawn at `fit`, and every length in it is a multiple of
 * that scale, so at 1 it would be `content / fit`. The largest hundredth that
 * fits, at most 1. A rise of a single step is not taken: text that rewraps at
 * the new size could take it straight back, and the column would flicker.
 */
export function fitScale(content: number, fit: number, available: number): number {
  if (!(content > 0) || !(available > 0) || !(fit > 0)) return 1;
  const fits = Math.min(1, Math.floor(((available * fit) / content) / FIT_STEP + 1e-9) * FIT_STEP);
  const next = Math.max(MIN_FIT, Math.round(fits * 100) / 100);
  return next > fit && next - fit < 2 * FIT_STEP - 1e-9 ? fit : next;
}

/** How tall `el`'s children reach inside its content box, whatever the box's own height. */
function contentHeight(el: HTMLElement): number {
  const style = getComputedStyle(el);
  const top = el.getBoundingClientRect().top + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.paddingTop) || 0);
  let bottom = top;
  for (const child of el.children) bottom = Math.max(bottom, child.getBoundingClientRect().bottom + cssPx(child, 'margin-bottom', 0));
  return bottom - top;
}

/**
 * A column that fits its box (`fitScale`): give it the `fit-scale` class and
 * this ref. It writes `--fit` on the element whenever the box or anything in
 * it changes size.
 */
export function useFitScale(): (el: HTMLElement | null) => void {
  const observer = useRef<ResizeObserver | null>(null);
  return useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const watched = new Set<Element>();
    const measure = (): void => {
      const fit = parseFloat(el.style.getPropertyValue('--fit')) || 1;
      const style = getComputedStyle(el);
      const available = el.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
      const next = fitScale(contentHeight(el), fit, available);
      if (next !== fit) el.style.setProperty('--fit', String(next));
      for (const child of el.children) {
        if (watched.has(child)) continue;
        watched.add(child);
        observer.current?.observe(child);
      }
    };
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
    measure();
  }, []);
}

/**
 * The box an element draws in, kept current, and the element: give it the
 * ref. Zero until it has been measured (and in a test environment).
 */
export function useBox<E extends HTMLElement = HTMLElement>(): [(el: E | null) => void, Box, E | null] {
  const [el, setEl] = useState<E | null>(null);
  const [box, setBox] = useState<Box>({ width: 0, height: 0 });
  useLayoutEffect(() => {
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
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [el]);
  return [setEl, box, el];
}

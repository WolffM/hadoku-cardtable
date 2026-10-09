/**
 * A graveyard or an exile, opened: every card of the pile laid out whole, over the board beside the
 * pile it came from. The operator, 2026-10-09: *"i need some solution for when the graveyard and exile
 * get very large. i dont necessarily want to make them scrollable, but i do need a way to reach certain
 * cards which is currently impossible."* — the pile on the board squeezes each buried card's name
 * strip toward nothing once it outgrows its box (`board.css`, the pile section), so a card in the
 * middle could be neither read nor clicked.
 *
 * What it is and is not:
 *
 *   - **The board's own cards.** `Board.tsx` hands this the pile's `CardOnBoard`s, so a card here
 *     carries the same `data-card-id` the inspector keys on (one expanded view, never a second) and
 *     the same `onClick` a Forge-offered card answers with on the board. While this is open a pile
 *     card's id is on two elements; the pile's own comes first in the document, so every
 *     `querySelector` by id still finds the board's.
 *   - **Never a scroller.** The cards are battlefield size (`card-size.ts`, the one source of a card's
 *     size) and shrink together until every one fits the room beside the pile, down to
 *     `PILE_MIN_CARD_W`; past that the panel clips. It draws inside `[data-board-overlay]`, which is
 *     `overflow: clip`, so it can never widen the board either.
 *   - **Local.** Nothing here is sent: it is this screen's look at a public zone.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { battlefieldCardWidth } from './card-size.ts';
import './pile-view.css';

/** A card's height over its width — `card.css`'s 488 × 680. */
const CARD_TALL = 680 / 488;
/** Space between cards, and between the panel and anything it stands beside, in px. */
export const PILE_GAP = 6;
/** The narrowest a card in the view is drawn, in px: the inspector reads it at any size, but below this there is no card left to point at. */
export const PILE_MIN_CARD_W = 40;

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PileFit {
  cardW: number;
  cols: number;
  rows: number;
}

/**
 * The largest card width, never above `preferredW`, at which `count` cards in rows fit `room` — and
 * the columns that width is laid out in. Below `PILE_MIN_CARD_W` it stays at the minimum, in as many
 * columns as the width takes.
 */
export function fitPile(count: number, preferredW: number, room: { width: number; height: number }, gap = PILE_GAP): PileFit {
  const n = Math.max(1, count);
  let best: PileFit = { cardW: 0, cols: n, rows: 1 };
  for (let rows = 1; rows <= n; rows += 1) {
    const cols = Math.ceil(n / rows);
    const w = Math.min(preferredW, (room.width - (cols - 1) * gap) / cols, (room.height - (rows - 1) * gap) / (rows * CARD_TALL));
    if (w > best.cardW) best = { cardW: w, cols, rows: Math.ceil(n / cols) };
  }
  if (best.cardW >= PILE_MIN_CARD_W) return { ...best, cardW: Math.floor(best.cardW) };
  const cols = Math.max(1, Math.min(n, Math.floor((room.width + gap) / (PILE_MIN_CARD_W + gap))));
  return { cardW: PILE_MIN_CARD_W, cols, rows: Math.ceil(n / cols) };
}

/**
 * Where a panel of `size` stands: just past the pile's right edge, centred on it vertically, and
 * shifted as little as needed to stay a `gap` inside `bounds`. Client coordinates in, client out.
 */
export function placePile(pile: Box, bounds: Box, size: { width: number; height: number }, gap = PILE_GAP): { left: number; top: number } {
  const left = Math.max(bounds.left + gap, Math.min(pile.right + gap, bounds.right - gap - size.width));
  const centre = (pile.top + pile.bottom) / 2 - size.height / 2;
  const top = Math.max(bounds.top + gap, Math.min(centre, bounds.bottom - gap - size.height));
  return { left, top };
}

type Layout = PileFit & { left: number; top: number };

export function PileView({
  ownerSide,
  zone,
  label,
  count,
  onClose,
  children,
}: {
  ownerSide: 'you' | 'them';
  zone: 'graveyard' | 'exile';
  label: string;
  count: number;
  onClose: () => void;
  /** The pile's cards, top of the pile first. */
  children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const pileSelector = `.seat [data-zone="${zone}"][data-owner="${ownerSide}"]`;

  useLayoutEffect(() => {
    const measure = (): void => {
      const el = panel.current;
      const overlay = el?.parentElement;
      const board = el?.closest('.board');
      const pile = board?.querySelector(pileSelector);
      if (el === null || el === undefined || overlay === null || overlay === undefined || board === null || board === undefined || pile === null || pile === undefined) return;
      const bounds = overlay.getBoundingClientRect();
      const from = pile.getBoundingClientRect();
      const css = getComputedStyle(el);
      const head = el.firstElementChild?.getBoundingClientRect().height ?? 0;
      const chromeW = Number.parseFloat(css.paddingLeft) + Number.parseFloat(css.paddingRight) + Number.parseFloat(css.borderLeftWidth) + Number.parseFloat(css.borderRightWidth);
      const chromeH =
        Number.parseFloat(css.paddingTop) + Number.parseFloat(css.paddingBottom) + Number.parseFloat(css.borderTopWidth) + Number.parseFloat(css.borderBottomWidth) + head + PILE_GAP;
      const preferred = battlefieldCardWidth(board, ownerSide) ?? battlefieldCardWidth(board, 'you') ?? PILE_MIN_CARD_W * 2;
      const room = {
        width: bounds.right - Math.min(from.right + PILE_GAP, bounds.right) - PILE_GAP - chromeW,
        height: bounds.height - 2 * PILE_GAP - chromeH,
      };
      const fit = fitPile(count, preferred, room);
      const size = {
        width: chromeW + fit.cols * fit.cardW + (fit.cols - 1) * PILE_GAP,
        height: chromeH + fit.rows * fit.cardW * CARD_TALL + (fit.rows - 1) * PILE_GAP,
      };
      const at = placePile(from, bounds, size);
      setLayout({ ...fit, left: at.left - bounds.left, top: at.top - bounds.top });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [count, ownerSide, pileSelector]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    // A press anywhere but the view — or the pile that opened it, whose own click toggles it — closes it.
    const onPress = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (panel.current?.contains(target) === true || target.closest(pileSelector) !== null) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPress, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPress, true);
    };
  }, [onClose, pileSelector]);

  const style =
    layout === null
      ? ({ visibility: 'hidden' } as CSSProperties)
      : ({ left: `${layout.left}px`, top: `${layout.top}px`, '--card-w': `${layout.cardW}px`, '--pile-cols': layout.cols } as CSSProperties);
  return (
    <section ref={panel} className="pile-view" data-testid="pile-view" data-zone-view={zone} data-owner={ownerSide} aria-label={label} style={style}>
      <header className="pile-view__head">
        <span>{label}</span>
        <span className="pile-view__count">{count}</span>
      </header>
      <ul className="pile-view__cards">{children}</ul>
    </section>
  );
}

/**
 * A question's card grid sized to the room its column has, so the sheet never scrolls.
 *
 * The operator, 2026-10-22, on Masticore's upkeep discard: *"i see TWO scroll bars, there should be
 * zero"* — the head scrolled its trigger text and the body scrolled seven cards. The column the
 * sheet sits in (`.live__prompt`, `../live/live.css`) has a definite height, so the room left for
 * the grid is known: the column less everything else the sheet draws. The tiles take the largest
 * width at which every one of them fits that room, in whichever column count gives it.
 *
 * Measured, not computed from CSS: a tile is its card plus a padded frame and a label, so a tile's
 * height is linear in its width (`extraH + width × aspect`), and one drawn tile gives both terms.
 */

/** A card's height over its width: `.prompt__cards .card`'s `aspect-ratio` (`prompts.css`). */
export const CARD_ASPECT = 680 / 488;

/** The widest a question's card is drawn, in rem: the prompt's own tile size (`prompts.css`'s `--card-w`). */
const MAX_CARD_REM = 7;

export interface GridRoom {
  /** The room the grid may fill, in px. */
  width: number;
  height: number;
  /** How many tiles it draws. */
  count: number;
  /** The grid's gap, in px. */
  gap: number;
  /** A tile's width and height beyond its card's: frame, padding and label. */
  extraW: number;
  extraH: number;
  /** The widest a tile's card is drawn, whatever the room: the grid's own `--card-w`. */
  maxCard: number;
}

export interface GridFit {
  cols: number;
  /** Each tile's width, frame included, in px. */
  tileW: number;
}

/** The column count and tile width at which `count` tiles fit `width × height` with the largest cards. */
export function fitCardGrid(room: GridRoom): GridFit {
  const { width, height, count, gap, extraW, extraH, maxCard } = room;
  let best: GridFit & { card: number } = { cols: 1, tileW: 0, card: -Infinity };
  for (let cols = 1; cols <= Math.max(1, count); cols++) {
    const rows = Math.ceil(count / cols);
    const byWidth = (width - (cols - 1) * gap) / cols - extraW;
    const byHeight = ((height - (rows - 1) * gap) / rows - extraH) / CARD_ASPECT;
    const card = Math.min(byWidth, byHeight, maxCard);
    if (card > best.card) best = { cols, tileW: Math.floor(card + extraW), card };
  }
  if (best.card > 0) return { cols: best.cols, tileW: best.tileW };
  // No room at all (the sheet's other content fills the column): the grid's own size, and the body scrolls.
  // Never a column of slivers, which is what this answered once (the operator, 2026-10-23, Goblin Matron).
  const cols = Math.max(1, Math.min(count, Math.floor((width + gap) / (maxCard + extraW + gap))));
  return { cols, tileW: Math.floor(Math.min(maxCard, (width - (cols - 1) * gap) / cols - extraW) + extraW) };
}

/**
 * Fit the one card grid in `sheet`, a sheet drawn in the live question column; a no-op anywhere
 * else (the draft table's grids keep their own wrap) or when the sheet holds no grid or several.
 */
export function fitSheetGrid(sheet: HTMLElement): void {
  const column = sheet.parentElement;
  if (column === null || !column.classList.contains('live__prompt')) return;
  const body = sheet.querySelector<HTMLElement>(':scope > .prompt__body');
  const grids = sheet.querySelectorAll<HTMLElement>('.prompt__cards');
  if (body === null || grids.length !== 1) return;
  const grid = grids[0]!;
  const tiles = [...grid.children].filter((li): li is HTMLElement => li instanceof HTMLElement && !li.classList.contains('prompt__divider'));
  const tile = tiles[0];
  const card = tile?.querySelector<HTMLElement>('.card');
  if (tile === undefined || card === null || card === undefined) return;
  const tileBox = tile.getBoundingClientRect();
  const cardW = card.getBoundingClientRect().width;
  if (tileBox.width <= 0 || cardW <= 0) return;
  const style = getComputedStyle(grid);
  // Everything the sheet draws but the grid: its head, actions, padding and gaps, and the body's
  // other content. The body's own height is what it SHOWS (it may be clipped); its scroll height
  // less the grid is what else it holds.
  const others = sheet.offsetHeight - body.clientHeight + (body.scrollHeight - grid.offsetHeight);
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const fit = fitCardGrid({
    width: grid.clientWidth,
    height: column.clientHeight - others,
    count: tiles.length,
    gap: Number.parseFloat(style.rowGap) || 0,
    extraW: tileBox.width - cardW,
    extraH: tileBox.height - cardW * CARD_ASPECT,
    maxCard: MAX_CARD_REM * rem,
  });
  const cols = String(fit.cols);
  const tileW = `${fit.tileW}px`;
  if (grid.dataset.fit === `${cols}x${tileW}`) return;
  grid.dataset.fit = `${cols}x${tileW}`;
  grid.style.setProperty('--fit-cols', cols);
  grid.style.setProperty('--fit-tile-w', tileW);
}

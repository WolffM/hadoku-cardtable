import { describe, expect, it } from 'vitest';

import { CARD_ASPECT, fitCardGrid } from './fit-cards.ts';

const room = { gap: 6, extraW: 10, extraH: 30, maxCard: 112 };
const tileH = (tileW: number) => (tileW - room.extraW) * CARD_ASPECT + room.extraH;
const fits = (width: number, height: number, count: number) => {
  const fit = fitCardGrid({ ...room, width, height, count });
  const rows = Math.ceil(count / fit.cols);
  return { ...fit, rows, w: fit.cols * fit.tileW + (fit.cols - 1) * room.gap, h: rows * tileH(fit.tileW) + (rows - 1) * room.gap };
};

describe('fitCardGrid', () => {
  it('seven cards in the 230 × 300 room Masticore’s discard had: every tile inside it', () => {
    const f = fits(230, 300, 7);
    expect(f.w).toBeLessThanOrEqual(230);
    expect(f.h).toBeLessThanOrEqual(300);
    expect(f.cols * f.rows).toBeGreaterThanOrEqual(7);
  });

  it('picks the column count that draws the largest cards', () => {
    // A wide, short room lays the cards out in one row rather than stacking them.
    expect(fits(800, 200, 4).cols).toBe(4);
    // A tall, narrow one stacks them.
    expect(fits(130, 900, 4).cols).toBe(1);
  });

  it('never draws a card wider than the grid’s own size, however much room there is', () => {
    expect(fitCardGrid({ ...room, width: 2000, height: 2000, count: 2 }).tileW).toBe(112 + room.extraW);
  });

  it('one card fills the room the same way', () => {
    const f = fits(230, 120, 1);
    expect(f.h).toBeLessThanOrEqual(120);
    expect(f.cols).toBe(1);
  });
});

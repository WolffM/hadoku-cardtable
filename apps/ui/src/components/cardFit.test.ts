import { describe, expect, it } from 'vitest';

import { CARD_RATIO, MIN_CARD_W, PILE_PEEK, columnsOf, fitGrid, fitPiles, gridAt, largestCard, pilesAt } from './cardFit.ts';

const H = (w: number): number => w / CARD_RATIO;

describe('a grid of cards fits its box: no scroll either way', () => {
  // A pack's half at 1280×800 and 1366×768, a narrow window, a wide one.
  const BOXES = [
    { width: 992, height: 300 },
    { width: 1078, height: 280 },
    { width: 600, height: 300 },
    { width: 1700, height: 420 },
  ];
  for (const box of BOXES) {
    for (const count of [1, 8, 15]) {
      it(`${count} cards in ${box.width}x${box.height}`, () => {
        const g = fitGrid(count, box, 10, 300);
        expect(g.cols * g.cardW + (g.cols - 1) * 10).toBeLessThanOrEqual(box.width + 0.5);
        expect(g.rows * H(g.cardW) + (g.rows - 1) * 10).toBeLessThanOrEqual(box.height + 0.5);
        expect(g.cols * g.rows).toBeGreaterThanOrEqual(count);
        // The largest that fits: a pixel wider does not.
        if (g.cardW < 300) expect(gridAt(count, g.cardW + 1, box.width, 10).height).toBeGreaterThan(box.height);
      });
    }
  }

  it('takes more rows when that gives larger cards, instead of scrolling sideways', () => {
    // 15 cards in a short wide box are two rows; in a tall narrow one, more.
    expect(fitGrid(15, { width: 1600, height: 300 }, 10, 300).rows).toBe(2);
    expect(fitGrid(15, { width: 500, height: 900 }, 10, 300).rows).toBeGreaterThan(2);
  });
});

describe('piles of cards fit their box: a tall pile splits into side-by-side columns', () => {
  it('splits the tallest pile first', () => {
    const at = pilesAt([12, 2, 3], 80, 5 * 80 + 4 * 8, 8);
    expect(at.cols).toEqual([3, 1, 1]);
    expect(at.perCol).toBe(4);
    expect(at.height).toBeCloseTo(H(80) + 3 * 80 * PILE_PEEK);
  });

  it('cannot fit when the piles outnumber the columns', () => {
    expect(pilesAt([1, 1, 1], 100, 250, 8).height).toBe(Infinity);
  });

  // A full draft's picks (45 cards in colour piles plus a sideboard) in the picks half at 1280×800 and 1366×768.
  const FULL = [9, 8, 7, 8, 6, 4, 3, 0];
  for (const box of [
    { width: 992, height: 250 },
    { width: 1078, height: 230 },
  ]) {
    it(`a full pool in ${box.width}x${box.height} at a legible size`, () => {
      const f = fitPiles(FULL, box, 12, 140);
      const columns = f.cols.reduce((a, b) => a + b, 0);
      expect(columns * f.cardW + (columns - 1) * 12).toBeLessThanOrEqual(box.width + 0.5);
      expect(f.height).toBeLessThanOrEqual(box.height + 0.5);
      expect(f.cardW).toBeGreaterThanOrEqual(60);
    });
  }
});

describe('largestCard', () => {
  it('is the cap when the cap fits, the floor when nothing does', () => {
    expect(largestCard(() => true, 140)).toBe(140);
    expect(largestCard(() => false, 140)).toBe(MIN_CARD_W);
  });

  it('finds the edge to a tenth of a pixel', () => {
    const w = largestCard((x) => x <= 77.77, 140);
    expect(w).toBeLessThanOrEqual(77.77);
    expect(w).toBeGreaterThan(77.6);
  });
});

describe('columnsOf', () => {
  it('cuts in order, evenly', () => {
    expect(columnsOf([1, 2, 3, 4, 5], 2)).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
    expect(columnsOf([], 1)).toEqual([[]]);
  });
});

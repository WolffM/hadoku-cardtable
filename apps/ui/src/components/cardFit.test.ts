import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CARD_RATIO, MIN_CARD_W, MIN_FIT, PILE_PEEK, columnsOf, fitGrid, fitPiles, fitScale, gridAt, largestCard, pilesAt } from './cardFit.ts';

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

describe('a column of controls fits its box: its lengths scale down instead of scrolling', () => {
  // The draft's side column with 44 picks, as main's run measured it: 749px of content in 647 (1280x800) and 615 (1366x768).
  it('draws at the largest step at which its content fits, from what it measured at the scale it is drawn at', () => {
    for (const available of [647, 615]) {
      const fit = fitScale(749, 1, available);
      expect(749 * fit, `${available}`).toBeLessThanOrEqual(available);
      expect(749 * (fit + 0.01), `${available}: one step larger would not fit`).toBeGreaterThan(available);
    }
    // Measured again at the scale it now draws at, it stays there: the answer is a fixed point.
    const fit = fitScale(749, 1, 647);
    expect(fitScale(749 * fit, fit, 647)).toBe(fit);
  });

  it('is 1 when the content fits, and grows back to 1 when the box does', () => {
    expect(fitScale(500, 1, 647)).toBe(1);
    expect(fitScale(600, 0.8, 800)).toBe(1);
  });

  it('a one-step rise is not taken, so text that rewraps cannot flip it back and forth', () => {
    const fit = fitScale(749, 1, 647);
    expect(fitScale(647 - 2, fit, 647), 'room for one more step, not two').toBe(fit);
  });

  it('never below its floor, and 1 for a box or content not measured yet', () => {
    expect(fitScale(2000, 1, 300)).toBe(MIN_FIT);
    expect(fitScale(0, 1, 647)).toBe(1);
    expect(fitScale(749, 1, 0)).toBe(1);
  });

  it("the draft's side column is such a column, and never shows a scroll bar", () => {
    const sheet = (name: string): string => readFileSync(resolve(import.meta.dirname ?? 'apps/ui/src/components', name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const aside = /\.draft__aside \{([^}]*)\}/.exec(sheet('draft.css'))?.[1] ?? '';
    expect(aside).not.toMatch(/overflow(-y)?:\s*(auto|scroll)/);
    const fit = /\.fit-scale \{([^}]*)\}/.exec(sheet('../styles.css'))?.[1] ?? '';
    expect(fit, 'a fit column redefines the UI scale\'s units, so every length inside it follows').toMatch(/--ui-px:[^;]*var\(--fit/);
    expect(fit).toMatch(/--ui-rem:[^;]*var\(--fit/);
  });
});

// A text tile (no art yet, or none at all, as on CI) at a small fit has more rules text than room: it is cut
// off and faded in its own box, never a scroll bar inside a card (e2e/dr-draft-picks.spec.ts at 1366×768).
describe("a card's rules text fits its tile at any size", () => {
  const sheets = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sheets(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []));
  const SRC = resolve(import.meta.dirname ?? 'apps/ui/src/components', '..');

  it('one rule clips it in every face, and no sheet lets it scroll', () => {
    const rules = sheets(SRC).flatMap((file) =>
      [...readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*\.card__rules\b[^{}]*)\{([^}]*)\}/g)].map((m) => ({ file, selector: m[1]!.trim(), body: m[2]! })),
    );
    expect(rules.filter((r) => /overflow(-[xy])?:\s*(auto|scroll)/.test(r.body)).map((r) => `${r.file}: ${r.selector}`)).toEqual([]);
    const base = rules.find((r) => r.selector === '.card__rules')!.body;
    expect(base).toMatch(/overflow:\s*hidden/);
    expect(base, 'a flex item shrinks to its box instead of growing the tile').toMatch(/min-height:\s*0/);
  });
});

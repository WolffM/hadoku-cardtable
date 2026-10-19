import { describe, expect, it } from 'vitest';

import { FAN_MIN_WIDTH, fanFocusAt, fanGeometry, fanLayer, gridGeometry } from './PackView.tsx';

// The operator's window, a laptop, a wide screen, and the narrowest a fan is drawn at.
const BOXES = [
  { width: 1050, height: 640 },
  { width: 600, height: 300 },
  { width: 1400, height: 600 },
  { width: FAN_MIN_WIDTH, height: 300 },
];

/** Every card's left and right edge, in the box's coordinates (the slot sits on the centre line). */
const edges = (width: number, cardW: number, xs: number[]) => xs.map((x) => ({ left: width / 2 + x - cardW / 2, right: width / 2 + x + cardW / 2 }));

describe('the fan fits the box it is drawn in', () => {
  for (const { width, height } of BOXES) {
    it(`keeps every card of 1-15 inside ${width}x${height}`, () => {
      for (let count = 1; count <= 15; count++) {
        const fan = fanGeometry(count, width, height);
        expect(fan.cardH + 30, `${count} cards: tall`).toBeLessThanOrEqual(height + 0.5);
        for (const e of edges(width, fan.cardW, fan.xs)) {
          expect(e.left, `${count} cards`).toBeGreaterThanOrEqual(-0.5);
          expect(e.right, `${count} cards`).toBeLessThanOrEqual(width + 0.5);
        }
      }
    });
  }

  it('shows every card a name’s worth', () => {
    for (const { width, height } of BOXES) {
      const fan = fanGeometry(15, width, height);
      expect(fan.step).toBeGreaterThanOrEqual(fan.cardW * 0.17 - 0.01);
    }
  });

  it('puts the middle card of a pack in the middle', () => {
    for (const count of [15, 14, 9, 1]) {
      const fan = fanGeometry(count, 1050, 640);
      expect(fan.xs[Math.floor((count - 1) / 2)]!).toBeLessThanOrEqual(fan.step / 2 + 1e-9);
    }
  });
});

describe('the open card', () => {
  it('is on top of every card it overlaps, wherever it is', () => {
    const fan = fanGeometry(15, 1050, 640);
    const e = edges(1050, fan.cardW, fan.xs);
    for (let open = 0; open < 15; open++) {
      for (let j = 0; j < 15; j++) {
        if (j === open || e[j]!.right <= e[open]!.left || e[j]!.left >= e[open]!.right) continue;
        expect(fanLayer(j, open, 15), `card ${j} vs open ${open}`).toBeLessThan(fanLayer(open, open, 15));
      }
    }
  });

  it('leaves each other card its far-side strip: covered by its neighbour toward the open card, never away from it', () => {
    for (let open = 0; open < 15; open++) {
      for (let j = 0; j < 15; j++) {
        if (j === open) continue;
        const toward = j < open ? j + 1 : j - 1;
        const away = j < open ? j - 1 : j + 1;
        expect(fanLayer(toward, open, 15)).toBeGreaterThan(fanLayer(j, open, 15));
        if (away >= 0 && away < 15) expect(fanLayer(away, open, 15)).toBeLessThan(fanLayer(j, open, 15));
      }
    }
  });
});

describe('which card the pointer is on', () => {
  const width = 1050;
  const fan = fanGeometry(15, width, 640);

  it('is one card per step, the same moving right as moving left', () => {
    const at = (i: number) => width / 2 + fan.xs[i]!;
    expect(fan.xs.map((_, i) => fanFocusAt(fan, at(i), width))).toEqual(fan.xs.map((_, i) => i));
    // Half a step either side of a card's place is still that card.
    for (let i = 1; i < 14; i++) {
      expect(fanFocusAt(fan, at(i) - fan.step * 0.49, width)).toBe(i);
      expect(fanFocusAt(fan, at(i) + fan.step * 0.49, width)).toBe(i);
    }
  });

  it('is over the card it opens, anywhere along the row', () => {
    const e = edges(width, fan.cardW, fan.xs);
    for (let x = e[0]!.left; x <= e[14]!.right; x += 3) {
      const open = fanFocusAt(fan, x, width);
      expect(x).toBeGreaterThanOrEqual(e[open]!.left - 0.01);
      expect(x).toBeLessThanOrEqual(e[open]!.right + 0.01);
    }
  });

  it('clamps past either end to the end card', () => {
    expect(fanFocusAt(fan, -50, width)).toBe(0);
    expect(fanFocusAt(fan, width + 50, width)).toBe(14);
  });
});

describe('the grid shows a whole pack without scrolling', () => {
  for (const { width, height } of BOXES) {
    it(`fits 15 cards in ${width}x${height}`, () => {
      const { cols, cardW } = gridGeometry(15, width, height);
      const rows = Math.ceil(15 / cols);
      expect(cols * cardW + (cols - 1) * 10).toBeLessThanOrEqual(width + 0.5);
      expect(rows * (cardW / (488 / 680)) + (rows - 1) * 10).toBeLessThanOrEqual(height + 0.5);
    });
  }
});

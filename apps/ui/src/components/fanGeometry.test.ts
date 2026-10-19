import { describe, expect, it } from 'vitest';

import { FAN_MIN_WIDTH, fanFocusAt, fanGeometry, fanSlots, gridGeometry } from './PackView.tsx';

// The operator's window, a laptop, a wide screen, and the narrowest a fan is drawn at.
const BOXES = [
  { width: 1050, height: 640 },
  { width: 600, height: 300 },
  { width: 1400, height: 600 },
  { width: FAN_MIN_WIDTH, height: 300 },
];

/** Every card's left and right edge, in the box's coordinates (the slot sits on the centre line). */
function edges(width: number, cardW: number, xs: number[]) {
  return xs.map((x) => ({ left: width / 2 + x - cardW / 2, right: width / 2 + x + cardW / 2 }));
}

describe('the fan fits the box it is drawn in', () => {
  for (const { width, height } of BOXES) {
    it(`keeps every card of 1-15 inside ${width}x${height}, with any card pulled open`, () => {
      for (let count = 1; count <= 15; count++) {
        const fan = fanGeometry(count, width, height);
        expect(fan.cardH + 30, `${count} cards: tall`).toBeLessThanOrEqual(height + 0.5);
        for (const focus of [null, ...fan.xs.map((_, i) => i)]) {
          for (const e of edges(width, fan.cardW, fanSlots(fan, focus))) {
            expect(e.left, `${count} cards, focus ${focus}`).toBeGreaterThanOrEqual(-0.5);
            expect(e.right, `${count} cards, focus ${focus}`).toBeLessThanOrEqual(width + 0.5);
          }
        }
      }
    });
  }

  it('shows the focused card whole: the next card starts where it ends', () => {
    const fan = fanGeometry(15, 1050, 640);
    for (let focus = 0; focus < 14; focus++) {
      const xs = fanSlots(fan, focus);
      expect(xs[focus + 1]! - xs[focus]!).toBeCloseTo(fan.cardW, 5);
    }
  });

  it('shows every card a name’s worth', () => {
    for (const { width, height } of BOXES) {
      const fan = fanGeometry(15, width, height);
      expect(fan.step).toBeGreaterThanOrEqual(fan.cardW * 0.17 - 0.01);
    }
  });
});

describe('which card the pointer is on', () => {
  const width = 1050;
  const fan = fanGeometry(15, width, 640);
  const left = width / 2 + fan.xs[0]! - fan.cardW / 2;

  it('is one card per strip, moving right exactly as it moves left', () => {
    const across = Array.from({ length: 15 }, (_, i) => fanFocusAt(fan, left + (i + 0.5) * fan.step, width));
    expect(across).toEqual(Array.from({ length: 15 }, (_, i) => i));
    // Back the other way: the same bands.
    expect([...across].reverse().map((_, k) => fanFocusAt(fan, left + (14 - k + 0.5) * fan.step, width))).toEqual(
      Array.from({ length: 15 }, (_, i) => 14 - i),
    );
  });

  it('lands on the card it opened: the pointer is over the focused card wherever its band is', () => {
    for (let x = left; x < left + 14 * fan.step; x += 3) {
      const focus = fanFocusAt(fan, x, width);
      const e = edges(width, fan.cardW, fanSlots(fan, focus))[focus]!;
      expect(x, `x ${x} -> card ${focus}`).toBeGreaterThanOrEqual(e.left - 0.01);
      expect(x).toBeLessThanOrEqual(e.right + 0.01);
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

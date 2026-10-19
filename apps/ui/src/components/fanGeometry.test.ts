import { describe, expect, it } from 'vitest';

import { FAN_MIN_WIDTH, FAN_SIDE, fanGeometry, fanLayer, fanX, gridGeometry, type FanGeometry } from './PackView.tsx';

// The operator's window, a laptop, a wide screen, and the narrowest a fan is drawn at.
const BOXES = [
  { width: 1050, height: 640 },
  { width: 600, height: 300 },
  { width: 1400, height: 600 },
  { width: FAN_MIN_WIDTH, height: 300 },
];

/** Every drawn card's left and right edge with `open` open, in the box's coordinates (the slot sits on the centre line). */
const edges = (width: number, fan: FanGeometry, count: number, open: number) =>
  Array.from({ length: count }, (_, i) => fanX(fan, i, open)).flatMap((x) => (x === null ? [] : [{ left: width / 2 + x - fan.cardW / 2, right: width / 2 + x + fan.cardW / 2 }]));

describe('the fan fits the box it is drawn in', () => {
  for (const { width, height } of BOXES) {
    it(`keeps every drawn card of a 15-card pack inside ${width}x${height}, whichever card is open`, () => {
      const fan = fanGeometry(width, height);
      expect(fan.cardH + 30).toBeLessThanOrEqual(height + 0.5);
      for (let open = 0; open < 15; open++) {
        for (const e of edges(width, fan, 15, open)) {
          expect(e.left, `open ${open}`).toBeGreaterThanOrEqual(-0.5);
          expect(e.right, `open ${open}`).toBeLessThanOrEqual(width + 0.5);
        }
      }
    });
  }

  it('shows every drawn card a name’s worth', () => {
    for (const { width, height } of BOXES) {
      const fan = fanGeometry(width, height);
      expect(fan.step).toBeGreaterThanOrEqual(fan.cardW * 0.17 - 0.01);
    }
  });
});

describe('the row scrolls through the pack', () => {
  const fan = fanGeometry(1050, 640);

  it('puts the open card in the middle and draws FAN_SIDE cards either side of it, no more', () => {
    for (let open = 0; open < 15; open++) {
      expect(fanX(fan, open, open)).toBe(0);
      const drawn = Array.from({ length: 15 }, (_, i) => i).filter((i) => fanX(fan, i, open) !== null);
      expect(drawn).toEqual(Array.from({ length: 15 }, (_, i) => i).filter((i) => Math.abs(i - open) <= FAN_SIDE));
    }
  });

  it('keeps the drawn cards in pack order, one step apart', () => {
    const xs = Array.from({ length: 15 }, (_, i) => fanX(fan, i, 7)).filter((x): x is number => x !== null);
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeCloseTo(fan.step);
  });
});

describe('the open card', () => {
  it('is on top of every card it overlaps, wherever it is', () => {
    for (let open = 0; open < 15; open++) {
      for (let j = 0; j < 15; j++) {
        if (j === open) continue;
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

import { describe, expect, it } from 'vitest';

import { FAN_MIN_WIDTH, fanGeometry, fanLayer, fanX, packRowHeight, POOL_MIN_H, type FanGeometry } from './PackView.tsx';

// The operator's window, a laptop, a wide screen, and the narrowest a fan is drawn at.
const BOXES = [
  { width: 1050, height: 640 },
  { width: 600, height: 300 },
  { width: 1400, height: 600 },
  { width: FAN_MIN_WIDTH, height: 300 },
];

/** Every drawn card's left and right edge with `open` open, in the box's coordinates (the slot sits on the centre line). */
const edges = (width: number, fan: FanGeometry, count: number, open: number) =>
  Array.from({ length: count }, (_, i) => fanX(fan, i, open, count)).flatMap((x) => (x === null ? [] : [{ left: width / 2 + x - fan.cardW / 2, right: width / 2 + x + fan.cardW / 2 }]));

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
  const drawn = (open: number, count = 15) => Array.from({ length: count }, (_, i) => i).filter((i) => fanX(fan, i, open, count) !== null);

  it('draws seven cards: from the first while the open card is near the start, the open one in the middle after, and the last seven at the end', () => {
    expect(drawn(0)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(drawn(3)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(drawn(7)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(fanX(fan, 7, 7, 15)).toBe(0);
    expect(drawn(14)).toEqual([8, 9, 10, 11, 12, 13, 14]);
  });

  it('draws a pack shorter than the row whole, and centred', () => {
    expect(drawn(0, 3)).toEqual([0, 1, 2]);
    expect(fanX(fan, 1, 0, 3)).toBe(0);
  });

  it('keeps the drawn cards in pack order, one step apart', () => {
    for (const open of [0, 7, 14]) {
      const xs = Array.from({ length: 15 }, (_, i) => fanX(fan, i, open, 15)).filter((x): x is number => x !== null);
      for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeCloseTo(fan.step);
    }
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

/*
 * Browser zoom, modelled the way Chrome does it: at zoom z a W×H window lays out W/z × H/z CSS px and
 * draws each at z screen pixels. The draft's body is the window less its padding (`draft.css`), the pack
 * row is `packRowHeight` of it across the whole width, and what the player sees is CSS px × z.
 */
describe('the fan row follows the browser zoom', () => {
  const PAD = 24;
  const seen = (width: number, height: number, zoom: number) => {
    const body = height / zoom - PAD;
    const row = packRowHeight(body);
    const fan = fanGeometry(width / zoom - 32, row);
    return { cardPx: fan.cardW * zoom, rowPx: row * zoom, poolCss: body - row };
  };
  // Zooming further in on a laptop, the picks' row reaches its floor first and the fan gives way to it.
  for (const [width, height, zooms] of [
    [1920, 1080, [0.67, 0.8, 1, 1.25, 1.5]],
    [1280, 800, [0.67, 0.8, 1, 1.25]],
    [1366, 768, [0.67, 0.8, 1, 1.25]],
  ] as const) {
    it(`at ${width}×${height}, zooming in grows the row and its cards on screen, and zooming out shrinks them (${zooms.join(', ')})`, () => {
      const at = zooms.map((z) => seen(width, height, z));
      for (let i = 1; i < at.length; i++) {
        expect(at[i]!.cardPx, `zoom ${zooms[i - 1]} → ${zooms[i]}`).toBeGreaterThan(at[i - 1]!.cardPx);
        expect(at[i]!.rowPx, `zoom ${zooms[i - 1]} → ${zooms[i]}`).toBeGreaterThan(at[i - 1]!.rowPx);
      }
    });

    it(`at ${width}×${height}, the picks' row keeps its room at every zoom`, () => {
      for (const z of [...zooms, 1.5, 2]) expect(seen(width, height, z).poolCss, `zoom ${z}`).toBeGreaterThanOrEqual(POOL_MIN_H - 0.5);
    });
  }

  it('is never taller than the largest card needs, so a tall window gives the rest to the picks', () => {
    const tallest = fanGeometry(4000, 10_000);
    expect(packRowHeight(3000)).toBeLessThanOrEqual(tallest.cardH + 30 + 0.5);
    expect(fanGeometry(4000, packRowHeight(3000)).cardH).toBeCloseTo(tallest.cardH);
  });

  it("gives way to whatever the picks' row is told to keep: the pod's column at its smallest fit, when that is more than the floor", () => {
    expect(packRowHeight(600, 1, 300)).toBe(300);
    expect(packRowHeight(600)).toBe(600 - POOL_MIN_H);
    expect(packRowHeight(3000, 1, 300)).toBe(packRowHeight(3000));
  });

  it('follows the UI scale as it follows zoom: the same row, in the scale\'s units', () => {
    expect(packRowHeight(800 * 1.25, 1.25)).toBeCloseTo(packRowHeight(800) * 1.25);
  });
});

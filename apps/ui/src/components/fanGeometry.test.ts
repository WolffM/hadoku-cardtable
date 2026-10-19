import { describe, expect, it } from 'vitest';

import { FAN_MIN_WIDTH, fanGeometry } from './PackView.tsx';

/**
 * The four corners of slot `i`, in the box's own coordinates: the slot sits on
 * the centre line 30 px down (`styles.css`, `.pack--fan .pack__slot`), is
 * offset by (x, y) and rotated about its own bottom-centre.
 */
function corners(width: number, cardW: number, cardH: number, slot: { x: number; y: number; angle: number }) {
  const a = (slot.angle * Math.PI) / 180;
  const pivot = { x: width / 2 + slot.x, y: 30 + cardH + slot.y };
  return [
    [-cardW / 2, -cardH],
    [cardW / 2, -cardH],
    [-cardW / 2, 0],
    [cardW / 2, 0],
  ].map(([dx, dy]) => ({
    x: pivot.x + dx! * Math.cos(a) - dy! * Math.sin(a),
    y: pivot.y + dx! * Math.sin(a) + dy! * Math.cos(a),
  }));
}

describe('the fan fits the box it is drawn in', () => {
  // The operator's window, a laptop, a wide screen, and the narrowest a fan is drawn at.
  const boxes = [
    { width: 1050, height: 440 },
    { width: 600, height: 200 },
    { width: 1400, height: 400 },
    { width: FAN_MIN_WIDTH, height: 300 },
  ];

  for (const { width, height } of boxes) {
    it(`keeps every card of 1-15 inside ${width}x${height}`, () => {
      for (let count = 1; count <= 15; count++) {
        const fan = fanGeometry(count, width, height);
        for (const slot of fan.slots) {
          for (const c of corners(width, fan.cardW, fan.cardH, slot)) {
            expect(c.x, `${count} cards: x`).toBeGreaterThanOrEqual(-0.5);
            expect(c.x, `${count} cards: x`).toBeLessThanOrEqual(width + 0.5);
            expect(c.y, `${count} cards: y`).toBeLessThanOrEqual(height + 0.5);
          }
        }
      }
    });
  }

  it('shows every card a name’s worth, and lets a full pack spread across a wide box', () => {
    const fan = fanGeometry(15, 1050, 440);
    const step = fan.slots[1]!.x - fan.slots[0]!.x;
    expect(step).toBeGreaterThanOrEqual(fan.cardW * 0.17 - 0.01);
    // The pack uses the width it has, not a fixed sliver in the middle of it.
    const span = fan.slots[14]!.x - fan.slots[0]!.x + fan.cardW;
    expect(span).toBeGreaterThan(1050 * 0.8);
  });

  it('draws one card straight and centred', () => {
    expect(fanGeometry(1, 800, 400).slots).toEqual([{ x: 0, y: 0, angle: 0 }]);
  });
});

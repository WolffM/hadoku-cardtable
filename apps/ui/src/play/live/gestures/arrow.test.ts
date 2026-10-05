/*
 * The arrow's curve (`arrowShape`): every arrow on the table is one quadratic
 * curve with its head along the tangent at the tip.
 */
import { describe, expect, it } from 'vitest';
import { arrowShape } from './arrow.ts';

function parse(d: string): { x1: number; y1: number; cx: number; cy: number; x2: number; y2: number } {
  const n = d.replace(/[MQ]/g, ' ').trim().split(/\s+/).map(Number);
  return { x1: n[0]!, y1: n[1]!, cx: n[2]!, cy: n[3]!, x2: n[4]!, y2: n[5]! };
}

/** How far the control point sits off the chord, signed by the side. */
function bowOf(c: ReturnType<typeof parse>): number {
  const dx = c.x2 - c.x1;
  const dy = c.y2 - c.y1;
  const len = Math.hypot(dx, dy);
  // Cross product of the chord with (control − midpoint), over the chord's length.
  const mx = (c.x1 + c.x2) / 2;
  const my = (c.y1 + c.y2) / 2;
  return (dx * (c.cy - my) - dy * (c.cx - mx)) / len;
}

describe('arrowShape', () => {
  it('runs from the tail to the tip', () => {
    const c = parse(arrowShape(10, 20, 300, 80).d);
    expect([c.x1, c.y1, c.x2, c.y2]).toEqual([10, 20, 300, 80]);
  });

  it('bows: a rightward arrow arcs up, an upward one arcs left', () => {
    const right = parse(arrowShape(0, 100, 200, 100).d);
    expect(right.cy).toBeLessThan(100);
    const up = parse(arrowShape(100, 300, 100, 0).d);
    expect(up.cx).toBeLessThan(100);
  });

  it('always bows to the same side of its travel, so a sweeping drag never flips', () => {
    const sides = new Set<number>();
    for (let a = 0; a < 360; a += 7) {
      const r = (a * Math.PI) / 180;
      const c = parse(arrowShape(0, 0, 200 * Math.cos(r), 200 * Math.sin(r)).d);
      sides.add(Math.sign(bowOf(c)));
    }
    expect([...sides]).toEqual([-1]);
  });

  it('keeps a visible arc between neighbours and a gentle one across the table', () => {
    // Two stack items side by side — a counterspell aimed at the spell beside it.
    expect(Math.abs(bowOf(parse(arrowShape(0, 0, 60, 0).d)))).toBeCloseTo(24, 6);
    expect(Math.abs(bowOf(parse(arrowShape(0, 0, 400, 0).d)))).toBeCloseTo(88, 6);
    expect(Math.abs(bowOf(parse(arrowShape(0, 0, 1200, 0).d)))).toBeCloseTo(110, 6);
  });

  it('points the head along the curve where it arrives, not along the chord', () => {
    const { d, points } = arrowShape(0, 100, 200, 100);
    const c = parse(d);
    const [tip, b1, b2] = points.split(' ').map((p) => p.split(',').map(Number)) as [number[], number[], number[]];
    expect(tip).toEqual([200, 100]);
    const mid = { x: (b1[0]! + b2[0]!) / 2, y: (b1[1]! + b2[1]!) / 2 };
    const back = { x: tip[0]! - mid.x, y: tip[1]! - mid.y };
    const tangent = { x: c.x2 - c.cx, y: c.y2 - c.cy };
    const cos = (back.x * tangent.x + back.y * tangent.y) / (Math.hypot(back.x, back.y) * Math.hypot(tangent.x, tangent.y));
    expect(cos).toBeCloseTo(1, 9);
    // The chord is horizontal and the tangent is not: the head comes in from above.
    expect(back.y).toBeGreaterThan(0);
  });

  it('draws nothing broken for a zero-length arrow', () => {
    const { d, points } = arrowShape(5, 5, 5, 5);
    expect(d).not.toMatch(/NaN/);
    expect(points).not.toMatch(/NaN/);
  });
});

/*
 * The arrow's curve (`arrowShape`): every arrow on the table is one quadratic
 * curve with its head along the tangent at the tip.
 */
import { describe, expect, it } from 'vitest';
import { ADJACENT_PX, aimAt, arrowShape } from './arrow.ts';

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

/** The least a self-target's control point stands off the card's centre line: `BOW_MIN` in `arrow.ts`. */
const BOW_SIDE = 20;

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

/*
 * Ledger Z9 (the operator, 2026-10-07): "if cryptbreaker has two cards right
 * next to them, and it's trying to target itself and the next two cards, then
 * the arrows should be drawn on top of the card so they are actually visible."
 */
describe('aimAt', () => {
  const box = (left: number, top: number, w = 60, h = 84) => ({ left, top, right: left + w, bottom: top + h });

  it('a target across the table is hit at the nearest point of its edge, as before', () => {
    const { from, tip } = aimAt({ x: 40, y: 42 }, box(400, 300));
    expect(from).toEqual({ x: 40, y: 42 });
    expect(tip).toEqual({ x: 400, y: 300 });
  });

  it('a target right beside the source is hit at its CENTRE, so the shaft crosses the cards', () => {
    // Cryptbreaker at 10..70, the next card at 76..136: six pixels apart.
    const { tip } = aimAt({ x: 40, y: 42 }, box(76, 0));
    expect(tip).toEqual({ x: 106, y: 42 });
    expect(aimAt({ x: 40, y: 42 }, box(76 + ADJACENT_PX, 0)).tip, 'past the threshold: the edge again').toEqual({ x: 76 + ADJACENT_PX, y: 42 });
  });

  it('a card targeting itself is an arc over the card, bottom to top', () => {
    const { from, tip } = aimAt({ x: 40, y: 42 }, box(10, 0));
    expect(from).toEqual({ x: 40, y: 80 });
    expect(tip).toEqual({ x: 40, y: 4 });
    const { d } = arrowShape(from.x, from.y, tip.x, tip.y);
    expect(d, 'the bow swings it out to the side, not through the card’s middle').toMatch(/Q (\d+\.?\d*) /);
    const cx = Number(/Q (-?[\d.]+) /.exec(d)![1]);
    expect(Math.abs(cx - 40)).toBeGreaterThanOrEqual(BOW_SIDE);
  });
});

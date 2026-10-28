/*
 * The arrow's curve (`arrowShape`): every arrow on the table is one quadratic
 * curve with its head along the tangent at the tip, drawn as a tapered ribbon.
 */
import { describe, expect, it } from 'vitest';
import { ADJACENT_PX, GHOST, SOLID, SPREAD, TIP_INSET, aimAt, arrowShape } from './arrow.ts';

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
    const { d, points, shaft } = arrowShape(5, 5, 5, 5);
    expect(d).not.toMatch(/NaN/);
    expect(points).not.toMatch(/NaN/);
    expect(shaft).not.toMatch(/NaN/);
  });

  it('a ghost carries the bigger head and the wider shaft; a committed arrow the smaller', () => {
    const headOf = (weight: number): number => {
      const [tip, barb] = arrowShape(0, 100, 400, 100, weight).points.split(' ').map((p) => p.split(',').map(Number)) as [number[], number[]];
      return Math.hypot(tip[0]! - barb[0]!, tip[1]! - barb[1]!);
    };
    expect(headOf(0)).toBeCloseTo(SOLID.head, 6);
    expect(headOf(1)).toBeCloseTo(GHOST.head, 6);
    expect(headOf(0.5), 'a commit tweens between them').toBeCloseTo((SOLID.head + GHOST.head) / 2, 6);
    const widest = (weight: number): number => {
      const nums = arrowShape(0, 100, 400, 100, weight).shaft.replace(/[MLAZ]/g, ' ').trim().split(/\s+/).map(Number);
      const ys = nums.filter((_, i) => i % 2 === 1);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(widest(1)).toBeGreaterThan(widest(0));
  });

  it('the shaft stops inside the head, never past its base or short of it', () => {
    // A straight-ish arrow along +x: the shaft's furthest point is under the head, behind the tip.
    const { shaft } = arrowShape(0, 0, 400, 0);
    const xs = shaft.replace(/[MLAZ]/g, ' ').trim().split(/\s+/).map(Number).filter((_, i) => i % 2 === 0);
    const reach = Math.max(...xs);
    const base = SOLID.head * Math.cos(SPREAD);
    expect(400 - reach).toBeLessThan(base);
    expect(400 - reach).toBeGreaterThan(0);
  });
});

/*
 * Ledger Z9 (the operator, 2026-10-07): "if cryptbreaker has two cards right
 * next to them, and it's trying to target itself and the next two cards, then
 * the arrows should be drawn on top of the card so they are actually visible."
 */
describe('aimAt', () => {
  const box = (left: number, top: number, w = 60, h = 84) => ({ left, top, right: left + w, bottom: top + h });
  /** The edge point `p` of box `b`, carried `TIP_INSET` of the way to its centre: where an edge-aimed tip lands. */
  const into = (p: { x: number; y: number }, b: ReturnType<typeof box>) => ({
    x: p.x + ((b.left + b.right) / 2 - p.x) * TIP_INSET,
    y: p.y + ((b.top + b.bottom) / 2 - p.y) * TIP_INSET,
  });

  it('a target across the table is hit just inside the nearest point of its edge', () => {
    const { from, tip } = aimAt({ x: 40, y: 42 }, box(400, 300));
    expect(from).toEqual({ x: 40, y: 42 });
    expect(tip).toEqual(into({ x: 400, y: 300 }, box(400, 300)));
    expect(tip.x, 'inside the card, not on its corner').toBeGreaterThan(400);
    expect(tip.y).toBeGreaterThan(300);
  });

  it('a target right beside the source is hit at its CENTRE, so the shaft crosses the cards', () => {
    // Cryptbreaker at 10..70, the next card at 76..136: six pixels apart.
    const { tip } = aimAt({ x: 40, y: 42 }, box(76, 0));
    expect(tip).toEqual({ x: 106, y: 42 });
    expect(aimAt({ x: 40, y: 42 }, box(76 + ADJACENT_PX, 0)).tip, 'past the threshold: the edge again').toEqual(into({ x: 76 + ADJACENT_PX, y: 42 }, box(76 + ADJACENT_PX, 0)));
  });

  it('a card that is not a neighbour — the other side of the table — is hit inside its edge however close it is', () => {
    // The two front rows face each other 55px apart at 1280×800 (w46-attack: Memnite attacking Jace), closer than
    // ADJACENT_PX; the attack arrow still lands at Jace's edge, not his centre.
    expect(aimAt({ x: 40, y: 42 }, box(10, 139), { neighbours: false }).tip).toEqual(into({ x: 40, y: 139 }, box(10, 139)));
    expect(aimAt({ x: 40, y: 42 }, box(76, 0), { neighbours: false }).tip, 'even six pixels apart').toEqual(into({ x: 76, y: 42 }, box(76, 0)));
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

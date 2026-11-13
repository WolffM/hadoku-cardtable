/*
 * The arrow's curve (`arrowShape`): every arrow on the table is one quadratic
 * curve with its head along the tangent at the tip, drawn as a tapered ribbon.
 */
import { describe, expect, it } from 'vitest';
import { ADJACENT_PX, ARC_MIN, GHOST, HOP_MIN, ORIGIN_DOWN, SOLID, SPREAD, TIP_INSET, aimAt, aimBetween, arrowShape, bendToward, type Side } from './arrow.ts';

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
    expect(Math.abs(bowOf(parse(arrowShape(0, 0, 60, 0).d)))).toBeCloseTo(30, 6);
    expect(Math.abs(bowOf(parse(arrowShape(0, 0, 130, 0).d))), 'a short arrow bows at least ARC_MIN').toBeCloseTo(ARC_MIN, 6);
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

/*
 * The operator, 2026-10-30, on the counter war: "the arrows are too small and they look weird. probably
 * because the cards are too close, but something about the arrow arc algorithm still needs to be changed."
 */
describe('aimBetween: an arrow between two stack cards', () => {
  const card = (left: number, top: number, w = 116, h = 161) => ({ left, top, right: left + w, bottom: top + h });
  const length = (a: { from: { x: number; y: number }; tip: { x: number; y: number } }): number => Math.hypot(a.tip.x - a.from.x, a.tip.y - a.from.y);
  /** The head's length, tip to barb, along the curve. */
  const headOf = (a: { from: { x: number; y: number }; tip: { x: number; y: number } }): number => {
    const [tip, barb] = arrowShape(a.from.x, a.from.y, a.tip.x, a.tip.y).points.split(' ').map((p) => p.split(',').map(Number)) as [number[], number[]];
    return Math.hypot(tip[0]! - barb[0]!, tip[1]! - barb[1]!);
  };
  /** How far the curve's middle stands off its chord: the arc a player sees. */
  const arcOf = (a: { from: { x: number; y: number }; tip: { x: number; y: number } }): number => Math.abs(bowOf(parse(arrowShape(a.from.x, a.from.y, a.tip.x, a.tip.y).d))) / 2;

  it.each([
    ['side by side, 28px apart', card(100, 300), card(244, 300)],
    ['touching', card(100, 300), card(216, 300)],
    ['overlapping at their edges', card(100, 300), card(190, 330)],
    ['leftward', card(400, 300), card(300, 300)],
    ['one above the other', card(100, 300), card(110, 140)],
    ['nearly on top of each other', card(100, 300), card(104, 302)],
  ])('%s: at least HOP_MIN long, a whole head, and a real arc', (_, own, to) => {
    const aim = aimBetween(own, to);
    expect(length(aim)).toBeGreaterThanOrEqual(HOP_MIN - 0.01);
    expect(headOf(aim), 'the head is never cut down to fit').toBeCloseTo(SOLID.head, 6);
    expect(arcOf(aim), 'its middle stands well off the chord').toBeGreaterThanOrEqual(ARC_MIN / 2 - 0.01);
  });

  it.each([
    ['to its right', card(100, 300), card(244, 300)],
    ['to its left', card(400, 300), card(300, 300)],
    ['above it', card(100, 300), card(110, 140)],
    ['below it', card(100, 300), card(90, 480)],
    ['far away', card(100, 300), card(600, 300)],
    ['under it', card(100, 300), card(104, 302)],
  ])('a target %s: the arrow leaves from the card\'s top centre, a quarter of its height down', (_, own, to) => {
    expect(aimBetween(own, to).from).toEqual({ x: own.left + 58, y: 300 + 161 * ORIGIN_DOWN });
  });

  it('a close target is landed on at its middle, which no neighbour covers', () => {
    expect(aimBetween(card(100, 300), card(244, 300)).tip).toEqual({ x: 302, y: 380.5 });
  });

  it('a target far enough away is aimed at as before: just inside its own nearest edge', () => {
    const to = card(600, 300);
    expect(aimBetween(card(100, 300), to)).toEqual(aimAt({ x: 158, y: 340.25 }, to, { neighbours: false }));
  });

  it('two cards on top of each other: the arrow runs down across the target, HOP_MIN long', () => {
    expect(aimBetween(card(100, 300), card(100, 300))).toEqual({ from: { x: 158, y: 340.25 }, tip: { x: 158, y: 460.25 } });
  });
});

describe('bendToward: the side an arrow bows to', () => {
  const card = (left: number, top: number, w = 116, h = 161) => ({ left, top, right: left + w, bottom: top + h });
  const middle = (b: { left: number; top: number; right: number; bottom: number }) => ({ x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 });
  /** How far, in radians, the drawn head (the curve's tangent at the tip) turns away from the line from its base to `centre`. */
  const missOf = (aim: { from: { x: number; y: number }; tip: { x: number; y: number } }, centre: { x: number; y: number }, side: Side): number => {
    const { cx, cy, x2, y2 } = parse(arrowShape(aim.from.x, aim.from.y, aim.tip.x, aim.tip.y, 0, side).d);
    const [hx, hy] = [x2 - cx, y2 - cy];
    const hl = Math.hypot(hx, hy);
    const [bx, by] = [centre.x - (x2 - (hx / hl) * SOLID.head), centre.y - (y2 - (hy / hl) * SOLID.head)];
    return Math.abs(Math.atan2(hx * by - hy * bx, hx * bx + hy * by));
  };

  it('side -1 mirrors the bow across the chord, and the ends stay put', () => {
    const a = parse(arrowShape(100, 100, 300, 100, 0, 1).d);
    const b = parse(arrowShape(100, 100, 300, 100, 0, -1).d);
    expect([b.x1, b.y1, b.x2, b.y2]).toEqual([a.x1, a.y1, a.x2, a.y2]);
    expect(b.cx).toBeCloseTo(a.cx, 9);
    expect(b.cy - 100).toBeCloseTo(100 - a.cy, 9);
  });

  it.each([
    ['the counter war: Swan Song down onto Counterspell', card(735, 375, 128, 172), card(795, 592, 128, 172)],
    ['a target down and to the right', card(100, 100), card(400, 400)],
    ['a target down and to the left', card(400, 100), card(100, 400)],
    ['a target up and to the right', card(100, 400), card(400, 100)],
    ['a target straight right', card(100, 100), card(500, 100)],
    ['a target straight below', card(100, 100), card(100, 450)],
  ])('%s: the head points at least as near the target\'s middle as the other side would', (_, own, to) => {
    const aim = aimBetween(own, to);
    const side = bendToward(aim.from, aim.tip, middle(to));
    expect(missOf(aim, middle(to), side)).toBeLessThanOrEqual(missOf(aim, middle(to), side === 1 ? -1 : 1) + 1e-9);
  });

  it('the counter war the operator saw: the bow flips, and the head turns in toward Counterspell\'s middle', () => {
    const to = card(795, 592, 128, 172);
    const aim = aimBetween(card(735, 375, 128, 172), to);
    expect(bendToward(aim.from, aim.tip, middle(to))).toBe(-1);
    expect(missOf(aim, middle(to), -1)).toBeLessThan(missOf(aim, middle(to), 1) - 0.1);
  });

  it('a tip on the middle itself points there either way, and keeps side 1', () => {
    expect(bendToward({ x: 100, y: 100 }, { x: 300, y: 180 }, { x: 300, y: 180 })).toBe(1);
  });
});

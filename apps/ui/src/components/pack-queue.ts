/*
 * Where a draft pod's waiting packs go: the pile beside each seat, built from
 * the table's own geometry (`components/SeatBar.tsx` draws it).
 *
 * Every seat picks at its own pace (`@hadoku/draft`), so packs queue in front
 * of a slow seat. A pack is drawn as three card backs. The first four waiting
 * are always individually visible, each in its own place, never one over
 * another (the operator, 2026-10-22: "i would prefer if all the packs were
 * individually visible up to 4. from 4 on the rules are off"); from the fifth
 * on they go onto the seat itself (`packSlot`).
 *
 * The places are searched, not tabled (`pileRoom`): the four nearest the arrow
 * into the seat that clear every face, name, arrow, the counters, the panel's
 * edge and every other pile, at every turn the packs take. So no seat count and
 * no UI scale is a special case.
 */

/** The ring's radius, in the box's own units (the box is 100 wide). */
export const RING = 36;
/** Room above the top seat's face. */
const TOP = 11;
/** How far either side of a seat its arrow stops, along the ring: clear of its face (16°). */
export const CLEAR = (16 * Math.PI * RING) / 180;
/** A pack's width in box units: 10px of the panel's 264px inside, at every UI scale (both scale together). */
export const PACK = (100 * 10) / 264;
/** How long a pack takes to hop along its arrow: by its length, within these bounds. */
export const MS_PER_PX = 7;
export const FLIGHT_MIN_MS = 420;
export const FLIGHT_MAX_MS = 1100;
/** The gap between two packs sent at once, and between two packs reacting to an arrival. */
export const STAGGER_MS = 140;
export const REACT_MS = 70;
/** How long a pack takes to move to its new pose when the pile it is in changes. */
export const SHOVE_MS = 650;
/** How long a pack takes to leave its pile into its seat. */
export const LEAVE_MS = 380;

export const fixed = (n: number): string => n.toFixed(2);
export const rad = (d: number): number => (d * Math.PI) / 180;
const deg = (r: number): number => (r * 180) / Math.PI;

export interface TrackPoint {
  x: number;
  y: number;
  /** The direction of travel (increasing s), as a screen angle in degrees. */
  heading: number;
}

/**
 * The ring the seats sit on, in the box's own 0–100 units, walked clockwise
 * from the bottom by distance. Its centre sits above the box's: a seat's name
 * hangs under its face, so the bottom seat needs more room below it than the
 * top one needs above.
 */
export function ring() {
  const cy = TOP + RING;
  const length = 2 * Math.PI * RING;
  const at = (s0: number): TrackPoint => {
    const s = ((s0 % length) + length) % length;
    const a = 90 + deg(s / RING);
    return { x: 50 + RING * Math.cos(rad(a)), y: cy + RING * Math.sin(rad(a)), heading: a + 90 };
  };
  /** Points from s0 to s1 along the ring (either way round). */
  const points = (s0: number, s1: number): TrackPoint[] => {
    const steps = Math.max(2, Math.ceil(Math.abs(s1 - s0) / 1.5));
    return Array.from({ length: steps + 1 }, (_, i) => at(s0 + ((s1 - s0) * i) / steps));
  };
  /** An SVG path through `points`. */
  const path = (ps: readonly TrackPoint[]): string => ps.map((p, i) => `${i === 0 ? 'M' : 'L'} ${fixed(p.x)} ${fixed(p.y)}`).join(' ');
  return { length, at, points, path };
}

export interface PackSlot {
  /**
   * The pack's centre about the waiting seat's face, upright on screen, in pack
   * widths (the face is 4 across): `x` + toward the arrow's side, `y` + down.
   */
  x: number;
  y: number;
  /** Degrees about its centre; + turns toward the arrow's side. */
  r: number;
  /** How it moves: still, shoved about, wedged and rattling, rocking on a corner, slumped. */
  pose: 'tidy' | 'jostled' | 'jammed' | 'teeter' | 'slumped';
}

/** A pile's four places, nearest the arrowhead first, in `PackSlot`'s frame (`pileRoom` finds them). */
export type Pile = readonly { x: number; y: number }[];

/** How many packs a pile keeps in full view; every pack past them goes onto the seat. */
export const IN_VIEW = 4;

/** The turns of the packs in view, by depth: square, then askew, then shoved hard. */
const TURNS = [[3], [-3, 4], [-9, 8, -6], [-14, 12, -10, 15]];

/**
 * Where waiting pack `i` sits when `depth` are waiting. Depth is at most
 * seats − 1: the seat is looking at the one pack that is not waiting.
 *
 * The first four are always in full view, each on its own: they take the
 * pile's four places (`pileRoom`: clear of every face, name, arrow, the
 * counters and the other piles), nearest the arrowhead first, and nothing up to
 * the fourth is ever placed over another. They only turn where they stand:
 *
 *   1  one pack, square, where the arrow reaches the seat;
 *   2  two, side by side, tidy;
 *   3  a third squeezes in: all three knocked askew;
 *   4  blockage: a fourth crowds in, all four shoved hard and the newest rattling.
 *
 * From the fifth on the rules are off, and the rest go onto the seat itself:
 *
 *   5  one lands on the face, teetering;
 *   6  it is shoved up and one drops across the name;
 *   7  one slumps on the face's middle: the seat is all but buried.
 */
export function packSlot(i: number, depth: number, pile: Pile): PackSlot {
  if (i < IN_VIEW) {
    const at = pile[i]!;
    const r = TURNS[Math.min(depth, IN_VIEW) - 1]![i]!;
    const pose = depth <= 2 ? 'tidy' : depth >= IN_VIEW && i === IN_VIEW - 1 ? 'jammed' : 'jostled';
    return { x: at.x, y: at.y, r, pose };
  }
  switch (i) {
    case 4:
      if (depth >= 7) return { x: -0.75, y: -0.85, r: -16, pose: 'teeter' };
      if (depth >= 6) return { x: -0.55, y: -0.95, r: -10, pose: 'jostled' };
      return { x: -0.5, y: -0.7, r: -16, pose: 'teeter' };
    case 5:
      return { x: 0, y: 2.75, r: 84, pose: 'jostled' };
    default:
      return { x: 0.55, y: 0.05, r: 10, pose: 'slumped' };
  }
}

type Pt = readonly [number, number];
type Poly = readonly Pt[];

/** Whether two convex polygons overlap (separating axes). */
function overlaps(a: Poly, b: Poly): boolean {
  for (const poly of [a, b]) {
    for (let k = 0; k < poly.length; k++) {
      const [x1, y1] = poly[k]!;
      const [x2, y2] = poly[(k + 1) % poly.length]!;
      const nx = y2 - y1;
      const ny = x1 - x2;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const [x, y] of a) { const d = x * nx + y * ny; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
      for (const [x, y] of b) { const d = x * nx + y * ny; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
      if (a1 <= b0 || b1 <= a0) return false;
    }
  }
  return true;
}

interface Obstacle {
  poly: Poly;
  /** Its bounds, to skip the far ones cheaply. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const obstacle = (poly: Poly): Obstacle => ({
  poly,
  x0: Math.min(...poly.map((p) => p[0])),
  y0: Math.min(...poly.map((p) => p[1])),
  x1: Math.max(...poly.map((p) => p[0])),
  y1: Math.max(...poly.map((p) => p[1])),
});
const box = (x0: number, y0: number, x1: number, y1: number): Obstacle => obstacle([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);

/** A card back's height over its width (`aspect-ratio: 488 / 680`). */
const CARD_H = 680 / 488;
/** The fan inside a pack (`pack-queue.css`): each back 1.5px along and 5° round per step. */
const FAN = [-1, 0, 1].map((k) => ({ k, along: 0.15 * k, turn: 5 * k }));

/** A pack's three backs as polygons in box units: centre (x, y), turned `angle` degrees on screen. */
function packCards(x: number, y: number, angle: number): Poly[] {
  const a = rad(angle);
  return FAN.map(({ along, turn }) => {
    const cx = x + (along * Math.cos(a) + along * Math.sin(a)) * PACK;
    const cy = y + (along * Math.sin(a) - along * Math.cos(a)) * PACK;
    const t = rad(angle + turn);
    const c = Math.cos(t), s = Math.sin(t);
    const w = PACK / 2, h = (PACK * CARD_H) / 2;
    return ([[-w, -h], [w, -h], [w, h], [-w, h]] as const).map(([px, py]) => [cx + px * c - py * s, cy + px * s + py * c] as Pt);
  });
}

/** Whether two shapes are the same places, one shifted onto the other. */
function sameShape(a: Pt[], b: Pt[]): boolean {
  const norm = (ps: Pt[]) => {
    const x0 = Math.min(...ps.map((p) => p[0])), y0 = Math.min(...ps.map((p) => p[1]));
    return ps.map(([x, y]) => `${x - x0},${y - y0}`).sort().join(' ');
  };
  return norm(a) === norm(b);
}

/** Every pose a pack in view takes, by (depth − 1) × IN_VIEW + i: its turn and whether it rattles. */
const POSES: { r: number; pose: PackSlot['pose'] }[] = [];

/** A pack in view's backs, box units: its centre, its pose's turn mirrored to its seat, grown if it rattles. */
function backsAt([x, y]: Pt, { r, pose }: { r: number; pose: PackSlot['pose'] }, sx: 1 | -1): Poly[] {
  const backs = packCards(x, y, r * sx);
  return pose === 'jammed' ? backs.map((b) => grow(b, RATTLE * PACK)) : backs;
}

/**
 * The shapes a pile may take, in pack widths, each either way up and either way
 * round, the squarer the better: a block, an L, a row or a column, and a
 * staircase (for an arrow that arrives on the slant).
 */
const STEP_X = 1.75;
const STEP_Y = 2;
const SHAPES: { places: Pt[]; penalty: number }[] = (
  [
    [0, [[0, 0], [1, 0], [0, 1], [1, 1]]],
    [0.4, [[0, 0], [1, 0], [2, 0], [0, 1]]],
    [0.4, [[0, 0], [0, 1], [0, 2], [1, 0]]],
    [0.8, [[0, 0], [1, 0], [2, 0], [3, 0]]],
    [0.8, [[0, 0], [0, 1], [0, 2], [0, 3]]],
    [0.8, [[0, 0], [1, 0.625], [2, 1.25], [3, 1.875]]],
  ] as [number, Pt[]][]
)
  .flatMap(([penalty, shape]) =>
    [1, -1].flatMap((fx) => [1, -1].map((fy) => ({ penalty, places: shape.map(([x, y]): Pt => [x * fx * STEP_X, y * fy * STEP_Y]) }))),
  )
  // A flip that only shifts the shape (a block, a row) is the same shape: keep one.
  .filter((shape, k, all) => all.findIndex((other) => sameShape(other.places, shape.places)) === k);
/** How much nearer its own face than any other a pile's every pack must be, in pack widths: whose pile it is never reads wrong. */
const OWN = 0.4;
/** How many seat orders are tried before the pod settles for a pile that strays. */
const ROUNDS = 4;
/** What straying at all costs: more than any pile on its own ground. */
const STRAY = 1000;
/** How far a pile's places may be from the face, in pack widths, and how finely they are tried. */
const REACH = 6;
const GRID = 0.25;
/** Clearance kept round every pack in view, in pack widths, and more round the one that rattles. */
const CLEARANCE = 0.07;
const RATTLE = 0.08;

export interface Room {
  /** Each seat's face centre, box units. */
  faces: readonly { x: number; y: number }[];
  /** Each seat's mirror: +1 when its arrow arrives on its right. */
  sides: readonly (1 | -1)[];
  /** Where the arrow into each seat ends, box units. */
  heads: readonly { x: number; y: number }[];
  /** The face, its ring, each name line and the counters, as boxes in box units. */
  faceHalf: number;
  names: readonly { left: number; top: number; right: number; bottom: number }[];
  centre: { left: number; top: number; right: number; bottom: number };
  /** Every arrow: its points, its stroke width, box units. */
  arrows: readonly { points: readonly { x: number; y: number }[]; width: number }[];
  /**
   * Where a pack may reach, box units: the pod panel's padding box, not just
   * the ring's square. A seat on the ring's rim has room beside it only out
   * there, and without it its pile strays toward a neighbour's face.
   */
  bounds: { left: number; top: number; right: number; bottom: number };
}

/**
 * Each seat's pile: the four places nearest its arrowhead where four packs fit
 * side by side, as a block, a row or a column, at every turn `packSlot` gives
 * them, clear of every face, name, arrow, the counters, the panel's edge and
 * every earlier seat's pile. The table's own geometry decides, so every seat
 * count, table shape and UI scale is the same rule.
 */
export function pileRoom(room: Room): Pile[] {
  const pad = CLEARANCE * PACK;
  const fixed: Obstacle[] = [];
  for (const f of room.faces) fixed.push(box(f.x - room.faceHalf - pad, f.y - room.faceHalf - pad, f.x + room.faceHalf + pad, f.y + room.faceHalf + pad));
  for (const n of [...room.names, room.centre]) fixed.push(box(n.left - pad, n.top - pad, n.right + pad, n.bottom + pad));
  for (const { points, width } of room.arrows) {
    const half = width / 2 + pad;
    for (let k = 1; k < points.length; k++) {
      const p = points[k - 1]!, q = points[k]!;
      const d = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const nx = (-(q.y - p.y) / d) * half, ny = ((q.x - p.x) / d) * half;
      fixed.push(obstacle([[p.x + nx, p.y + ny], [q.x + nx, q.y + ny], [q.x - nx, q.y - ny], [p.x - nx, p.y - ny]]));
    }
    // The head (`podcircle-head`): 5 strokes across, its tip 3 tenths past the end.
    const end = points[points.length - 1]!, before = points[points.length - 2]!;
    const d = Math.hypot(end.x - before.x, end.y - before.y) || 1;
    const dx = (end.x - before.x) / d, dy = (end.y - before.y) / d;
    const u = (5 * width) / 10;
    const at = (mx: number, my: number): Pt => [end.x + ((mx - 6) * dx - (my - 5) * dy) * u, end.y + ((mx - 6) * dy + (my - 5) * dx) * u];
    const g = pad / u;
    fixed.push(obstacle([at(-g, -g), at(9 + g, 5), at(-g, 10 + g)]));
  }
  const clearOf = (cards: Poly[], blockers: readonly Obstacle[], edges: boolean): boolean =>
    cards.every((card) => {
      const o = obstacle(card);
      if (edges && (o.x0 < room.bounds.left + pad || o.y0 < room.bounds.top + pad || o.x1 > room.bounds.right - pad || o.y1 > room.bounds.bottom - pad)) return false;
      const grown = { x0: o.x0 - pad, y0: o.y0 - pad, x1: o.x1 + pad, y1: o.y1 + pad };
      return !blockers.some((b) => b.x1 > grown.x0 && b.x0 < grown.x1 && b.y1 > grown.y0 && b.y0 < grown.y1 && overlaps(card, b.poly));
    });

  // Each seat's candidates, ranked once; which ones fit depends on the piles placed before it.
  const seats = room.faces.map((face, at) => {
    const sx = room.sides[at]!;
    const toBox = (p: Pt): Pt => [face.x + p[0] * sx * PACK, face.y + p[1] * PACK];
    const head: Pt = [((room.heads[at]!.x - face.x) * sx) / PACK, (room.heads[at]!.y - face.y) / PACK];
    const dist = (p: Pt) => Math.hypot(p[0] - head[0], p[1] - head[1]);
    const others = room.faces.filter((_, j) => j !== at).map((f): Pt => [((f.x - face.x) * sx) / PACK, (f.y - face.y) / PACK]);
    /** How far a place strays past its seat's own ground: 0 when it is clearly nearer its own face than any other. */
    const stray = (p: Pt) => Math.max(0, Math.hypot(p[0], p[1]) + OWN - Math.min(...others.map((o) => Math.hypot(p[0] - o[0], p[1] - o[1]))));
    // Every shape near the face, the ones hugging the arrowhead and the face first;
    // the ones that stray toward another seat only when nothing else fits, and then the least.
    const steps = Math.round((2 * REACH) / GRID) + 1;
    // Each grid point's distance to the arrowhead and whether it is this seat's own, once.
    const span = Math.max(...SHAPES.flatMap((sh) => sh.places.flatMap(([px, py]) => [Math.abs(px), Math.abs(py)])));
    const side = Math.round((2 * (REACH + span)) / GRID) + 1;
    const lo = -(REACH + span);
    const toHead = new Float64Array(side * side);
    const strays = new Float64Array(side * side);
    for (let gx = 0; gx < side; gx++) {
      for (let gy = 0; gy < side; gy++) {
        const p: Pt = [lo + gx * GRID, lo + gy * GRID];
        toHead[gx * side + gy] = dist(p);
        strays[gx * side + gy] = stray(p);
      }
    }
    const count = SHAPES.length * steps * steps;
    const costs = new Float64Array(count);
    for (let k = 0; k < SHAPES.length; k++) {
      const shape = SHAPES[k]!;
      const offsets = shape.places.map(([px, py]) => Math.round(px / GRID) * side + Math.round(py / GRID));
      const cx = shape.places.reduce((t, p) => t + p[0], 0) / 4;
      const cy = shape.places.reduce((t, p) => t + p[1], 0) / 4;
      for (let gx = 0; gx < steps; gx++) {
        for (let gy = 0; gy < steps; gy++) {
          const x = -REACH + gx * GRID, y = -REACH + gy * GRID;
          const base = (gx + Math.round(span / GRID)) * side + gy + Math.round(span / GRID);
          let first = Infinity;
          let away = 0;
          for (const o of offsets) {
            first = Math.min(first, toHead[base + o]!);
            away += strays[base + o]!;
          }
          const mx = x + cx, my = y + cy;
          costs[(k * steps + gx) * steps + gy] = first + 0.5 * Math.hypot(mx - head[0], my - head[1]) + Math.hypot(mx, my) + shape.penalty + (away > 0 ? STRAY + 4 * away : 0);
        }
      }
    }
    // Sorted natively: each cost to 1e-4, with its index in the low bits.
    const keyed = new Float64Array(count);
    for (let i = 0; i < count; i++) keyed[i] = Math.round(costs[i]! * 1e4) * 2 ** 18 + i;
    keyed.sort();
    const order = Array.from(keyed, (v) => v % 2 ** 18);
    const candidate = (i: number) => {
      const k = Math.floor(i / (steps * steps)), gx = Math.floor(i / steps) % steps, gy = i % steps;
      const x = -REACH + gx * GRID, y = -REACH + gy * GRID;
      return SHAPES[k]!.places.map(([px, py]): Pt => [x + px, y + py]).sort((a, b) => dist(a) - dist(b));
    };
    const cell = (v: number) => Math.round(v / GRID);
    /** One pack's backs at a place and pose (a rattling one at its widest), and whether they are clear. */
    const tried = new Map<number, { cards: Poly[]; clear: boolean }>();
    const lone = (p: Pt, pose: number) => {
      const key = ((cell(p[0]) + 512) * 1024 + cell(p[1]) + 512) * 16 + pose;
      let seen = tried.get(key);
      if (seen === undefined) {
        const cards = backsAt(toBox(p), POSES[pose]!, sx);
        seen = { cards, clear: clearOf(cards, fixed, true) };
        tried.set(key, seen);
      }
      return seen;
    };
    /** Whether two packs of one pile touch: only their offset and poses matter. */
    const touching = (a: Pt, pa: number, b: Pt, pb: number) => {
      const key = (((cell(b[0] - a[0]) + 512) * 1024 + cell(b[1] - a[1]) + 512) * 16 + pa) * 16 + pb;
      let hit = touches.get(key);
      if (hit === undefined) {
        const one = backsAt(toBox([0, 0]), POSES[pa]!, sx);
        const two = backsAt(toBox([b[0] - a[0], b[1] - a[1]]), POSES[pb]!, sx);
        hit = one.some((c) => two.some((d) => overlaps(grow(c, pad), d)));
        touches.set(key, hit);
      }
      return hit;
    };
    const touches = new Map<number, boolean>();
    // Every pose the four will take, depth by depth, with the packs beside them at that depth.
    const fits = (places: Pt[], taken: readonly Obstacle[]): Poly[] | null => {
      const all: Poly[] = [];
      for (let depth = 1; depth <= IN_VIEW; depth++) {
        for (let i = 0; i < depth; i++) {
          const pose = (depth - 1) * IN_VIEW + i;
          const seen = lone(places[i]!, pose);
          if (!seen.clear || !clearOf(seen.cards, taken, false)) return null;
          for (let j = 0; j < i; j++) if (touching(places[j]!, (depth - 1) * IN_VIEW + j, places[i]!, pose)) return null;
          all.push(...seen.cards);
        }
      }
      return all;
    };
    /** The best pile that fits beside `taken`, and whether it is wholly this seat's own. */
    const place = (taken: readonly Obstacle[]) => {
      for (const i of order) {
        const places = candidate(i);
        const cards = fits(places, taken);
        if (cards !== null) return { pile: places.map(([x, y]) => ({ x, y })), cards: cards.map(obstacle), own: costs[i]! < STRAY };
      }
      // Nowhere fits (a pod too small for its seats): the pile stands off the arrowhead in a row.
      return { pile: SHAPES[1]!.places.map(([x, y]) => ({ x: head[0] + x, y: head[1] + y })), cards: [], own: false };
    };
    return place;
  });

  // Seats are placed one after another, each round the piles before it. A seat that
  // had to stray toward a neighbour goes first next time; the round with fewest strays wins.
  let order = room.faces.map((_, at) => at);
  let best: { piles: Pile[]; strays: number } | null = null;
  for (let round = 0; round < ROUNDS; round++) {
    const piles: Pile[] = [];
    const taken: Obstacle[] = [];
    const strays: number[] = [];
    for (const at of order) {
      const { pile, cards, own } = seats[at]!(taken);
      piles[at] = pile;
      taken.push(...cards);
      if (!own) strays.push(at);
    }
    if (best === null || strays.length < best.strays) best = { piles, strays: strays.length };
    if (strays.length === 0) break;
    order = [...strays, ...order.filter((at) => !strays.includes(at))];
  }
  return best!.piles;
}

/** A card's rectangle with every side pushed out by `d`. */
function grow(rect: Poly, d: number): Poly {
  const [p0, p1, , p3] = rect as [Pt, Pt, Pt, Pt];
  const unit = (a: Pt, b: Pt): Pt => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [((b[0] - a[0]) / l) * d, ((b[1] - a[1]) / l) * d];
  };
  const ex = unit(p0, p1), ey = unit(p0, p3);
  const signs: Pt[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  return rect.map(([x, y], k) => [x + signs[k]![0] * ex[0] + signs[k]![1] * ey[0], y + signs[k]![0] * ex[1] + signs[k]![1] * ey[1]] as Pt);
}

/** Until the seats are measured, a pile has no places of its own (and no pack is drawn). */
export const UNMEASURED: Pile = Array.from({ length: IN_VIEW }, () => ({ x: 0, y: 0 }));
for (let depth = 1; depth <= IN_VIEW; depth++) for (let i = 0; i < IN_VIEW; i++) POSES.push(i < depth ? packSlot(i, depth, UNMEASURED) : { r: 0, pose: 'tidy' });


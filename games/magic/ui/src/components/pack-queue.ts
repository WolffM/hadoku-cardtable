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
 * The places are searched, not tabled (`pileRoom`). First along the arrow into
 * the seat (the operator, 2026-10-22: "lets try to prioritize placing them on
 * the arrow boundary, else it looks too messy"): a queue against the arrow's
 * stroke, stepping back from its head, each pack turned with it. Only where the
 * arrow cannot hold four does a seat take the four places nearest its arrowhead
 * anywhere. Either way every place clears every face, name, arrow, the
 * counters, the panel's edge and every other pile, at every turn the packs
 * take. So no seat count and no UI scale is a special case.
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
  const centre = { x: 50, y: cy };
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
  return { length, at, points, path, centre };
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

/** One place in a pile, in `PackSlot`'s frame: its centre, and the turn a pack there takes before it is jostled. */
export interface Place {
  x: number;
  y: number;
  turn: number;
}

/** A pile's four places, nearest the arrowhead first (`pileRoom` finds them), and whether they queue along the arrow. */
export interface Pile {
  places: readonly Place[];
  along: 'arrow' | 'room';
}

/** How many packs a pile keeps in full view; every pack past them goes onto the seat. */
export const IN_VIEW = 4;

/** The turns of the packs in view, by depth, about their place's own: square, then nudged, then knocked askew, then shoved. */
const TURNS = [[0], [0, 2], [-3, 4, -2], [-6, 5, -4, 7]];

/**
 * Where waiting pack `i` sits when `depth` are waiting. Depth is at most
 * seats − 1: the seat is looking at the one pack that is not waiting.
 *
 * The first four are always in full view, each on its own: they take the
 * pile's four places (`pileRoom`: clear of every face, name, arrow, the
 * counters and the other piles), nearest the arrowhead first, and nothing up to
 * the fourth is ever placed over another. They only turn where they stand:
 *
 *   1  one pack, square to its place, where the arrow reaches the seat;
 *   2  two, one behind the other, tidy;
 *   3  a third joins the queue: all three knocked a little askew;
 *   4  blockage: a fourth crowds in, all four shoved and the newest rattling.
 *
 * From the fifth on the rules are off, and the rest go onto the seat itself:
 *
 *   5  one lands on the face, teetering;
 *   6  it is shoved up and one drops across the name;
 *   7  one slumps on the face's middle: the seat is all but buried.
 */
export function packSlot(i: number, depth: number, pile: Pile): PackSlot {
  if (i < IN_VIEW) {
    const at = pile.places[i]!;
    const r = at.turn + TURNS[Math.min(depth, IN_VIEW) - 1]![i]!;
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
  return !separates(a, a, b) && !separates(b, a, b);
}

/** Whether one of `poly`'s edges is an axis `a` and `b` lie apart along. */
function separates(poly: Poly, a: Poly, b: Poly): boolean {
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k]!, q = poly[(k + 1) % poly.length]!;
    const nx = q[1] - p[1];
    const ny = p[0] - q[0];
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let m = 0; m < a.length; m++) {
      const d = a[m]![0] * nx + a[m]![1] * ny;
      a0 = Math.min(a0, d);
      a1 = Math.max(a1, d);
    }
    for (let m = 0; m < b.length; m++) {
      const d = b[m]![0] * nx + b[m]![1] * ny;
      b0 = Math.min(b0, d);
      b1 = Math.max(b1, d);
    }
    if (a1 <= b0 || b1 <= a0) return true;
  }
  return false;
}

interface Obstacle {
  poly: Poly;
  /** Its bounds, to skip the far ones cheaply. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
function obstacle(poly: Poly): Obstacle {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { poly, x0, y0, x1, y1 };
}
const box = (x0: number, y0: number, x1: number, y1: number): Obstacle => obstacle([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);

/** Obstacles bucketed by the cells their bounds cover, box units: a query looks only at the ones near it. */
const CELL = 4;
type Blockers = Map<number, Obstacle[]>;
const cellOf = (v: number): number => Math.floor(v / CELL);
const cellKey = (cx: number, cy: number): number => (cx + 4096) * 8192 + cy + 4096;
function blockers(obstacles: readonly Obstacle[]): Blockers {
  const cells: Blockers = new Map();
  for (const o of obstacles) {
    for (let cx = cellOf(o.x0); cx <= cellOf(o.x1); cx++) {
      for (let cy = cellOf(o.y0); cy <= cellOf(o.y1); cy++) {
        const key = cellKey(cx, cy);
        const here = cells.get(key);
        if (here === undefined) cells.set(key, [o]);
        else here.push(o);
      }
    }
  }
  return cells;
}
/** Whether any of `cells`' obstacles meets `poly`, whose bounds grown by the clearance are x0…x1, y0…y1. */
function blocks(cells: Blockers, poly: Poly, x0: number, y0: number, x1: number, y1: number): boolean {
  for (let cx = cellOf(x0); cx <= cellOf(x1); cx++) {
    for (let cy = cellOf(y0); cy <= cellOf(y1); cy++) {
      const here = cells.get(cellKey(cx, cy));
      if (here !== undefined && here.some((b) => b.x1 > x0 && b.x0 < x1 && b.y1 > y0 && b.y0 < y1 && overlaps(poly, b.poly))) return true;
    }
  }
  return false;
}

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

/** A pack in view's backs, box units: its centre, its place's turn and its pose's, mirrored to its seat, grown if it rattles. */
function backsAt([x, y]: Pt, { r, pose }: { r: number; pose: PackSlot['pose'] }, sx: 1 | -1, turn = 0): Poly[] {
  const backs = packCards(x, y, (turn + r) * sx);
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
  /** Which of `arrows` runs into each seat. */
  inbound: readonly number[];
  /** The ring's centre, box units: the outside of an arrow is the side away from it. */
  hub: { x: number; y: number };
  /**
   * Where a pack may reach, box units: the pod panel's padding box, not just
   * the ring's square. A seat on the ring's rim has room beside it only out
   * there, and without it its pile strays toward a neighbour's face.
   */
  bounds: { left: number; top: number; right: number; bottom: number };
}

/**
 * How a queue along an arrow is searched, in pack widths: its offset from the
 * arrow's middle, its first pack's distance back from the head, the step
 * between packs, and how much further out a second file runs than the first.
 */
const QUEUE_STEP = 0.1;
const QUEUE_OFF = { from: 0.6, to: 1.6 };
const QUEUE_BACK = { from: 0, to: 4 };
const QUEUE_GAP = { from: 1, to: 1.6 };
const QUEUE_FILE = { from: 0.8, to: 2, step: 0.2 };
/** How many first files that fit are tried at each count before fewer are tried. */
const QUEUE_TRIES = 8;
/** How far past the arrow's tail, along the ring, a file may run. */
const QUEUE_PAST = 1;
const inSteps = (v: number) => Math.round(v / QUEUE_STEP);
/** Every first file a queue may take (its offset, first pack's distance back, and gap, in steps), the snuggest first. */
const FILES: { off: number; first: number; gap: number }[] = [];
for (let off = 0; off <= inSteps(QUEUE_OFF.to - QUEUE_OFF.from); off++) {
  for (let first = inSteps(QUEUE_BACK.from); first <= inSteps(QUEUE_BACK.to); first++) {
    for (let gap = inSteps(QUEUE_GAP.from); gap <= inSteps(QUEUE_GAP.to); gap++) FILES.push({ off, first, gap });
  }
}
FILES.sort((a, b) => a.off + a.first + a.gap - (b.off + b.first + b.gap));
/** A file of `n` packs `gap` apart, the first `first` back from the head, all `off` out. */
const file = (off: number, first: number, gap: number, n: number): { off: number; back: number }[] =>
  Array.from({ length: n }, (_, i) => ({ off, back: first + i * gap }));
/** Each first file's four places, made once. */
const FILE_SPOTS = FILES.map(({ off, first, gap }) => file(off, first, gap, IN_VIEW));

/**
 * Each seat's pile, at every turn `packSlot` gives its packs clear of every
 * face, name, arrow, the counters, the panel's edge and every earlier seat's
 * pile. First a queue along the arrow into the seat: against its stroke on the
 * ring's outside (its inside only if the outside has no room for one), stepping
 * back from its head, each pack turned with the arrow, as close to the stroke,
 * the head and the pack before as fits. As many as the arrow holds go in that
 * file; the rest continue in a second file just outside it, parallel to the
 * arrow and staggered between the first file's packs. Only where no queue fits
 * at all, the four places nearest its arrowhead where four packs fit side by
 * side, as a block, a row or a column. The table's own geometry decides, so
 * every seat count, table shape and UI scale is the same rule.
 */
export function pileRoom(room: Room): Pile[] {
  const search = pileSearch(room);
  for (;;) {
    const step = search.next();
    if (step.done) return step.value;
  }
}

/** How many fallback candidates are judged between two of `pileSearch`'s pauses. */
const JUDGED_PER_STEP = 256;

/**
 * `pileRoom`, a piece at a time: it pauses (yields) between pieces of a few
 * milliseconds each — after each seat, after a seat's arrow, after its ranking
 * and every `JUDGED_PER_STEP` candidates it judges — and returns the piles. A
 * table's first search is a few hundred milliseconds of arithmetic, so a screen
 * runs it a slice per task (`SeatBar`'s `usePiles`) rather than in the frame
 * that first draws the pod.
 */
export function* pileSearch(room: Room): Generator<void, Pile[], void> {
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
  const table = blockers(fixed);
  const clearOf = (cards: readonly Obstacle[], cells: Blockers, edges: boolean): boolean =>
    cards.every((o) => {
      if (edges && (o.x0 < room.bounds.left + pad || o.y0 < room.bounds.top + pad || o.x1 > room.bounds.right - pad || o.y1 > room.bounds.bottom - pad)) return false;
      return !blocks(cells, o.poly, o.x0 - pad, o.y0 - pad, o.x1 + pad, o.y1 + pad);
    });

  // Each seat's candidates; which ones fit depends on the piles placed before it.
  const seats = room.faces.map((face, at) => {
    const sx = room.sides[at]!;
    const toBox = (p: Pt): Pt => [face.x + p[0] * sx * PACK, face.y + p[1] * PACK];
    const head: Pt = [((room.heads[at]!.x - face.x) * sx) / PACK, (room.heads[at]!.y - face.y) / PACK];
    const dist = (p: Pt) => Math.hypot(p[0] - head[0], p[1] - head[1]);
    const steps = Math.round((2 * REACH) / GRID) + 1;
    /**
     * Every shape near the face, ranked: the ones hugging the arrowhead and the
     * face first; the ones that stray toward another seat only when nothing else
     * fits, and then the least. Only a seat whose arrow holds no queue needs it,
     * so it is ranked the first time one asks.
     */
    let ranked: { costs: Float64Array; order: number[] } | null = null;
    const rank = () => {
      if (ranked !== null) return ranked;
      const others = room.faces.filter((_, j) => j !== at).map((f): Pt => [((f.x - face.x) * sx) / PACK, (f.y - face.y) / PACK]);
      /** How far a place strays past its seat's own ground: 0 when it is clearly nearer its own face than any other. */
      const stray = (p: Pt) => {
        let near = Infinity;
        for (const o of others) near = Math.min(near, Math.hypot(p[0] - o[0], p[1] - o[1]));
        return Math.max(0, Math.hypot(p[0], p[1]) + OWN - near);
      };
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
      ranked = { costs, order: Array.from(keyed, (v) => v % 2 ** 18) };
      return ranked;
    };
    const candidate = (i: number) => {
      const k = Math.floor(i / (steps * steps)), gx = Math.floor(i / steps) % steps, gy = i % steps;
      const x = -REACH + gx * GRID, y = -REACH + gy * GRID;
      return SHAPES[k]!.places.map(([px, py]): Pt => [x + px, y + py]).sort((a, b) => dist(a) - dist(b));
    };
    const cell = (v: number) => Math.round(v / GRID);
    /** One pack's backs at a place and pose (a rattling one at its widest), and whether they are clear. */
    const tried = new Map<number, { cards: Obstacle[]; clear: boolean }>();
    const lone = (p: Pt, pose: number) => {
      const key = ((cell(p[0]) + 512) * 1024 + cell(p[1]) + 512) * 16 + pose;
      let seen = tried.get(key);
      if (seen === undefined) {
        const cards = backsAt(toBox(p), POSES[pose]!, sx).map(obstacle);
        seen = { cards, clear: clearOf(cards, table, true) };
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
    /**
     * The queue along the arrow into this seat: each place a point on the arrow `back`
     * from its head, pushed `off` off its middle to one side, turned with it.
     */
    const arrow = room.arrows[room.inbound[at]!]!;
    const line = [...arrow.points].reverse();
    // The arrow is an arc of the ring: the head's angle about the hub, and which way round its tail lies.
    const r0 = Math.hypot(line[0]!.x - room.hub.x, line[0]!.y - room.hub.y);
    const a0 = Math.atan2(line[0]!.y - room.hub.y, line[0]!.x - room.hub.x);
    const a1 = Math.atan2(line[1]!.y - room.hub.y, line[1]!.x - room.hub.x);
    const way = Math.sign(Math.sin(a1 - a0)) || 1;
    const length = line.reduce((t, p, k) => (k === 0 ? 0 : t + Math.hypot(p.x - line[k - 1]!.x, p.y - line[k - 1]!.y)), 0);
    const reach = length + QUEUE_PAST * PACK;
    const queued = new Map<number, { box: Pt; turn: number } | null>();
    const queuedAt = (side: 1 | -1, off: number, back: number) => {
      const key = (side + 1) * 1e6 + off * 1e3 + back;
      if (queued.has(key)) return queued.get(key)!;
      const a = back * QUEUE_STEP * PACK;
      let found: { box: Pt; turn: number } | null = null;
      if (a <= reach) {
        const t = a0 + (way * a) / r0;
        // Outward from the hub, and the direction of travel (toward the head).
        const ox = Math.cos(t), oy = Math.sin(t);
        const tx = way * oy, ty = -way * ox;
        const o = r0 + side * (arrow.width / 2 + (QUEUE_OFF.from + off * QUEUE_STEP) * PACK);
        const screen = ((deg(Math.atan2(ty, tx)) + 90) % 180 + 180) % 180 - 90;
        found = { box: [room.hub.x + ox * o, room.hub.y + oy * o], turn: screen * sx };
      }
      queued.set(key, found);
      return found;
    };
    type Spot = { off: number; back: number };
    /** A queued pack's backs at a pose, grown by the clearance once asked, and whether they clear the table; null off the arrow. */
    type Backs = { cards: Obstacle[]; grown: Obstacle[] | null; clear: boolean; apart: Map<Backs, boolean> };
    const queueCards = new Map<number, Backs | null>();
    const backsOf = (side: 1 | -1, { off, back }: Spot, pose: number): Backs | null => {
      const key = ((side + 1) * 1e6 + off * 1e3 + back) * 16 + pose;
      let seen = queueCards.get(key);
      if (seen === undefined) {
        const spot = back < 0 ? null : queuedAt(side, off, back);
        if (spot === null) seen = null;
        else {
          const cards = backsAt(spot.box, POSES[pose]!, sx, spot.turn).map(obstacle);
          seen = { cards, grown: null, clear: clearOf(cards, table, true), apart: new Map() };
        }
        queueCards.set(key, seen);
      }
      return seen;
    };
    /** Whether pack `j`'s backs, grown by the clearance, keep off pack `i`'s. Disjoint bounds are disjoint shapes. */
    const apart = (j: Backs, i: Backs): boolean => {
      let clear = j.apart.get(i);
      if (clear === undefined) {
        const grown = (j.grown ??= j.cards.map((c) => obstacle(grow(c.poly, pad))));
        clear = !grown.some((c) => i.cards.some((d) => c.x1 >= d.x0 && c.x0 <= d.x1 && c.y1 >= d.y0 && c.y0 <= d.y1 && overlaps(c.poly, d.poly)));
        j.apart.set(i, clear);
      }
      return clear;
    };
    /**
     * Whether pack `i` of a queue at `spots` fits at every depth it is drawn at: on
     * the arrow, clear of the table and of `taken`, and apart from every pack before
     * it at that depth. It depends on nothing after it, so a queue fits exactly
     * when each of its packs does, and how many of a queue fit is counted pack by
     * pack, never re-checked whole.
     */
    const packFits = (side: 1 | -1, spots: readonly Spot[], i: number, taken: Blockers): boolean => {
      const { off, back } = spots[i]!;
      // On the arrow and clear of the table and of `taken` at every depth: the same for every queue it is in.
      const key = ((side + 1) * 1e6 + off * 1e3 + back) * IN_VIEW + i;
      let alone = solo.get(key);
      if (alone === undefined) {
        alone = true;
        for (let depth = i + 1; depth <= IN_VIEW && alone; depth++) {
          const seen = backsOf(side, spots[i]!, (depth - 1) * IN_VIEW + i);
          alone = seen !== null && seen.clear && clearOf(seen.cards, taken, false);
        }
        solo.set(key, alone);
      }
      if (!alone) return false;
      for (let depth = i + 1; depth <= IN_VIEW; depth++) {
        const seen = backsOf(side, spots[i]!, (depth - 1) * IN_VIEW + i)!;
        for (let j = 0; j < i; j++) if (!apart(backsOf(side, spots[j]!, (depth - 1) * IN_VIEW + j)!, seen)) return false;
      }
      return true;
    };
    /** Each pack's own fit beside the current `taken` (`alongArrow` clears it). */
    const solo = new Map<number, boolean>();
    /** How many of `spots`, from `from` on, fit after the ones before `from` (which do). */
    const fitting = (side: 1 | -1, spots: readonly Spot[], from: number, taken: Blockers): number => {
      let i = from;
      while (i < spots.length && packFits(side, spots, i, taken)) i++;
      return i - from;
    };
    /** Every back a fitting queue draws, depth by depth. */
    const queueBacks = (side: 1 | -1, spots: readonly Spot[]): Obstacle[] => {
      const all: Obstacle[] = [];
      for (let depth = 1; depth <= IN_VIEW; depth++) {
        for (let i = 0; i < Math.min(depth, spots.length); i++) all.push(...backsOf(side, spots[i]!, (depth - 1) * IN_VIEW + i)!.cards);
      }
      return all;
    };
    /**
     * The rest of a queue after `spots` (which fit), file after file: each next
     * file just further out than the last, parallel to the arrow and staggered
     * between its packs, the one that holds the most (the nearest of those). Null
     * when no further file takes one.
     */
    const continued = (side: 1 | -1, spots: Spot[], from: { off: number; first: number }, gap: number, taken: Blockers): Spot[] | null => {
      if (spots.length === IN_VIEW) return spots;
      const half = Math.round(gap / 2);
      let best: { spots: Spot[]; file: { off: number; first: number } } | null = null;
      for (let out = from.off + inSteps(QUEUE_FILE.from); out <= from.off + inSteps(QUEUE_FILE.to); out += inSteps(QUEUE_FILE.step)) {
        for (const first of [from.first + half, from.first - half]) {
          const next = [...spots, ...file(out, first, gap, IN_VIEW - spots.length)];
          const n = fitting(side, next, spots.length, taken);
          if (n > (best === null ? 0 : best.spots.length - spots.length)) best = { spots: next.slice(0, spots.length + n), file: { off: out, first } };
        }
      }
      return best === null ? null : continued(side, best.spots, best.file, gap, taken);
    };

    /**
     * The queue: the outside before the inside; then as many packs as fit in the
     * file against the stroke, the rest in files further out; then the snuggest
     * (the first few first files that fit at each count are tried).
     */
    const alongArrow = (taken: Blockers) => {
      solo.clear();
      for (const side of [1, -1] as const) {
        // How many of each first file's four fit, counted the first time a count asks.
        const holds = new Int8Array(FILES.length).fill(-1);
        for (let held = IN_VIEW; held >= 1; held--) {
          let tries = 0;
          for (let f = 0; f < FILES.length; f++) {
            if (holds[f]! < 0) holds[f] = fitting(side, FILE_SPOTS[f]!, 0, taken);
            if (holds[f]! < held) continue;
            const { off, first, gap } = FILES[f]!;
            const spots = continued(side, FILE_SPOTS[f]!.slice(0, held), { off, first }, gap, taken);
            if (spots === null) {
              if (++tries === QUEUE_TRIES) break;
              continue;
            }
            const places = spots.map(({ off: o, back }): Place => {
              const { box: [bx, by], turn } = queuedAt(side, o, back)!;
              return { x: ((bx - face.x) * sx) / PACK, y: (by - face.y) / PACK, turn };
            });
            return { pile: { places, along: 'arrow' as const }, cards: queueBacks(side, spots), own: true };
          }
        }
      }
      return null;
    };

    /**
     * Whether a candidate's every pose, depth by depth, clears the table and keeps
     * its packs apart: the table never changes, so each is judged once (0 unjudged,
     * 1 fits, 2 does not), and only those that fit are tried beside other piles.
     */
    const standing = new Uint8Array(SHAPES.length * steps * steps);
    const places = new Map<number, Pt[]>();
    const stands = (i: number): Pt[] | null => {
      if (standing[i] === 0) {
        const at = candidate(i);
        let ok = true;
        for (let depth = 1; depth <= IN_VIEW && ok; depth++) {
          for (let k = 0; k < depth && ok; k++) {
            const pose = (depth - 1) * IN_VIEW + k;
            ok = lone(at[k]!, pose).clear;
            for (let j = 0; j < k && ok; j++) ok = !touching(at[j]!, (depth - 1) * IN_VIEW + j, at[k]!, pose);
          }
        }
        standing[i] = ok ? 1 : 2;
        if (ok) places.set(i, at);
      }
      return standing[i] === 1 ? places.get(i)! : null;
    };
    // Every pose the four will take, depth by depth, clear of the piles before this one.
    const fits = (at: Pt[], taken: Blockers): Obstacle[] | null => {
      const all: Obstacle[] = [];
      for (let depth = 1; depth <= IN_VIEW; depth++) {
        for (let i = 0; i < depth; i++) {
          const seen = lone(at[i]!, (depth - 1) * IN_VIEW + i);
          if (!clearOf(seen.cards, taken, false)) return null;
          all.push(...seen.cards);
        }
      }
      return all;
    };
    /** The best pile that fits beside `taken`, and whether it is wholly this seat's own. */
    function* place(before: readonly Obstacle[]): Generator<void, { pile: Pile; cards: Obstacle[]; own: boolean }, void> {
      const taken = blockers(before);
      const queue = alongArrow(taken);
      if (queue !== null) return queue;
      yield;
      const anywhere = (places: Pt[]): Pile => ({ places: places.map(([x, y]) => ({ x, y, turn: 0 })), along: 'room' });
      const fresh = ranked === null;
      const { costs, order } = rank();
      if (fresh) yield;
      let judged = 0;
      for (const i of order) {
        if (standing[i] === 0 && ++judged % JUDGED_PER_STEP === 0) yield;
        const at = stands(i);
        const cards = at === null ? null : fits(at, taken);
        if (cards !== null) return { pile: anywhere(at!), cards, own: costs[i]! < STRAY };
      }
      // Nowhere fits (a pod too small for its seats): the pile stands off the arrowhead in a row.
      return { pile: anywhere(SHAPES[1]!.places.map(([x, y]) => [head[0] + x, head[1] + y])), cards: [], own: false };
    }
    return place;
  });

  // Seats are placed one after another, each round the piles before it. A seat that
  // missed its arrow, or had to stray toward a neighbour, goes first next time; the
  // round with fewest seats off their arrows wins, then the one with fewest strays.
  let order = room.faces.map((_, at) => at);
  let best: { piles: Pile[]; score: number } | null = null;
  for (let round = 0; round < ROUNDS; round++) {
    const piles: Pile[] = [];
    const taken: Obstacle[] = [];
    const missed: number[] = [];
    let score = 0;
    for (const at of order) {
      const { pile, cards, own } = yield* seats[at]!(taken);
      yield;
      piles[at] = pile;
      taken.push(...cards);
      if (pile.along === 'room' || !own) missed.push(at);
      score += (pile.along === 'room' ? room.faces.length + 1 : 0) + (own ? 0 : 1);
    }
    if (best === null || score < best.score) best = { piles, score };
    if (missed.length === 0) break;
    order = [...missed, ...order.filter((at) => !missed.includes(at))];
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

/** A pile with no places of its own, for the poses' turns (`POSES`). */
const UNMEASURED: Pile = { places: Array.from({ length: IN_VIEW }, () => ({ x: 0, y: 0, turn: 0 })), along: 'room' };
for (let depth = 1; depth <= IN_VIEW; depth++) for (let i = 0; i < IN_VIEW; i++) POSES.push(i < depth ? packSlot(i, depth, UNMEASURED) : { r: 0, pose: 'tidy' });


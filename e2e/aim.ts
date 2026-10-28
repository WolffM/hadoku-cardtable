/*
 * Where the board's arrows land, for the specs that measure them. An arrow aimed at a box takes the
 * nearest of its eight edge points (the corners and the mid-sides, `gestures/arrow.ts`'s
 * `edgeNearest`) and carries it `TIP_INSET` of the way to the box's centre, so the head lands on
 * the target (`aimAt`). The e2e tsconfig cannot import the app's source, so the rule is restated
 * here, once, for every spec.
 */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** `gestures/arrow.ts`'s `TIP_INSET`. A change there must change this. */
export const TIP_INSET = 0.25;

export const centre = (b: Box): Point => ({ x: b.left + b.width / 2, y: b.top + b.height / 2 });

export const away = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** The four corners and the four edge midpoints of a box. */
export const eight = (b: Box): Point[] => {
  const xs = [b.left, b.left + b.width / 2, b.left + b.width];
  const ys = [b.top, b.top + b.height / 2, b.top + b.height];
  return ys.flatMap((y, r) => xs.map((x, c) => ({ x, y, centre: r === 1 && c === 1 }))).filter((p) => !p.centre).map(({ x, y }) => ({ x, y }));
};

/** Where a tip aimed at the edge point `p` of `b` lands: `TIP_INSET` of the way in toward the centre. */
export const landing = (p: Point, b: Box): Point => {
  const c = centre(b);
  return { x: p.x + (c.x - p.x) * TIP_INSET, y: p.y + (c.y - p.y) * TIP_INSET };
};

/** The eight places an edge-aimed tip can land on `b`. */
export const tips = (b: Box): Point[] => eight(b).map((p) => landing(p, b));

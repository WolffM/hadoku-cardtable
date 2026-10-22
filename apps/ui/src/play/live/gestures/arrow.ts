/*
 * The targeter arrow. Ours: a curved shaft and a plain head, no card frame, no
 * mana symbol, no tap symbol — nothing of WotC's (`CLAUDE.md`).
 *
 * Re-homed from `../LiveBoard.tsx`'s `Targeter` (wave 20), which drew it with
 * `createPortal`. This draws the same SVG with the same classes, the same
 * `data-*`, as plain DOM. The shaft is a `path` (one quadratic curve, see
 * `arrowShape`) since 2026-10-05; `e2e/arrow.spec.ts` reads its `d` and the
 * head `polygon` in the overlay's own coordinates.
 *
 * Wave 24 §B.4 adds the second caller: the arrow now draws for CLICK targeting
 * too, from the same function, into the same overlay. `data-mode` says which
 * gesture drew it, and it is the only thing that is new.
 */
import { centreOf } from '../../lift.ts';
import type { AutoTargetArrow } from './auto-targets.ts';
import type { DropTarget, Point } from './types.ts';

const SVG = 'http://www.w3.org/2000/svg';

export interface ArrowSpec {
  /** The tail, in client coordinates. */
  from: Point;
  /** Where the pointer is, in client coordinates — the tip when nothing snaps. */
  to: Point;
  source: number | null;
  target: DropTarget | null;
  /** The element the tip snaps to, or null. */
  snap: Element | null;
  /**
   * The element the arrow leaves from, or null when it leaves from a bare
   * point. While the pointer is over it there is no arrow: one aimed into its
   * own tail points at nothing.
   */
  tail: Element | null;
  mode: 'drag' | 'click';
}

/** The head's length and half-spread, in the overlay's own units. Wave 20's numbers. */
const HEAD = 13;
const SPREAD = 0.42;

/**
 * How far the shaft bows off its chord: a share of the chord's length, never
 * flatter than `BOW_MIN` (two neighbouring stack items still read as an arc
 * over the carousel — a counterspell aimed at the spell beside it) and never
 * deeper than `BOW_MAX` (a hand-to-far-corner drag stays a gentle sweep).
 */
const BOW = 0.22;
const BOW_MIN = 24;
const BOW_MAX = 110;

/** An arrow's shape: the shaft's path and the head's three points, in overlay units. */
export interface ArrowShape {
  /** `M x1 y1 Q cx cy x2 y2` — one quadratic curve. */
  d: string;
  /** Tip first, then the two barbs. */
  points: string;
}

/**
 * The curved arrow from (x1, y1) to (x2, y2) — the operator, 2026-10-05: *"the
 * straight arrow looks ugly … show a curved arrow in pretty much all cases"*.
 *
 * The control point sits off the chord's midpoint along the normal that is
 * ALWAYS on the same rotational side of the travel direction, so the bow turns
 * smoothly as a drag sweeps around its tail and never flips sides: a rightward
 * arrow arcs up, an upward one arcs left. The head lies along the curve's own
 * tangent at the tip (control point → tip), so it points the way the shaft
 * arrives, not along the chord.
 */
export function arrowShape(x1: number, y1: number, x2: number, y2: number): ArrowShape {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const bow = len === 0 ? 0 : Math.min(BOW_MAX, Math.max(BOW_MIN, len * BOW)) / len;
  const cx = (x1 + x2) / 2 + dy * bow;
  const cy = (y1 + y2) / 2 - dx * bow;
  const angle = len === 0 ? 0 : Math.atan2(y2 - cy, x2 - cx);
  return {
    d: `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`,
    points: [
      `${x2},${y2}`,
      `${x2 - HEAD * Math.cos(angle - SPREAD)},${y2 - HEAD * Math.sin(angle - SPREAD)}`,
      `${x2 - HEAD * Math.cos(angle + SPREAD)},${y2 - HEAD * Math.sin(angle + SPREAD)}`,
    ].join(' '),
  };
}

/**
 * J5 (wave 64): the one arrow element every screen that ever draws one
 * builds — the interactive targeter and the passive stack arrows here, and
 * (since this fold) `live/placed.ts`'s `.placed__arrow` and
 * `live/presence.ts`'s mirror of the OTHER seat's arrow, which used to hand-roll
 * the identical `<svg><path/><polygon/></svg>` three more times between them.
 * `className` is the SVG's own; `shaftClass`/`headClass` are each caller's
 * existing stylesheet hook (presence's has none — its CSS selects the bare
 * tags) and `testid`/`extra` are each caller's own markers, all optional so
 * the bare shape is still the whole of what this returns with none given.
 */
export function newArrow(opts: { className: string; testid?: string; shaftClass?: string; headClass?: string }): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', opts.className);
  if (opts.testid !== undefined) svg.setAttribute('data-testid', opts.testid);
  svg.setAttribute('aria-hidden', 'true');
  const shaft = document.createElementNS(SVG, 'path');
  if (opts.shaftClass !== undefined) shaft.setAttribute('class', opts.shaftClass);
  const head = document.createElementNS(SVG, 'polygon');
  if (opts.headClass !== undefined) head.setAttribute('class', opts.headClass);
  svg.append(shaft, head);
  return svg;
}

/** Shape an arrow `newArrow` built, from `from` to `tip`, both in client coordinates, against `box` (the overlay's own). */
export function positionArrow(svg: SVGSVGElement, from: Point, tip: Point, box: DOMRect): void {
  const { d, points } = arrowShape(from.x - box.left, from.y - box.top, tip.x - box.left, tip.y - box.top);
  // Unchanged is left alone: a write the next box read must lay out, on every paint, for an arrow that stood still.
  const shaft = svg.querySelector('path')!;
  if (shaft.getAttribute('d') !== d) shaft.setAttribute('d', d);
  const head = svg.querySelector('polygon')!;
  if (head.getAttribute('points') !== points) head.setAttribute('points', points);
}

/**
 * Draw (or move) the one arrow inside `overlay`.
 *
 * Idempotent: the SVG is created on the first call and updated in place after
 * it, so a pointermove does not churn the DOM. Everything is in the overlay's
 * own coordinates, so it is correct wherever lane A puts the overlay.
 */
export function drawArrow(overlay: HTMLElement, spec: ArrowSpec): void {
  if (spec.tail !== null && within(spec.tail.getBoundingClientRect(), spec.to)) {
    clearArrow(overlay);
    return;
  }
  const aimed = spec.snap === null ? { from: spec.from, tip: spec.to } : aimOn(spec.snap, spec.from, spec.target?.kind === 'player' ? 'player' : 'card');
  let svg = overlay.querySelector<SVGSVGElement>('[data-testid="targeter"]');
  if (svg === null) {
    svg = newArrow({ className: 'targeter', testid: 'targeter', shaftClass: 'targeter__shaft', headClass: 'targeter__head' });
    overlay.append(svg);
  }
  flag(svg, 'data-source', spec.source === null ? null : String(spec.source));
  flag(svg, 'data-target', spec.target === null ? null : `${spec.target.kind}:${spec.target.id}`);
  flag(svg, 'data-snapped', spec.snap === null ? null : 'true');
  flag(svg, 'data-mode', spec.mode);
  positionArrow(svg, aimed.from, aimed.tip, overlay.getBoundingClientRect());
}

/**
 * Closer than this (the tail, a card's centre, to the target's box) and the
 * arrow runs to the target's CENTRE, over the cards, instead of to its nearest
 * edge — ledger Z9. A board card is 60-115px wide with a 6-8px gap, so a
 * neighbour's edge is 36-66px from the source's centre and the next card over
 * is 100px and more: this sits between.
 */
export const ADJACENT_PX = 72;

/**
 * Where an arrow from `from` runs when its target is the box `to`: the tail
 * as given and the tip at the nearest of eight points on the target's edge
 * (Q11) — except that a target touching the source, or the source itself,
 * gets no visible arrow that way. The operator, 2026-10-07: *"if cryptbreaker
 * has two cards right next to them, and it's trying to target itself and the
 * next two cards, then the arrows should be drawn on top of the card so they
 * are actually visible."* So:
 *
 *  - the tail INSIDE the target (the card targets itself): the arrow is an
 *    arc over the card, from its bottom to its top — the bow (`arrowShape`)
 *    swings it out to the side;
 *  - the target within `ADJACENT_PX` of the tail, on the SAME side of the
 *    table (`neighbours`): the tip is the target's centre, so the shaft
 *    crosses the cards, which the overlay draws over. A card across the
 *    table is never a neighbour, however close the two front rows sit: the
 *    arrow there crosses the gap and lands on the edge, as it always has
 *    (`w46-attack.spec.ts` pins the attack arrow at the planeswalker's edge).
 *
 * Pure, on boxes: `arrow.test.ts` drives it with numbers.
 */
export function aimAt(
  from: Point,
  to: { left: number; top: number; right: number; bottom: number },
  opts: { neighbours?: boolean } = {},
): { from: Point; tip: Point } {
  const centre = { x: (to.left + to.right) / 2, y: (to.top + to.bottom) / 2 };
  if (within(to, from)) return { from: { x: centre.x, y: to.bottom - 4 }, tip: { x: centre.x, y: to.top + 4 } };
  const dx = Math.max(to.left - from.x, 0, from.x - to.right);
  const dy = Math.max(to.top - from.y, 0, from.y - to.bottom);
  if (opts.neighbours !== false && Math.hypot(dx, dy) < ADJACENT_PX) return { from, tip: centre };
  return { from, tip: edgeNearest(to, from) };
}

/** `p` lies on or inside the box. */
function within(r: { left: number; top: number; right: number; bottom: number }, p: Point): boolean {
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
}

/** `edgePointNearest` on a box rather than an element. */
function edgeNearest(r: { left: number; top: number; right: number; bottom: number }, from: Point): Point {
  const xs = [r.left, (r.left + r.right) / 2, r.right];
  const ys = [r.top, (r.top + r.bottom) / 2, r.bottom];
  let best: Point = { x: r.left, y: r.top };
  let bestD = Infinity;
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      if (row === 1 && col === 1) continue;
      const p = { x: xs[col]!, y: ys[row]! };
      const d = Math.hypot(p.x - from.x, p.y - from.y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
  }
  return best;
}

/**
 * A card is aimed at by `aimAt`; a player's face, a round avatar and not a
 * card, keeps its centre. Neighbours are cards of the same seat: a tail
 * outside the target's `.seat` box (the other side of the table, or the
 * stack band, which has no seat) is aimed at the edge whatever the distance.
 */
function aimOn(snap: Element, from: Point, kind: 'player' | 'card'): { from: Point; tip: Point } {
  if (kind === 'player') return { from, tip: centreOf(snap) };
  const seat = snap.closest('.seat')?.getBoundingClientRect();
  const neighbours = seat === undefined || within(seat, from);
  return aimAt(from, snap.getBoundingClientRect(), { neighbours });
}

/** Take the arrow away. Absent is fine — this is called on every gesture end. */
export function clearArrow(overlay: HTMLElement | null): void {
  overlay?.querySelector('[data-testid="targeter"]')?.remove();
}

/** The persistent arrows' own testid — never `targeter`, so the one interactive arrow and these never collide. */
const AUTO_TESTID = 'stack-target-arrow';

/**
 * Reconcile the overlay's passive arrows against `specs` (item 8): one SVG per
 * spec, keyed by `data-key` so an unchanged pair is left alone across paints,
 * and every key not in `specs` any more is removed — the stack item resolved,
 * or its target left the board. Same curve and head as `drawArrow`,
 * drawn a touch lighter (`./gestures.css`) so it reads as "already decided"
 * rather than "decide this".
 */
export function drawAutoTargetArrows(overlay: HTMLElement, specs: readonly AutoTargetArrow[]): void {
  // Every end read before any arrow is written: one layout for the lot, and none with nothing to draw.
  const aims = specs.map((spec) => ({ spec, aimed: aimOn(spec.to, spec.from, spec.kind === 'player' ? 'player' : 'card') }));
  const box = aims.length === 0 ? null : overlay.getBoundingClientRect();
  const seen = new Set<string>();
  for (const { spec, aimed } of aims) {
    seen.add(spec.key);
    let svg = overlay.querySelector<SVGSVGElement>(`[data-testid="${AUTO_TESTID}"][data-key="${spec.key}"]`);
    if (svg === null) {
      svg = newArrow({ className: 'targeter targeter--auto', testid: AUTO_TESTID, shaftClass: 'targeter__shaft', headClass: 'targeter__head' });
      svg.setAttribute('data-key', spec.key);
      svg.setAttribute('data-role', spec.role);
      overlay.append(svg);
    }
    positionArrow(svg, aimed.from, aimed.tip, box!);
  }
  for (const el of [...overlay.querySelectorAll(`[data-testid="${AUTO_TESTID}"]`)]) {
    if (!seen.has(el.getAttribute('data-key') ?? '')) el.remove();
  }
}

/** Take every passive arrow away — on dispose, so a board left behind carries none. */
export function clearAutoTargetArrows(overlay: HTMLElement | null): void {
  overlay?.querySelectorAll(`[data-testid="${AUTO_TESTID}"]`).forEach((el) => el.remove());
}

/** An attribute that is ABSENT when it has no value — `undefined` in JSX, and what the e2e reads. */
function flag(el: Element, name: string, value: string | null): void {
  if (value === null) el.removeAttribute(name);
  else el.setAttribute(name, value);
}

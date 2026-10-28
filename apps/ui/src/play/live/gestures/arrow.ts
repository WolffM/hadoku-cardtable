/*
 * The board's one arrow. Ours: a curved, tapered ribbon and a swept head, no card
 * frame, no mana symbol, no tap symbol — nothing of WotC's (`CLAUDE.md`).
 *
 * Re-homed from `../LiveBoard.tsx`'s `Targeter` (wave 20), which drew it with
 * `createPortal`. The curve is one quadratic (`arrowShape`) since 2026-10-05; the
 * ribbon look since 2026-10-28 (the operator: arrows were *"quite ugly and in some
 * cases very difficult to see"* on some themes).
 *
 * One SVG per arrow, in the overlay's own coordinates:
 *
 *   path.arrow__spine        the curve itself, tail to tip — never painted. It is
 *                            the FIRST path, so every reader that takes an arrow's
 *                            `M x1 y1 Q cx cy x2 y2` off `querySelector('path')`
 *                            (`e2e/arrow.spec.ts` and the specs after it) keeps
 *                            reading the curve.
 *   g.arrow__rim             the shaft's outline and the head, in the rim colour,
 *   g.arrow__core            then the same two again in the arrow's own colour on
 *                            top: one ribbon with an outline that clears 3:1 on every
 *                            theme's board (`arrow.css`), whatever the colour itself.
 *   g.arrow__mark            the corner brackets on a stack item's target (`markArrow`).
 *
 * The item that resolves next BREATHES (`breathe`): a blurred copy of its arrow and brackets in a
 * sibling `svg.arrow-glow`, sized to them, whose opacity rises and falls. Only that layer's
 * opacity moves, so the compositor runs the pulse and nothing is drawn again per frame
 * (`composited-loops.test.ts`: a breathing `filter` once ran a game at 7 fps); the arrow itself
 * stays still, at full contrast.
 *
 * A GHOST (`data-ghost`) is an arrow still being aimed, this seat's targeter or the
 * other seat's: its shaft is square, outlined chunks travelling toward the tip — two
 * dashed strokes along a STEM (the curve, stopped inside the head), the rim's dash 2px
 * longer at each end so every chunk keeps its outline, animated in CSS, not here.
 * Strokes, not masks over the ribbon: a mask is repainted whole on every frame of the
 * travel, and measured (`scripts/fps`, crowded board) that cost more than a core while
 * aiming. Committing it (`commitArrowAt`) closes the gaps and settles it into the ribbon.
 */
import { centreOf } from '../../lift.ts';
import { prefersReducedMotion } from '../../motion.ts';
import type { AutoTargetArrow } from './auto-targets.ts';
import type { DropTarget, Point } from './types.ts';
import './arrow.css';

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

/**
 * How far the shaft bows off its chord: a share of the chord's length, never
 * flatter than `BOW_MIN` (two neighbouring stack items still read as an arc
 * over the carousel — a counterspell aimed at the spell beside it) and never
 * deeper than `BOW_MAX` (a hand-to-far-corner drag stays a gentle sweep).
 */
const BOW = 0.22;
const BOW_MIN = 24;
const BOW_MAX = 110;

/**
 * The ribbon's measures, in the overlay's own units: a committed arrow, and the
 * heavier ghost (`weight` 1) a player is still aiming. The head is `HEAD` from tip
 * to barb at `SPREAD` off the curve; the shaft runs `tail` wide at its tail to
 * `neck` wide where it enters the head, and stops inside it.
 */
export const SOLID = { head: 27, tail: 2.5, neck: 6 } as const;
export const GHOST = { head: 32, tail: 3, neck: 8 } as const;
export const SPREAD = 0.4;
/** How far inside the head, as a share of its length, the shaft stops: under the head's fill, never past its base. */
const SHAFT_INTO_HEAD = 0.75;

/** The ghost's chunks and gaps along the stem; `arrow.css`'s dash patterns and travel are these numbers. */
export const DASH = 13;
export const GAP = 11;

/** An arrow's shape, in overlay units. */
export interface ArrowShape {
  /** `M x1 y1 Q cx cy x2 y2` — one quadratic curve, tail to tip. */
  d: string;
  /** The head: tip first, then the two barbs. */
  points: string;
  /** The shaft's closed outline, tail to where it stops inside the head. */
  shaft: string;
  /** The curve from the tail to where the shaft stops: one quadratic, what a ghost's dashes run along. */
  stem: string;
}

const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
const r1 = (n: number): string => (Math.round(n * 10) / 10).toString();

/**
 * The curved arrow from (x1, y1) to (x2, y2) — the operator, 2026-10-05: *"the
 * straight arrow looks ugly … show a curved arrow in pretty much all cases"*.
 *
 * The control point sits off the chord's midpoint along the normal that is
 * ALWAYS on the same rotational side of the travel direction, so the bow turns
 * smoothly as a drag sweeps around its tail and never flips sides: a rightward
 * arrow arcs up, an upward one arcs left. The head lies along the curve's own
 * tangent at the tip (control point → tip), so it points the way the shaft
 * arrives, not along the chord. `weight` runs from a committed arrow (0) to a
 * ghost (1); a commit tweens it.
 */
export function arrowShape(x1: number, y1: number, x2: number, y2: number, weight = 0): ArrowShape {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const bow = len === 0 ? 0 : Math.min(BOW_MAX, Math.max(BOW_MIN, len * BOW)) / len;
  const cx = (x1 + x2) / 2 + dy * bow;
  const cy = (y1 + y2) / 2 - dx * bow;
  const angle = len === 0 ? 0 : Math.atan2(y2 - cy, x2 - cx);
  // A short arrow keeps a head it can carry: never more than half its own chord.
  const head = Math.min(lerp(SOLID.head, GHOST.head, weight), len / 2);
  return {
    d: `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`,
    points: [
      `${x2},${y2}`,
      `${x2 - head * Math.cos(angle - SPREAD)},${y2 - head * Math.sin(angle - SPREAD)}`,
      `${x2 - head * Math.cos(angle + SPREAD)},${y2 - head * Math.sin(angle + SPREAD)}`,
    ].join(' '),
    ...shaftOf([x1, y1, cx, cy, x2, y2], head * Math.cos(SPREAD) * SHAFT_INTO_HEAD, weight),
  };
}

/** Samples along the curve: plenty for a smooth outline at any board size. */
const SAMPLES = 24;

/**
 * The shaft: the curve from the tail to `short` (arc length) before the tip, as an outline offset
 * to either side by a width that eases from `tail` to `neck` and closed with a round tail, and as
 * the bare curve itself (the stem).
 */
function shaftOf(p: readonly number[], short: number, weight: number): { shaft: string; stem: string } {
  const [x0, y0, cx, cy, x2, y2] = p as [number, number, number, number, number, number];
  const at = (t: number): [number, number] => {
    const u = 1 - t;
    return [u * u * x0 + 2 * u * t * cx + t * t * x2, u * u * y0 + 2 * u * t * cy + t * t * y2];
  };
  // Arc lengths, to find where along t the shaft stops.
  const lens = [0];
  let [px, py] = at(0);
  for (let i = 1; i <= SAMPLES; i++) {
    const [x, y] = at(i / SAMPLES);
    lens.push(lens[i - 1]! + Math.hypot(x - px, y - py));
    px = x;
    py = y;
  }
  const total = lens[SAMPLES]!;
  const want = Math.max(0, total - short);
  let i = 1;
  while (i < SAMPLES && lens[i]! < want) i++;
  const span = lens[i]! - lens[i - 1]!;
  const end = (i - 1 + (span === 0 ? 0 : (want - lens[i - 1]!) / span)) / SAMPLES;
  const tail = lerp(SOLID.tail, GHOST.tail, weight) / 2;
  const neck = lerp(SOLID.neck, GHOST.neck, weight) / 2;
  const left: string[] = [];
  const right: string[] = [];
  for (let k = 0; k <= SAMPLES; k++) {
    const t = (end * k) / SAMPLES;
    const [x, y] = at(t);
    // The tangent, then the normal to it.
    let tx = 2 * (1 - t) * (cx - x0) + 2 * t * (x2 - cx);
    let ty = 2 * (1 - t) * (cy - y0) + 2 * t * (y2 - cy);
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const e = k / SAMPLES;
    const w = tail + (neck - tail) * (1 - (1 - e) * (1 - e));
    left.push(`${r1(x - ty * w)} ${r1(y + tx * w)}`);
    right.push(`${r1(x + ty * w)} ${r1(y - tx * w)}`);
  }
  // The curve up to `end`, exactly: de Casteljau's first half keeps the tail, pulls the control
  // point `end` of the way toward the old one, and ends on the curve's own point at `end`.
  const [ex, ey] = at(end);
  const stem = `M ${r1(x0)} ${r1(y0)} Q ${r1(x0 + (cx - x0) * end)} ${r1(y0 + (cy - y0) * end)} ${r1(ex)} ${r1(ey)}`;
  return { shaft: `M ${left.join(' L ')} L ${right.reverse().join(' L ')} A ${r1(tail)} ${r1(tail)} 0 0 1 ${left[0]} Z`, stem };
}

/**
 * The one arrow element every screen that draws one builds, drawn by the one
 * `.arrow` block (`./arrow.css`): the interactive targeter and the passive
 * combat arrows here, `live/placed.ts`'s stack arrows and `live/presence.ts`'s
 * mirror of the OTHER seat's aim. `className` adds the caller's own classes, a
 * modifier and the marker its readers find it by; `testid` is its own marker too.
 * `ghost` draws it as an aim still in progress.
 */
export function newArrow(opts: { className?: string; testid?: string; ghost?: boolean } = {}): SVGSVGElement {
  const svg = el('svg', opts.className === undefined ? 'arrow' : `arrow ${opts.className}`);
  if (opts.testid !== undefined) svg.setAttribute('data-testid', opts.testid);
  svg.setAttribute('aria-hidden', 'true');
  svg.append(el('path', 'arrow__spine'));
  for (const layer of ['rim', 'core'] as const) {
    const g = el('g', `arrow__${layer}`);
    g.append(el('path', 'arrow__shaft'));
    // Only a ghost travels: a committed arrow never carries the dashes.
    if (opts.ghost === true) g.append(el('path', 'arrow__stem'));
    g.append(el('polygon', 'arrow__head'));
    svg.append(g);
  }
  svg.toggleAttribute('data-ghost', opts.ghost === true);
  return svg;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, className: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  if (className !== '') node.setAttribute('class', className);
  return node;
}

/** Where each arrow was last shaped, overlay-relative, so a commit can re-shape it at another weight. */
const shaped = new WeakMap<SVGSVGElement, { x1: number; y1: number; x2: number; y2: number }>();

/** Shape an arrow `newArrow` built, from `from` to `tip`, both in client coordinates, against `box` (the overlay's own). */
export function positionArrow(svg: SVGSVGElement, from: Point, tip: Point, box: DOMRect): void {
  const ends = { x1: from.x - box.left, y1: from.y - box.top, x2: tip.x - box.left, y2: tip.y - box.top };
  shaped.set(svg, ends);
  write(svg, arrowShape(ends.x1, ends.y1, ends.x2, ends.y2, svg.hasAttribute('data-ghost') ? 1 : 0));
}

function write(svg: SVGSVGElement, { d, points, shaft, stem }: ArrowShape): void {
  // Unchanged is left alone: a write the next box read must lay out, on every paint, for an arrow that stood still.
  if (svg.querySelector('.arrow__spine')?.getAttribute('d') !== d) syncGlow(svg, { d, points, shaft });
  for (const p of svg.querySelectorAll('.arrow__spine')) if (p.getAttribute('d') !== d) p.setAttribute('d', d);
  for (const p of svg.querySelectorAll('.arrow__stem')) if (p.getAttribute('d') !== stem) p.setAttribute('d', stem);
  for (const p of svg.querySelectorAll('.arrow__shaft')) if (p.getAttribute('d') !== shaft) p.setAttribute('d', shaft);
  for (const p of svg.querySelectorAll('.arrow__head')) if (p.getAttribute('points') !== points) p.setAttribute('points', points);
}

/** How far outside its target's box the brackets stand, and how long each arm is. */
const MARK_PAD = 6;
const MARK_ARM = 18;

/**
 * The corner brackets on the box `to` (client coordinates, against `box`): what says a card, a
 * face or a stack item is TARGETED, beside the arrow that says by what. Brackets, never a ring:
 * the accent outline already means "you can pick this" and the warn glow "this can act".
 */
export function markArrow(svg: SVGSVGElement, to: { left: number; top: number; right: number; bottom: number }, box: DOMRect): void {
  let mark = svg.querySelector('.arrow__mark');
  if (mark === null) {
    mark = el('g', 'arrow__mark');
    mark.append(el('path', 'arrow__mark-rim'), el('path', 'arrow__mark-core'));
    svg.append(mark);
  }
  const [x0, y0, x1, y1] = [to.left - box.left - MARK_PAD, to.top - box.top - MARK_PAD, to.right - box.left + MARK_PAD, to.bottom - box.top + MARK_PAD].map(r1).map(Number) as [number, number, number, number];
  const a = MARK_ARM;
  const d =
    `M ${x0} ${y0 + a} L ${x0} ${y0} L ${x0 + a} ${y0} M ${x1 - a} ${y0} L ${x1} ${y0} L ${x1} ${y0 + a} ` +
    `M ${x1} ${y1 - a} L ${x1} ${y1} L ${x1 - a} ${y1} M ${x0 + a} ${y1} L ${x0} ${y1} L ${x0} ${y1 - a}`;
  if (mark.querySelector('path')?.getAttribute('d') !== d) {
    marked.set(svg, [x0, y0, x1, y1]);
    for (const p of mark.querySelectorAll('path')) p.setAttribute('d', d);
    syncGlow(svg);
  }
}

/** Each arrow's brackets as last drawn, overlay-relative: the glow covers them too. */
const marked = new WeakMap<SVGSVGElement, [number, number, number, number]>();
/** Each breathing arrow's glow layer. */
const glows = new WeakMap<SVGSVGElement, SVGSVGElement>();
/** How far the glow's blur reaches past what it copies. */
const GLOW_PAD = 16;

/**
 * Start or stop `svg` breathing: the item it belongs to is, or is no longer, the next to resolve.
 * The glow is the arrow's sibling, beneath it (`arrow.css`), so whoever removes the arrow removes
 * it through `removeArrow`.
 */
export function breathe(svg: SVGSVGElement, on: boolean): void {
  const glow = glows.get(svg);
  if (on === (glow !== undefined)) return;
  svg.toggleAttribute('data-next', on);
  if (!on) {
    glow!.remove();
    glows.delete(svg);
    return;
  }
  const layer = el('svg', 'arrow-glow');
  layer.setAttribute('aria-hidden', 'true');
  layer.append(el('path', 'arrow-glow__body'), el('path', 'arrow-glow__mark'));
  svg.after(layer);
  glows.set(svg, layer);
  syncGlow(svg);
}

/** Take an arrow away, and its glow with it. */
export function removeArrow(svg: Element): void {
  if (svg instanceof SVGSVGElement) {
    glows.get(svg)?.remove();
    glows.delete(svg);
  }
  svg.remove();
}

/** Copy the arrow (or its new shape) and its brackets into its glow, and fit the glow's box to them. */
function syncGlow(svg: SVGSVGElement, shape?: Pick<ArrowShape, 'd' | 'points' | 'shaft'>): void {
  const glow = glows.get(svg);
  if (glow === undefined) return;
  const shaft = shape?.shaft ?? svg.querySelector('.arrow__shaft')?.getAttribute('d') ?? '';
  const points = shape?.points ?? svg.querySelector('.arrow__head')?.getAttribute('points') ?? '';
  const spine = shape?.d ?? svg.querySelector('.arrow__spine')?.getAttribute('d') ?? '';
  const mark = svg.querySelector('.arrow__mark path')?.getAttribute('d') ?? '';
  glow.querySelector('.arrow-glow__body')!.setAttribute('d', points === '' ? shaft : `${shaft} M ${points.replaceAll(' ', ' L ').replaceAll(',', ' ')} Z`);
  glow.querySelector('.arrow-glow__mark')!.setAttribute('d', mark);
  // The box: the curve's hull (a quadratic lies inside its three points) and the brackets, padded for the blur.
  const n = spine.replace(/[MQ]/g, ' ').trim().split(/\s+/).map(Number);
  const xs = [n[0], n[2], n[4]].filter((v): v is number => Number.isFinite(v));
  const ys = [n[1], n[3], n[5]].filter((v): v is number => Number.isFinite(v));
  const m = marked.get(svg);
  if (m !== undefined) {
    xs.push(m[0], m[2]);
    ys.push(m[1], m[3]);
  }
  if (xs.length === 0) return;
  const [left, top] = [Math.min(...xs) - GLOW_PAD, Math.min(...ys) - GLOW_PAD];
  const [width, height] = [Math.max(...xs) - left + GLOW_PAD, Math.max(...ys) - top + GLOW_PAD];
  glow.setAttribute('viewBox', `${r1(left)} ${r1(top)} ${r1(width)} ${r1(height)}`);
  glow.style.left = `${r1(left)}px`;
  glow.style.top = `${r1(top)}px`;
  glow.style.width = `${r1(width)}px`;
  glow.style.height = `${r1(height)}px`;
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
    svg = newArrow({ testid: 'targeter', ghost: true });
    overlay.append(svg);
  }
  snapped.set(svg, spec.snap);
  flag(svg, 'data-source', spec.source === null ? null : String(spec.source));
  flag(svg, 'data-target', spec.target === null ? null : `${spec.target.kind}:${spec.target.id}`);
  flag(svg, 'data-snapped', spec.snap === null ? null : 'true');
  flag(svg, 'data-mode', spec.mode);
  positionArrow(svg, aimed.from, aimed.tip, overlay.getBoundingClientRect());
}

/** The element each targeter's tip snapped to when it was last drawn. */
const snapped = new WeakMap<SVGSVGElement, Element | null>();

/** The committed arrows still standing, each with the element it settled on. */
const committed = new Map<SVGSVGElement, { target: Element; expiry: ReturnType<typeof setTimeout> }>();

/** How long the gaps take to close, and how long a committed arrow waits for the arrow that replaces it. */
export const CLOSE_MS = 280;
export const COMMITTED_MAX_MS = 4000;

/**
 * A press or a release on `node`: if the targeter's tip is snapped to the element `node` is in,
 * that is the aim committed — whichever sender then answers Forge (a drag's `commitDrag`, a
 * card's own click, a held group's attack). The ghost closes into a solid arrow where it stands,
 * and stays until the arrow Forge's answer draws to the same target arrives (`retireCommitted`),
 * the gesture is cancelled (`clearCommitted`), or `COMMITTED_MAX_MS` passes.
 *
 * It leaves the `targeter` testid behind, so it is never the live arrow to anything that reads one.
 */
export function commitArrowAt(overlay: HTMLElement | null, node: EventTarget | null): void {
  const svg = overlay?.querySelector<SVGSVGElement>('[data-testid="targeter"][data-snapped]') ?? null;
  const target = svg === null ? null : (snapped.get(svg) ?? null);
  if (svg === null || target === null || !(node instanceof Node) || !target.contains(node)) return;
  svg.setAttribute('data-testid', 'targeter-committed');
  committed.set(svg, { target, expiry: setTimeout(() => retire(svg), COMMITTED_MAX_MS) });
  settle(svg);
}

/**
 * The gaps close as the head shrinks to its committed size, then the ribbon takes over from the
 * dashes and the rim bumps once (`arrow.css`'s `data-settle`).
 */
function settle(svg: SVGSVGElement): void {
  const ends = shaped.get(svg);
  const dashes = [...svg.querySelectorAll<SVGPathElement>('.arrow__stem')];
  const solid = (): void => {
    svg.removeAttribute('data-ghost');
    dashes.forEach((p) => p.remove());
    if (ends !== undefined) write(svg, arrowShape(ends.x1, ends.y1, ends.x2, ends.y2, 0));
    svg.setAttribute('data-settle', '');
  };
  if (ends === undefined || prefersReducedMotion()) {
    solid();
    return;
  }
  // The travel stops where it is: each dash keeps the offset its animation had reached.
  const offsets = dashes.map((p) => getComputedStyle(p).strokeDashoffset);
  dashes.forEach((p, i) => {
    p.style.strokeDashoffset = offsets[i]!;
    p.style.animation = 'none';
  });
  const start = performance.now();
  const step = (now: number): void => {
    if (!svg.isConnected) return;
    const k = Math.min(1, (now - start) / CLOSE_MS);
    const e = 1 - (1 - k) ** 3;
    if (k >= 1) {
      solid();
      return;
    }
    // Each chunk grows into its gap, so the chunks never jump; the rim's stays 4px longer.
    for (const p of dashes) {
      const grow = p.parentElement?.classList.contains('arrow__rim') === true ? 4 : 0;
      p.style.strokeDasharray = `${DASH + grow + GAP * e} ${Math.max(0, GAP - grow - GAP * e)}`;
    }
    write(svg, arrowShape(ends.x1, ends.y1, ends.x2, ends.y2, 1 - e));
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function retire(svg: SVGSVGElement): void {
  const c = committed.get(svg);
  if (c !== undefined) clearTimeout(c.expiry);
  committed.delete(svg);
  svg.remove();
}

/** The arrows Forge's answer drew have arrived: a committed arrow to any of their targets has done its job. */
export function retireCommitted(overlay: HTMLElement, targets: Iterable<Element>): void {
  if (committed.size === 0) return;
  const to = new Set(targets);
  for (const [svg, c] of committed) if (overlay.contains(svg) && to.has(c.target)) retire(svg);
}

/** The gesture was let go or the board is going: every committed arrow goes with it. */
export function clearCommitted(overlay: HTMLElement | null): void {
  for (const svg of [...committed.keys()]) if (overlay === null || overlay.contains(svg)) retire(svg);
}

/**
 * How far into its target an edge-aimed tip lands: this share of the way from the edge point
 * to the target's centre. The operator, 2026-10-28: *"it would probably be better if the arrow
 * went a bit into the card rather than just pointing at the edge"* — 25%, chosen on the preview.
 */
export const TIP_INSET = 0.25;

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
 * (Q11), carried `TIP_INSET` of the way toward its centre so the head lands ON
 * the target — except that a target touching the source, or the source itself,
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
 *    arrow there crosses the gap and lands inside the edge, as it always has
 *    (`w46-attack.spec.ts` pins the attack arrow at the planeswalker).
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
  const edge = edgeNearest(to, from);
  return { from, tip: { x: lerp(edge.x, centre.x, TIP_INSET), y: lerp(edge.y, centre.y, TIP_INSET) } };
}

/** `p` lies on or inside the box. */
function within(r: { left: number; top: number; right: number; bottom: number }, p: Point): boolean {
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
}

/** The nearest of the box's eight edge points (corners and mid-sides) to `from`. */
export function edgeNearest(r: { left: number; top: number; right: number; bottom: number }, from: Point): Point {
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

/** Take the live arrow away. Absent is fine — this is called on every gesture end. A committed one stays (`commitArrowAt`). */
export function clearArrow(overlay: HTMLElement | null): void {
  overlay?.querySelector('[data-testid="targeter"]')?.remove();
}

/** The persistent arrows' own testid — never `targeter`, so the one interactive arrow and these never collide. */
const AUTO_TESTID = 'stack-target-arrow';

/**
 * Reconcile the overlay's passive arrows against `specs` (item 8): one SVG per
 * spec, keyed by `data-key` so an unchanged pair is left alone across paints,
 * and every key not in `specs` any more is removed — the stack item resolved,
 * or its target left the board. Same ribbon as `drawArrow`, committed.
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
      svg = newArrow({ className: 'arrow--auto', testid: AUTO_TESTID });
      svg.setAttribute('data-key', spec.key);
      svg.setAttribute('data-role', spec.role);
      overlay.append(svg);
    }
    positionArrow(svg, aimed.from, aimed.tip, box!);
  }
  for (const el of [...overlay.querySelectorAll(`[data-testid="${AUTO_TESTID}"]`)]) {
    if (!seen.has(el.getAttribute('data-key') ?? '')) el.remove();
  }
  retireCommitted(overlay, specs.map((s) => s.to));
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

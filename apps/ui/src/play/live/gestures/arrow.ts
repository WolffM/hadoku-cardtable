/*
 * The targeter arrow. Ours: a tapered shaft and a plain head, no card frame, no
 * mana symbol, no tap symbol — nothing of WotC's (`CLAUDE.md`).
 *
 * Re-homed from `../LiveBoard.tsx`'s `Targeter` (wave 20), which drew it with
 * `createPortal`. This draws the same SVG with the same classes, the same
 * `data-*` and the same geometry, as plain DOM: `e2e/arrow.spec.ts` measures
 * `[data-testid="targeter"]`'s `line` and `polygon` in the overlay's own
 * coordinates and must keep reading exactly what it read before.
 *
 * Wave 24 §B.4 adds the second caller: the arrow now draws for CLICK targeting
 * too, from the same function, into the same overlay. `data-mode` says which
 * gesture drew it, and it is the only thing that is new.
 */
import { centreOf } from './targets.ts';
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
  mode: 'drag' | 'click';
}

/** The head's length and half-spread, in the overlay's own units. Wave 20's numbers. */
const HEAD = 13;
const SPREAD = 0.42;

/**
 * Draw (or move) the one arrow inside `overlay`.
 *
 * Idempotent: the SVG is created on the first call and updated in place after
 * it, so a pointermove does not churn the DOM. Everything is in the overlay's
 * own coordinates, so it is correct wherever lane A puts the overlay.
 */
export function drawArrow(overlay: HTMLElement, spec: ArrowSpec): void {
  const box = overlay.getBoundingClientRect();
  const tip = spec.snap === null ? spec.to : centreOf(spec.snap);
  const x1 = spec.from.x - box.left;
  const y1 = spec.from.y - box.top;
  const x2 = tip.x - box.left;
  const y2 = tip.y - box.top;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const points = [
    `${x2},${y2}`,
    `${x2 - HEAD * Math.cos(angle - SPREAD)},${y2 - HEAD * Math.sin(angle - SPREAD)}`,
    `${x2 - HEAD * Math.cos(angle + SPREAD)},${y2 - HEAD * Math.sin(angle + SPREAD)}`,
  ].join(' ');

  let svg = overlay.querySelector<SVGSVGElement>('[data-testid="targeter"]');
  if (svg === null) {
    svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'targeter');
    svg.setAttribute('data-testid', 'targeter');
    svg.setAttribute('aria-hidden', 'true');
    const shaft = document.createElementNS(SVG, 'line');
    shaft.setAttribute('class', 'targeter__shaft');
    const head = document.createElementNS(SVG, 'polygon');
    head.setAttribute('class', 'targeter__head');
    svg.append(shaft, head);
    overlay.append(svg);
  }
  flag(svg, 'data-source', spec.source === null ? null : String(spec.source));
  flag(svg, 'data-target', spec.target === null ? null : `${spec.target.kind}:${spec.target.id}`);
  flag(svg, 'data-snapped', spec.snap === null ? null : 'true');
  flag(svg, 'data-mode', spec.mode);
  const shaft = svg.querySelector('line')!;
  shaft.setAttribute('x1', String(x1));
  shaft.setAttribute('y1', String(y1));
  shaft.setAttribute('x2', String(x2));
  shaft.setAttribute('y2', String(y2));
  svg.querySelector('polygon')!.setAttribute('points', points);
}

/** Take the arrow away. Absent is fine — this is called on every gesture end. */
export function clearArrow(overlay: HTMLElement | null): void {
  overlay?.querySelector('[data-testid="targeter"]')?.remove();
}

/** An attribute that is ABSENT when it has no value — `undefined` in JSX, and what the e2e reads. */
function flag(el: Element, name: string, value: string | null): void {
  if (value === null) el.removeAttribute(name);
  else el.setAttribute(name, value);
}

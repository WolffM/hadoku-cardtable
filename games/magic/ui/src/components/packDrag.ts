/**
 * The pack's two drags (the operator, 2026-11-19: *"allow dragging cards off the
 * fan and into the pool for selecting rather than just clicking or pressing
 * enter. (this should also allow dragging a card directly to the sideboard)"*
 * and *"allow dragging the fan from left to right to scroll it"*).
 *
 * One press on the pack becomes one of three things, decided once, when the
 * pointer has travelled `DRAG_SLOP`, and kept until it is let go (`dragKind`):
 *
 *  - a PAN, when it left sideways: at least `PAN_BIAS` times further across
 *    than up or down. The fan's row follows the pointer a card per step. The
 *    bias is toward lifting, because the sideboard is down and to the right of
 *    most of the fan: a card dragged at it leaves on a diagonal, and a pan is
 *    a flat stroke along the row;
 *  - a LIFT, any other way off a card someone may take: a copy of the card
 *    follows the pointer (`PackView` draws it), and letting it go over the
 *    picks takes it, over the sideboard takes it into the sideboard, anywhere
 *    else puts it back;
 *  - a click, when it never travelled that far: what a press on the pack
 *    always was.
 *
 * Pointer events, not the builder's HTML drag (`deck/dragMove.tsx`): a pack
 * card is a button, which Firefox will not start an HTML drag from, an HTML
 * drag cannot be told from a pan once it starts, and a touch screen only
 * starts one on a long press. What a drop means is still that module's: the
 * areas are its `data-drop-area`s and their highlight its `data-drop-over`.
 */

import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';

import type { Area } from '../deck/dragMove.tsx';

/** How far a press travels before it is a drag: under it, a click. */
export const DRAG_SLOP = 8;
/** A drag is a pan when it left this many times further sideways than up or down. */
export const PAN_BIAS = 2;

export type DragKind = 'pan' | 'lift';

/**
 * What a press that has moved `dx`, `dy` is: null while it could still be a
 * click, `'none'` for a drag that does nothing here. `can.lift` is false off a
 * card; a row whose cards do not lift pans whichever way it is dragged.
 */
export function dragKind(dx: number, dy: number, can: { pan: boolean; lift: boolean }): DragKind | 'none' | null {
  if (Math.hypot(dx, dy) < DRAG_SLOP) return null;
  if (can.pan && (!can.lift || Math.abs(dx) >= PAN_BIAS * Math.abs(dy))) return 'pan';
  return can.lift ? 'lift' : 'none';
}

/** A viewport rectangle, as plain numbers. */
export interface DragRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The card in the air: which one, where its copy is drawn, and the area it would land in. */
export interface Lifted extends DragRect {
  at: number;
  over: Area | null;
}

/**
 * Where a card let go at `x`, `y` lands: the sideboard (`pool`) over the
 * picks' sideboard area, the deck anywhere else over the picks, null off them.
 */
export function dropAreaAt(root: Element, x: number, y: number): Area | null {
  const scope = root.getRootNode() as Document | ShadowRoot;
  const under = typeof scope.elementFromPoint === 'function' ? scope.elementFromPoint(x, y) : null;
  if (under === null || under.closest('[data-pick-drop]') === null) return null;
  return under.closest('[data-drop-area="pool"]') !== null ? 'pool' : 'deck';
}

export interface PackDragOptions {
  /** A pan this many px moves the row one card; null where nothing pans. */
  panStep: number | null;
  /** Cards can be taken now. */
  lifts: boolean;
  /** The open card, read as a pan starts. */
  open: () => number;
  /** The open card a pan asks for; the caller keeps it inside the pack. */
  onPan: (open: number) => void;
  /** A drag began. */
  onStart: () => void;
  /** The area a lifted card is over as it moves, and `undefined` once it is let go. */
  onOver: (over: Area | null | undefined) => void;
  /** Card `at` let go over `to`, its copy at `from`. */
  onDrop: (at: number, to: Area, from: DragRect) => void;
}

interface Press {
  id: number;
  x: number;
  y: number;
  /** The slot pressed, or -1 for the pack's own background. */
  at: number;
  rect: DragRect | null;
  kind: DragKind | null;
  open: number;
}

export interface PackDrag {
  /** Spread on the pack's root. */
  handlers: {
    onPointerDown: (e: PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: PointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: PointerEvent<HTMLElement>) => void;
    onLostPointerCapture: (e: PointerEvent<HTMLElement>) => void;
    onClickCapture: (e: MouseEvent<HTMLElement>) => void;
    onDragStart: (e: MouseEvent<HTMLElement>) => void;
  };
  lifted: Lifted | null;
  /** A pan or a lift is under way: the pointer passing over a card is not a hover. */
  active: () => boolean;
  /** Put a lifted card back (its pack is gone, or was passed). */
  cancel: () => void;
}

/** Where the pressed card's copy is with the pointer at `e`, and what it is over. */
function liftAt(p: Press, e: PointerEvent<HTMLElement>): Lifted {
  const rect = p.rect ?? { left: p.x, top: p.y, width: 0, height: 0 };
  return {
    at: p.at,
    left: rect.left + e.clientX - p.x,
    top: rect.top + e.clientY - p.y,
    width: rect.width,
    height: rect.height,
    over: dropAreaAt(e.currentTarget, e.clientX, e.clientY),
  };
}

export function usePackDrag(options: PackDragOptions): PackDrag {
  const opts = useRef(options);
  opts.current = options;
  const press = useRef<Press | null>(null);
  /** The click a drag's release fires is the drag's, not a pick. */
  const swallow = useRef(false);
  const [lifted, setLifted] = useState<Lifted | null>(null);

  const stop = useRef((): void => {
    const was = press.current;
    press.current = null;
    if (was?.kind !== 'lift') return;
    setLifted(null);
    opts.current.onOver(undefined);
  }).current;

  // Escape puts a lifted card back.
  const lifting = lifted !== null;
  useEffect(() => {
    if (!lifting) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') stop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lifting, stop]);

  const handlers = useRef<PackDrag['handlers']>({
    onPointerDown: (e) => {
      swallow.current = false;
      if (press.current !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const slot = (e.target as Element).closest('.pack__slot');
      const at = slot === null ? -1 : Array.prototype.indexOf.call(e.currentTarget.children, slot);
      const r = slot?.getBoundingClientRect();
      press.current = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        at,
        rect: r === undefined ? null : { left: r.left, top: r.top, width: r.width, height: r.height },
        kind: null,
        open: opts.current.open(),
      };
    },
    onPointerMove: (e) => {
      const p = press.current;
      if (p === null || e.pointerId !== p.id) return;
      const o = opts.current;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      if (p.kind === null) {
        const kind = dragKind(dx, dy, { pan: o.panStep !== null, lift: o.lifts && p.at >= 0 });
        if (kind === null) return;
        if (kind === 'none') {
          press.current = null;
          return;
        }
        p.kind = kind;
        swallow.current = true;
        // The rest of the drag is the pack's, wherever the pointer goes. A pointer the browser
        // has already let go of (or a DOM with no capture) is followed as far as its events reach.
        try {
          e.currentTarget.setPointerCapture(p.id);
        } catch {
          // Nothing to capture.
        }
        o.onStart();
      }
      if (p.kind === 'pan') {
        if (o.panStep !== null && o.panStep > 0) o.onPan(p.open - Math.round(dx / o.panStep));
        return;
      }
      const lift = liftAt(p, e);
      setLifted(lift);
      o.onOver(lift.over);
    },
    onPointerUp: (e) => {
      const p = press.current;
      if (p === null || e.pointerId !== p.id) return;
      const lift = p.kind === 'lift' ? liftAt(p, e) : null;
      stop();
      if (lift !== null && lift.over !== null) opts.current.onDrop(lift.at, lift.over, lift);
    },
    onPointerCancel: (e) => {
      if (press.current?.id === e.pointerId) stop();
    },
    onLostPointerCapture: (e) => {
      if (press.current?.id === e.pointerId && press.current.kind !== null) stop();
    },
    onClickCapture: (e) => {
      if (!swallow.current) return;
      swallow.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
    // A card's art is an image, and the browser's own drag of it would end the press.
    onDragStart: (e) => e.preventDefault(),
  }).current;

  return { handlers, lifted, active: () => press.current?.kind != null, cancel: stop };
}

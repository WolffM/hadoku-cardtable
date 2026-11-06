/*
 * Pan and zoom for the deck editor's two card surfaces — the pool grid, and
 * the deck's piles — never for its pinned bar or its strip (the operator:
 * "sideboarding view is a mess … displaying the entire thing on the screen is
 * certainly wrong"). One shared zoom (one pill, one "100%"), because the
 * editor's own default — everything fits at zoom 1 — is one idea, not two;
 * each surface keeps its OWN pan offset, because they are two separate lists
 * a drag over one must never move the other.
 *
 * ## Pan, and a card's own gestures
 *
 * A card moves by a click (what a finger's tap fires too) or by a mouse's
 * native HTML5 drag (`dragMove.tsx`). A press becomes a pan only once it
 * travels past `PAN_SLOP`, so a tap is never a pan; a finger may pan from
 * anywhere, a card included, while a mouse pans only from empty space,
 * because a mouse press on a card is that card's drag (`mayPan`). A press
 * that panned swallows its own trailing click, so a pan never moves a card.
 *
 * ## The zoom anchor
 *
 * A pinch, a ctrl+wheel and the pill's − and + all resolve to `zoomAt`: zoom
 * to a target while keeping one viewport point of each surface over the same
 * point of its content. A gesture anchors its own surface under the fingers
 * and the other at its top-left; a step anchors both at their centres. Every
 * pan and zoom is clamped (`clampOffset`) so content never leaves a gap.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

/** A tile the deck editor's own gestures (a click, a mouse's native drag) already own. */
const CARD_SELECTOR = '.deck-editor__card';

/** How far a press travels before it is a pan rather than a tap, in CSS px. */
export const PAN_SLOP = 6;

/**
 * Whether a press may become a pan. A finger always may, wherever it lands: a tap on a card still
 * moves it (no travel, no pan), and a swipe that starts on one pans. A mouse on a card is that
 * card's own click or native drag, so only a mouse on empty space pans.
 */
export function mayPan(pointerType: string, target: EventTarget | null): boolean {
  if (pointerType !== 'mouse') return true;
  return !(target instanceof Element && target.closest(CARD_SELECTOR) !== null);
}

/** One surface's pan offset, in viewport px — the translate half of its transform. */
export interface Offset {
  readonly x: number;
  readonly y: number;
}

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 3;

/** `zoom`, kept inside `[ZOOM_MIN, ZOOM_MAX]` — the one place either bound is spelled out. */
export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

export type Surface = 'pool' | 'deck';

/** The editor's whole view: one zoom, and each surface's own pan offset. */
export interface EditorView {
  readonly zoom: number;
  readonly pool: Offset;
  readonly deck: Offset;
}

/** Zoom 1, no pan either side — today's "everything fits" layout, unchanged. */
export const IDENTITY_VIEW: EditorView = { zoom: ZOOM_MIN, pool: { x: 0, y: 0 }, deck: { x: 0, y: 0 } };

/** The CSS transform a surface draws at, from the view and its own offset. */
export function transformOf(zoom: number, offset: Offset): string {
  return `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`;
}

/** The distance between two touches, for a pinch's zoom factor. */
export function pinchDistance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

/** A surface's viewport and its content, unscaled, in CSS px — what a pan is clamped against. */
export interface Extent {
  readonly viewW: number;
  readonly viewH: number;
  readonly contentW: number;
  readonly contentH: number;
}

/** `offset` kept so the scaled content never leaves a gap it could cover: no further than its own edges. */
export function clampOffset(offset: Offset, zoom: number, e: Extent): Offset {
  const minX = Math.min(0, e.viewW - e.contentW * zoom);
  const minY = Math.min(0, e.viewH - e.contentH * zoom);
  return { x: Math.min(0, Math.max(minX, offset.x)), y: Math.min(0, Math.max(minY, offset.y)) };
}

/** The midpoint between two touches — the pinch's own anchor. */
export function pinchCenter(ax: number, ay: number, bx: number, by: number): { x: number; y: number } {
  return { x: (ax + bx) / 2, y: (ay + by) / 2 };
}

/**
 * `view` zoomed to `targetZoom`, keeping each surface's anchor (a viewport point, in that surface's
 * own coordinates) over the same point of its content, then clamped to each surface's extent. A
 * gesture anchors the surface it is on at the fingers and the other at its top-left corner; a step
 * button anchors both at their centres. A no-op zoom returns `view` itself.
 */
export function zoomAt(
  view: EditorView,
  targetZoom: number,
  anchors: Readonly<Record<Surface, { x: number; y: number }>>,
  extents: Readonly<Partial<Record<Surface, Extent>>> = {},
): EditorView {
  const zoom = clampZoom(targetZoom);
  if (zoom === view.zoom) return view;
  const scale = zoom / view.zoom;
  const at = (s: Surface): Offset => {
    const o = view[s];
    const a = anchors[s];
    const next = { x: a.x - (a.x - o.x) * scale, y: a.y - (a.y - o.y) * scale };
    const e = extents[s];
    return e === undefined ? next : clampOffset(next, zoom, e);
  };
  return { zoom, pool: at('pool'), deck: at('deck') };
}

/** `view` with `surface` panned by `(dx, dy)` viewport px — 1:1 with the pointer, at any zoom — and clamped. */
export function panBy(view: EditorView, surface: Surface, dx: number, dy: number, extent?: Extent): EditorView {
  const offset = view[surface];
  const moved = { x: offset.x + dx, y: offset.y + dy };
  const next = extent === undefined ? moved : clampOffset(moved, view.zoom, extent);
  if (next.x === offset.x && next.y === offset.y) return view;
  return { ...view, [surface]: next };
}

/** How fast a wheel notch zooms: `WHEEL_SENSITIVITY` px of `deltaY` is one e-fold. */
const WHEEL_SENSITIVITY = 100;
/** What one press of the pill's − or + multiplies the zoom by. */
export const ZOOM_STEP = 1.25;

export interface PanZoomHandle {
  readonly view: EditorView;
  /** Back to zoom 1, no pan either side — the pill's own reset. */
  readonly reset: () => void;
  /** Zoom by `factor`, each surface anchored at its own centre — the pill's − and +. */
  readonly step: (factor: number) => void;
  /** Ref callback: bind to the pool surface's viewport element. */
  readonly bindPool: (el: HTMLElement | null) => void;
  /** Ref callback: bind to the deck surface's viewport element. */
  readonly bindDeck: (el: HTMLElement | null) => void;
}

const SURFACES: readonly Surface[] = ['pool', 'deck'];

/** A viewport's extent: its own client box, and its one child surface's unscaled layout box. */
function extentOf(el: HTMLElement): Extent {
  const surface = el.firstElementChild as HTMLElement | null;
  return {
    viewW: el.clientWidth,
    viewH: el.clientHeight,
    contentW: surface?.offsetWidth ?? el.clientWidth,
    contentH: surface?.offsetHeight ?? el.clientHeight,
  };
}

/**
 * Installs pan (one pointer dragging), pinch-zoom (two touches) and desktop zoom (wheel held with
 * ctrl, which is also what a trackpad pinch sends) on whichever element each `bind*` is handed —
 * native listeners, because the wheel listener must be `{ passive: false }` to `preventDefault()`
 * the page's own zoom, and pointer capture needs the real element.
 *
 * A press becomes a pan only once it travels past `PAN_SLOP`, and only then is the pointer captured:
 * capturing at the press would retarget a tap's `click` from the card to the viewport, and the card
 * would never move. A press that did pan swallows the `click` it would otherwise end in.
 */
export function usePanZoom(): PanZoomHandle {
  const [view, setView] = useState<EditorView>(IDENTITY_VIEW);
  const viewRef = useRef(view);
  viewRef.current = view;
  const els = useRef<Partial<Record<Surface, HTMLElement>>>({});
  const cleanups = useRef<Partial<Record<Surface, () => void>>>({});

  const extents = (): Partial<Record<Surface, Extent>> => {
    const out: Partial<Record<Surface, Extent>> = {};
    for (const s of SURFACES) {
      const el = els.current[s];
      if (el !== undefined) out[s] = extentOf(el);
    }
    return out;
  };

  const reset = useCallback((): void => setView(IDENTITY_VIEW), []);

  const step = useCallback((factor: number): void => {
    const ex = extents();
    const centre = (s: Surface): { x: number; y: number } => ({ x: (ex[s]?.viewW ?? 0) / 2, y: (ex[s]?.viewH ?? 0) / 2 });
    setView((v) => zoomAt(v, v.zoom * factor, { pool: centre('pool'), deck: centre('deck') }, ex));
  }, []);

  const bind = useCallback(
    (surface: Surface) =>
      (el: HTMLElement | null): void => {
        cleanups.current[surface]?.();
        delete cleanups.current[surface];
        delete els.current[surface];
        if (el === null) return;
        els.current[surface] = el;

        /** Live pointers by id — one pans, two pinch. */
        const pointers = new Map<number, { x: number; y: number }>();
        /** The one pointer that may pan: where it pressed, where it last was, and whether it has started. */
        let pan: { id: number; from: { x: number; y: number }; last: { x: number; y: number }; moving: boolean } | null = null;
        let pinchStart: { dist: number; zoom: number } | null = null;
        let swallowClick = false;

        const rezoom = (targetZoom: number, cx: number, cy: number): void => {
          const rect = el.getBoundingClientRect();
          const anchors = { pool: { x: 0, y: 0 }, deck: { x: 0, y: 0 }, [surface]: { x: cx - rect.left, y: cy - rect.top } };
          const ex = extents();
          setView((v) => zoomAt(v, targetZoom, anchors, ex));
        };

        const onPointerDown = (e: PointerEvent): void => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          swallowClick = false;
          pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.size === 2) {
            pan = null;
            const [a, b] = [...pointers.values()];
            pinchStart = { dist: pinchDistance(a!.x, a!.y, b!.x, b!.y), zoom: viewRef.current.zoom };
          } else if (pointers.size === 1 && mayPan(e.pointerType, e.target)) {
            const at = { x: e.clientX, y: e.clientY };
            pan = { id: e.pointerId, from: at, last: at, moving: false };
          }
        };

        const onPointerMove = (e: PointerEvent): void => {
          if (!pointers.has(e.pointerId)) return;
          pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.size === 2 && pinchStart !== null) {
            const [a, b] = [...pointers.values()];
            const center = pinchCenter(a!.x, a!.y, b!.x, b!.y);
            swallowClick = true;
            rezoom(pinchStart.zoom * (pinchDistance(a!.x, a!.y, b!.x, b!.y) / pinchStart.dist), center.x, center.y);
            return;
          }
          if (pan === null || pan.id !== e.pointerId) return;
          if (!pan.moving) {
            if (Math.hypot(e.clientX - pan.from.x, e.clientY - pan.from.y) < PAN_SLOP) return;
            pan.moving = true;
            swallowClick = true;
            try {
              el.setPointerCapture(e.pointerId);
            } catch {
              // A pointer the browser has already released cannot be captured; its moves still arrive while it is over `el`.
            }
          }
          const dx = e.clientX - pan.last.x;
          const dy = e.clientY - pan.last.y;
          pan.last = { x: e.clientX, y: e.clientY };
          const ex = extentOf(el);
          setView((v) => panBy(v, surface, dx, dy, ex));
        };

        const onPointerEnd = (e: PointerEvent): void => {
          pointers.delete(e.pointerId);
          if (pointers.size < 2) pinchStart = null;
          if (pan?.id === e.pointerId) pan = null;
        };

        const onClick = (e: MouseEvent): void => {
          if (!swallowClick) return;
          swallowClick = false;
          e.stopPropagation();
          e.preventDefault();
        };

        const onWheel = (e: WheelEvent): void => {
          if (!e.ctrlKey) return;
          e.preventDefault();
          rezoom(viewRef.current.zoom * Math.exp(-e.deltaY / WHEEL_SENSITIVITY), e.clientX, e.clientY);
        };

        el.addEventListener('pointerdown', onPointerDown);
        el.addEventListener('pointermove', onPointerMove);
        el.addEventListener('pointerup', onPointerEnd);
        el.addEventListener('pointercancel', onPointerEnd);
        el.addEventListener('click', onClick, true);
        el.addEventListener('wheel', onWheel, { passive: false });
        cleanups.current[surface] = () => {
          el.removeEventListener('pointerdown', onPointerDown);
          el.removeEventListener('pointermove', onPointerMove);
          el.removeEventListener('pointerup', onPointerEnd);
          el.removeEventListener('pointercancel', onPointerEnd);
          el.removeEventListener('click', onClick, true);
          el.removeEventListener('wheel', onWheel);
        };
      },
    [],
  );

  const bindPool = useMemo(() => bind('pool'), [bind]);
  const bindDeck = useMemo(() => bind('deck'), [bind]);

  return { view, reset, step, bindPool, bindDeck };
}

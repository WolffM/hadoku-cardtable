/* Stand-ins: a copy of an element in an overlay, moving where the element must not (a transform in a laid-out row counts toward its overflow). */

import { everyFrame } from './frame.ts';

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** `r` as a box relative to `to`. */
export const rel = (r: DOMRect, to: DOMRect): Box => ({ left: r.left - to.left, top: r.top - to.top, width: r.width, height: r.height });

export interface StandInOptions {
  cls: string;
  /** The piece inside it that carries the copy, and `data-stand-in`'s value. */
  pieceCls: string;
  key: string;
  copy: (el: HTMLElement) => HTMLElement;
  /** `el` as drawn now, once it is no longer connected; null when gone. */
  find: () => HTMLElement | null;
}

/**
 * A copy of `el` in `overlay`, kept on `el`'s box every frame until `stop`. Mounted, the copy's face is lined up
 * on `el`'s exactly, so handing over either way never jumps. An `el` drawn again meanwhile is followed, and hidden.
 */
export function standIn(overlay: HTMLElement, el: HTMLElement, o: StandInOptions): { wrap: HTMLElement; box: () => Box; card: () => HTMLElement; mount: () => void; stop: () => void } {
  const wrap = document.createElement('div');
  wrap.className = o.cls;
  wrap.dataset.standIn = o.key;
  wrap.setAttribute('aria-hidden', 'true');
  const piece = document.createElement('div');
  piece.className = o.pieceCls;
  const copy = o.copy(el);
  piece.append(copy);
  wrap.append(piece);
  let at: Box = rel(el.getBoundingClientRect(), overlay.getBoundingClientRect());
  let fix = { x: 0, y: 0 };
  let live = true;
  /** The read: where `el` is drawn now. */
  const measure = (): void => {
    if (!el.isConnected) {
      const now = o.find();
      if (now !== null) {
        el = now;
        el.style.visibility = 'hidden';
      }
    }
    if (el.isConnected) at = rel(el.getBoundingClientRect(), overlay.getBoundingClientRect());
  };
  /** The write: the copy over it. */
  const draw = (): void => {
    Object.assign(wrap.style, { left: `${at.left + fix.x}px`, top: `${at.top + fix.y}px`, width: `${at.width}px` });
    wrap.style.setProperty('--card-w', `${at.width}px`);
  };
  const mount = (): void => {
    measure();
    draw();
    overlay.append(wrap);
    // With no motion on it yet: where the copy is against `el`, in one layout that `el`'s box comes out of too.
    const want = el.getBoundingClientRect();
    const got = copy.getBoundingClientRect();
    fix = { x: want.left - got.left, y: want.top - got.top };
    at = rel(want, overlay.getBoundingClientRect());
    draw();
    everyFrame(() => {
      if (!live) return null;
      measure();
      return draw;
    });
  };
  return { wrap, box: () => at, card: () => el, mount, stop: () => (live = false) };
}

/**
 * Runs `done` once `el`'s running `left`/`top` transitions have finished (a clock started at the style change
 * runs ahead of a transition that starts a frame later), a retargeted one waited for in turn; nothing running
 * is done next microtask, and a page that cannot list animations (jsdom) waits `fallbackMs`. Returns a cancel.
 */
export function afterGlide(el: Element, done: () => void, fallbackMs: number): () => void {
  let live = true;
  if (typeof el.getAnimations !== 'function') {
    const timer = setTimeout(done, fallbackMs);
    return () => clearTimeout(timer);
  }
  const wait = (): void => {
    if (!live) return;
    const running = el.getAnimations().filter((a) => 'transitionProperty' in a && (a.transitionProperty === 'left' || a.transitionProperty === 'top'));
    if (running.length > 0) {
      // Finished or cancelled (retargeted, or the element gone), it is looked at again: a cancel is not an arrival.
      void Promise.allSettled(running.map((a) => a.finished)).then(wait);
      return;
    }
    live = false;
    done();
  };
  queueMicrotask(wait);
  return () => {
    live = false;
  };
}

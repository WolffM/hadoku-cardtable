/*
 * The box-draw rectangle (§B.2). Arena's marquee: drag over your own creatures
 * and every one Forge offered inside it is selected.
 *
 * Guidance only — `./commit.ts`'s `commitMarquee` is what decides, off the
 * elements' own boxes, and it works whether or not this drew anything. Like the
 * arrow it lives in lane A's overlay, in the overlay's own coordinates, and it
 * never takes the pointer.
 */
import type { Rect } from './commit.ts';

export function drawMarquee(overlay: HTMLElement, rect: Rect): void {
  const box = overlay.getBoundingClientRect();
  let el = overlay.querySelector<HTMLElement>('[data-testid="marquee"]');
  if (el === null) {
    el = document.createElement('div');
    el.className = 'marquee';
    el.setAttribute('data-testid', 'marquee');
    el.setAttribute('aria-hidden', 'true');
    overlay.append(el);
  }
  el.style.left = `${rect.left - box.left}px`;
  el.style.top = `${rect.top - box.top}px`;
  el.style.width = `${rect.right - rect.left}px`;
  el.style.height = `${rect.bottom - rect.top}px`;
}

export function clearMarquee(overlay: HTMLElement | null): void {
  overlay?.querySelector('[data-testid="marquee"]')?.remove();
}

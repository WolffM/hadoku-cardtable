/*
 * The board's tooltip: what a mark means, on hover. The operator, 2026-10-12:
 * *"when any of our symbols are hovered … show a little tooltip for what it
 * means (summoning sickness, token, keywords, etc."*
 *
 * One mechanism, read off the DOM the way the inspector is (`../inspect`): an
 * element that means something carries its words in `data-tip`, and this module
 * draws them. Nothing here knows what a mark is.
 *
 * ## The marks take no pointer events, and keep taking none
 *
 * Every mark on a card (`card.css`: the corner marks, the keyword tags, the
 * counters, the P/T badge, the ×N count) is `pointer-events: none`, so a press
 * anywhere on a card is the card's — Forge's offer, a drag, an arrangement.
 * Giving the marks the pointer back to hover them would take those presses
 * away. So a mark is found by its BOX: the pointer is over a card, and the tip
 * is that card's own mark whose box holds the pointer. Over the rest of the card
 * there is no tip — the art is the inspector's. A mark drawn on the card's tile itself (a Room door's,
 * `CardTile`'s `DoorMark`) is found the same way. A card that is itself the thing to explain (a
 * hand card an effect forbids) carries `data-tip` on its own `<li>`.
 *
 * Off the cards, the nearest `data-tip` ancestor of the pointer's target (the
 * phase rail's stop).
 *
 * The tip is drawn in the board's zoom layer at the pointer, takes no pointer events
 * and never steals focus; a press puts it away. Keyboard focus on an element
 * with `data-tip` shows it the same way.
 */
import { scopeOf } from '../../dom.ts';
import { topLayerIn } from '../../topLayer.tsx';

import './tip.css';

/** The offset from the pointer, so the tip never sits under it. */
const OFFSET = { x: 12, y: 16 };
const EDGE = 4;

/** Whether the point is inside the element's box. */
function holds(el: Element, x: number, y: number): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/**
 * The element whose `data-tip` answers a pointer at (`x`, `y`) over `target`: a
 * mark of the card under it whose box holds the point, else the card itself when
 * it carries one, else the nearest `data-tip` ancestor. Null for none.
 */
export function tipAt(target: Element, x: number, y: number): HTMLElement | null {
  const card = target.closest<HTMLElement>('.board-card');
  if (card !== null) {
    for (const mark of card.querySelectorAll<HTMLElement>(':scope > [data-tip], :scope > :not(.board-card__pile) > [data-tip], :scope > .board-card__face [data-tip]')) {
      if (holds(mark, x, y)) return mark;
    }
    if (card.dataset.tip !== undefined) return card;
  }
  return target.closest<HTMLElement>('[data-tip]:not(.board-card)');
}

/** Where the tip goes: beside the pointer, flipped to the other side at the layer's edges. */
export function placeTip(
  at: { x: number; y: number },
  size: { width: number; height: number },
  layer: { left: number; top: number; width: number; height: number },
): { left: number; top: number } {
  let left = at.x - layer.left + OFFSET.x;
  let top = at.y - layer.top + OFFSET.y;
  if (left + size.width > layer.width - EDGE) left = at.x - layer.left - OFFSET.x - size.width;
  if (top + size.height > layer.height - EDGE) top = at.y - layer.top - OFFSET.y - size.height;
  return { left: Math.max(EDGE, left), top: Math.max(EDGE, top) };
}

/** Boot the tooltip on a board. Returns the dispose. */
export function mountTips(root: HTMLElement): () => void {
  const scope = scopeOf(root);
  let tip: HTMLElement | null = null;
  let frame = 0;
  let pending: { target: EventTarget | null; x: number; y: number } | null = null;

  function hide(): void {
    tip?.remove();
    tip = null;
  }

  function show(host: HTMLElement, x: number, y: number): void {
    const text = host.dataset.tip ?? '';
    const layer = topLayerIn(root);
    if (text === '' || layer === null) {
      hide();
      return;
    }
    if (tip === null || tip.parentElement !== layer) {
      hide();
      tip = document.createElement('div');
      tip.className = 'board-tip';
      tip.setAttribute('role', 'tooltip');
      tip.setAttribute('data-testid', 'board-tip');
      layer.appendChild(tip);
    }
    if (tip.textContent !== text) tip.textContent = text;
    const spot = placeTip({ x, y }, { width: tip.offsetWidth, height: tip.offsetHeight }, layer.getBoundingClientRect());
    tip.style.left = `${spot.left}px`;
    tip.style.top = `${spot.top}px`;
  }

  function settle(): void {
    frame = 0;
    const at = pending;
    pending = null;
    if (at === null) return;
    const host = at.target instanceof Element ? tipAt(at.target, at.x, at.y) : null;
    if (host === null) hide();
    else show(host, at.x, at.y);
  }

  function onPointerMove(event: Event): void {
    const e = event as PointerEvent;
    if (e.pointerType === 'touch') return;
    // A held button is a drag or a selection: the pointer is spoken for.
    if (e.buttons !== 0) {
      hide();
      return;
    }
    pending = { target: e.target, x: e.clientX, y: e.clientY };
    if (frame === 0) frame = requestAnimationFrame(settle);
  }

  function onPointerOut(event: Event): void {
    if ((event as PointerEvent).relatedTarget === null) hide();
  }

  function onFocusIn(event: Event): void {
    const host = event.target instanceof HTMLElement && event.target.dataset.tip !== undefined ? event.target : null;
    if (host === null) return;
    const r = host.getBoundingClientRect();
    show(host, r.left, r.bottom);
  }

  scope.addEventListener('pointermove', onPointerMove, { passive: true });
  scope.addEventListener('pointerout', onPointerOut);
  scope.addEventListener('pointerdown', hide, true);
  scope.addEventListener('focusin', onFocusIn);
  scope.addEventListener('focusout', hide);
  return () => {
    if (frame !== 0) cancelAnimationFrame(frame);
    scope.removeEventListener('pointermove', onPointerMove);
    scope.removeEventListener('pointerout', onPointerOut);
    scope.removeEventListener('pointerdown', hide, true);
    scope.removeEventListener('focusin', onFocusIn);
    scope.removeEventListener('focusout', hide);
    hide();
  };
}

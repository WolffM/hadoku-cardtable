/*
 * The gesture state machine, and the one entry point.
 *
 * Framework-free: `installGestures` takes lane C's canvas element, attaches
 * `pointerdown` to it by DELEGATION and the move/release pair to `window`, and
 * creates its own DOM inside lane A's overlay root. It renders nothing through
 * React and holds no React state, which is what lets the same code answer a
 * drag, a box-draw and a bare hover without a re-render between them.
 *
 * ## window, not pointer capture
 *
 * The move and the release are listened for on `window` with no pointer
 * capture, so the event's own `target` is the element UNDER the pointer: jsdom
 * has no `elementFromPoint`, and a captured pointer would report the source
 * anyway. `e2e/arrow.spec.ts` cancels a drag by dispatching `pointercancel` on
 * `window`, which is the same seam from the other side.
 *
 * ## Which gesture a press starts
 *
 * In this order, and the order is the whole of the disambiguation:
 *
 *  1. **on a card Forge offered** → a DRAG from that card (wave 20). This is
 *     also how an attacker is declared by dragging it forward, which
 *     `../combat-drag.jvm.test.ts` proves against a real Forge, so it stays
 *     first.
 *  2. **elsewhere on the table while this seat is declaring attackers** → a
 *     BOX-DRAW (§B.2). Nothing else claims that press: a selection is not open
 *     during `InputAttack`, so the pointing gesture below cannot fire.
 *  3. **elsewhere on the table while a selection is open** → the source-less
 *     pointing gesture (wave 20): the spell doing the targeting is not itself
 *     one of Forge's choices, so there is often no offered card to drag FROM.
 *
 * A press that never passes `DRAG_SLOP_PX` is a plain click and this layer
 * stays out of it — no suppression, exactly as before.
 *
 * ## Nothing here decides legality
 *
 * Every send goes through `./commit.ts` into `../match.ts`'s `selectCard` /
 * `selectPlayer`, which re-check Forge's CURRENT offer. A gesture can pick the
 * wrong thing; it cannot put an id on the wire that Forge did not name.
 */
import { boardInteraction, declaringAttackers, subscribe } from '../match.ts';
import { clearArrow, drawArrow } from './arrow.ts';
import { commitDrag, commitMarquee, rectOf, type Rect } from './commit.ts';
import { applyIntents, clearIntents } from './intent.ts';
import { clearMarquee, drawMarquee } from './marquee.ts';
import { boxOf, cardBox, centreOf, targetUnder } from './targets.ts';
import {
  DRAG_SLOP_PX,
  type DragState,
  type GestureHandle,
  type GestureOptions,
  type MarqueeState,
  type Point,
} from './types.ts';
import './gestures.css';

/** Set on the canvas while this layer is installed, so `./gestures.css` can dress it. */
const CANVAS_ATTR = 'data-gesture-canvas';

export function installGestures(options: GestureOptions): GestureHandle {
  const { canvas, match } = options;
  let drag: DragState | null = null;
  let marquee: MarqueeState | null = null;
  /** Where the pointer is while NO gesture is held — the click-targeting arrow's tip. */
  let hover: { at: Point; node: EventTarget | null } | null = null;
  /** What was drawn last, so `onChange` fires on a change and not on every move. */
  let shape = '';
  let live = true;

  const overlayOf = (): HTMLElement | null => canvas.querySelector<HTMLElement>('[data-board-overlay]');

  const inside = (node: EventTarget | null): boolean =>
    node instanceof Element && (node.closest('.board') !== null || node.closest('[data-zone]') !== null);

  /**
   * The press began on something the BROWSER will drag natively.
   *
   * Lane A's arrange gesture (§A.1) makes every card on the viewer's own
   * battlefield `draggable="true"` and hangs HTML5 `dragstart`/`drop` on it
   * (`Board.tsx:644,658-662`). That press and this layer's overlap, and the
   * expensive half is a card Forge did NOT offer while a selection is open: it
   * is draggable, so the native drag runs, and the source-less pointing gesture
   * below would run too — one press that rearranges the battlefield AND sends
   * `selectCard` for whatever it was released over. So a press that started on a
   * natively-draggable element starts no gesture of ours.
   *
   * It costs no legal drag source. The card branch above returns first for
   * anything `boardInteraction` offered, and lane A's own half of the fix makes
   * an offered card not `draggable` at all — belt and braces, and either one
   * alone is enough.
   */
  const nativelyDraggable = (node: EventTarget | null): boolean => {
    if (!(node instanceof Element)) return false;
    const found = node.closest('[draggable="true"]');
    return found !== null && canvas.contains(found);
  };

  /**
   * The tail of the CLICK-targeting arrow (§B.4), or null when there is nothing
   * to draw from.
   *
   * A drag anchors its arrow to the card it was picked up from. A click has no
   * such anchor, so the tail is the thing the player pointed at last
   * (`match.lastSelectedCard` — the card they clicked to cast or activate) and,
   * failing that, the top of the stack: a triggered ability that wants a target
   * was never clicked at all, and its source is what the arrow should leave
   * from. No origin, no arrow — a tail from nowhere is not guidance.
   */
  function clickOrigin(): Element | null {
    const held = match.lastSelectedCard;
    if (held !== null) {
      const box = cardBox(canvas, held);
      if (box !== null) return box;
    }
    for (const item of match.view?.stack ?? []) {
      if (item.sourceCardId === null) continue;
      const box = cardBox(canvas, item.sourceCardId);
      if (box !== null) return box;
    }
    return null;
  }

  /** Draw whatever the current state means, into lane A's overlay. Absent overlay: nothing. */
  function paint(): void {
    const overlay = overlayOf();
    flag(CANVAS_ATTR, '');
    flag('data-dragging', drag !== null && drag.moved ? '' : null);
    flag('data-marquee', marquee !== null && marquee.moved ? '' : null);
    applyIntents(canvas, match);

    let next = '';
    if (overlay === null) {
      // The arrow is guidance, not the gesture: with no overlay nothing is
      // drawn and every send below still happens.
    } else if (drag !== null && drag.moved) {
      const snap = drag.target === null ? null : boxOf(canvas, drag.target);
      drawArrow(overlay, { from: drag.from, to: drag.at, source: drag.source, target: drag.target, snap, mode: 'drag' });
      clearMarquee(overlay);
      next = `drag:${drag.source ?? ''}:${drag.target === null ? '' : `${drag.target.kind}:${drag.target.id}`}`;
    } else if (marquee !== null && marquee.moved) {
      clearArrow(overlay);
      drawMarquee(overlay, rectOf(marquee.press, marquee.at));
      next = 'marquee';
    } else {
      const origin = hover !== null && match.selectables !== null ? clickOrigin() : null;
      if (origin === null || hover === null) {
        clearArrow(overlay);
        clearMarquee(overlay);
      } else {
        const target = targetUnder(hover.node, boardInteraction(match));
        const snap = target === null ? null : boxOf(canvas, target);
        const source = originId(origin);
        drawArrow(overlay, { from: centreOf(origin), to: hover.at, source, target, snap, mode: 'click' });
        clearMarquee(overlay);
        next = `click:${source ?? ''}:${target === null ? '' : `${target.kind}:${target.id}`}`;
      }
    }
    if (next === shape) return;
    shape = next;
    options.onChange?.();
  }

  function flag(name: string, value: string | null): void {
    if (value === null) canvas.removeAttribute(name);
    else canvas.setAttribute(name, value);
  }

  function onPointerDown(event: PointerEvent): void {
    // Left button only: a right-click is Forge's own menu on the desktop and
    // is not this gesture's to take.
    if (event.button !== 0) return;
    const at = { x: event.clientX, y: event.clientY };
    const offered = boardInteraction(match);
    const under = targetUnder(event.target, offered);
    if (under !== null && under.kind === 'card') {
      const box = cardBox(canvas, under.id);
      drag = { source: under.id, press: at, from: box === null ? at : centreOf(box), at, target: under, moved: false };
      hover = null;
      paint();
      return;
    }
    if (!inside(event.target)) return;
    // Lane A's arrange gesture owns this press; see `nativelyDraggable`. Placed
    // before BOTH fallbacks: the box-draw has the same twin — a marquee started
    // on a draggable permanent would rearrange the battlefield and declare
    // attackers in one gesture.
    if (nativelyDraggable(event.target)) return;
    if (declaringAttackers(match)) {
      marquee = { press: at, at, moved: false };
      hover = null;
      paint();
      return;
    }
    // Inside a selection the gesture may start anywhere on the table: the
    // spell doing the targeting is not itself one of Forge's choices, so
    // there is often no offered card to drag FROM.
    if (match.selectables === null) return;
    drag = { source: null, press: at, from: at, at, target: under, moved: false };
    hover = null;
    paint();
  }

  function onPointerMove(event: PointerEvent): void {
    const at = { x: event.clientX, y: event.clientY };
    if (drag !== null) {
      const moved = drag.moved || past(drag.press, at);
      drag = { ...drag, at, moved, target: targetUnder(event.target, boardInteraction(match)) };
    } else if (marquee !== null) {
      marquee = { press: marquee.press, at, moved: marquee.moved || past(marquee.press, at) };
    } else {
      hover = canvas.contains(event.target instanceof Node ? event.target : null) ? { at, node: event.target } : null;
    }
    paint();
  }

  function onPointerUp(event: PointerEvent): void {
    const heldDrag = drag;
    const heldMarquee = marquee;
    drag = null;
    marquee = null;
    hover = null;
    paint();
    if (heldDrag !== null) {
      if (heldDrag.moved) commitDrag(match, heldDrag, event.target);
      return;
    }
    if (heldMarquee !== null && heldMarquee.moved) {
      commitMarquee(match, rectOf(heldMarquee.press, { x: event.clientX, y: event.clientY }), canvas);
    }
  }

  function onPointerCancel(): void {
    drag = null;
    marquee = null;
    hover = null;
    paint();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);

  /*
   * Forge spoke, or React redrew. Both change what this layer must show — the
   * offered set moved under an open drag, or the `<li>` carrying an intent mark
   * was remounted and lost it — and both are answered by painting again.
   * `applyIntents` writes only where the value differs, so this is cheap.
   */
  const unsubscribe = subscribe(match, () => {
    if (live) paint();
  });
  const observer = new MutationObserver((records) => {
    if (!live) return;
    // Our own arrow and marquee live in the overlay; reacting to those would be
    // reacting to ourselves.
    const overlay = overlayOf();
    if (records.every((r) => overlay !== null && r.target instanceof Node && overlay.contains(r.target))) return;
    applyIntents(canvas, match);
  });
  observer.observe(canvas, { childList: true, subtree: true });
  paint();

  return {
    dispose(): void {
      live = false;
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      observer.disconnect();
      unsubscribe();
      const overlay = overlayOf();
      clearArrow(overlay);
      clearMarquee(overlay);
      clearIntents(canvas);
      canvas.removeAttribute(CANVAS_ATTR);
      canvas.removeAttribute('data-dragging');
      canvas.removeAttribute('data-marquee');
    },
  };
}

function past(press: Point, at: Point): boolean {
  return Math.hypot(at.x - press.x, at.y - press.y) >= DRAG_SLOP_PX;
}

/** The card id an origin element carries, for the arrow's `data-source`. */
function originId(el: Element): number | null {
  const raw = el.getAttribute('data-board-card') ?? el.getAttribute('data-card-id');
  return raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
}

export type { Rect };

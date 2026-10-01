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
 * stays out of it — no click is suppressed, exactly as before. What a claimed
 * press DOES refuse, from the press itself, is the browser's default: a drag on
 * the table may not highlight the words it crosses (`claim`).
 *
 * ## Nothing here decides legality
 *
 * Every send goes through `./commit.ts` into `../match.ts`'s `selectCard` /
 * `selectPlayer`, which re-check Forge's CURRENT offer. A gesture can pick the
 * wrong thing; it cannot put an id on the wire that Forge did not name.
 */
import { boardInteraction, declaringAttackers, declaringCombat, payingMana, subscribe } from '../match.ts';
import { clearArrow, drawArrow } from './arrow.ts';
import { commitDrag, commitMarquee, rectOf, type Rect } from './commit.ts';
import { applyIntents, clearIntents } from './intent.ts';
import { clearMarquee, drawMarquee } from './marquee.ts';
import { commitStackTarget, stackAsk, stackItemUnder } from './stack.ts';
import { boxOf, cardBox, centreOf, targetUnder } from './targets.ts';
import {
  DRAG_SLOP_PX,
  type DragState,
  type DropTarget,
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
   * Lane A's arrange gesture (§A.1) makes the cards of the viewer's own
   * battlefield — and, since wave 25, of their own HAND — `draggable="true"` and
   * hangs HTML5 `dragstart`/`drop` on them (`Board.tsx`'s `CardOnBoard`). A hand
   * card Forge OFFERED is deliberately left out of that, because dragging a card
   * out of hand is how it is played and this guard would take that press.
   * That press and this layer's overlap, and the
   * expensive half is a card Forge did NOT offer while a selection is open: it
   * is draggable, so the native drag runs, and the source-less pointing gesture
   * below would run too — one press that rearranges the battlefield AND sends
   * `selectCard` for whatever it was released over. So a press that started on a
   * natively-draggable element starts no gesture of ours.
   *
   * ## It stands down during combat declaration, and `onDragStart` says why
   *
   * Lane A's own half stands arranging down while Forge has an OPEN SELECTION
   * (`LiveClickables.selectionOpen`). **Forge publishes no selection during
   * declare-attackers or declare-blockers** — `../match.ts`'s `declaringCombat`
   * carries the call sites — so in those two moments the viewer's own creatures
   * stay natively draggable, and a guard that stood down there would hand the
   * attack and the block gestures to the arrange gesture: §B.2 and §B.3 gone. So
   * the guard yields to `declaringCombat`, and `onDragStart` cancels the native
   * drag for exactly the presses this layer claimed.
   *
   * It yields to `payingMana` for the same reason and from the same kind of fact:
   * `e2e/play.spec.ts:970-972` pays for a cast spell by dragging a land ALREADY
   * on the battlefield, and a payment opens no selection either, so that land is
   * natively draggable too.
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

  /**
   * What is under `node` that the pointer may aim at. While a question is up that
   * Forge asked about the STACK (a counterspell's *"select target spell"*, Q7),
   * the stack items it names are the targets; otherwise it is what Forge offered
   * on the board.
   */
  function targetAt(node: EventTarget | null): DropTarget | null {
    const asked = stackAsk(match);
    if (asked !== null) {
      const id = stackItemUnder(node, asked);
      return id === null ? null : { kind: 'stack', id };
    }
    return targetUnder(node, boardInteraction(match));
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
      const origin = hover !== null && (match.selectables !== null || stackAsk(match) !== null) ? clickOrigin() : null;
      if (origin === null || hover === null) {
        clearArrow(overlay);
        clearMarquee(overlay);
      } else {
        const target = targetAt(hover.node);
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

  /**
   * This layer has the press, so the browser's own idea of what a press means
   * must not run beside it — and the one that matters is TEXT SELECTION.
   *
   * The operator, 2026-09-27: dragging on the table highlighted every word the
   * pointer crossed. `./gestures.css` does write `user-select: none` on the
   * canvas, but only once `data-dragging` is set, which is after the press passes
   * `DRAG_SLOP_PX` — and the browser began selecting on the press itself. So the
   * default is refused at the press, before there is anything to undo.
   *
   * **Only on a press this layer CLAIMED.** A press on a natively-draggable
   * element (lane A's arrangement) returns above this without cancelling
   * anything, because cancelling `pointerdown` is also how the native HTML5 drag
   * is cancelled — it would take the arrangement with it. That press selects no
   * text either, from the static rule on the card itself (`../../board.css`).
   *
   * Cancelling `pointerdown` suppresses the compatibility mouse events and the
   * selection; it does NOT suppress `click`, which is not one of them, so a press
   * that never passes the slop is still the plain click it always was — the
   * property `e2e/play.spec.ts` leans on for every card it plays by clicking.
   */
  function claim(event: PointerEvent): void {
    if (event.cancelable) event.preventDefault();
  }

  function onPointerDown(event: PointerEvent): void {
    // Left button only: a right-click is Forge's own menu on the desktop and
    // is not this gesture's to take.
    if (event.button !== 0) return;
    /*
     * Lane A's arrange gesture owns a press on a natively-draggable element —
     * EVEN one Forge offered. At ordinary priority Forge's actionable set names
     * most of a player's own permanents ("you could"), and claiming those presses
     * is what turned `e2e/table-fit.spec.ts` red. A CLICK still plays the card,
     * because the slop keeps this layer out of one; what is given up is
     * drag-to-play on a card the player can also rearrange.
     *
     * The exceptions are the two inputs where a press on one's own battlefield
     * card IS the answer Forge is waiting for: combat declaration, and a mana
     * payment. Both are read off which input Forge is parked on, never off its
     * prose — see `../match.ts`'s `declaringCombat` and `payingMana`.
     *
     * Before EVERY branch, so the box-draw has it too: a marquee started on a
     * draggable permanent would otherwise rearrange the battlefield and declare
     * attackers in one press.
     */
    if (nativelyDraggable(event.target) && !declaringCombat(match) && !payingMana(match)) return;
    const at = { x: event.clientX, y: event.clientY };
    if (stackAsk(match) !== null && inside(event.target)) {
      // A question about the stack: the press may start anywhere on the table, and
      // the arrow leaves from the card being cast when it is on screen.
      const origin = clickOrigin();
      claim(event);
      drag = { source: null, press: at, from: origin === null ? at : centreOf(origin), at, target: targetAt(event.target), moved: false };
      hover = null;
      paint();
      return;
    }
    const offered = boardInteraction(match);
    const under = targetUnder(event.target, offered);
    if (under !== null && under.kind === 'card') {
      const box = cardBox(canvas, under.id);
      claim(event);
      drag = { source: under.id, press: at, from: box === null ? at : centreOf(box), at, target: under, moved: false };
      hover = null;
      paint();
      return;
    }
    if (!inside(event.target)) return;
    if (declaringAttackers(match)) {
      claim(event);
      marquee = { press: at, at, moved: false };
      hover = null;
      paint();
      return;
    }
    // Inside a selection the gesture may start anywhere on the table: the
    // spell doing the targeting is not itself one of Forge's choices, so
    // there is often no offered card to drag FROM.
    if (match.selectables === null) return;
    claim(event);
    drag = { source: null, press: at, from: at, at, target: under, moved: false };
    hover = null;
    paint();
  }

  function onPointerMove(event: PointerEvent): void {
    const at = { x: event.clientX, y: event.clientY };
    if (drag !== null) {
      const moved = drag.moved || past(drag.press, at);
      drag = { ...drag, at, moved, target: targetAt(event.target) };
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
      if (stackAsk(match) !== null) {
        // The release IS the answer, a click on the item as much as a drag onto it.
        const id = stackItemUnder(event.target, stackAsk(match)!);
        if (id !== null) commitStackTarget(match, id);
        return;
      }
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

  /**
   * This layer claimed the press, so the browser's native drag must not have it.
   *
   * **There is no `pointerup` after a `dragstart`.** Once the native drag begins
   * the browser delivers drag events and ends with `dragend`, so `commitDrag` and
   * `commitMarquee` would never run and the gesture would silently do nothing.
   * jsdom does not model that, so only a browser would have caught it — the same
   * shape as the `e2e/table-fit.spec.ts` red, mirrored.
   *
   * Cancelling `dragstart` aborts that one drag and nothing else: a press this
   * layer did not claim never reaches here with `drag` or `marquee` set, so lane
   * A's arrange gesture is untouched everywhere it owns the press.
   *
   * **In the CAPTURE phase, and it also stops propagation.** `preventDefault`
   * alone aborts the browser's drag but still lets lane A's own `onDragStart`
   * run — and a `dragstart` that was cancelled fires no `dragend`, so that
   * lane's `arranging.end()` would never balance its `arranging.start()` and it
   * would be left believing a drag was in flight. Capturing on the canvas runs
   * before any handler on the card and before React's own root listener, so for
   * a press this layer claimed lane A never sees the event at all.
   */
  function onDragStart(event: Event): void {
    if (drag === null && marquee === null) return;
    event.preventDefault();
    event.stopPropagation();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('dragstart', onDragStart, true);
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
      canvas.removeEventListener('dragstart', onDragStart, true);
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

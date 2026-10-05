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
 * anyway. The e2e arrow spec cancels a drag by dispatching `pointercancel` on
 * `window`, which is the same seam from the other side.
 *
 * ## Which gesture a press starts
 *
 * In this order, and the order is the whole of the disambiguation:
 *
 *  1. **on a card Forge offered** → a DRAG from that card. This is also how
 *     an attacker is declared by dragging it forward, which
 *     `../combat-drag.jvm.test.ts` proves against a real Forge, so it stays
 *     first.
 *  2. **elsewhere on the table while this seat is declaring attackers** → a
 *     box-draw. Nothing else claims that press: a selection is not open
 *     during `InputAttack`, so the pointing gesture below cannot fire.
 *  3. **elsewhere on the table while a selection is open** → the source-less
 *     pointing gesture: the spell doing the targeting is not itself one of
 *     Forge's choices, so there is often no offered card to drag FROM.
 *
 * A press that never passes `DRAG_SLOP_PX` is a plain click and this layer
 * stays out of it — no click is suppressed. What a claimed press DOES refuse,
 * from the press itself, is the browser's default: a drag on the table may
 * not highlight the words it crosses (`claim`).
 *
 * ## Nothing here decides legality
 *
 * Every send goes through `./commit.ts` into `../match.ts`'s `selectCard` /
 * `selectPlayer`, which re-check Forge's CURRENT offer. A gesture can pick the
 * wrong thing; it cannot put an id on the wire that Forge did not name.
 *
 * ## Casting a hand card: click and drag are one interaction, and nothing
 * reaches Forge until the release
 *
 * A press on a card Forge offered already starts the drag above — that part
 * is unchanged. What is different for a card sitting in the VIEWER's own hand
 * right now (never a battlefield permanent — a land offered for its mana
 * ability is a battlefield card, and this is false for it) is that the drag
 * is tagged `lifted: true` from the press itself, before the slop, so a PLAIN
 * CLICK lifts it exactly as a drag does. `onPointerMove` draws the lifted
 * card following the pointer (`drawCastLift`) and two cues: the viewer's own
 * battlefield lights up for a card that needs no target, and the hand shows a
 * cancel cue under the pointer. No text is drawn. No arrow yet: nothing
 * has been aimed at anything, because nothing has been sent.
 *
 * ### Everything a lift decides happens at the release
 *
 * The card's CURRENT type line decides what a release means (`./cast.ts`'s
 * `needsTarget` — Instant, Sorcery, or an Aura subtype needs a target;
 * everything else does not), and nothing is sent before the release either
 * way. `resolveLift` below is the one place a lifted hand card's gesture
 * ends, however it ends:
 *
 *  - over the viewer's own hand → the card floats back; nothing is sent,
 *    whatever the card is (nothing was ever sent to undo);
 *  - no target needed, over the viewer's own battlefield → `selectCard`
 *    (the play) and one call telling `Board` where it landed, at the slot
 *    under the release point;
 *  - no target needed, anywhere else → the card floats back; nothing is
 *    sent;
 *  - a target is needed, anywhere outside the hand → `selectCard` (the cast)
 *    goes out now, the card is pinned at the release point (`drawCastLift`
 *    with `'parked'`), and this module's `parked` holds that fact until
 *    Forge's reply resolves it. While Forge asks for the target, the card is
 *    in no zone the board draws, so React unmounts its element: a stand-in
 *    copied at the release (`parkedGhost`) is drawn at the park point
 *    instead, and the click-targeting arrow (`paint()`'s fallback branch)
 *    leaves from `parked` itself rather than from a DOM lookup, so a target
 *    ask is answered like any other click-cast.
 *
 * ### A click lifts; the next press is the release
 *
 * A plain click's `pointerup` (zero `moved`) does NOT resolve the gesture: it
 * flips `held` to `false` and nothing more. `onPointerMove` is a bare
 * `window` listener that never checks button state, so the card keeps
 * following the pointer and the cues keep updating exactly as a held drag
 * does. The NEXT press (`onPointerDown`'s very first checks) is the release,
 * at its own point — not wherever the first click happened to let go.
 *
 * A plain click's `pointerup` ALSO fires a native `click` right after it with
 * no intervening movement, and that click would otherwise reach the card's
 * own `onClick` in `Board.tsx` and send a premature `selectCard` before this
 * layer ever gets to decide anything — `suppressClick` marks exactly the
 * presses this module has claimed, and the capturing `click` listener on
 * `canvas` swallows that one native click the same way `onDragStart` already
 * swallows the native HTML5 drag — before React's own delegated handler,
 * attached to this same element, ever sees it. The same flag, left untouched,
 * also swallows the native click the resolving press leaves behind (see
 * `onPointerDown`): that press may land on something Forge offers for an
 * unrelated reason (a land offered for its mana ability, say), and the native
 * click reaching IT would be a second, accidental `selectCard`.
 *
 * ### Cancelling a lift or a cast in progress
 *
 * `cancelLive` is the one function a right-click or Escape calls. While a
 * cast is PARKED (Forge has been asked to cast it, and may or may not have
 * opened a target ask yet), a cancel sends Forge's own Cancel —
 * `pressButton(match, 'cancel')`, the SAME sender the control bar's own
 * Cancel button uses — but ONLY while Forge is actually asking about THIS
 * cast (`match.selectables !== null`, or a mana payment is open): a land, or
 * a spell that needed neither, is already done by the time its release
 * returns, Forge is back at priority, and its button 2 may well be bound to
 * something else entirely — pressing it regardless of what Forge is asking
 * would send that instead. Before any cast at all (the card is merely
 * LIFTED, held or click-armed), a cancel is silent: nothing was ever sent, so
 * there is nothing to undo — the card simply floats back.
 *
 * One more cancel beyond right-click and Escape: a left click that lands on
 * nothing Forge's open selection names, while a cast is parked, is the same
 * cancel rather than a resolving press — there is nothing left for it to
 * resolve, since the cast already went out at release. `onPointerDown`'s own
 * check for a press while `parked` is what answers that.
 *
 * ## Where a cast lands
 *
 * `selectCard` alone tells Forge WHAT to cast, never WHERE the player put it,
 * so a newly-arrived permanent used to append to the end of its type row
 * every time. `Board.tsx` exports `notePlayedTo(cardId, point)` for exactly
 * this gap, read across the lane boundary like every other cross-lane import
 * in this file, never written to. This module calls it exactly once, from
 * `resolveLift`, at the release that actually plays the card: by the time
 * that call happens the card has not reached Forge yet, so `Board`'s own
 * re-render once Forge's reply adds it to the battlefield is already the
 * right moment to apply the pending placement.
 */
import {
  boardInteraction,
  declaringAttackers,
  declaringCombat,
  payingMana,
  pressButton,
  selectCard,
  subscribe,
  type LiveMatch,
} from '../match.ts';
// Where a cast lands on the battlefield — a plain function, not a component,
// read across the lane boundary.
import { notePlayedTo, previewPlayedTo } from '../../Board.tsx';
import { autoTargetArrows } from './auto-targets.ts';
import { clearArrow, clearAutoTargetArrows, drawArrow, drawAutoTargetArrows } from './arrow.ts';
import {
  CAST_LIFT_ATTR,
  clearAllCastLifts,
  clearCastLift,
  clearDropCues,
  drawCastLift,
  floatCastLiftHome,
  handCardTypeLine,
  isHandCard,
  needsTarget,
  overOwnBattlefield,
  overOwnHand,
  parkedGhost,
  updateDropCues,
} from './cast.ts';
import { commitDrag, commitMarquee, rectOf, type Rect } from './commit.ts';
import { applyIntents, clearIntents } from './intent.ts';
import { clearMarquee, drawMarquee } from './marquee.ts';
import { commitStackTarget, stackAsk, stackItemBox, stackItemUnder } from './stack.ts';
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

/**
 * A targeted cast, sent at release and pinned at the point it was released.
 * `home` is where it floats back to on a cancel: the same point `drag.from`
 * held, the card's own centre at the moment it was first lifted.
 */
interface Parked {
  readonly source: number;
  readonly at: Point;
  readonly home: Point;
  /** The card's stand-in at `at`, shown only while the board renders no element for the card itself. */
  readonly ghost: HTMLElement | null;
  /** Forge's state has shown the card out of the hand since the cast went out. */
  leftHand: boolean;
}

/** Where Forge's state holds the card now: the viewer's hand, another zone the board draws, or nowhere it draws (mid-cast). */
function whereIs(match: LiveMatch, id: number): 'hand' | 'drawn' | 'limbo' {
  if (isHandCard(match, id)) return 'hand';
  for (const p of match.view?.players ?? []) {
    for (const zone of [p.battlefield, p.graveyard, p.exile]) {
      if (zone.some((c) => c.id === id)) return 'drawn';
    }
  }
  return 'limbo';
}

export function installGestures(options: GestureOptions): GestureHandle {
  const { canvas, match } = options;
  let drag: DragState | null = null;
  let marquee: MarqueeState | null = null;
  /** Where the pointer is while NO gesture is held — the click-targeting arrow's tip. */
  let hover: { at: Point; node: EventTarget | null } | null = null;
  /** What was drawn last, so `onChange` fires on a change and not on every move. */
  let shape = '';
  let live = true;
  /** A targeted cast already sent, pinned, waiting on Forge — see the module header. Null: no cast in flight. */
  let parked: Parked | null = null;
  /**
   * Set the moment a press is claimed as a hand-card cast — see the module
   * header's own section — and consumed by the capturing `click` listener
   * below, which is the only thing that ever reads it. Reset at the top of
   * every FRESH `pointerdown` so a press that never produces a click (a real
   * drag, released somewhere else entirely) cannot leave it stuck for an
   * unrelated later click.
   */
  let suppressClick = false;

  const overlayOf = (): HTMLElement | null => canvas.querySelector<HTMLElement>('[data-board-overlay]');

  const inside = (node: EventTarget | null): boolean =>
    node instanceof Element && (node.closest('.board') !== null || node.closest('[data-zone]') !== null);

  /**
   * The press began on something the BROWSER will drag natively.
   *
   * Lane A's arrange gesture makes the cards of the viewer's own battlefield
   * — and their own hand — `draggable="true"` and hangs HTML5
   * `dragstart`/`drop` on them (`Board.tsx`'s `CardOnBoard`). A hand card
   * Forge OFFERED is deliberately left out of that, because dragging a card
   * out of hand is how it is played and this guard would take that press.
   * That press and this layer's overlap, and the expensive half is a card
   * Forge did NOT offer while a selection is open: it is draggable, so the
   * native drag runs, and the source-less pointing gesture below would run
   * too — one press that rearranges the battlefield AND sends `selectCard`
   * for whatever it was released over. So a press that started on a
   * natively-draggable element starts no gesture of ours.
   *
   * ## It stands down during combat declaration, and `onDragStart` says why
   *
   * Lane A's own half stands arranging down while Forge has an OPEN SELECTION
   * (`LiveClickables.selectionOpen`). **Forge publishes no selection during
   * declare-attackers or declare-blockers** — `../match.ts`'s `declaringCombat`
   * carries the call sites — so in those two moments the viewer's own creatures
   * stay natively draggable, and a guard that stood down there would hand the
   * attack and the block gestures to the arrange gesture entirely. So the
   * guard yields to `declaringCombat`, and `onDragStart` cancels the native
   * drag for exactly the presses this layer claimed.
   *
   * It yields to `payingMana` for the same reason and from the same kind of
   * fact: a payment can be made by dragging a land ALREADY on the
   * battlefield, and a payment opens no selection either, so that land is
   * natively draggable too.
   */
  const nativelyDraggable = (node: EventTarget | null): boolean => {
    if (!(node instanceof Element)) return false;
    const found = node.closest('[draggable="true"]');
    return found !== null && canvas.contains(found);
  };

  /**
   * The tail of the click-targeting arrow, or null when there is nothing to
   * draw from.
   *
   * A drag anchors its arrow to the card it was picked up from. A click has
   * no such anchor, so the tail is the thing the player pointed at last
   * (`match.lastSelectedCard` — the card they clicked to cast or activate)
   * and, failing that, the top of the stack: a triggered ability that wants a
   * target was never clicked at all, and its source is what the arrow should
   * leave from. No origin, no arrow — a tail from nowhere is not guidance.
   *
   * A parked cast comes first and is answered from `parked` itself, never
   * from a DOM lookup alone: while Forge asks for its target the card is in
   * no zone the board draws, so its element is usually gone and only the
   * release point says where the arrow leaves from.
   *
   * **The stack item's OWN element, when the source card has none of its
   * own.** World Breaker's cast trigger ("when you cast this spell") needs
   * its target while World Breaker itself is still ON THE STACK — not yet on
   * any battlefield, not in any hand — so `cardBox` finds nothing for it
   * (`StackItem` in `../../Board.tsx` carries `data-stack-id`, never
   * `data-card-id`/`data-board-card`; its `CardTile` carries a DRAFT-namespaced
   * id `targets.ts`'s `boardId` already refuses). `stackItemBox` is the one
   * element that is always there for a stack-resident source, so it is the
   * fallback — never a fallback POINT.
   */
  function clickOrigin(): { at: Point; source: number | null } | null {
    // A parked card is where the player let go of it, whether or not the
    // board still renders its element.
    if (parked !== null) {
      const box = cardBox(canvas, parked.source);
      return { at: box === null ? parked.at : centreOf(box), source: parked.source };
    }
    const held = match.lastSelectedCard;
    if (held !== null) {
      const box = cardBox(canvas, held);
      if (box !== null) return { at: centreOf(box), source: originId(box) };
    }
    for (const item of match.view?.stack ?? []) {
      if (item.sourceCardId === null) continue;
      const box = cardBox(canvas, item.sourceCardId);
      if (box !== null) return { at: centreOf(box), source: originId(box) };
      const stackBox = stackItemBox(canvas, item.id);
      if (stackBox !== null) return { at: centreOf(stackBox), source: item.sourceCardId };
    }
    return null;
  }

  /**
   * What is under `node` that the pointer may aim at. While a question is up
   * that Forge asked about the STACK (a counterspell's "select target
   * spell"), the stack items it names are the targets; otherwise it is what
   * Forge offered on the board.
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
    } else if (drag !== null && drag.lifted) {
      // Pre-release: the card follows the pointer (drawn directly from
      // `onPointerMove`/`onPointerDown`, not here) and there is no arrow —
      // nothing has been aimed at anything, because nothing has been sent
      // yet.
      clearArrow(overlay);
      clearMarquee(overlay);
      next = `lift:${drag.source ?? ''}`;
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
      // This is also how a parked cast draws its arrow, see `clickOrigin`.
      const origin = hover !== null && (match.selectables !== null || stackAsk(match) !== null) ? clickOrigin() : null;
      if (origin === null || hover === null) {
        clearArrow(overlay);
        clearMarquee(overlay);
      } else {
        const target = targetAt(hover.node);
        const snap = target === null ? null : boxOf(canvas, target);
        const source = origin.source;
        drawArrow(overlay, { from: origin.at, to: hover.at, source, target, snap, mode: 'click' });
        clearMarquee(overlay);
        next = `click:${source ?? ''}:${target === null ? '' : `${target.kind}:${target.id}`}`;
      }
    }
    // Forge's own already-decided targets. Independent of whichever gesture
    // (if any) is in progress above, so it is reconciled every paint
    // regardless of branch — a drag or a box-draw does not hide it.
    if (overlay !== null) drawAutoTargetArrows(overlay, autoTargetArrows(canvas, match));
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
   * `./gestures.css` does write `user-select: none` on the canvas, but only
   * once `data-dragging` is set, which is after the press passes
   * `DRAG_SLOP_PX` — and the browser begins selecting on the press itself. So
   * the default is refused at the press, before there is anything to undo.
   *
   * **Only on a press this layer CLAIMED.** A press on a natively-draggable
   * element (lane A's arrangement) returns above this without cancelling
   * anything, because cancelling `pointerdown` is also how the native HTML5
   * drag is cancelled — it would take the arrangement with it. That press
   * selects no text either, from the static rule on the card itself
   * (`../../board.css`).
   *
   * Cancelling `pointerdown` suppresses the compatibility mouse events and
   * the selection; it does NOT suppress `click`, which is not one of them, so
   * a press that never passes the slop is still the plain click it always
   * was — the property `e2e/play.spec.ts` leans on for every card it plays by
   * clicking.
   */
  function claim(event: PointerEvent): void {
    if (event.cancelable) event.preventDefault();
  }

  /**
   * What a lifted hand card's RELEASE means — the one and only place a hand
   * card's gesture reaches Forge. Called from `onPointerUp` (a held drag's
   * own release) and from `onPointerDown`'s resolving press (a click-armed
   * one) alike, always with that press's OWN point — never the point the
   * lift started from, and never a point an earlier frame remembered.
   */
  function resolveLift(state: DragState, point: Point, node: EventTarget | null): void {
    clearDropCues(canvas);
    if (state.source === null) return;
    const source = state.source;
    const spell = needsTarget(handCardTypeLine(match, source));
    if (overOwnHand(node)) {
      previewPlayedTo(null);
      floatCastLiftHome(canvas, source, state.from, () => {});
      return;
    }
    if (!spell) {
      previewPlayedTo(null);
      if (overOwnBattlefield(node)) {
        selectCard(match, source);
        // The one placement call, at the release — the slot under the
        // release point.
        notePlayedTo(source, point);
        clearCastLift(canvas, source);
      } else {
        floatCastLiftHome(canvas, source, state.from, () => {});
      }
      return;
    }
    // A card that needs a target: the cast goes out now, wherever it was
    // released outside the hand, and the card parks right there.
    previewPlayedTo(null);
    const ghost = parkedGhost(canvas, source);
    selectCard(match, source);
    drawCastLift(canvas, source, point, 'parked');
    parked = { source, at: point, home: state.from, ghost, leftHand: false };
    // The pointer is at the park point now; the arrow follows it from there
    // the moment Forge asks for the target, before the pointer next moves.
    hover = { at: point, node };
    paint();
  }

  /**
   * The parked card's stand-in is on the page exactly while the board has no
   * element of its own for the card: Forge holds a card being cast in none of
   * the zones the board draws until its targets are chosen, so React
   * unmounts it, and without the stand-in the player would see the card
   * vanish the moment they let go of it.
   */
  function syncParkedGhost(): void {
    if (parked === null || parked.ghost === null) return;
    const { ghost } = parked;
    if (cardBox(canvas, parked.source) !== null) {
      ghost.remove();
      return;
    }
    if (ghost.isConnected) return;
    ghost.setAttribute(CAST_LIFT_ATTR, 'parked');
    ghost.style.left = `${parked.at.x}px`;
    ghost.style.top = `${parked.at.y}px`;
    // Under the board, so its card styles still dress the stand-in, but
    // outside every zone, so nothing counting a zone's cards counts it.
    (canvas.querySelector('.board') ?? canvas).appendChild(ghost);
  }

  /** Let a parked card go — its own element, or its stand-in when the board has none. */
  function releaseParked(p: Parked, floatHome: boolean): void {
    const ghost = p.ghost !== null && p.ghost.isConnected ? p.ghost : null;
    if (floatHome) {
      floatCastLiftHome(canvas, p.source, p.home, () => ghost?.remove(), ghost ?? cardBox(canvas, p.source));
    } else {
      ghost?.remove();
      clearCastLift(canvas, p.source);
    }
  }

  /**
   * Right-click or Escape, while a hand-card gesture is live. See the module
   * header's own section — this is the one function either input calls, for
   * both a parked cast and a bare lift.
   */
  function cancelLive(): void {
    if (parked !== null) {
      const p = parked;
      parked = null;
      // Forge is asking about THIS cast only if a selection or a payment is
      // open now — a land, or a spell that needed neither, is already done,
      // and pressing Cancel regardless would reach whatever button 2 means
      // next.
      if (match.selectables !== null || payingMana(match)) pressButton(match, 'cancel');
      releaseParked(p, true);
      paint();
      return;
    }
    if (drag !== null && drag.lifted) {
      const d = drag;
      drag = null;
      clearDropCues(canvas);
      previewPlayedTo(null);
      if (d.source !== null) floatCastLiftHome(canvas, d.source, d.from, () => {});
      paint();
    }
  }

  /**
   * A parked cast that Forge has finished with — no selection, no payment, no
   * open ask, and the card itself is off the stack too (it resolved, or the
   * selection closed without a question this layer answers) — needs no
   * cancel and no further input; it is simply over, so the lift comes off.
   *
   * Only once Forge's state has the card somewhere settled again: a zone the
   * board draws, or back in the hand after having left it. Between the cast
   * going out and Forge opening its target selection, nothing is open for a
   * moment — the card is still in the hand on the first frames after the
   * send, then in no zone at all — and settling in that gap would drop the
   * parked cast just before Forge asks about it, leaving a right-click or
   * Escape with nothing to cancel and the arrow with no origin.
   */
  function settleParkedIfResolved(): void {
    if (parked === null) return;
    const where = whereIs(match, parked.source);
    if (where !== 'hand') parked.leftHand = true;
    if (match.selectables !== null || payingMana(match) || match.asks.length > 0 || stackAsk(match) !== null) return;
    if (match.view?.stack.some((item) => item.sourceCardId === parked!.source)) return;
    if (where === 'limbo' || (where === 'hand' && !parked.leftHand)) return;
    const p = parked;
    parked = null;
    releaseParked(p, false);
  }

  function onPointerDown(event: PointerEvent): void {
    /*
     * A right-click cancels a live gesture outright, before any button
     * filtering below — a parked cast or a bare lift, held or click-armed
     * alike.
     */
    if (event.button === 2 && (parked !== null || (drag !== null && drag.lifted))) {
      claim(event);
      cancelLive();
      return;
    }
    /*
     * A click that lands on nothing, while a cast is parked, is a cancel too.
     * A press that lands on something Forge's open selection NAMES is left
     * alone — the ordinary click Board's own markup already answers with,
     * same as any other click-cast — so only a stray press inside the
     * table/board area, naming nothing, is claimed here.
     */
    if (parked !== null && event.button === 0 && match.selectables !== null && inside(event.target) && targetAt(event.target) === null) {
      claim(event);
      cancelLive();
      return;
    }
    /*
     * A click-armed gesture (`held: false`) does not resolve at its own
     * release — it keeps following the pointer with no button held until
     * THIS press resolves it, at its own point. Ahead of every other branch
     * below: the resolving press may land on anything at all, including
     * something that would otherwise start an unrelated gesture of its own.
     */
    if (drag !== null && drag.lifted && !drag.held) {
      claim(event);
      const held = drag;
      drag = null;
      resolveLift(held, { x: event.clientX, y: event.clientY }, event.target);
      paint();
      return;
    }
    // Left button only from here: a right-click is Forge's own menu on the
    // desktop and is not this gesture's to take.
    if (event.button !== 0) return;
    // Reset at the top of every FRESH press — see the flag's own doc comment.
    suppressClick = false;
    /*
     * Lane A's arrange gesture owns a press on a natively-draggable element —
     * EVEN one Forge offered. At ordinary priority Forge's actionable set names
     * most of a player's own permanents ("you could"), and claiming those presses
     * would break the arrangement gesture. A CLICK still plays the card,
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
      drag = {
        source: null,
        press: at,
        from: origin === null ? at : origin.at,
        at,
        target: targetAt(event.target),
        moved: false,
        lifted: false,
        held: true,
      };
      hover = null;
      paint();
      return;
    }
    const offered = boardInteraction(match);
    const under = targetUnder(event.target, offered);
    if (under !== null && under.kind === 'card') {
      const box = cardBox(canvas, under.id);
      claim(event);
      /*
       * Only a card in the viewer's own hand is ever lifted; a battlefield
       * land offered for its mana ability is not in anyone's hand and this is
       * false for it, so it drags exactly as it always has.
       *
       * **Priority's own offer ONLY — never a selection's, and never an
       * ask's.** A selection can itself name a hand card (Secluded Glen's
       * "reveal a Faerie?" is one real example), so `isHandCard` alone is not
       * enough: a card Forge is actively asking the seat to CHOOSE is not one
       * it is offering to be CAST, and the two can share the same id.
       * `match.asks.length > 0` already empties `offered` entirely
       * (`boardInteraction`'s own guard), so that half holds without a
       * separate check here; `match.selectables === null` is the other half;
       * `weaklySelectable.has(id)` on top of both is the precise positive
       * case — Forge's own priority-time "you could cast this", never
       * `highlighted`/`mulliganHand`/combat's unions, none of which a press
       * on a hand card should ever read as "lift and cast".
       */
      const castFromHand =
        isHandCard(match, under.id) &&
        match.selectables === null &&
        match.asks.length === 0 &&
        (match.weaklySelectable?.has(under.id) ?? false);
      if (castFromHand) suppressClick = true;
      const from = box === null ? at : centreOf(box);
      drag = {
        source: under.id,
        press: at,
        from,
        at,
        target: under,
        moved: false,
        lifted: castFromHand,
        held: true,
      };
      hover = null;
      if (castFromHand) {
        const spell = needsTarget(handCardTypeLine(match, under.id));
        const overHand = overOwnHand(event.target);
        const overBf = overOwnBattlefield(event.target);
        drawCastLift(canvas, under.id, at, 'lifted');
        updateDropCues(canvas, spell, overHand, overBf);
      }
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
    // there is often no offered card to drag FROM. The tail is still the
    // SOURCE's own element (`clickOrigin`, same as the click-targeting
    // arrow) — never the press point, which is wherever on the table this
    // drag happened to start and not where the spell doing the targeting is.
    if (match.selectables === null) return;
    const origin = clickOrigin();
    claim(event);
    drag = { source: null, press: at, from: origin === null ? at : origin.at, at, target: under, moved: false, lifted: false, held: true };
    hover = null;
    paint();
  }

  function onPointerMove(event: PointerEvent): void {
    const at = { x: event.clientX, y: event.clientY };
    if (drag !== null) {
      const moved = drag.moved || past(drag.press, at);
      const next: DragState = { ...drag, at, moved, target: targetAt(event.target) };
      drag = next;
      if (next.lifted && next.source !== null) {
        const spell = needsTarget(handCardTypeLine(match, next.source));
        const overHand = overOwnHand(event.target);
        const overBf = overOwnBattlefield(event.target);
        drawCastLift(canvas, next.source, at, 'lifted');
        updateDropCues(canvas, spell, overHand, overBf);
        // Only a no-target card ever lands in a row.
        previewPlayedTo(!spell && overBf ? at : null);
      }
    } else if (marquee !== null) {
      marquee = { press: marquee.press, at, moved: marquee.moved || past(marquee.press, at) };
    } else {
      hover = canvas.contains(event.target instanceof Node ? event.target : null) ? { at, node: event.target } : null;
    }
    paint();
  }

  function onPointerUp(event: PointerEvent): void {
    /*
     * A plain click (zero `moved`) does NOT resolve the gesture — it ARMS it
     * (`held: false`) and keeps tracking the pointer with no button down,
     * same as a held drag, until the next press resolves it (`onPointerDown`'s
     * own top-of-function check). Every other kind of drag, and a real drag
     * (`moved: true`), still ends here exactly as before.
     */
    if (drag !== null && drag.lifted && !drag.moved) {
      drag = { ...drag, held: false };
      paint();
      return;
    }
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
      if (heldDrag.lifted) {
        resolveLift(heldDrag, { x: event.clientX, y: event.clientY }, event.target);
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
    // The browser took the pointer away mid-aim: the same as letting go of
    // the cast with right-click or Escape.
    if (parked !== null && drag === null) {
      cancelLive();
      return;
    }
    if (drag !== null && drag.lifted) {
      clearDropCues(canvas);
      previewPlayedTo(null);
      if (drag.source !== null) floatCastLiftHome(canvas, drag.source, drag.from, () => {});
    }
    drag = null;
    marquee = null;
    hover = null;
    paint();
  }

  /** Escape cancels cleanly, from either phase — see `cancelLive`. */
  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    if (parked === null && !(drag !== null && drag.lifted)) return;
    cancelLive();
  }

  /** The browser's own context menu is suppressed only while a gesture or cast is live — never otherwise. */
  /** The board is a game surface: a right-click there never opens the browser's menu. */
  function onContextMenu(event: Event): void {
    event.preventDefault();
  }

  /**
   * This layer claimed the press, so the browser's native drag must not have it.
   *
   * **There is no `pointerup` after a `dragstart`.** Once the native drag begins
   * the browser delivers drag events and ends with `dragend`, so `commitDrag` and
   * `commitMarquee` would never run and the gesture would silently do nothing.
   * jsdom does not model that, so only a browser would have caught it.
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

  /**
   * The native `click` a plain press leaves behind, for a press this module
   * is about to settle ITSELF (see `onPointerUp` and the module header's
   * section on `suppressClick`). Same technique as `onDragStart` just above
   * and the same reason — before React's own delegated handler on this
   * element ever sees it — except this one is conditional: every click this
   * module did NOT just claim passes through untouched.
   */
  function onClickCapture(event: Event): void {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('dragstart', onDragStart, true);
  canvas.addEventListener('click', onClickCapture, true);
  canvas.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('keydown', onKeyDown);

  /*
   * Forge spoke, or React redrew. Both change what this layer must show — the
   * offered set moved under an open drag, or the `<li>` carrying an intent mark
   * was remounted and lost it — and both are answered by painting again.
   * `applyIntents` writes only where the value differs, so this is cheap.
   */
  const unsubscribe = subscribe(match, () => {
    if (!live) return;
    settleParkedIfResolved();
    syncParkedGhost();
    paint();
  });
  const observer = new MutationObserver((records) => {
    if (!live) return;
    // Our own arrow and marquee live in the overlay; reacting to those would be
    // reacting to ourselves.
    const overlay = overlayOf();
    if (records.every((r) => overlay !== null && r.target instanceof Node && overlay.contains(r.target))) return;
    applyIntents(canvas, match);
    syncParkedGhost();
  });
  observer.observe(canvas, { childList: true, subtree: true });
  paint();

  return {
    dispose(): void {
      live = false;
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('dragstart', onDragStart, true);
      canvas.removeEventListener('click', onClickCapture, true);
      canvas.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown);
      observer.disconnect();
      unsubscribe();
      const overlay = overlayOf();
      clearArrow(overlay);
      clearAutoTargetArrows(overlay);
      clearMarquee(overlay);
      clearIntents(canvas);
      clearAllCastLifts(canvas);
      clearDropCues(canvas);
      // A gesture disposed mid-flight (a remount, a resync) leaves no
      // placement preview behind either.
      if ((drag !== null && drag.lifted) || parked !== null) previewPlayedTo(null);
      parked = null;
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

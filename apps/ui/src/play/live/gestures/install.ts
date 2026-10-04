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
 *
 * ## Arena casting (R7): click and drag become one interaction
 *
 * A press on a card Forge offered already starts the drag above — that part
 * is unchanged. What is new is `./cast.ts`'s `isHandCard`: when the card a
 * press started on is sitting in the VIEWER's own hand (never a battlefield
 * permanent — a land offered for its mana ability, wave 35 §F, is a
 * battlefield card and this is false for it), the drag is tagged
 * `stage: 'lifted'` from the press itself, before the slop, so a PLAIN CLICK
 * lifts it exactly as a drag does — the operator's *"clicking can also make
 * the card follow your mouse so that seems the same as drag to me."* `paint()`
 * draws the lifted card following the pointer (`drawCastLift`) and no arrow.
 *
 * ### The cast is sent AT THE SETTLE, not at release
 *
 * The moment the pointer crosses into the viewer's own battlefield
 * (`overOwnBattlefield`), the stage becomes `'settled'`, `selectCard(source)`
 * is sent right there (`onPointerMove`, `drag.cast` turns `true`), the card is
 * pinned at that spot, and from then only the targeter arrow moves — the
 * operator: *"the card settles there... and from then on only the targeting
 * arrow follows the pointer."* The gesture is NOT over: Forge may reply, over
 * the wire, with a fresh targeting ask while this press is still held (or,
 * for a click-lift, still armed — see below), and the SAME held gesture is
 * what answers it: `targetAt`/`boardInteraction` read `match.selectables` on
 * every move, so the instant Forge's reply opens one, the arrow starts
 * snapping to real legal targets, unchanged machinery, the same eight snap
 * points every other drag already draws. The eventual release (or the next
 * press, for a click-lift) reaches `./commit.ts`'s `commitDrag` with `source`
 * forced to `null` — once cast, this gesture must never send `source` again —
 * so a release over a legal target sends only the target, and a release
 * anywhere else sends nothing further: "a card without targets is cast by
 * releasing it over the battlefield" already happened, at the settle, and a
 * release with no target ask open is just that cast's quiet end.
 *
 * ### Cancelling AFTER the cast is Forge's own Cancel, not silence
 *
 * Before the settle, nothing has been sent, so Escape or a drop back on the
 * hand is simply letting go — `cancelCastNetwork` is a no-op. After the
 * settle, Forge is parked on the targeting ask the cast opened
 * (`InputSelectTargets`, which answers to exactly the same button bar every
 * other yes/no question in this layer already presses),
 * so the one correct way out is `pressButton(match, 'cancel')` — the SAME
 * sender the control bar's own Cancel button uses, which already refuses
 * itself when Forge has not enabled it (a mandatory target with candidates on
 * the board cannot be backed out of, by Forge's own rule, and this layer does
 * not pretend otherwise).
 *
 * ### A plain click is the same gesture, just without the button held
 *
 * A plain click's `pointerup` (zero `moved`) does NOT end the gesture: it
 * flips `held` to `false` and nothing more. `onPointerMove` is a bare
 * `window` listener that never checks button state, so the card keeps
 * following the pointer, keeps settling, keeps sending at the settle, exactly
 * as a held drag does — the operator's *"clicking can also make the card
 * follow your mouse so that seems the same as drag to me."* The NEXT press
 * (`onPointerDown`'s very first check) is what resolves it: a drop back on
 * the hand cancels, anything else finishes the cast through the same path a
 * drag's release uses.
 *
 * A plain click's `pointerup` ALSO fires a native `click` right after it with
 * no intervening movement, and that click would otherwise reach the card's
 * own `onClick` in `Board.tsx` and send a premature `selectCard` before this
 * layer ever gets to decide anything — `suppressClick` marks exactly the
 * presses this module has claimed as an Arena cast, and the capturing `click`
 * listener on `canvas` swallows that one native click the same way
 * `onDragStart` already swallows the native HTML5 drag — before React's own
 * delegated handler, attached to this same element, ever sees it.
 *
 * ## R9 — a cast goes to ANY slot, not the end of the row
 *
 * `selectCard` alone tells Forge WHAT to cast, never WHERE the player put it,
 * so a newly-arrived permanent used to append to the end of its type row
 * every time (lane B's own finding, `b.md`). `Board.tsx` exports two plain
 * functions for exactly this gap, `notePlayedTo(cardId, point)` and
 * `previewPlayedTo(point | null)` — read across the lane boundary like every
 * other cross-lane import in this file, never written to. `notePlayedTo` is
 * called twice at most: once at the settle (`onPointerMove`, alongside
 * `selectCard`) and again at the release IF that release is genuinely over
 * the viewer's own battlefield (`noteReleasePlacement`) — the later call
 * wins, which is where the player actually let go. `previewPlayedTo` is
 * driven on every move while lifted or settled, the same cadence the arrow
 * already moves at, and cleared (`clearPlacementPreview`) at every ending:
 * a finish, a cancel, Escape, or disposal mid-flight.
 */
import {
  boardInteraction,
  declaringAttackers,
  declaringCombat,
  payingMana,
  pressButton,
  selectCard,
  subscribe,
} from '../match.ts';
// R9 (lane B's seam, `b.md`): where a cast lands on the battlefield. Plain
// functions, not components — reading them across the lane boundary is the
// agreed seam, same as every other cross-lane import in this file.
import { notePlayedTo, previewPlayedTo } from '../../Board.tsx';
import { autoTargetArrows } from './auto-targets.ts';
import { clearArrow, clearAutoTargetArrows, drawArrow, drawAutoTargetArrows } from './arrow.ts';
import { isHandCard, overOwnBattlefield, overOwnHand, clearAllCastLifts, clearCastLift, drawCastLift } from './cast.ts';
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
  /**
   * Set the moment a press is claimed as an Arena cast (R7) — see the module
   * header's last section — and consumed by the capturing `click` listener
   * below, which is the only thing that ever reads it. Reset at the top of
   * every `pointerdown` so a press that never produces a click (a real drag,
   * released somewhere else entirely) cannot leave it stuck for an unrelated
   * later click.
   */
  let suppressClick = false;

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
  /**
   * The card under `node` is one an OPEN selection names. A press on it while a
   * click-armed cast is still out is an ANSWER to that selection, never a drop
   * back on the hand: Secluded Glen's "reveal a Faerie" opens exactly such a
   * selection — naming a hand card — within ~90 ms of the land's own cast
   * settling, so the armed gesture is still there when the player clicks the
   * Faerie. Treating that press as "back on the hand" sent Forge's Cancel into
   * the reveal, and the land entered tapped every time (ledger T12, the wave 36
   * regression; it was latent in wave 35 and timing-dependent).
   */
  function namedByOpenSelection(node: EventTarget | null): boolean {
    const t = targetAt(node);
    return t !== null && t.kind === 'card' && match.selectables !== null && match.selectables.cards.has(t.id);
  }

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
    } else if (drag !== null && drag.stage === 'lifted') {
      // Arena casting (R7), before the settle: the card follows the pointer
      // and there is no arrow yet — nothing has been aimed at anything.
      clearArrow(overlay);
      clearMarquee(overlay);
      if (drag.source !== null) drawCastLift(canvas, drag.source, drag.at, false);
      next = `lift:${drag.source ?? ''}`;
    } else if (drag !== null && drag.stage === 'settled') {
      // Arena casting (R7), after the settle: pinned at the staging spot, and
      // only the arrow — the same one every other drag draws — moves from here.
      clearMarquee(overlay);
      const from = drag.stagedAt ?? drag.from;
      if (drag.source !== null) drawCastLift(canvas, drag.source, from, true);
      const snap = drag.target === null ? null : boxOf(canvas, drag.target);
      drawArrow(overlay, { from, to: drag.at, source: drag.source, target: drag.target, snap, mode: 'drag' });
      next = `settled:${drag.source ?? ''}:${drag.target === null ? '' : `${drag.target.kind}:${drag.target.id}`}`;
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
    // Item 8: Forge's own already-decided targets. Independent of whichever
    // gesture (if any) is in progress above, so it is reconciled every paint
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

  /**
   * Arena casting (R7) only. Clears this gesture's own lift — purely local,
   * no network effect, safe to call unconditionally once a gesture is ending.
   */
  function dropCastLift(state: DragState): void {
    if (state.source !== null) clearCastLift(canvas, state.source);
  }

  /**
   * Arena casting (R7) only. The network half of a CANCEL — Escape, or a drop
   * back on the hand. Before the settle nothing was ever sent, so this is a
   * no-op. After it, the press is a cancel only while Forge is still asking
   * about the cast: a target selection (`selectables`) or a mana payment. A
   * land, or a spell that needed neither, is already done by then, Forge is
   * back at priority, and its button 2 is End Turn — pressing it ended the
   * operator's turn (2026-10-03, a Battlefield Forge dragged back over the
   * hand). An open ask needs no check here: `pressButton` refuses during one.
   */
  function cancelCastNetwork(state: DragState): void {
    if (!state.cast) return;
    if (match.selectables === null && !payingMana(match)) return;
    pressButton(match, 'cancel');
  }

  /**
   * Arena casting (R7) only. The network half of ENDING a gesture whose cast
   * was already sent at the settle — a real drag's release, or the press that
   * resolves a click-armed one. `source: null` is the whole point of the
   * call: `commitDrag` must never resend it, only ever answer a target ask
   * that is open NOW (see the module header). A gesture that never settled
   * (dropped off the battlefield, or back on the hand, before crossing in)
   * sent nothing at all, so there is nothing to finish either.
   */
  function finishCast(state: DragState, node: EventTarget | null): void {
    if (!state.cast) return;
    commitDrag(match, { ...state, source: null }, node);
  }

  /**
   * R9: tell `Board` a second time where this cast landed — "the later call
   * wins, that's where the player let go" (the manager's own words). Only
   * when the cast was actually sent (nothing to place before the settle) AND
   * the release is genuinely over the viewer's own battlefield; released
   * anywhere else (onto an opponent to answer a target ask, say), the
   * settle-time call (`onPointerMove`) already made still stands.
   */
  function noteReleasePlacement(state: DragState, point: Point, node: EventTarget | null): void {
    if (state.cast && state.source !== null && overOwnBattlefield(node)) notePlayedTo(state.source, point);
  }

  /** R9: let go of the placement preview. Arena-cast gestures only — nothing else ever draws one. */
  function clearPlacementPreview(state: DragState): void {
    if (state.stage !== null) previewPlayedTo(null);
  }

  function onPointerDown(event: PointerEvent): void {
    // Left button only: a right-click is Forge's own menu on the desktop and
    // is not this gesture's to take.
    if (event.button !== 0) return;
    /*
     * Arena casting (R7): a click-armed gesture (`held: false`) does not end
     * at its own release — it keeps following the pointer with no button
     * held (the module header's own section explains why) until THIS press
     * resolves it. Ahead of every other branch below: the resolving press
     * may land on anything at all, including something that would otherwise
     * start an unrelated gesture of its own.
     */
    if (drag !== null && drag.stage !== null && !drag.held) {
      claim(event);
      const held = drag;
      drag = null;
      dropCastLift(held);
      clearPlacementPreview(held);
      paint();
      if (overOwnHand(event.target) && !namedByOpenSelection(event.target)) {
        cancelCastNetwork(held);
      } else {
        noteReleasePlacement(held, { x: event.clientX, y: event.clientY }, event.target);
        finishCast(held, event.target);
      }
      return;
    }
    // Reset at the top of every FRESH press — see the flag's own doc comment.
    suppressClick = false;
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
      drag = {
        source: null,
        press: at,
        from: origin === null ? at : centreOf(origin),
        at,
        target: targetAt(event.target),
        moved: false,
        stage: null,
        stagedAt: null,
        cast: false,
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
       * Arena casting (R7) — see the module header. Only a card in the
       * viewer's own hand is ever lifted; a battlefield land now offered for
       * its mana ability (wave 35 §F) is not in anyone's hand and this is
       * false for it, so it drags exactly as it always has.
       *
       * **Priority's own offer ONLY — never a selection's, and never an
       * ask's.** Found by lane E against a real Forge (R13, Secluded Glen):
       * `InputSelectEntitiesFromList` (`"reveal a Faerie?"`) opens a
       * `setSelectables` that itself NAMES the hand card, so `isHandCard`
       * alone claimed that press for the lift too — the click never reached
       * Forge, and the seat silently fell through to whatever a cancelled
       * input does next (the land arrived tapped, with no cast having
       * happened). A card Forge is actively asking the seat to CHOOSE is not
       * one it is offering to be CAST, and the two can share the same id.
       * `match.asks.length > 0` already empties `offered` entirely
       * (`boardInteraction`'s own guard), so that half holds without a
       * separate check here; `match.selectables === null` is the one this
       * bug needed; `weaklySelectable.has(id)` on top of both is the precise
       * positive case — Forge's own priority-time "you could cast this",
       * never `highlighted`/`mulliganHand`/combat's unions, none of which a
       * press on a hand card should ever read as "lift and cast".
       */
      const castFromHand =
        isHandCard(match, under.id) &&
        match.selectables === null &&
        match.asks.length === 0 &&
        (match.weaklySelectable?.has(under.id) ?? false);
      if (castFromHand) suppressClick = true;
      drag = {
        source: under.id,
        press: at,
        from: box === null ? at : centreOf(box),
        at,
        target: under,
        moved: false,
        stage: castFromHand ? 'lifted' : null,
        stagedAt: null,
        cast: false,
        held: true,
      };
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
    drag = { source: null, press: at, from: at, at, target: under, moved: false, stage: null, stagedAt: null, cast: false, held: true };
    hover = null;
    paint();
  }

  function onPointerMove(event: PointerEvent): void {
    const at = { x: event.clientX, y: event.clientY };
    if (drag !== null) {
      const moved = drag.moved || past(drag.press, at);
      let next: DragState = { ...drag, at, moved, target: targetAt(event.target) };
      /*
       * Arena casting (R7): the settle, and THE cast. Once it happens it is
       * not undone for the rest of this gesture — `stagedAt` and `cast` are
       * both set exactly once, here, regardless of whether a button is still
       * held (a click-armed gesture settles from a bare hover move, same as
       * a held drag) — see the module header's "sent AT THE SETTLE" section.
       */
      if (next.stage === 'lifted' && overOwnBattlefield(event.target)) {
        next = { ...next, stage: 'settled', stagedAt: at, cast: true };
        if (next.source !== null) {
          selectCard(match, next.source);
          // R9: the first placement call — "at the moment your gesture sends
          // the cast" (the manager's own words). The release may call again
          // and win; this is what a card gets if the pointer never moves again.
          notePlayedTo(next.source, at);
        }
      }
      // R9: the live preview, for every move while lifted or settled —
      // whichever slot `point` currently hits, or none once the pointer
      // leaves the viewer's own battlefield.
      if (next.stage !== null) previewPlayedTo(overOwnBattlefield(event.target) ? at : null);
      drag = next;
    } else if (marquee !== null) {
      marquee = { press: marquee.press, at, moved: marquee.moved || past(marquee.press, at) };
    } else {
      hover = canvas.contains(event.target instanceof Node ? event.target : null) ? { at, node: event.target } : null;
    }
    paint();
  }

  function onPointerUp(event: PointerEvent): void {
    /*
     * Arena casting (R7): a plain click (zero `moved`) does NOT end the
     * gesture — it ARMS it (`held: false`) and keeps tracking the pointer
     * with no button down, same as a held drag, until the next press
     * resolves it (`onPointerDown`'s own top-of-function check). Every other
     * kind of drag, and a real Arena drag (`moved: true`), still ends here
     * exactly as before.
     */
    if (drag !== null && drag.stage !== null && !drag.moved) {
      drag = { ...drag, held: false };
      paint();
      return;
    }
    const heldDrag = drag;
    const heldMarquee = marquee;
    drag = null;
    marquee = null;
    hover = null;
    if (heldDrag !== null) {
      dropCastLift(heldDrag);
      clearPlacementPreview(heldDrag);
    }
    paint();
    if (heldDrag !== null) {
      if (stackAsk(match) !== null) {
        // The release IS the answer, a click on the item as much as a drag onto it.
        const id = stackItemUnder(event.target, stackAsk(match)!);
        if (id !== null) commitStackTarget(match, id);
        return;
      }
      if (heldDrag.stage !== null) {
        // Arena casting (R7): the cast already went at the settle (or never
        // did, and `finishCast` is a no-op). A drop back on the hand is the
        // one new cancel; `finishCast` is everything else, release included.
        if (overOwnHand(event.target)) {
          cancelCastNetwork(heldDrag);
          return;
        }
        // R9: the release's own placement call — it wins over the settle's.
        noteReleasePlacement(heldDrag, { x: event.clientX, y: event.clientY }, event.target);
        finishCast(heldDrag, event.target);
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
    if (drag !== null) {
      dropCastLift(drag);
      clearPlacementPreview(drag);
      if (drag.stage !== null) cancelCastNetwork(drag);
    }
    drag = null;
    marquee = null;
    hover = null;
    paint();
  }

  /** Arena casting (R7): Escape cancels cleanly, from either stage, held or armed. */
  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    if (drag === null || drag.stage === null) return;
    const held = drag;
    drag = null;
    dropCastLift(held);
    clearPlacementPreview(held);
    cancelCastNetwork(held);
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

  /**
   * Arena casting (R7)'s other capture: the native `click` a plain press
   * leaves behind, for a press this module is about to settle ITSELF through
   * `commitDrag` (see `onPointerUp` and the module header's last section).
   * Same technique as `onDragStart` just above and the same reason — before
   * React's own delegated handler on this element ever sees it — except this
   * one is conditional: every click this module did NOT just claim passes
   * through untouched, exactly as before this wave (`suppressClick` is false
   * for anything but a hand-card lift).
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
      canvas.removeEventListener('click', onClickCapture, true);
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
      // R9: a gesture disposed mid-flight (a remount, a resync) leaves no
      // placement preview behind either.
      if (drag !== null && drag.stage !== null) previewPlayedTo(null);
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

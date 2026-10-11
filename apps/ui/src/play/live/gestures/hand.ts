/*
 * The hand reorder. Operator: *"cannot reorder items in hand. and this needs
 * a much smoother animation when it is done. also when cards are picked up
 * and reordered it should be visible to the opponent as well."*
 *
 * Before this, a hand card Forge offered started `install.ts`'s cast gesture
 * on the very first press, so a reorder was reachable only on a card Forge
 * was not offering (`Board.tsx`'s `useArrangeDrag`, which now never arranges
 * a hand card at all, so the press always reaches here first). Now EVERY press on
 * the viewer's own hand card, offered or not, is this gesture, and
 * `install.ts` keeps reusing its own existing `drag`/`resolveLift` machinery
 * end to end — this module supplies only what is NEW: the hand's own
 * geometry, the board sizing, the FLIP, and the bridge into `Board.tsx`'s
 * arrangement store and `presence.ts`'s wire.
 *
 * ## Which gesture a press becomes
 *
 * `install.ts` still sets `drag.lifted = true` at the press, exactly as the
 * old cast-from-hand branch did (so a plain click still ARMS the gesture —
 * `DragState.held`'s own doc comment — rather than this module inventing a
 * second click-arm state machine). What is new is WHERE that press is read
 * from: every own-hand card, not only an offered one (`handCardPress`, called
 * from `install.ts`'s `onPointerDown` ahead of the arrangement stand-down).
 *
 * While the pointer stays over the viewer's own hand, `install.ts`'s move
 * handler calls into this module instead of `./cast.ts`'s drop cues
 * (`updateHandIndicator`): the lifted card keeps following the pointer,
 * already board-sized from the press (`./cast.ts`'s `drawCastLift` itself
 * pins `--card-w` to the viewer's own battlefield the moment a card lifts —
 * this module does not read or write that property at all), and the row's
 * own `data-arrange-indicator`/`data-arrange-target` marks (`Board.tsx`'s
 * `board.css`, already drawn for the battlefield's own rearrange) preview
 * where it would land. The moment the pointer leaves the hand, `install.ts`
 * falls back to the cast gesture's own cues — the handoff is that mode
 * change, nothing more, because the press, the lift and the element being
 * dragged never stop being the same ones.
 *
 * ## Committing
 *
 * A release back inside the hand (`install.ts`'s `resolveLift`, its own
 * `overHome(node, 'hand')` branch) calls
 * `commitHandReorder`: `Board.tsx`'s `withHandMove`/`commitHandMove` write the
 * new order into the arrangement store (never Forge — nothing is sent),
 * `presence.ts`'s `queueHandMove` tells the other seat which two INDICES
 * swapped (never an id, never a name), and every hand `<li>` whose box moved
 * — the dragged one included — glides there with a FLIP (`flipHand`): the
 * position is set to where it already was with no transition, then cleared
 * with one, so the browser animates the DELTA rather than snapping.
 *
 * A release outside the hand is untouched: `install.ts`'s existing cast flow
 * takes it exactly as it always has.
 */
import type { Point } from './types.ts';
import type { DropTarget } from '../../Board.tsx';
import { commitHandMove } from '../../Board.tsx';
import { queueHandMove } from '../presence.ts';
import { clearCastLift } from './cast.ts';
import { GLIDE_MS } from '../../motion.ts';
import './hand.css';

/** The house curve — the same one `./gestures.css`'s `[data-cast-lift='parked'|'returning']` already use. */
const HOUSE_CURVE = 'cubic-bezier(0.3, 0.7, 0.3, 1)';

/** Set on a hand card while it FLIPs into its new slot; `./hand.css` reads it to keep the card out of the player's way mid-flight. */
export const HAND_FLIP_ATTR = 'data-hand-flip';

function ownHandList(canvas: ParentNode): HTMLElement | null {
  return canvas.querySelector<HTMLElement>('[data-zone="hand"][data-owner="you"] ul.zone__cards');
}

/**
 * A press on the viewer's own hand card, wherever Forge stands on it — the
 * one thing `install.ts` could not get from `./cast.ts`'s `isHandCard` alone,
 * which only answers "is this id in the hand", not "is this press on the
 * hand's own markup". Returns the id and the pressed `<li>`, or null off the
 * hand entirely.
 */
export function handCardPress(node: EventTarget | null): { id: number; li: HTMLElement } | null {
  if (!(node instanceof Element)) return null;
  const li = node.closest<HTMLElement>('[data-zone="hand"][data-owner="you"] li.board-card');
  if (li === null) return null;
  const raw = li.getAttribute('data-board-card') ?? li.getAttribute('data-card-id');
  const id = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(id) ? { id, li } : null;
}

/** The viewer's own hand, in DOM order — the same order `Board.tsx`'s `handOrder` just rendered, read back rather than recomputed. */
export function handOrderIds(canvas: ParentNode): number[] {
  const list = ownHandList(canvas);
  if (list === null) return [];
  const out: number[] = [];
  for (const li of list.querySelectorAll<HTMLElement>(':scope > li.board-card')) {
    const raw = li.getAttribute('data-board-card') ?? li.getAttribute('data-card-id');
    const id = raw === null ? Number.NaN : Number(raw);
    if (Number.isFinite(id)) out.push(id);
  }
  return out;
}

/**
 * Where `point` would land `cardId` among its OWN hand's siblings (never a
 * stack, never a pile — a hand has none): before the first sibling whose
 * centre is to its right, or `end` past every sibling. `index` is the
 * position in the hand WITHOUT `cardId` that this names — exactly what
 * `queueHandMove`'s own `to` and `withHandMove`'s own splice point need.
 */
function nearestHandSlot(canvas: ParentNode, cardId: number, point: Point): { target: DropTarget; index: number } {
  const list = ownHandList(canvas);
  const siblings =
    list === null
      ? []
      : [...list.querySelectorAll<HTMLElement>(':scope > li.board-card')].filter((li) => {
          const raw = li.getAttribute('data-board-card') ?? li.getAttribute('data-card-id');
          return raw !== null && Number(raw) !== cardId;
        });
  for (let i = 0; i < siblings.length; i += 1) {
    const box = siblings[i]!.getBoundingClientRect();
    if (point.x < box.left + box.width / 2) {
      const raw = siblings[i]!.getAttribute('data-board-card') ?? siblings[i]!.getAttribute('data-card-id');
      return { target: { kind: 'before', id: Number(raw) }, index: i };
    }
  }
  return { target: { kind: 'end' }, index: siblings.length };
}

let indicator: HTMLElement | null = null;
let marked: Element[] = [];

/** Clear the indicator bar and every `data-arrange-target` mark it left — a release, a cancel, or the pointer leaving the hand for the cast gesture. */
export function clearHandIndicator(): void {
  indicator?.remove();
  indicator = null;
  for (const el of marked) el.removeAttribute('data-arrange-target');
  marked = [];
}

/**
 * The preview: mark the sibling `point` would land in front of (or the slot
 * itself, empty) and draw the SAME indicator bar `Board.tsx`'s own
 * battlefield rearrange already draws (`board.css`'s `[data-arrange-indicator]`
 * — nothing new to style here, which is the whole point of reusing it).
 */
export function updateHandIndicator(canvas: ParentNode, cardId: number, point: Point): void {
  const board = canvas.querySelector<HTMLElement>('.board');
  const list = ownHandList(canvas);
  if (board === null || list === null) return;
  for (const el of marked) el.removeAttribute('data-arrange-target');
  marked = [];
  // The one bar is moved, never taken out and put back: a child added to or removed from `.board`
  // lays the whole board out again, and this runs every frame of the drag.
  indicator?.setAttribute('hidden', '');
  const { target } = nearestHandSlot(canvas, cardId, point);
  const boardBox = board.getBoundingClientRect();
  let at: DOMRect;
  if (target.kind === 'before') {
    const el = list.querySelector<HTMLElement>(`:scope > li.board-card[data-board-card="${target.id}"], :scope > li.board-card[data-card-id="${target.id}"]`);
    if (el === null) return;
    el.setAttribute('data-arrange-target', 'before');
    marked.push(el);
    at = el.getBoundingClientRect();
  } else {
    const siblings = [...list.querySelectorAll<HTMLElement>(':scope > li.board-card')].filter((li) => {
      const raw = li.getAttribute('data-board-card') ?? li.getAttribute('data-card-id');
      return raw !== null && Number(raw) !== cardId;
    });
    const last = siblings[siblings.length - 1] ?? null;
    if (last === null) {
      at = list.getBoundingClientRect();
    } else {
      last.setAttribute('data-arrange-target', 'end');
      marked.push(last);
      at = last.getBoundingClientRect();
    }
  }
  if (at.width === 0 && at.height === 0 && target.kind === 'end') return;
  if (indicator === null || indicator.parentElement !== board) {
    indicator?.remove();
    indicator = document.createElement('div');
    indicator.setAttribute('data-arrange-indicator', '');
    indicator.setAttribute('data-arrange-slot', 'hand');
    indicator.style.width = '3px';
    board.append(indicator);
  }
  indicator.removeAttribute('hidden');
  indicator.setAttribute('data-arrange-kind', target.kind === 'before' ? 'before' : 'end');
  indicator.style.height = `${at.height}px`;
  const x = target.kind === 'before' ? at.left : at.right;
  indicator.style.left = `${x - boardBox.left}px`;
  indicator.style.top = `${at.top - boardBox.top}px`;
}

function centreOf(r: DOMRect): Point {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * The FLIP (First, Last, Invert, Play): every hand `<li>` whose centre moved
 * between `before` (captured just ahead of the commit, the dragged card's own
 * last on-screen box included — wherever the pointer let it go, fixed-position
 * and all) and now (after `Board.tsx`'s re-render put the new order on the
 * page) gets an inverse `transform`, with no transition, then the SAME
 * transform cleared WITH one — so the browser animates the delta instead of
 * snapping. Mutation: skip this function and the hand still reorders
 * correctly; only the motion is gone — which is exactly `hand.test`'s own
 * "drop the FLIP" case.
 */
export function flipHand(canvas: ParentNode, before: ReadonlyMap<number, Point>): void {
  const list = ownHandList(canvas);
  if (list === null) return;
  const moving: HTMLElement[] = [];
  for (const li of list.querySelectorAll<HTMLElement>(':scope > li.board-card')) {
    const raw = li.getAttribute('data-board-card') ?? li.getAttribute('data-card-id');
    const id = raw === null ? Number.NaN : Number(raw);
    const prev = before.get(id);
    if (prev === undefined) continue;
    const now = centreOf(li.getBoundingClientRect());
    const dx = prev.x - now.x;
    const dy = prev.y - now.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    li.setAttribute(HAND_FLIP_ATTR, '');
    li.style.transition = 'none';
    li.style.transform = `translate(${dx}px, ${dy}px)`;
    moving.push(li);
  }
  if (moving.length === 0) return;
  // Force the start transform to paint before the next frame swaps in the transition.
  void list.getBoundingClientRect();
  requestAnimationFrame(() => {
    for (const li of moving) {
      li.style.transition = `transform ${GLIDE_MS}ms ${HOUSE_CURVE}`;
      li.style.transform = '';
    }
    setTimeout(() => {
      for (const li of moving) {
        li.style.transition = '';
        li.removeAttribute(HAND_FLIP_ATTR);
      }
    }, GLIDE_MS);
  });
}

/**
 * The commit: called once, from `install.ts`'s `resolveLift`, for a release
 * back inside the viewer's own hand. `fromIndex` is the card's own position
 * in the hand at the PRESS that started this gesture (`install.ts` reads
 * `handOrderIds` once, there, before anything moves) — never recomputed here,
 * because by commit time the dragged card is still sitting at that same DOM
 * position (it never physically reordered; only `position: fixed` moved it).
 *
 * Nothing is sent to Forge, whatever `point` lands on — a hand reorder is
 * invisible to the engine by construction, the same guarantee `Board.tsx`'s
 * own battlefield rearrange already makes.
 */
export function commitHandReorder(canvas: ParentNode, cardId: number, fromIndex: number, point: Point): void {
  const list = ownHandList(canvas);
  if (list === null) {
    clearHandIndicator();
    return;
  }
  const before = new Map<number, Point>();
  for (const li of list.querySelectorAll<HTMLElement>(':scope > li.board-card')) {
    const raw = li.getAttribute('data-board-card') ?? li.getAttribute('data-card-id');
    const id = raw === null ? Number.NaN : Number(raw);
    if (Number.isFinite(id)) before.set(id, centreOf(li.getBoundingClientRect()));
  }
  const order = handOrderIds(canvas);
  const withoutDragged = order.filter((id) => id !== cardId);
  const { target, index: toIndex } = nearestHandSlot(canvas, cardId, point);
  clearHandIndicator();
  commitHandMove(withoutDragged, cardId, target);
  if (toIndex !== fromIndex) queueHandMove(fromIndex, toIndex);
  requestAnimationFrame(() => {
    // The dragged card is still pinned at the release point (`position: fixed`,
    // `./cast.ts`'s own attribute) — let it go FIRST, so its box now reflects
    // where `Board.tsx`'s re-render actually put it, the same box `flipHand`
    // measures every other hand card's "after" from.
    clearCastLift(canvas, cardId);
    flipHand(canvas, before);
  });
}

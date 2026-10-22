/*
 * What a release MEANS. Every branch ends in `selectCard` / `selectPlayer` —
 * the senders a click uses — and nothing here invents a wire method.
 *
 * Re-homed from `../LiveBoard.tsx` (wave 20 §B), plus wave 24's two combat
 * gestures. `../match.ts` re-checks Forge's CURRENT offer inside both senders,
 * so no decision taken here can put an id on the wire that Forge did not name.
 */
import {
  afterMarked,
  assignBlock,
  attackAssignment,
  boardInteraction,
  isBlockAssignment,
  isMarked,
  landsOffered,
  ownBlocker,
  removeBlock,
  selectCard,
  selectPlayer,
  type LiveMatch,
} from '../match.ts';
import { cardBox, cardElements, targetUnder } from './targets.ts';
import type { DragState, DropTarget } from './types.ts';
import { playRole } from '../../../sound/index.ts';

/**
 * What a release of `source` over `node` sends as its TARGET, or null — and so
 * the one thing the targeter's tip may snap to (`./install.ts`'s `targetAt`):
 * the arrow and the drop answer from this same function, so an arrow never
 * claims a target the release would not send.
 *
 * Something Forge offered is under the pointer (`targetUnder`), and it is a
 * target of THIS drag:
 *
 *  - never the dragged card itself — a release on its own card uses it
 *    (`commitDrag`'s target-less branch), it does not aim it at itself. The
 *    operator, 2026-10-15: *"if hovering over the card itself it weirdly
 *    draws an arrow to the top of the card. let's not allow arrows to snap
 *    to things that are not valid targets"*;
 *  - a blocker's, only an attacker it may block (`isBlockAssignment`);
 *  - while Forge has a selection open, whatever else it offered;
 *  - with no selection open (declaring attackers, paying mana), only a
 *    defender the dragged attacker may attack (`attackAssignment`). Forge's
 *    actionable set there names this seat's OTHER attackers and mana
 *    sources, and none of those is something the dragged card points at.
 */
export function aimedTarget(match: LiveMatch, source: number | null, node: EventTarget | null): DropTarget | null {
  const target = targetUnder(node, boardInteraction(match));
  if (target === null || (target.kind === 'card' && target.id === source)) return null;
  if (source !== null && ownBlocker(match, source)) {
    return target.kind === 'card' && isBlockAssignment(match, source, target.id) ? target : null;
  }
  if (match.selectables !== null) return target;
  return source !== null && target.kind !== 'stack' && attackAssignment(match, source, target) !== null ? target : null;
}

/** Everything a release can mean. */
export function commitDrag(match: LiveMatch, drag: DragState, node: EventTarget | null): void {
  const source = drag.source !== null && boardInteraction(match).selectable.has(drag.source) ? drag.source : null;
  const target = aimedTarget(match, source, node);

  /*
   * Blocking is a drag and only a drag. Dropped on an attacker, the creature
   * blocks it — moved off whatever it blocked before (`assignBlock`). Dropped
   * anywhere else, its own spot included, it is out of combat (`removeBlock`).
   */
  if (source !== null && ownBlocker(match, source)) {
    if (target !== null && target.kind === 'card') {
      playRole('ui.target');
      assignBlock(match, source, target.id);
    } else {
      removeBlock(match, source);
    }
    return;
  }

  if (target === null) {
    // Nothing Forge named is under the pointer. A drop inside a zone is the
    // card being used — the same single frame its own face sends — whenever
    // Forge currently offers it, selection open or not: `source` is null for
    // a card Forge did not name, and `selectCard` re-checks the offer before
    // anything leaves, so this can never invent an affordance. A drop
    // outside every zone does nothing and says nothing.
    if (source === null) return;
    if (!(node instanceof Element) || node.closest('[data-zone]') === null) return;
    selectCard(match, source);
    return;
  }
  playRole('ui.target');
  /*
   * Attacking by drag, and the other reversed order: `InputAttack` declares an
   * attacker against whichever defender is CURRENT, and a click on a defender
   * is what makes it current. So the defender goes first, the attacker second,
   * and the attacker's click waits until Forge has marked the defender current
   * (`afterMarked`: Forge may apply two quick clicks in either order). When the
   * defender is already the marked one, the attacker's click is all it takes.
   */
  if (source !== null && target.kind !== 'stack' && attackAssignment(match, source, target) !== null) {
    attackWith(match, [source], target);
    return;
  }
  // Forge's own `max`: one thing wanted, so the drop is the thing meant.
  const single = match.selectables !== null && match.selectables.max <= 1;
  if (source !== null && !single && !selectCard(match, source)) return;
  if (target.kind === 'card') selectCard(match, target.id);
  else if (target.kind === 'player') selectPlayer(match, target.id);
}

/**
 * Declare `attackers` against the defender `target`: the defender's click first,
 * so `InputAttack` makes it current, then every attacker's own click — sent only
 * once Forge has marked the defender (`afterMarked`), or at once when it already
 * is. One attacker for a drag, a box's whole group for an aimed box. An attacker
 * already attacking `target` is left out: its click would toggle it off.
 */
export function attackWith(match: LiveMatch, attackers: readonly number[], target: { kind: 'card' | 'player'; id: number }): void {
  const todo = attackers.filter((id) => attackAssignment(match, id, target) === 'assign');
  if (todo.length === 0) return;
  const declare = (): void => {
    for (const id of todo) selectCard(match, id);
  };
  if (isMarked(match, target)) { declare(); return; }
  const picked = target.kind === 'card' ? selectCard(match, target.id) : selectPlayer(match, target.id);
  if (picked) afterMarked(match, target, declare);
}

/**
 * Every defender `InputAttack` would take for `attacker` right now: the
 * opponents it offers and the planeswalkers and battles (`attackAssignment`).
 */
function defendersOf(match: LiveMatch, attacker: number): DropTarget[] {
  const offer = boardInteraction(match);
  const out: DropTarget[] = [];
  for (const id of offer.selectablePlayers) if (attackAssignment(match, attacker, { kind: 'player', id }) !== null) out.push({ kind: 'player', id });
  for (const id of offer.selectable) if (attackAssignment(match, attacker, { kind: 'card', id }) !== null) out.push({ kind: 'card', id });
  return out;
}

/** A rectangle in client coordinates. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The marquee's box, from the press and the pointer — either drag direction. */
export function rectOf(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}

function overlaps(a: Rect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** What a box-draw over attackers did: sent its clicks, or held a group to be aimed at a defender. */
export type MarqueeCommit = { kind: 'sent'; ids: number[] } | { kind: 'aim'; ids: number[] };

/**
 * Box-draw multi-select (§B.2): every creature Forge OFFERED whose box the
 * marquee touched, each sent as its own `selectCard`.
 *
 * `boardInteraction` is consulted once per id, inside `selectCard`, so an id
 * Forge did not offer cannot leave however the marquee was drawn — and an id
 * whose offer disappears part-way through the sweep (Forge answering between
 * two frames) stops there rather than being forced out. `sent` is what was
 * actually sent, in DOM order.
 *
 * ## Wave 32 Q14 — a box over declared attackers pulls them back
 *
 * Forge's `InputAttack.onCardSelected` toggles: a click on a creature already
 * attacking undeclares it (`InputAttack.java:208-218`). So a box is a TOGGLE
 * too, and a box that swept both kinds must not undo half of what it meant:
 *
 *  - it touches at least one creature that is not yet attacking → it DECLARES,
 *    and only those (the ones already attacking are left alone);
 *  - it touches ONLY creatures already attacking → it pulls every one of them
 *    back.
 *
 * ## A box that declares is aimed, when there is a choice of defender
 *
 * The operator, 2026-10-19: *"when i draw a box to select a number of
 * creatures, i still want to select where the arrow goes rather than having
 * them auto-select a target"* — a box's clicks declare against whatever
 * defender `InputAttack` has current, a planeswalker included. So a box that
 * DECLARES while Forge offers more than one defender sends nothing: it returns
 * the group (`aim`), and `./install.ts` holds it until the defender's click
 * (`attackWith`). One defender, the opponent alone, and it declares at once.
 */
export function commitMarquee(match: LiveMatch, rect: Rect, root: ParentNode): MarqueeCommit {
  const offered = boardInteraction(match).selectable;
  const mine = new Set(viewerBattlefield(match).map((c) => c.id));
  const hits: number[] = [];
  for (const { id, el } of cardElements(root)) {
    // Only this seat's own creatures: a defender the box crossed is aimed at, never swept.
    if (!offered.has(id) || !mine.has(id)) continue;
    if (!overlaps(rect, el.getBoundingClientRect())) continue;
    hits.push(id);
  }
  const attacking = new Set(viewerBattlefield(match).filter((c) => c.attacking).map((c) => c.id));
  const { ids, on } = boxToggle(hits, attacking);
  if (on && defendersOf(match, ids[0]!).length > 1) return { kind: 'aim', ids };
  const sent: number[] = [];
  for (const id of ids) if (selectCard(match, id)) sent.push(id);
  return { kind: 'sent', ids: sent };
}

/**
 * Which of the cards a box touched it clicks, for a click that toggles one
 * state — attacking, tapped. The box takes the click of the cards still to
 * turn on: it touched at least one that is off → it turns those on and leaves
 * the ones already on alone; it touched only ones that are on → it turns every
 * one of them off. Never half of each, so the cards the release marks all go
 * the same way. Not a majority and not the card the drag started on: a box
 * starts on empty table, and topping up the rest is what a second box over a
 * half-tapped row means.
 */
export function boxToggle(hits: readonly number[], on: ReadonlySet<number>): { ids: number[]; on: boolean } {
  const off = hits.filter((id) => !on.has(id));
  return off.length > 0 ? { ids: off, on: true } : { ids: [...hits], on: false };
}

/** The lands a box clicks, and whether those clicks tap them (true) or untap them. */
export interface LandSweep {
  ids: number[];
  tap: boolean;
}

/**
 * A box drawn over the viewer's own lands: the ones it touched that Forge takes
 * a click on now (`landsOffered`), in DOM order, by `boxToggle`'s rule — a click
 * on an untapped land taps it for mana, on a tapped one untaps it. Nothing is
 * sent here — Forge takes one click at a time, so `./install.ts` sends them one
 * after another.
 */
export function landsInBox(match: LiveMatch, rect: Rect, root: ParentNode): LandSweep {
  const lands = landsOffered(match);
  const clickable = new Set(lands.map((c) => c.id));
  const tapped = new Set(lands.filter((c) => c.tapped).map((c) => c.id));
  const hits: number[] = [];
  for (const { id, el } of cardElements(root)) {
    if (clickable.has(id) && overlaps(rect, el.getBoundingClientRect())) hits.push(id);
  }
  const { ids, on } = boxToggle(hits, tapped);
  return { ids, tap: on };
}

/**
 * The operator, 2026-10-08: *"when drawing a box to tap
 * lands, can we have them all tap simultaneously rather than one at a time?"*
 * Forge still takes one `selectCard` at a time (`./install.ts`'s `pumpTaps`,
 * unchanged) — this is the DRAWN state only, an optimistic attribute every
 * boxed land gets at the release, before any of them is confirmed.
 * `card.css`'s tapped selector draws `data-tapped-pending` as tapped and
 * `data-untapped-pending` as upright, whatever `data-tapped` says.
 */
export const TAPPED_PENDING_ATTR = 'data-tapped-pending';
export const UNTAPPED_PENDING_ATTR = 'data-untapped-pending';

/** Mark every id's own board element pending-tapped (or pending-untapped), all at once — the box's release, before Forge confirms any of them. */
export function markTapPending(root: ParentNode, ids: readonly number[], tap: boolean): void {
  for (const id of ids) cardBox(root, id)?.setAttribute(tap ? TAPPED_PENDING_ATTR : UNTAPPED_PENDING_ATTR, '');
}

/** Drop the pending mark off one id: Forge confirmed it (its own `data-tapped` now carries it) or the sweep gave up on it. */
export function clearTapPending(root: ParentNode, id: number): void {
  const el = cardBox(root, id);
  el?.removeAttribute(TAPPED_PENDING_ATTR);
  el?.removeAttribute(UNTAPPED_PENDING_ATTR);
}

/** This seat's own battlefield, off the view. */
function viewerBattlefield(match: LiveMatch) {
  return match.view?.players.find((p) => p.isViewer)?.battlefield ?? [];
}

export type { DropTarget };

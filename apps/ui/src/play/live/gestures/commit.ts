/*
 * What a release MEANS. Every branch ends in `selectCard` / `selectPlayer` —
 * the senders a click uses — and nothing here invents a wire method.
 *
 * Re-homed from `../LiveBoard.tsx` (wave 20 §B), plus wave 24's two combat
 * gestures. `../match.ts` re-checks Forge's CURRENT offer inside both senders,
 * so no decision taken here can put an id on the wire that Forge did not name.
 */
import { afterMarked, attackAssignment, boardInteraction, isBlockAssignment, isMarked, landsToTap, selectCard, selectPlayer, type LiveMatch } from '../match.ts';
import { cardElements, targetUnder } from './targets.ts';
import type { DragState, DropTarget } from './types.ts';

/** Everything a release can mean. */
export function commitDrag(match: LiveMatch, drag: DragState, node: EventTarget | null): void {
  const offered = boardInteraction(match);
  const source = drag.source !== null && offered.selectable.has(drag.source) ? drag.source : null;
  const target = targetUnder(node, offered);

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
  if (target.kind === 'card' && target.id === source) {
    selectCard(match, source);
    return;
  }
  /*
   * Blocking by drag (§B.3), and the ONE place the order is reversed.
   *
   * `InputBlock` takes the attacker first — a click on an attacking card sets
   * `currentAttacker`, and the click AFTER it becomes that attacker's blocker
   * (`InputBlock.java:112-160`). The gesture the operator asked for is "drag
   * the blocker onto the attacker", so the frames go out attacker-then-blocker
   * even though the pointer travelled the other way. `isBlockAssignment` is
   * where the argument that this is Forge's own condition lives.
   *
   * …unless Forge has ALREADY made that attacker the current one, which it
   * says by HIGHLIGHTING it (`setCurrentAttacker`, `InputBlock.java:190-197` —
   * and its constructor auto-selects the first blockable attacker before the
   * input is even shown). Then the attacker's click would be a no-op and the
   * gesture is one frame, which is what `../combat-drag.jvm.test.ts` measured
   * against a real Forge. So the wire carries the clicks Forge still needs and
   * not one more: two when the player pointed at a DIFFERENT attacker, one when
   * they pointed at the one Forge was already on.
   */
  if (source !== null && target.kind === 'card' && isBlockAssignment(match, source, target.id)) {
    const attacker = { kind: 'card' as const, id: target.id };
    if (isMarked(match, attacker)) { selectCard(match, source); return; }
    if (!selectCard(match, target.id)) return;
    // the blocker's click waits for Forge to make the attacker current: see `afterMarked`
    afterMarked(match, attacker, () => selectCard(match, source));
    return;
  }
  /*
   * Attacking by drag, and the other reversed order: `InputAttack` declares an
   * attacker against whichever defender is CURRENT, and a click on a defender
   * is what makes it current. So the defender goes first, the attacker second,
   * and the attacker's click waits until Forge has marked the defender current
   * (`afterMarked`: Forge may apply two quick clicks in either order). When the
   * defender is already the marked one, the attacker's click is all it takes.
   */
  if (source !== null && target.kind !== 'stack') {
    const assignment = attackAssignment(match, source, target);
    if (assignment === 'already') return;
    if (assignment === 'assign') {
      if (isMarked(match, target)) { selectCard(match, source); return; }
      const picked = target.kind === 'card' ? selectCard(match, target.id) : selectPlayer(match, target.id);
      if (picked) afterMarked(match, target, () => selectCard(match, source));
      return;
    }
  }
  // Forge's own `max`: one thing wanted, so the drop is the thing meant.
  const single = match.selectables !== null && match.selectables.max <= 1;
  if (source !== null && !single && !selectCard(match, source)) return;
  if (target.kind === 'card') selectCard(match, target.id);
  else if (target.kind === 'player') selectPlayer(match, target.id);
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

/**
 * Box-draw multi-select (§B.2): every creature Forge OFFERED whose box the
 * marquee touched, each sent as its own `selectCard`.
 *
 * `boardInteraction` is consulted once per id, inside `selectCard`, so an id
 * Forge did not offer cannot leave however the marquee was drawn — and an id
 * whose offer disappears part-way through the sweep (Forge answering between
 * two frames) stops there rather than being forced out. Returns what was
 * actually sent, in DOM order, so a caller can say what happened.
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
 */
export function commitMarquee(match: LiveMatch, rect: Rect, root: ParentNode): number[] {
  const offered = boardInteraction(match).selectable;
  const hits: number[] = [];
  for (const { id, el } of cardElements(root)) {
    if (!offered.has(id)) continue;
    if (!overlaps(rect, el.getBoundingClientRect())) continue;
    hits.push(id);
  }
  const attacking = attackingCards(match);
  const fresh = hits.filter((id) => !attacking.has(id));
  const toSend = fresh.length > 0 ? fresh : hits;
  const sent: number[] = [];
  for (const id of toSend) if (selectCard(match, id)) sent.push(id);
  return sent;
}

/**
 * A box drawn over the viewer's own lands: the ones it touched that Forge will
 * tap for mana now (`landsToTap`), in DOM order. Nothing is sent here — Forge
 * takes one tap at a time, so `./install.ts` sends them one after another.
 */
export function landsInBox(match: LiveMatch, rect: Rect, root: ParentNode): number[] {
  const tappable = new Set(landsToTap(match));
  const hits: number[] = [];
  for (const { id, el } of cardElements(root)) {
    if (tappable.has(id) && overlaps(rect, el.getBoundingClientRect())) hits.push(id);
  }
  return hits;
}

/** This seat's own creatures Forge says are attacking — its `Attacking` property, off the view. */
function attackingCards(match: LiveMatch): ReadonlySet<number> {
  const out = new Set<number>();
  const me = match.view?.players.find((p) => p.isViewer);
  for (const c of me?.battlefield ?? []) if (c.attacking) out.add(c.id);
  return out;
}

export type { DropTarget };

/*
 * Casting a card from the hand: geometry, type-line rules, and every DOM
 * write the gesture layer makes while a hand card is in motion.
 *
 * This module answers two geometry questions `install.ts` needs —
 *
 *  - is the card a press started on sitting in the VIEWER's own hand right
 *    now (`isHandCard`) — the only cards this gesture applies to;
 *  - is a point over the viewer's own battlefield (`overOwnBattlefield`) or
 *    back over their own hand (`overOwnHand`);
 *
 * — plus the type-line rule that decides whether a card needs a target
 * (`needsTarget`), and every DOM write this gesture makes while a hand card
 * is in motion: the card following the pointer (`drawCastLift`), the card
 * parked at its release point while a cast is being aimed, the float-back
 * animation when it returns to the hand (`floatCastLiftHome`), and the cues
 * drawn on the viewer's own hand and battlefield while a card is lifted.
 */
import { clearPlacementColumns, showPlacementColumns } from '../../Board.tsx';
import type { LiveMatch } from '../match.ts';
import { battlefieldCardWidth, sizeAsBattlefieldCard } from '../../card-size.ts';
import { cardBox } from './targets.ts';
import type { Point } from './types.ts';

/** True only for a card Forge offered that is in the VIEWER's own hand right now. */
export function isHandCard(match: LiveMatch, id: number): boolean {
  const mine = match.view?.players.find((p) => p.isViewer);
  return mine?.hand?.some((c) => c.id === id) ?? false;
}

/** The viewer's own hand card's current type line, or null — it may have left the hand already. */
export function handCardTypeLine(match: LiveMatch, id: number): string | null {
  const mine = match.view?.players.find((p) => p.isViewer);
  return mine?.hand?.find((c) => c.id === id)?.card.typeLine ?? null;
}

/**
 * Whether a card needs a target to be cast: read off its CURRENT type line —
 * `card.typeLine`, live off the wire's `Type` (the same field
 * `../match.ts`'s `isOwnBattlefieldLand` reads) — never the printed card, so
 * an effect that changes a card's types is honoured as Forge currently sees
 * it. Instant, Sorcery, or an Aura SUBTYPE (the line reads `"Enchantment —
 * Aura"`, never a bare `"Aura"` core type) needs a target; everything else —
 * creature, land, artifact, a non-Aura enchantment — does not, and is a
 * battlefield drop instead.
 */
export function needsTarget(typeLine: string | null): boolean {
  if (typeLine === null) return false;
  return typeLine.includes('Instant') || typeLine.includes('Sorcery') || typeLine.includes('Aura');
}

/** The pointer has crossed into the viewer's own battlefield. */
export function overOwnBattlefield(node: EventTarget | null): boolean {
  return node instanceof Element && node.closest('[data-zone="battlefield"][data-owner="you"]') !== null;
}

/** The pointer is over the viewer's own hand. */
export function overOwnHand(node: EventTarget | null): boolean {
  return node instanceof Element && node.closest('[data-zone="hand"][data-owner="you"]') !== null;
}

/** The viewer's own hand zone element, for the cancel cue. */
function ownHandZone(root: ParentNode): HTMLElement | null {
  return root.querySelector('[data-zone="hand"][data-owner="you"]');
}

/**
 * The two cues drawn while a hand card is lifted. Out of the hand, a card
 * that needs no target could land on the viewer's battlefield, so its rows
 * show their columns — `Board.tsx`'s placement scaffold, the same one a
 * rearrange draws (a card that needs a target never lands in a row, so it
 * gets none). Over the hand, the cancel cue (`data-cancel-hint`, drawn by
 * `./gestures.css`): releasing there always returns the card, whatever it is.
 */
export function updateDropCues(canvas: ParentNode, spell: boolean, overHand: boolean): void {
  if (spell || overHand) clearPlacementColumns(canvas);
  else showPlacementColumns(canvas);
  const hand = ownHandZone(canvas);
  if (hand !== null) {
    if (overHand) hand.setAttribute('data-cancel-hint', '');
    else hand.removeAttribute('data-cancel-hint');
  }
}

/** Every drop cue off, whichever it was — a release, a cancel, or a dispose mid-flight. */
export function clearDropCues(canvas: ParentNode): void {
  clearPlacementColumns(canvas);
  ownHandZone(canvas)?.removeAttribute('data-cancel-hint');
}

/** The one attribute this module writes for the lift itself. Nothing else in this repo writes it. */
export const CAST_LIFT_ATTR = 'data-cast-lift';

/** How long the float-back CSS transition runs — named here for the JS side that schedules the clean-up after it. */
export const FLOAT_BACK_MS = 300;

/** A pending `floatCastLiftHome` clean-up per card id, so a new lift/park on the same id cannot be clobbered by a stale one. */
const returnTimers = new Map<number, ReturnType<typeof setTimeout>>();

function cancelReturnTimer(id: number): void {
  const timer = returnTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    returnTimers.delete(id);
  }
}

/**
 * Draw the card at `at`. `'lifted'`: still following the pointer, pre-release.
 * `'parked'`: a targeted cast already sent, pinned at its release point for the
 * rest of the aim. `'carried'`: a played card on its way to the battlefield —
 * out of the hand's row like the other two, but NOT drawn: its stand-in
 * (`parkedGhost`, taken at the release) is what the player sees until it
 * lands, so nothing Forge does to the card on the way shows through. A
 * shockland that enters tapped is tapped a frame or two before it changes
 * zone, and drew tapped in mid-air. No text is drawn on the card in any state.
 *
 * `'lifted'` also pins `--card-w` to the viewer's own battlefield's CURRENT
 * value (`.board-card`'s own rule, `card.css`, already draws off this
 * property — nothing else has to change). A hand row's own `--card-w` has no
 * `--card-max` ceiling (`board.css`'s T6 comment: *"a hand card is as tall as
 * its row allows"*), so a card lifted straight out of a loose hand could
 * otherwise draw bigger than any card on the board (the operator, ledger
 * AD2: *"sometimes cards in hand can display bigger"*). Snapshotting it once,
 * at the lift, means nothing shrinks later — a `'parked'` or `'carried'` card
 * (the same element, or `parkedGhost`'s clone of it) keeps the value this set.
 * Read with `getComputedStyle` rather than the zone's own source formula,
 * so this needs no second copy of it and stays correct if that formula
 * changes; empty only where there is no battlefield zone to read (a fixture
 * with no `Board` mounted around it), and then the hand's own size is left
 * standing rather than writing a blank custom property.
 */
export function drawCastLift(root: ParentNode, id: number, at: Point, mode: 'lifted' | 'parked' | 'carried'): void {
  const el = cardBox(root, id);
  if (!(el instanceof HTMLElement)) return;
  cancelReturnTimer(id);
  el.setAttribute(CAST_LIFT_ATTR, mode);
  el.style.left = `${at.x}px`;
  el.style.top = `${at.y}px`;
  if (mode === 'lifted') {
    const width = battlefieldCardWidth(root, 'you');
    if (width !== null) sizeAsBattlefieldCard(el, width);
  }
}

/** Let the one card named go — back into its own flow, wherever the gesture ended, with no animation. */
export function clearCastLift(root: ParentNode, id: number): void {
  cancelReturnTimer(id);
  const el = cardBox(root, id);
  if (!(el instanceof HTMLElement)) return;
  el.removeAttribute(CAST_LIFT_ATTR);
  el.style.removeProperty('left');
  el.style.removeProperty('top');
  el.style.removeProperty('--card-w');
}

/**
 * Float a card back to `home` — the card's own box centre at the moment it
 * was first lifted — with a short CSS transition, then let it go.
 * `./gestures.css`'s `[data-cast-lift='returning']` rule is what actually
 * animates the `left`/`top` change this function makes; this function only
 * needs to know WHEN the animation is done, to call `clearCastLift`.
 *
 * `prefers-reduced-motion` is read here too, not only in CSS: skipping the
 * timer outright, rather than letting a now-instant transition still hold
 * the attribute for `FLOAT_BACK_MS`, keeps the clean-up synchronous for a
 * caller that needs it to be.
 *
 * `id` null: a stand-in for a card this screen cannot name — the other seat's
 * card going back into their hidden hand (`../presence.ts`) — so there is no
 * card of its own to let go, only `el`, which `onDone` takes away.
 */
export function floatCastLiftHome(
  root: ParentNode,
  id: number | null,
  home: Point,
  onDone: () => void,
  el: Element | null = id === null ? null : cardBox(root, id),
): void {
  if (!(el instanceof HTMLElement)) {
    onDone();
    return;
  }
  if (id !== null) cancelReturnTimer(id);
  el.setAttribute(CAST_LIFT_ATTR, 'returning');
  el.style.left = `${home.x}px`;
  el.style.top = `${home.y}px`;
  const done = (): void => {
    if (id === null) return onDone();
    returnTimers.delete(id);
    clearCastLift(root, id);
    onDone();
  };
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return done();
  const timer = setTimeout(done, FLOAT_BACK_MS);
  if (id !== null) returnTimers.set(id, timer);
}

/** Marks the stand-in `parkedGhost` draws; it carries no card id, so `cardBox` never finds it. */
/**
 * The reserved gap a stand-in glides into: the `data-expected` gap `Board`
 * draws in that side's battlefield while a placement waits. Measured on the
 * frame after the board drew it (the reservation wakes the board; React draws
 * it before the next paint), and null when there is none — a `stack` target, a
 * cast with a target, a release off the battlefield.
 */
export function expectedGapBox(root: ParentNode, owner: 'you' | 'them'): DOMRect | null {
  const gap = root.querySelector<HTMLElement>(`[data-zone="battlefield"][data-owner="${owner}"] li.zone__gap[data-expected]`);
  if (gap === null) return null;
  const box = gap.getBoundingClientRect();
  return box.width > 0 && box.height > 0 ? box : null;
}

export const CAST_GHOST_ATTR = 'data-cast-ghost';

/**
 * A detached copy of a card's own element, taken while it is still on the
 * page, to stand in for it at the park point once React unmounts the real
 * one: during target selection Forge has the card in neither the hand, the
 * battlefield nor the stack, so the board renders no element for it.
 */
export function parkedGhost(root: ParentNode, id: number): HTMLElement | null {
  const el = cardBox(root, id);
  if (!(el instanceof HTMLElement)) return null;
  const ghost = el.cloneNode(true) as HTMLElement;
  // Nothing that finds a card by id or by test id may find the copy.
  for (const node of [ghost, ...ghost.querySelectorAll('[data-board-card], [data-card-id], [data-testid]')]) {
    node.removeAttribute('data-board-card');
    node.removeAttribute('data-card-id');
    node.removeAttribute('data-testid');
  }
  // Outside the zone it was drawn in, the zone's own sizing no longer reaches it.
  const { width, height } = el.getBoundingClientRect();
  if (width > 0 && height > 0) {
    ghost.style.width = `${width}px`;
    ghost.style.height = `${height}px`;
  }
  ghost.setAttribute(CAST_GHOST_ATTR, String(id));
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  return ghost;
}

/** How close a stand-in's centre is to its card's to count as already there (`landCastGhost`). */
export const IN_PLACE_PX = 4;

/** On a card's own battlefield element while its stand-in is still travelling to it. `./gestures.css` hides it; the row keeps its place. */
export const CAST_LANDING_ATTR = 'data-cast-landing';

/**
 * A played card arrives: its stand-in travels from where it was let go to the
 * place `arrived` already holds in its row, and only then does the real card
 * show. The row is laid out with the card in it from the first frame, so
 * nothing around it moves twice.
 *
 * The stand-in is the travelling thing, never `arrived` itself: a transform on
 * a card inside the battlefield counts toward that zone's scroll overflow, and
 * a card lifted out of the row would close the gap it is flying to.
 *
 * The same trip takes the other seat's cancelled card home (`../presence.ts`):
 * `arrived` is then a back in their hand, and `id` null — see
 * `floatCastLiftHome`.
 *
 * A stand-in already standing where the card is drawn (it waited in the gap the
 * card took) does not travel: it is a swap in place. The trip it used to make
 * there — the gap to itself, 300 ms with the real card hidden under it — was on
 * every landing (the Viridian Shaman recording, 2026-10-09: `dx: 0, dy: 0`).
 */
export function landCastGhost(root: ParentNode, id: number | null, ghost: HTMLElement, from: Point, arrived: HTMLElement): void {
  const box = arrived.getBoundingClientRect();
  const to = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  if (Math.hypot(to.x - from.x, to.y - from.y) < IN_PLACE_PX) {
    ghost.remove();
    if (id !== null) clearCastLift(root, id);
    arrived.removeAttribute(CAST_LANDING_ATTR);
    return;
  }
  ghost.setAttribute(CAST_LIFT_ATTR, 'parked');
  ghost.style.left = `${from.x}px`;
  ghost.style.top = `${from.y}px`;
  if (!ghost.isConnected) (root.querySelector('.board') ?? (root as Element)).appendChild(ghost);
  arrived.setAttribute(CAST_LANDING_ATTR, '');
  // The start point has to be a painted style before the end point replaces it, or there is no transition to run.
  void ghost.getBoundingClientRect();
  floatCastLiftHome(
    root,
    id,
    to,
    () => {
      ghost.remove();
      arrived.removeAttribute(CAST_LANDING_ATTR);
    },
    ghost,
  );
  // It shrinks to the size it will have in the row on the way there. A tapped
  // card's box is the card turned on its side, so its sides are swapped back:
  // the stand-in stays upright for the whole trip.
  if (box.width > 0 && box.height > 0) {
    const turned = arrived.hasAttribute('data-tapped');
    ghost.style.width = `${turned ? box.height : box.width}px`;
    ghost.style.height = `${turned ? box.width : box.height}px`;
  }
}

/** Every lift away, whoever it belonged to — on dispose, so a board left behind carries none, and every pending float-back timer with it. */
export function clearAllCastLifts(root: ParentNode): void {
  for (const timer of returnTimers.values()) clearTimeout(timer);
  returnTimers.clear();
  for (const el of root.querySelectorAll<HTMLElement>(`[${CAST_LIFT_ATTR}]`)) {
    el.removeAttribute(CAST_LIFT_ATTR);
    el.style.removeProperty('left');
    el.style.removeProperty('top');
  }
  for (const ghost of root.querySelectorAll(`[${CAST_GHOST_ATTR}]`)) ghost.remove();
  for (const el of root.querySelectorAll(`[${CAST_LANDING_ATTR}]`)) el.removeAttribute(CAST_LANDING_ATTR);
}

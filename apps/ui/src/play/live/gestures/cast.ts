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
 * drawn on the viewer's own hand and battlefield zones while a card is
 * lifted.
 */
import type { LiveMatch } from '../match.ts';
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

/** The viewer's own battlefield zone element, for the drop cue — null before `Board` mounts one. */
function ownBattlefieldZone(root: ParentNode): HTMLElement | null {
  return root.querySelector('[data-zone="battlefield"][data-owner="you"]');
}

/** The viewer's own hand zone element, for the cancel cue. */
function ownHandZone(root: ParentNode): HTMLElement | null {
  return root.querySelector('[data-zone="hand"][data-owner="you"]');
}

/**
 * The two cues drawn on lane A's own zone markup while a hand card is
 * lifted: the viewer's own battlefield lights up (`data-drop`, "ok" over it,
 * "hint" elsewhere — never for a card that needs a target, which never lands
 * in a row there); the hand shows the cancel cue (`data-cancel-hint`)
 * whenever ANY lifted card sits over it, whatever that card is, since
 * releasing over the hand always returns it. `./gestures.css` draws both
 * attributes.
 */
export function updateDropCues(canvas: ParentNode, spell: boolean, overHand: boolean, overBattlefield: boolean): void {
  const bf = ownBattlefieldZone(canvas);
  if (bf !== null) {
    if (spell) bf.removeAttribute('data-drop');
    else bf.setAttribute('data-drop', overBattlefield ? 'ok' : 'hint');
  }
  const hand = ownHandZone(canvas);
  if (hand !== null) {
    if (overHand) hand.setAttribute('data-cancel-hint', '');
    else hand.removeAttribute('data-cancel-hint');
  }
}

/** Every drop cue off, whichever it was — a release, a cancel, or a dispose mid-flight. */
export function clearDropCues(canvas: ParentNode): void {
  ownBattlefieldZone(canvas)?.removeAttribute('data-drop');
  ownHandZone(canvas)?.removeAttribute('data-cancel-hint');
}

/**
 * The verdict text shown on a lifted card, describing what letting go right
 * now would do: a card that needs a target reads "choose a target" anywhere
 * outside the hand, since a targeted cast is sent wherever it is released; a
 * card that needs no target reads "play it" only over the viewer's own
 * battlefield, and "back to hand" everywhere else, the hand itself included.
 */
export function verdictFor(spell: boolean, overHand: boolean, overBattlefield: boolean): string {
  if (overHand) return 'let go: back to hand';
  if (spell) return 'let go: choose a target';
  return overBattlefield ? 'let go: play it' : 'let go: back to hand';
}

/** The one attribute this module writes for the lift itself. Nothing else in this repo writes it. */
export const CAST_LIFT_ATTR = 'data-cast-lift';
/** The verdict label, read by `./gestures.css`'s `::after` off its own text. */
export const CAST_VERDICT_ATTR = 'data-cast-verdict';

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
 * Draw the card at `at`. `'lifted'`: still following the pointer, pre-release
 * — `verdict` is one of the three strings `./gestures.css` renders, or null
 * while the card has not moved from the hand yet. `'parked'`: a targeted
 * cast already sent, pinned at its release point for the rest of the aim —
 * no verdict label once it has parked, since the targeting arrow is the
 * guidance from then on.
 */
export function drawCastLift(root: ParentNode, id: number, at: Point, mode: 'lifted' | 'parked', verdict: string | null): void {
  const el = cardBox(root, id);
  if (!(el instanceof HTMLElement)) return;
  cancelReturnTimer(id);
  el.setAttribute(CAST_LIFT_ATTR, mode);
  if (verdict === null) el.removeAttribute(CAST_VERDICT_ATTR);
  else el.setAttribute(CAST_VERDICT_ATTR, verdict);
  el.style.left = `${at.x}px`;
  el.style.top = `${at.y}px`;
}

/** Let the one card named go — back into its own flow, wherever the gesture ended, with no animation. */
export function clearCastLift(root: ParentNode, id: number): void {
  cancelReturnTimer(id);
  const el = cardBox(root, id);
  if (!(el instanceof HTMLElement)) return;
  el.removeAttribute(CAST_LIFT_ATTR);
  el.removeAttribute(CAST_VERDICT_ATTR);
  el.style.removeProperty('left');
  el.style.removeProperty('top');
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
 */
export function floatCastLiftHome(root: ParentNode, id: number, home: Point, onDone: () => void): void {
  const el = cardBox(root, id);
  if (!(el instanceof HTMLElement)) {
    onDone();
    return;
  }
  cancelReturnTimer(id);
  el.setAttribute(CAST_LIFT_ATTR, 'returning');
  el.removeAttribute(CAST_VERDICT_ATTR);
  el.style.left = `${home.x}px`;
  el.style.top = `${home.y}px`;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    clearCastLift(root, id);
    onDone();
    return;
  }
  const timer = setTimeout(() => {
    returnTimers.delete(id);
    clearCastLift(root, id);
    onDone();
  }, FLOAT_BACK_MS);
  returnTimers.set(id, timer);
}

/** Every lift away, whoever it belonged to — on dispose, so a board left behind carries none, and every pending float-back timer with it. */
export function clearAllCastLifts(root: ParentNode): void {
  for (const timer of returnTimers.values()) clearTimeout(timer);
  returnTimers.clear();
  for (const el of root.querySelectorAll<HTMLElement>(`[${CAST_LIFT_ATTR}]`)) {
    el.removeAttribute(CAST_LIFT_ATTR);
    el.removeAttribute(CAST_VERDICT_ATTR);
    el.style.removeProperty('left');
    el.style.removeProperty('top');
  }
}

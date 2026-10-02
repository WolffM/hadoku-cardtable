/*
 * Arena casting (R7). The operator, 2026-10-02: *"in mtg arena the card hovers
 * to follow the mouse for a bit until its over your battle field, then just
 * the arrow follows the mouse as you go to your target. clicking can also
 * make the card follow your mouse so that seems the same as drag to me."*
 *
 * This module answers exactly two questions `install.ts`'s state machine
 * needs and draws the one new thing the Arena model adds — the card itself,
 * following the pointer:
 *
 *  - is the card a press started on sitting in the VIEWER's own hand right
 *    now (`isHandCard`) — the only cards this gesture applies to. A land
 *    Forge offers for its mana ability (wave 35 §F) is a BATTLEFIELD card and
 *    this is false for it, same as any other permanent; only a card still in
 *    hand is ever lifted;
 *  - is a point over the viewer's own battlefield (`overOwnBattlefield`, the
 *    settle) or back over their own hand (`overOwnHand`, the cancel).
 *
 * Nothing here decides what a release MEANS — `./commit.ts`'s `commitDrag`
 * still does that, unchanged, once `install.ts` decides the gesture is not
 * being cancelled. This module only ever touches the DOM to draw the lift:
 * `data-cast-lift` on the card's own `<li>`, the same seam `./intent.ts` uses
 * for the attack-intent mark, styled in `./gestures.css`.
 */
import type { LiveMatch } from '../match.ts';
import { cardBox } from './targets.ts';
import type { Point } from './types.ts';

/** True only for a card Forge offered that is in the VIEWER's own hand right now. */
export function isHandCard(match: LiveMatch, id: number): boolean {
  const mine = match.view?.players.find((p) => p.isViewer);
  return mine?.hand?.some((c) => c.id === id) ?? false;
}

/** The settle: the pointer has crossed into the viewer's own battlefield. */
export function overOwnBattlefield(node: EventTarget | null): boolean {
  return node instanceof Element && node.closest('[data-zone="battlefield"][data-owner="you"]') !== null;
}

/** The cancel: the pointer is back over the viewer's own hand. */
export function overOwnHand(node: EventTarget | null): boolean {
  return node instanceof Element && node.closest('[data-zone="hand"][data-owner="you"]') !== null;
}

/** The one attribute this module writes. Nothing else in this repo writes it. */
export const CAST_LIFT_ATTR = 'data-cast-lift';

/**
 * Draw the card at `at`. While lifted, the caller passes the live pointer
 * position, so this moves every frame; once settled, the caller always passes
 * the SAME `stagedAt` (`install.ts`'s `paint()` reads it off the drag, which
 * sets it exactly once), so the position this writes stops changing even
 * though this function itself draws it fresh every time — the pin is the
 * caller's doing, not a branch in here.
 */
export function drawCastLift(root: ParentNode, id: number, at: Point, settled: boolean): void {
  const el = cardBox(root, id);
  if (!(el instanceof HTMLElement)) return;
  el.setAttribute(CAST_LIFT_ATTR, settled ? 'settled' : 'lifted');
  el.style.left = `${at.x}px`;
  el.style.top = `${at.y}px`;
}

/** Let the one card named go — back into its own flow, wherever the gesture ended. */
export function clearCastLift(root: ParentNode, id: number): void {
  const el = cardBox(root, id);
  if (!(el instanceof HTMLElement)) return;
  el.removeAttribute(CAST_LIFT_ATTR);
  el.style.removeProperty('left');
  el.style.removeProperty('top');
}

/** Every lift away, whoever it belonged to — on dispose, so a board left behind carries none. */
export function clearAllCastLifts(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>(`[${CAST_LIFT_ATTR}]`)) {
    el.removeAttribute(CAST_LIFT_ATTR);
    el.style.removeProperty('left');
    el.style.removeProperty('top');
  }
}

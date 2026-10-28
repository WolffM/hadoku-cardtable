/*
 * Casting a card out of one of the viewer's zones — the hand, or a graveyard
 * or exile Forge offers it from (flashback, unearth, escape, foretell…):
 * geometry, type-line rules, and every DOM write the gesture layer makes
 * while such a card is in motion.
 *
 * This module answers the geometry questions `install.ts` needs —
 *
 *  - which of the VIEWER's own zones the card a press started on is sitting
 *    in right now (`castZoneOf`) — the only cards this gesture applies to;
 *  - is a point over the viewer's own battlefield (`overOwnBattlefield`), or
 *    back over the zone the card came from (`overHome`);
 *
 * — plus the type-line rule that decides whether a card needs a target
 * (`needsTarget`), and every DOM write this gesture makes while the card is
 * in motion: the card following the pointer (`drawCastLift`), the card
 * parked at its release point while a cast is being aimed, the float-back
 * animation when it returns home (`floatCastLiftHome`), and the cues drawn
 * on its own zone and the viewer's battlefield while a card is lifted.
 */
import { clearPlacementColumns, showPlacementColumns } from '../../Board.tsx';
import { viewerOf } from '../../adapter.ts';
import type { BoardView } from '../../adapter.ts';
import type { LiveMatch } from '../match.ts';
import { handCardWidth, sizeAsCard } from '../../card-size.ts';
import { GLIDE_MS, prefersReducedMotion } from '../../motion.ts';
import { cardBox, overlayOf } from '../board-dom.ts';
import { entryHeft, entryWeight, playLanding, type EntryWeight } from '../entries.ts';
import type { Point } from './types.ts';

/**
 * The viewer's own zones a card is lifted out of to be cast. Forge offers a
 * card outside the hand from its `ZoneType.Flashback` scan — the graveyard,
 * exile, library and command zone (`Player.getCardsActivatableInExternalZones`,
 * read by `AvailableActions.collectActionable`) — and the board draws three of
 * them: the library only as its top card, while the viewer may look at it
 * (Courser of Kruphix's lands, Future Sight's spells).
 */
export type CastZone = 'hand' | 'graveyard' | 'exile' | 'library';

/** The viewer's own zone the card is in right now, when it is one a cast lifts it out of. */
export function castZoneOf(match: LiveMatch, id: number): CastZone | null {
  const mine = viewerOf(match.view);
  if (mine === undefined) return null;
  if (mine.hand?.some((c) => c.id === id) === true) return 'hand';
  if (mine.graveyard.some((c) => c.id === id)) return 'graveyard';
  if (mine.exile.some((c) => c.id === id)) return 'exile';
  if (mine.libraryTop?.[0]?.id === id) return 'library';
  return null;
}

/** True only for a card in the VIEWER's own hand right now. */
export function isHandCard(match: LiveMatch, id: number): boolean {
  return castZoneOf(match, id) === 'hand';
}

/** The current type line of a card in one of the viewer's cast zones, or null — it may have left already. */
export function castCardTypeLine(match: LiveMatch, id: number): string | null {
  const mine = viewerOf(match.view);
  const card = [...(mine?.hand ?? []), ...(mine?.graveyard ?? []), ...(mine?.exile ?? []), ...(mine?.libraryTop ?? [])].find((c) => c.id === id);
  return card?.card.typeLine ?? null;
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

/** The pointer is back over the viewer's own zone the card came from: a release there is a cancel (or, in the hand, a reorder). */
export function overHome(node: EventTarget | null, zone: CastZone): boolean {
  return node instanceof Element && node.closest(`[data-zone="${zone}"][data-owner="you"]`) !== null;
}

/**
 * The two cues drawn while a card is lifted. Out of its zone, a card that
 * needs no target could land on the viewer's battlefield, so its rows show
 * their columns — `Board.tsx`'s placement scaffold, the same one a rearrange
 * draws (a card that needs a target never lands in a row, so it gets none).
 * Over its own zone, the cancel cue (`data-cancel-hint`, drawn by
 * `./gestures.css`): releasing there always returns the card, whatever it is.
 */
export function updateDropCues(canvas: ParentNode, spell: boolean, zone: CastZone, overZone: boolean): void {
  if (spell || overZone) clearPlacementColumns(canvas);
  else showPlacementColumns(canvas);
  const home = canvas.querySelector(`[data-zone="${zone}"][data-owner="you"]`);
  if (overZone) home?.setAttribute('data-cancel-hint', '');
  else home?.removeAttribute('data-cancel-hint');
}

/** Every drop cue off, whichever it was — a release, a cancel, or a dispose mid-flight. */
export function clearDropCues(canvas: ParentNode): void {
  clearPlacementColumns(canvas);
  for (const el of canvas.querySelectorAll('[data-cancel-hint]')) el.removeAttribute('data-cancel-hint');
}

/** The one attribute this module writes for the lift itself. Nothing else in this repo writes it. */
export const CAST_LIFT_ATTR = 'data-cast-lift';

/**
 * A pending `floatCastLiftHome` per card id, so a new lift/park on the same id cannot be clobbered by
 * a stale one. A float superseded that way still ends what it drew: its `onDone` takes away the
 * stand-in it was floating (a cancelled cast's ghost), which nothing else would — the card's own
 * element is the new lift's, so only that part of the clean-up is skipped.
 */
const returnTimers = new Map<number, { readonly timer: ReturnType<typeof setTimeout>; readonly onDone: () => void }>();

function cancelReturnTimer(id: number): void {
  const pending = returnTimers.get(id);
  if (pending === undefined) return;
  clearTimeout(pending.timer);
  returnTimers.delete(id);
  pending.onDone();
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
 * `'lifted'` also pins `--card-w` to the hand's own card width as the hand
 * draws it now (`card-size.ts`'s `handCardWidth`; `.board-card`'s own rule,
 * `card.css`, already draws off this property). A card being cast is a hand
 * card's size from the lift to the stack, and only its landing shrinks it into
 * its battlefield slot (the operator, 2026-10-15: "casting cards are just as
 * big as hand cards and shrink down to card size once they resolve") — out of
 * the hand's grid it would otherwise draw at the row's uncapped `--card-w`,
 * wider than a crowded hand's narrowed column. Set once, at the lift (not on
 * every move: the measure is a layout), so nothing changes size later — a `'parked'` or `'carried'` card
 * (the same element, or `parkedGhost`'s clone of it) keeps the value this
 * set. Measured, not the zone's source formula; empty only where there is no
 * hand or battlefield to read (a fixture with no `Board` mounted around it),
 * and then the card's own size is left standing.
 */
export function drawCastLift(root: ParentNode, id: number, at: Point, mode: 'lifted' | 'parked' | 'carried'): void {
  const el = cardBox(root, id);
  if (!(el instanceof HTMLElement)) return;
  cancelReturnTimer(id);
  const lifting = mode === 'lifted' && el.getAttribute(CAST_LIFT_ATTR) !== 'lifted';
  el.setAttribute(CAST_LIFT_ATTR, mode);
  el.style.left = `${at.x}px`;
  el.style.top = `${at.y}px`;
  if (lifting) {
    const width = handCardWidth(root);
    if (width !== null) sizeAsCard(el, width);
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
 * the attribute for `GLIDE_MS`, keeps the clean-up synchronous for a
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
  if (prefersReducedMotion()) return done();
  const timer = setTimeout(done, GLIDE_MS);
  if (id !== null) returnTimers.set(id, { timer, onDone });
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

const CAST_GHOST_ATTR = 'data-cast-ghost';

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

/**
 * How close a stand-in's centre is to its card's to count as already there (`landCastGhost`). The
 * other screen's back can be caught in the last few px of its glide into the gap when the card is
 * drawn there (w67-shaman's Grizzly Bears: 449,280 and 450,282 against 454,280), and a 300 ms trip
 * across that is a flight to nowhere with the real card hidden under it.
 */
const IN_PLACE_PX = 8;

/**
 * What `landCastGhost` drew, for the landing's telemetry (`../handover-report.ts`): a `swap` in place
 * or a `flight`, from the stand-in's centre as drawn when it starts to the card's in its row, and
 * how much narrower it ends than it starts (the shrink into the slot) — the trip itself, measured
 * where it starts, never sampled from a later frame.
 */
export interface Landing {
  readonly how: 'swap' | 'flight';
  readonly from: Point;
  readonly to: Point;
  readonly shrink: number;
}

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
 * A stand-in already standing where the card is drawn, at the size it is drawn
 * (it waited in the gap the card took), does not travel: it is a swap in place.
 * The trip it used to make there — the gap to itself, 300 ms with the real card
 * hidden under it — was on every landing (the Viridian Shaman recording,
 * 2026-10-09: `dx: 0, dy: 0`). A cast card waits over its gap at a hand card's
 * size, so its landing is the shrink into the slot, in place.
 *
 * `weight`, when given (`castLandingWeight`), draws the landing's own weight tail once this trip
 * ends — the same weight effects `entries.ts`'s `playEntry` ends with, by the permanent's own
 * card data, never a badge read off `arrived`: a creature by its power, any other permanent by its
 * mana value. Null — no tail — for a trip with nothing to weigh (a float home, an echo this
 * screen cannot name).
 */
/**
 * A permanent's landing weight from its own card data — `entries.ts`'s `entryHeft`: a creature's
 * power, every other permanent (artifact, enchantment, planeswalker, battle) by its mana value —
 * looked up live off `view`'s battlefield, either seat's, never a badge read off the DOM: a cast
 * noncreature permanent has no P/T badge to read, so reading one left it weightless. Null when
 * `view` has no battlefield card at `cardId` yet (Forge has not drawn it there), or `cardId` is
 * null (nothing of this screen's own to weigh — a float back to a hand, the other seat's echo of
 * a card this screen cannot name). The one place every cast or arriving permanent's landing learns
 * its weight, so a caller holding `view` and an id never has to thread the weight through itself.
 */
export function castLandingWeight(view: BoardView | null, cardId: number | null): EntryWeight | null {
  if (cardId === null || view === null) return null;
  for (const p of view.players) {
    const card = p.battlefield.find((c) => c.id === cardId);
    if (card !== undefined) return entryWeight(entryHeft(card.card));
  }
  return null;
}

/**
 * The weight tail onto a landing already at its slot — `landCastGhost`'s own flight (a cast, a
 * token's travel from its maker, the other seat's echo) ends there, so this is its last leg, never
 * a second animation bolted on after a gap (the brief's own words for AF413's cast join): a quick
 * hang-and-drop squish on `ghost`, still standing in for the card, then the same weight effects
 * `entries.ts`'s `playEntry` ends with. Null — no tail — with no weight to draw it by, or with
 * motion off.
 */
function weightTail(root: ParentNode, ghost: HTMLElement, arrived: HTMLElement, key: string, weight: EntryWeight | null): (() => Promise<void>) | null {
  if (weight === null || prefersReducedMotion()) return null;
  const board = (root.querySelector('.board') ?? root) as HTMLElement;
  const overlay = overlayOf(root);
  if (overlay === null) return null;
  return () => playLanding(board, overlay, arrived, weight, key, ghost);
}

export function landCastGhost(root: ParentNode, id: number | null, ghost: HTMLElement, from: Point, arrived: HTMLElement, weight: EntryWeight | null = null): Landing {
  const box = arrived.getBoundingClientRect();
  const to = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  const turned = arrived.hasAttribute('data-tapped');
  const size = { width: turned ? box.height : box.width, height: turned ? box.width : box.height };
  const key = `cast:${id ?? arrived.getAttribute('data-board-card') ?? `${to.x}:${to.y}`}`;
  const tail = weightTail(root, ghost, arrived, key, weight);
  ghost.setAttribute(CAST_LIFT_ATTR, 'parked');
  ghost.style.left = `${from.x}px`;
  ghost.style.top = `${from.y}px`;
  if (!ghost.isConnected) (root.querySelector('.board') ?? (root as Element)).appendChild(ghost);
  // The start — its point and the size it is drawn at, in px, so the shrink has two lengths to run
  // between — has to be a painted style before the end replaces it, or there is no transition to run.
  const start = ghost.getBoundingClientRect();
  const drawn = start.width > 0 && start.height > 0;
  const landing = {
    from: drawn ? { x: start.left + start.width / 2, y: start.top + start.height / 2 } : from,
    to,
    shrink: drawn ? start.width - size.width : 0,
  };
  // The weight's own hang-and-drop keeps the ghost (and so `arrived`, hidden under it) a moment
  // longer: never finish before that tail has played.
  const finish = (): void => {
    ghost.remove();
    if (id !== null) clearCastLift(root, id);
    arrived.removeAttribute(CAST_LANDING_ATTR);
  };
  const sameSize = !drawn || (Math.abs(start.width - size.width) < IN_PLACE_PX && Math.abs(start.height - size.height) < IN_PLACE_PX);
  if (Math.hypot(to.x - from.x, to.y - from.y) < IN_PLACE_PX && sameSize) {
    if (tail !== null) {
      arrived.setAttribute(CAST_LANDING_ATTR, '');
      void tail().then(finish);
    } else finish();
    return { how: 'swap', ...landing };
  }
  arrived.setAttribute(CAST_LANDING_ATTR, '');
  if (drawn) {
    ghost.style.width = `${start.width}px`;
    ghost.style.height = `${start.height}px`;
  }
  void ghost.getBoundingClientRect();
  floatCastLiftHome(
    root,
    id,
    to,
    () => {
      if (tail !== null) void tail().then(finish);
      else finish();
    },
    ghost,
  );
  // It shrinks to the size it will have in the row on the way there. A tapped
  // card's box is the card turned on its side, so its sides are swapped back:
  // the stand-in stays upright for the whole trip.
  if (box.width > 0 && box.height > 0) {
    ghost.style.width = `${size.width}px`;
    ghost.style.height = `${size.height}px`;
  }
  return { how: 'flight', ...landing };
}

/** Every lift away, whoever it belonged to — on dispose, so a board left behind carries none, and every pending float-back timer with it. */
export function clearAllCastLifts(root: ParentNode): void {
  for (const { timer } of returnTimers.values()) clearTimeout(timer);
  returnTimers.clear();
  for (const el of root.querySelectorAll<HTMLElement>(`[${CAST_LIFT_ATTR}]`)) {
    el.removeAttribute(CAST_LIFT_ATTR);
    el.style.removeProperty('left');
    el.style.removeProperty('top');
  }
  for (const ghost of root.querySelectorAll(`[${CAST_GHOST_ATTR}]`)) ghost.remove();
  for (const el of root.querySelectorAll(`[${CAST_LANDING_ATTR}]`)) el.removeAttribute(CAST_LANDING_ATTR);
}

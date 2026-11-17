/**
 * The mana ring opens only on a release that crossed no drag (the operator, on Abzan Devotee:
 * "should not pop up the mana ability when i'm trying to drag it. only on mouse up should it
 * appear and only if it wasn't dragged." Ruling the same day: "not just on release, but also only
 * if on release and no drag happened. and yes, everything. this feature is annoying because
 * otherwise theres no way to drag cards." Retires the old press-drag-release for every mana
 * source, lands included.) The gestures layer (`gestures/install.ts`) tracks a press on a mana
 * source WITHOUT claiming it, so a press on an arrangeable permanent still starts `Board.tsx`'s own
 * reorder-drag exactly as a card with no mana choice would; it opens the ring itself only once that
 * same pointer lets go having never crossed the drag slop.
 *
 * A pick sends the source's click with the pick as its intent (`match.manaIntent`), which answers
 * Forge's ability and colour questions as they come (`./mana-ring.ts`'s `intentReply`). The ring
 * stays up, held, until Forge's own question for it arrives and takes it over: one ring, where the
 * tap was (the operator: "let's make sure it only displays once").
 */

import { clickCard, type LiveMatch } from './match.ts';
import { intentOf, pressRing, type Ring, type RingAnswer } from './mana-ring.ts';
import type { PressPoint } from './movable.tsx';

export interface ManaPress {
  readonly source: number;
  readonly ring: Ring;
  /** Where the tap was: the ring stands there. */
  readonly at: PressPoint;
}

/** Raised on `window` whenever the held ring opens or closes. */
export const MANA_PRESS_EVENT = 'cardtable:mana-press';

/**
 * How long a tap's ring is held for Forge's question, in ms; and how long after it closed a ring
 * Forge opens late still stands where the tap was, without blooming again.
 */
const HOLD_MS = 3000;

const held = new WeakMap<LiveMatch, ManaPress>();
const closed = new WeakMap<LiveMatch, { readonly at: PressPoint; readonly when: number }>();

const changed = (): void => {
  window.dispatchEvent(new Event(MANA_PRESS_EVENT));
};

/** A tap's ring while it waits for Forge's question. */
export function heldManaPress(match: LiveMatch): ManaPress | null {
  return held.get(match) ?? null;
}

/** The ring a tap on `source` would draw now, or null when the offer gives it no choice to draw. */
export function pressRingFor(match: LiveMatch, source: number): Ring | null {
  const abilities = match.manaRings?.get(source);
  return abilities === undefined ? null : pressRing(abilities);
}

function close(match: LiveMatch, press: ManaPress): void {
  held.delete(match);
  closed.set(match, { at: press.at, when: performance.now() });
  changed();
}

/** The held ring is done: Forge's question took it over, or another question came instead, or it was given up. */
export function releaseHeldPress(match: LiveMatch): void {
  const press = held.get(match);
  if (press !== undefined) close(match, press);
}

/** Where a ring opening now stands, when a tap's ring just closed there: it does not bloom again. */
export function echoOfManaPress(match: LiveMatch): PressPoint | null {
  const last = closed.get(match);
  return last !== undefined && performance.now() - last.when < HOLD_MS ? last.at : null;
}

/**
 * A release with no drag: the source's click, as a click on it always was. When the offer gives it
 * a choice, the ring opens there, held, for Forge's question to take over.
 */
export function tapManaPress(match: LiveMatch, source: number, at: PressPoint): void {
  const ring = pressRingFor(match, source);
  clickCard(match, source);
  if (ring === null) return;
  const press: ManaPress = { source, ring, at };
  held.set(match, press);
  changed();
  setTimeout(() => {
    if (held.get(match) === press) releaseHeldPress(match);
  }, HOLD_MS);
}

/** A pick on a held ring, before Forge's question arrived: the click is out, so the pick rides as its intent. */
export function pickHeldPress(match: LiveMatch, source: number, answer: RingAnswer): void {
  releaseHeldPress(match);
  match.manaIntent = intentOf(answer, source);
}

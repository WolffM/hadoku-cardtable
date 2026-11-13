/**
 * The mana ring drawn on a press, before anything is sent (the operator, 2026-11-06: press a mana
 * source, drag to a disc, let go on it; "the regular tap should also work"). The gestures layer
 * (`gestures/install.ts`) opens it on the press and resolves the release; `ManaRings` draws it.
 *
 * A pick sends the source's click with the pick as its intent (`match.manaIntent`), which answers
 * Forge's ability and colour questions as they come (`./mana-ring.ts`'s `intentReply`). A release on
 * nothing sends nothing. A tap that never left the press sends the click alone, as before, and the
 * ring stays up, held, until Forge's own question for it arrives and takes it over: one ring, where
 * the press was, from the press to the pick (the operator, 2026-11-08: "let's make sure it only
 * displays once").
 */

import { clickCard, selectCard, type LiveMatch } from './match.ts';
import { intentOf, pressRing, type Ring, type RingAnswer } from './mana-ring.ts';
import type { PressPoint } from './movable.tsx';

export interface ManaPress {
  readonly source: number;
  readonly ring: Ring;
  /** Where the press was: the ring stands there, and so does the ring Forge's question takes it over as. */
  readonly at: PressPoint;
}

/** Raised on `window` whenever the press's ring opens, is held, or closes. */
export const MANA_PRESS_EVENT = 'cardtable:mana-press';

/**
 * How long a tap's ring is held for Forge's question, in ms; and how long after it closed a ring Forge
 * opens late still stands where the press was, without blooming again.
 */
const HOLD_MS = 3000;

const open = new WeakMap<LiveMatch, ManaPress>();
const held = new WeakMap<LiveMatch, ManaPress>();
const closed = new WeakMap<LiveMatch, { readonly at: PressPoint; readonly when: number }>();

const changed = (): void => {
  window.dispatchEvent(new Event(MANA_PRESS_EVENT));
};

/** The press's ring while the press is down. */
export function manaPressOf(match: LiveMatch): ManaPress | null {
  return open.get(match) ?? null;
}

/** A tap's ring while it waits for Forge's question. */
export function heldManaPress(match: LiveMatch): ManaPress | null {
  return held.get(match) ?? null;
}

/** The ring a press on `source` draws now, or null when the offer gives it no choice to draw. */
export function pressRingFor(match: LiveMatch, source: number): Ring | null {
  const abilities = match.manaRings?.get(source);
  return abilities === undefined ? null : pressRing(abilities);
}

export function openManaPress(match: LiveMatch, press: ManaPress): void {
  held.delete(match);
  open.set(match, press);
  changed();
}

function close(match: LiveMatch, from: WeakMap<LiveMatch, ManaPress>): void {
  const press = from.get(match);
  if (press === undefined) return;
  from.delete(match);
  closed.set(match, { at: press.at, when: performance.now() });
  changed();
}

export function closeManaPress(match: LiveMatch): void {
  close(match, open);
}

/** The held ring is done: Forge's question took it over, or another question came instead, or it was given up. */
export function releaseHeldPress(match: LiveMatch): void {
  close(match, held);
}

/** Where a ring opening now stands, when a press's ring just closed there: it does not bloom again. */
export function echoOfManaPress(match: LiveMatch): PressPoint | null {
  const last = closed.get(match);
  return last !== undefined && performance.now() - last.when < HOLD_MS ? last.at : null;
}

/** A tap that never left the press: the source's click, as a click on it always was; its ring is held for Forge's question. */
export function tapManaPress(match: LiveMatch, source: number): void {
  const press = open.get(match);
  open.delete(match);
  clickCard(match, source);
  if (press === undefined) return;
  held.set(match, press);
  changed();
  setTimeout(() => {
    if (held.get(match) === press) releaseHeldPress(match);
  }, HOLD_MS);
}

/** A pick on the press's ring: the source's click, carrying the pick. */
export function pickManaPress(match: LiveMatch, source: number, answer: RingAnswer): void {
  closeManaPress(match);
  const intent = intentOf(answer, source);
  if (intent === null) return;
  match.manaIntent = intent;
  if (!selectCard(match, source)) match.manaIntent = null;
}

/** A pick on a held ring, before Forge's question arrived: the click is out, so the pick rides as its intent. */
export function pickHeldPress(match: LiveMatch, source: number, answer: RingAnswer): void {
  releaseHeldPress(match);
  match.manaIntent = intentOf(answer, source);
}

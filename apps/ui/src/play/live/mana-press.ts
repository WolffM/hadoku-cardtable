/**
 * The mana ring drawn on a press, before anything is sent (the operator, 2026-11-06: press a mana
 * source, drag to a disc, let go on it; "the regular tap should also work"). The gestures layer
 * (`gestures/install.ts`) opens it on the press and resolves the release; `ManaPressRing` draws it.
 *
 * A pick sends the source's click with the pick as its intent (`match.manaIntent`), which answers
 * Forge's ability and colour questions as they come (`./mana-ring.ts`'s `intentReply`). A release on
 * nothing sends nothing. A tap that never left the press sends the click alone, as before, and Forge's
 * own ring opens where the press's stood without blooming again.
 */

import { clickCard, selectCard, type LiveMatch } from './match.ts';
import { intentOf, pressRing, type Ring, type RingAnswer } from './mana-ring.ts';

export interface ManaPress {
  readonly source: number;
  readonly ring: Ring;
}

/** Raised on `window` whenever the press's ring opens or closes. */
export const MANA_PRESS_EVENT = 'cardtable:mana-press';

/** How long after a tap's ring closed Forge's own ring for it opens still, in ms. */
const ECHO_MS = 1500;

const open = new WeakMap<LiveMatch, ManaPress>();
const closedAt = new WeakMap<LiveMatch, number>();

export function manaPressOf(match: LiveMatch): ManaPress | null {
  return open.get(match) ?? null;
}

/** The ring a press on `source` draws now, or null when the offer gives it no choice to draw. */
export function pressRingFor(match: LiveMatch, source: number): Ring | null {
  const abilities = match.manaRings?.get(source);
  return abilities === undefined ? null : pressRing(abilities);
}

export function openManaPress(match: LiveMatch, press: ManaPress): void {
  open.set(match, press);
  window.dispatchEvent(new Event(MANA_PRESS_EVENT));
}

export function closeManaPress(match: LiveMatch): void {
  if (!open.delete(match)) return;
  closedAt.set(match, performance.now());
  window.dispatchEvent(new Event(MANA_PRESS_EVENT));
}

/** Whether a ring opening now stands where the press's ring just stood: it does not bloom again. */
export function echoesManaPress(match: LiveMatch): boolean {
  const at = closedAt.get(match);
  return at !== undefined && performance.now() - at < ECHO_MS;
}

/** A tap that never left the press: the source's click, as a click on it always was. */
export function tapManaPress(match: LiveMatch, source: number): void {
  closeManaPress(match);
  clickCard(match, source);
}

/** A pick on the press's ring: the source's click, carrying the pick. */
export function pickManaPress(match: LiveMatch, source: number, answer: RingAnswer): void {
  closeManaPress(match);
  const intent = intentOf(answer, source);
  if (intent === null) return;
  match.manaIntent = intent;
  if (!selectCard(match, source)) match.manaIntent = null;
}

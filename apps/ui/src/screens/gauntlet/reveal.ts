/*
 * The Gauntlet's reveal, as a clock: the format title lands, then the room's coin flips for P1
 * (`CoinToss.tsx`, its own `FLIP_MS`), then the ten decks deal into the pool one by one.
 *
 * The clock is the server's: it starts at the view's `revealAt` and lasts `GAUNTLET_REVEAL_MS`,
 * when the server opens the first ban. Every beat below is cut from that one length, so the last
 * deck lands as the first ban opens, a screen opening mid-reveal joins it where it is, and one
 * opening after it draws the end state.
 */
import { useEffect, useState } from 'react';

import { GAUNTLET_DECKS, GAUNTLET_REVEAL_MS } from '@hadoku/shared';

import { FLIP_MS } from '../../play/live/CoinToss.tsx';
import { GLIDE_MS, prefersReducedMotion } from '../../play/motion.ts';

/** The title's landing, before the coin. */
export const TITLE_MS = Math.round(GAUNTLET_REVEAL_MS * 0.15);
/** The landed coin stays this long, so P1 is read before the decks come. */
export const COIN_HOLD_MS = Math.round(GAUNTLET_REVEAL_MS * 0.08);
/** One deck's flight into its slot (`gauntlet.css` reads it as `--deal-ms`). */
export const DEAL_MS = GLIDE_MS * 2;
/** The first deal: the coin has landed and been read. */
export const DEAL_FROM_MS = TITLE_MS + FLIP_MS + COIN_HOLD_MS;
/** Between one deck dealt and the next: what is left of the reveal, shared out so the last lands at its end. */
export const DEAL_STAGGER_MS = Math.floor((GAUNTLET_REVEAL_MS - DEAL_FROM_MS - DEAL_MS) / (GAUNTLET_DECKS - 1));

/** When deck `i` (in draw order) is dealt, from `revealAt`. */
export function dealtAt(i: number): number {
  return DEAL_FROM_MS + i * DEAL_STAGGER_MS;
}

export interface RevealStage {
  /** The coin is drawn: from the title's landing until the first deal. */
  coin: boolean;
  /** How many decks have been dealt, in draw order. */
  dealt: number;
  done: boolean;
}

export const REVEALED: RevealStage = { coin: false, dealt: GAUNTLET_DECKS, done: true };

export function revealStage(elapsed: number): RevealStage {
  if (elapsed >= GAUNTLET_REVEAL_MS) return REVEALED;
  const dealt = elapsed < DEAL_FROM_MS ? 0 : Math.min(GAUNTLET_DECKS, Math.floor((elapsed - DEAL_FROM_MS) / DEAL_STAGGER_MS) + 1);
  return { coin: elapsed >= TITLE_MS && elapsed < DEAL_FROM_MS, dealt, done: false };
}

/** The next moment, after `elapsed`, at which the stage changes. */
function nextChange(elapsed: number): number | null {
  if (elapsed < TITLE_MS) return TITLE_MS;
  if (elapsed < DEAL_FROM_MS) return DEAL_FROM_MS;
  const next = dealtAt(Math.floor((elapsed - DEAL_FROM_MS) / DEAL_STAGGER_MS) + 1);
  if (next <= dealtAt(GAUNTLET_DECKS - 1)) return next;
  return elapsed < GAUNTLET_REVEAL_MS ? GAUNTLET_REVEAL_MS : null;
}

export interface RevealClock extends RevealStage {
  /** Where the reveal was when this screen first drew it — a tile dealt before then joins its flight part-way. */
  joinedAt: number;
}

/**
 * The reveal's stage on this screen, from the server's `revealAt`. No reveal (before the draw), a
 * reveal already over, or a viewer who asked for less motion: the end state.
 */
export function useReveal(revealAt: number | null): RevealClock {
  const playing = revealAt !== null && !prefersReducedMotion();
  const elapsed = playing ? Date.now() - revealAt : GAUNTLET_REVEAL_MS;
  const [joinedAt] = useState(elapsed);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const at = nextChange(Date.now() - revealAt);
    if (at === null) return;
    const timer = setTimeout(() => tick((n) => n + 1), Math.max(0, revealAt + at - Date.now()));
    return () => clearTimeout(timer);
  });
  return { ...revealStage(elapsed), joinedAt };
}

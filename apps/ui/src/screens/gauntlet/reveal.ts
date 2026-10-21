/*
 * The Gauntlet's reveal, as a clock: the format title lands, then the room's coin flips for P1
 * (`CoinToss.tsx`, its own `FLIP_MS`), then the ten decks deal into the pool one by one.
 * Everything the screen draws during the reveal is a function of the time since it began, so a
 * test and the screen read the same table.
 */
import { useEffect, useState } from 'react';

import { FLIP_MS } from '../../play/live/CoinToss.tsx';
import { GLIDE_MS, prefersReducedMotion } from '../../play/motion.ts';

/** The title's landing, before the coin. */
export const TITLE_MS = 900;
/** Between one deck dealt and the next. */
export const DEAL_STAGGER_MS = 220;
/** One deck's flight into its slot (`gauntlet.css` reads it as `--deal-ms`). */
export const DEAL_MS = GLIDE_MS * 2;
/** How many decks a reveal deals. */
const DECKS = 10;
/** The landed coin stays this long, so P1 is read before the decks come. */
export const COIN_HOLD_MS = 700;
/** The first deal: the coin has landed and been read. */
export const DEAL_FROM_MS = TITLE_MS + FLIP_MS + COIN_HOLD_MS;
/** The whole reveal: the last deck has landed. */
export const REVEAL_MS = DEAL_FROM_MS + (DECKS - 1) * DEAL_STAGGER_MS + DEAL_MS;

export interface RevealStage {
  /** The coin is drawn: from the title's landing until the first deal. */
  coin: boolean;
  /** How many decks have been dealt, in draw order. */
  dealt: number;
  done: boolean;
}

export const REVEALED: RevealStage = { coin: false, dealt: DECKS, done: true };

export function revealStage(elapsed: number): RevealStage {
  if (elapsed >= REVEAL_MS) return REVEALED;
  const dealt = elapsed < DEAL_FROM_MS ? 0 : Math.min(DECKS, Math.floor((elapsed - DEAL_FROM_MS) / DEAL_STAGGER_MS) + 1);
  return { coin: elapsed >= TITLE_MS && elapsed < DEAL_FROM_MS, dealt, done: false };
}

/** The moments the stage changes, after `elapsed`. */
function nextChange(elapsed: number): number | null {
  if (elapsed < TITLE_MS) return TITLE_MS;
  if (elapsed < DEAL_FROM_MS) return DEAL_FROM_MS;
  const sinceDeal = elapsed - DEAL_FROM_MS;
  const nextDeal = DEAL_FROM_MS + (Math.floor(sinceDeal / DEAL_STAGGER_MS) + 1) * DEAL_STAGGER_MS;
  if (nextDeal <= DEAL_FROM_MS + (DECKS - 1) * DEAL_STAGGER_MS) return nextDeal;
  return elapsed < REVEAL_MS ? REVEAL_MS : null;
}

/**
 * The reveal's stage on this screen. It plays from the moment the screen first sees the Gauntlet
 * in its `reveal` phase; a screen that arrives later (a reload during ban/pick), or a viewer who
 * asked for less motion, gets the end state at once.
 */
export function useReveal(revealing: boolean): RevealStage & { startedAt: number | null } {
  const [startedAt, setStartedAt] = useState<number | null>(() => (revealing && !prefersReducedMotion() ? Date.now() : null));
  const [, tick] = useState(0);
  useEffect(() => {
    if (revealing && startedAt === null && !prefersReducedMotion()) setStartedAt(Date.now());
  }, [revealing, startedAt]);
  const elapsed = startedAt === null ? REVEAL_MS : Date.now() - startedAt;
  const stage = revealStage(elapsed);
  useEffect(() => {
    if (startedAt === null) return;
    const at = nextChange(Date.now() - startedAt);
    if (at === null) return;
    const timer = setTimeout(() => tick((n) => n + 1), Math.max(0, startedAt + at - Date.now()));
    return () => clearTimeout(timer);
  });
  return { ...stage, startedAt };
}

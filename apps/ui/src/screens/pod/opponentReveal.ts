/*
 * A round's opponent, revealed: the round's title lands as a Gauntlet's era does (`../gauntlet/reveal.ts`),
 * my seat comes in, then the other seat with the room's game-start sound, and only then the step before
 * the game (the operator, 2026-10-23: *"when the game starts, we need an 'opponent reveal' animation"*,
 * *"something similar to how the reveal animation works in gauntlet showing you the format"*).
 *
 * Once per table per page, like the carry to it (`followTableOnce`): back on the table page by choice,
 * or a viewer who asked for less motion, draws the end state. The page follows into the table's game
 * only once the reveal is over, so a start that is quicker than it does not cut it short.
 */
import { useEffect, useState } from 'react';

import { prefersReducedMotion } from '../../play/motion.ts';
import { playRole } from '../../sound/index.ts';

/** The title's landing (`PodSeats.css` reads the beats below as custom properties). */
export const REVEAL_TITLE_MS = 600;
/** My seat comes in as the title settles. */
export const REVEAL_ME_AT_MS = 350;
/** The other seat lands: the reveal's beat, and its sound. */
export const REVEAL_THEM_AT_MS = 1000;
/** One seat's entrance. */
export const REVEAL_SEAT_MS = 500;
/** The step before the game, after the other seat has been read. */
export const REVEAL_MS = 1900;

const revealed = new Set<string>();

function fresh(tableId: string | null): tableId is string {
  return tableId !== null && !revealed.has(tableId) && !prefersReducedMotion();
}

/**
 * Whether `tableId`'s reveal is playing on this page; `null` (not a paired player's table) never plays
 * one. A table that becomes this player's after the first draw (the room read lands) starts it then.
 */
export function useOpponentReveal(tableId: string | null): boolean {
  const [playing, setPlaying] = useState<string | null>(() => (fresh(tableId) ? tableId : null));
  if (playing !== tableId && fresh(tableId)) setPlaying(tableId);
  useEffect(() => {
    if (playing === null) return;
    revealed.add(playing);
    const sound = setTimeout(() => playRole('g.game-start'), REVEAL_THEM_AT_MS);
    const done = setTimeout(() => setPlaying(null), REVEAL_MS);
    return () => {
      clearTimeout(sound);
      clearTimeout(done);
    };
  }, [playing]);
  return playing !== null && playing === tableId;
}

/** Tests: every table's reveal plays again. */
export function forgetOpponentsRevealed(): void {
  revealed.clear();
}

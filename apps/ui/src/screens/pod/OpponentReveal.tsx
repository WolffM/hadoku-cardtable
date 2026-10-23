/*
 * A round's opponent, revealed: "<me> vs <them>" lands as a Gauntlet's era does (`../gauntlet/reveal.ts`),
 * the two avatars rush in from either side and clash in the middle with the room's game-start sound,
 * spring back apart, and only then does the table page draw its seats and the step before the game
 * (the operator, 2026-10-23: *"when the game starts, we need an 'opponent reveal' animation"*, then
 * *"we dont need to reuse the existing seat UI here. instead can we have their avatars come in from the
 * side and clash? at the top show 'Hadoku vs Sage'"*).
 *
 * Once per table per page, like the carry to it (`followTableOnce`): back on the table page by choice,
 * or a viewer who asked for less motion, draws the end state. The page follows into the table's game
 * only once the reveal is over, so a start that is quicker than it does not cut it short.
 */
import { useEffect, useState, type CSSProperties } from 'react';

import { Avatar } from '../../components/Avatar.tsx';
import { prefersReducedMotion } from '../../play/motion.ts';
import { playRole } from '../../sound/index.ts';
import './OpponentReveal.css';

/** The title's landing. */
export const REVEAL_TITLE_MS = 600;
/** The avatars set off, as the title settles. */
export const REVEAL_RUSH_AT_MS = 300;
/** From setting off to the clash: half of a flight (`OpponentReveal.css`'s `opponent-reveal-fly`). */
export const REVEAL_RUSH_MS = 450;
/** The clash: the sound, the flash, the shake. */
export const REVEAL_CLASH_AT_MS = REVEAL_RUSH_AT_MS + REVEAL_RUSH_MS;
/** The stage gives way to the page. */
export const REVEAL_MS = 2200;
/** The stage's fade into the page, at its end. */
const REVEAL_FADE_MS = 250;

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
    const sound = setTimeout(() => playRole('g.game-start'), REVEAL_CLASH_AT_MS);
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

export interface RevealPlayer {
  name: string;
  avatarId: string | null;
}

/** The stage: mine on the left, theirs on the right, whichever seat each holds at the table. */
export function OpponentReveal({ me, them }: { me: RevealPlayer; them: RevealPlayer }) {
  const beats = {
    '--title-ms': `${REVEAL_TITLE_MS}ms`,
    '--rush-at': `${REVEAL_RUSH_AT_MS}ms`,
    '--clash-at': `${REVEAL_CLASH_AT_MS}ms`,
    '--fly-ms': `${REVEAL_RUSH_MS * 2}ms`,
    '--fade-at': `${REVEAL_MS - REVEAL_FADE_MS}ms`,
    '--fade-ms': `${REVEAL_FADE_MS}ms`,
  } as CSSProperties;
  const fighter = (p: RevealPlayer, side: 'left' | 'right', testId: string) => (
    <span className="opponent-reveal__fighter" data-side={side} data-testid={testId}>
      <Avatar id={p.avatarId} fallback="initial" name={p.name} className="opponent-reveal__avatar" fallbackClassName="opponent-reveal__avatar opponent-reveal__avatar--none" />
    </span>
  );
  return (
    <div className="opponent-reveal" data-testid="opponent-reveal" style={beats}>
      <h2 className="opponent-reveal__title" data-testid="opponent-reveal-title">
        <span>{me.name}</span>
        <span className="opponent-reveal__vs">vs</span>
        <span>{them.name}</span>
      </h2>
      <div className="opponent-reveal__arena" aria-hidden="true">
        {fighter(me, 'left', 'opponent-reveal-me')}
        <span className="opponent-reveal__clash" />
        {fighter(them, 'right', 'opponent-reveal-them')}
      </div>
    </div>
  );
}

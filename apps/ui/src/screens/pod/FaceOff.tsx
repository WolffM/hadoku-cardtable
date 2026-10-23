/*
 * A table's two players, face to face: "<left> vs <right>" across the top, their avatars apart with the
 * series' score between them, each seat's Ready under its avatar.
 *
 * The first time a round's player reaches their table it plays as a reveal: the title lands as a
 * Gauntlet's era does (`../gauntlet/reveal.ts`), the avatars rush in from either side, clash in the
 * middle with the room's game-start sound, and bounce apart to where they then stay; the page's Ready
 * and the step before the game come in under them after (the operator, 2026-10-23: *"when the game
 * starts, we need an 'opponent reveal' animation"*, then *"have their avatars come in from the side and
 * clash? at the top show 'Hadoku vs Sage'"*, then *"let's not snap back to the old ready ui afterwards.
 * have them bounce off eachother then show the ready button underneath"*).
 *
 * Once per table per page, like the carry to it (`followTableOnce`): back on the table page by choice,
 * a watcher, or a viewer who asked for less motion, sees it at rest. The page follows into the table's
 * game only once the reveal is over, so a start that is quicker than it does not cut it short.
 */
import { useEffect, useState, type CSSProperties } from 'react';

import { Avatar } from '../../components/Avatar.tsx';
import { StatusPill } from '../../components/StatusPill.tsx';
import { prefersReducedMotion } from '../../play/motion.ts';
import { playRole } from '../../sound/index.ts';
import './FaceOff.css';

/** The title's landing. */
export const REVEAL_TITLE_MS = 600;
/** The avatars set off, as the title settles. */
export const REVEAL_RUSH_AT_MS = 300;
/** From setting off to the clash: half of a flight (`FaceOff.css`'s `face-off-fly`). */
export const REVEAL_RUSH_MS = 450;
/** The clash: the sound, the flash, the shake. */
export const REVEAL_CLASH_AT_MS = REVEAL_RUSH_AT_MS + REVEAL_RUSH_MS;
/** Both at rest, apart: the score and the Readys come in. */
export const REVEAL_REST_AT_MS = REVEAL_CLASH_AT_MS + REVEAL_RUSH_MS;
/** The page's own step comes in under the two. */
export const REVEAL_MS = REVEAL_REST_AT_MS + 200;

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

export interface FaceOffSeat {
  /** The table seat, which the series' wins and the seats' Ready are counted by. */
  seat: number;
  name: string;
  avatarId: string | null;
  wins: number;
  /** Its Ready, while the table's start waits on it. */
  ready?: boolean;
  mine: boolean;
}

export interface FaceOffProps {
  left: FaceOffSeat;
  right: FaceOffSeat;
  /** A series of more than one game: the score between them. */
  scored: boolean;
  /** Playing as the reveal; otherwise drawn at rest. */
  revealing: boolean;
}

export function FaceOff({ left, right, scored, revealing }: FaceOffProps) {
  const beats = {
    '--title-ms': `${REVEAL_TITLE_MS}ms`,
    '--rush-at': `${REVEAL_RUSH_AT_MS}ms`,
    '--clash-at': `${REVEAL_CLASH_AT_MS}ms`,
    '--rest-at': `${REVEAL_REST_AT_MS}ms`,
    '--fly-ms': `${REVEAL_RUSH_MS * 2}ms`,
  } as CSSProperties;
  const fighter = (p: FaceOffSeat, side: 'left' | 'right') => (
    <li className="face-off__fighter" data-side={side} data-mine={p.mine ? '' : undefined} data-testid={`table-seat-${p.seat}`}>
      <Avatar id={p.avatarId} fallback="initial" name={p.name} className="face-off__avatar" fallbackClassName="face-off__avatar face-off__avatar--none" />
      <span className="face-off__name">{p.name}</span>
      {p.ready !== undefined && (
        <span className="face-off__ready">
          <StatusPill testId={`table-seat-${p.seat}-ready`} state={p.ready ? 'yes' : 'no'} mark={p.ready ? 'tick' : 'ring'} label={p.ready ? 'ready' : 'not ready'} />
        </span>
      )}
    </li>
  );
  return (
    <div className="face-off" data-testid="table-seats" data-revealing={revealing || undefined} style={beats}>
      <h2 className="face-off__title" data-testid="face-off-title">
        <span>{left.name}</span>
        <span className="face-off__vs">vs</span>
        <span>{right.name}</span>
      </h2>
      <ul className="face-off__arena">
        {fighter(left, 'left')}
        <li className="face-off__clash" aria-hidden="true" />
        {scored && (
          <li className="face-off__score" aria-label={`${left.wins} to ${right.wins}`}>
            <span data-testid={`table-seat-${left.seat}-wins`}>{left.wins}</span>
            <span aria-hidden="true">–</span>
            <span data-testid={`table-seat-${right.seat}-wins`}>{right.wins}</span>
          </li>
        )}
        {fighter(right, 'right')}
      </ul>
    </div>
  );
}

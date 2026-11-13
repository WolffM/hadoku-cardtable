/*
 * "Your turn", for a moment, as your turn begins — the operator, 2026-10-14: *"'your turn' pop up on
 * the screen"*. The edge light (`board.css`'s `.seat[data-active]`) says whose turn it is for the
 * whole turn; this says that it has just become yours, once, and goes. It sits on the centre line
 * between the two seats, clear of the hand and the controls, takes no pointer, and fades out on its
 * own (`live.css`); reduced motion keeps the fade and drops the movement.
 *
 * Only a turn this screen saw begin: the first turn a screen sees of a match is never cued, so a
 * reload or a late join mid-turn does not announce a turn already under way, while the pregame
 * (turn 0) to turn 1 is a start like any other. A turn number going DOWN is the next game of the
 * match beginning, and every turn of that game is seen begin. The turn number and the active player
 * can land in separate deltas, in either order, so the cue keys on the pair — your turn, and a turn
 * number higher than any this screen saw someone else hold — never on the order they arrive in. Forge
 * hands the turn over at the last turn's cleanup (`PhaseHandler`'s CLEANUP), a delta before the turn
 * number moves: the turn just ended is never cued as yours.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';

import type { BoardView } from '../adapter.ts';

/** How long the cue stays up; `live.css`'s `--turn-cue-ms` spends it on a fade in, a hold and a fade out. */
export const TURN_CUE_MS = 1200;

/** What one match's screen has seen of its turns. */
interface Seen {
  match: string;
  /** Turns up to this one were under way when the screen first saw them. */
  first: number;
  /** The last turn cued, so a delta repeating it cues nothing. */
  cued: number | null;
  previous: number;
  /** The highest turn number seen while it was someone else's turn: a turn handed over is cued only once its number passes this. */
  theirs: number;
}

/** The turn being cued, while the cue is up; null otherwise. */
export function useYourTurnCue(view: BoardView | null, enabled: boolean, matchId: string): number | null {
  const seen = useRef<Seen | null>(null);
  const [cue, setCue] = useState<number | null>(null);
  const turn = view?.turn ?? null;
  const yours = view?.players.some((p) => p.isViewer && p.id === view.activePlayerId) === true;

  useEffect(() => {
    if (turn === null) return;
    let s = seen.current;
    if (s === null || s.match !== matchId) {
      s = { match: matchId, first: turn, cued: null, previous: turn, theirs: -1 };
      seen.current = s;
    } else if (turn < s.previous) {
      s.first = -1;
      s.cued = null;
      s.theirs = -1;
    }
    s.previous = turn;
    if (!yours) s.theirs = Math.max(s.theirs, turn);
    if (!enabled || !yours || turn <= s.first || turn <= s.theirs || turn === s.cued) return;
    s.cued = turn;
    setCue(turn);
  }, [turn, yours, enabled, matchId]);

  useEffect(() => {
    if (cue === null) return;
    const timer = setTimeout(() => setCue(null), TURN_CUE_MS);
    return () => clearTimeout(timer);
  }, [cue]);

  return cue;
}

export function TurnCue({ turn }: { turn: number }) {
  return (
    <p className="live__turn-cue" data-testid="turn-cue" data-turn={turn} role="status" style={{ '--turn-cue-ms': `${TURN_CUE_MS}ms` } as CSSProperties}>
      Your turn
    </p>
  );
}

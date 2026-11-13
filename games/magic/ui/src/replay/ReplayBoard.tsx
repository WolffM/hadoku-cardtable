/*
 * A replay's board: `LiveBoard` over the player's read-only match, drawn afresh on every seek
 * (`ReplayClock.seeks`). A seek is a new board, not a move from the last one, so nothing animates
 * across the jump: a motion layer that holds a card for a beat the jump skipped (a resolved spell kept
 * out of its graveyard until its effects play) would otherwise keep holding it.
 */

import { useSyncExternalStore } from 'react';

import { LiveBoard } from '../play/live/LiveBoard.tsx';
import type { LiveMatch } from '../play/live/match.ts';
import type { ReplayClock } from './player.ts';

export function ReplayBoard({ match, clock }: { match: LiveMatch; clock: ReplayClock }) {
  const seeks = useSyncExternalStore(clock.subscribe, clock.seeks);
  return <LiveBoard key={seeks} match={match} roomId={null} />;
}

/**
 * Into a match the room has just started, with its `g.match-start` sound (the
 * operator, 2026-10-11: *"a 'start of game' sound that plays before the
 * coinflip … when both players are ready and the room is initiated"*).
 *
 * It sounds here, at the hand-off from the room (both ready, Start, Rematch,
 * a bot game) and not on the match screen, because only this moment knows the
 * match is new: a reload or a rejoin opens the same screen on a match already
 * under way. Once per match on this page, however many paths ask (the starting
 * screen's own answer and its follow of the room's `matchId` both arrive).
 */
import { navigate } from '../../screens/route.ts';
import { playRole } from '../../sound/index.ts';

const sounded = new Set<string>();

export function openNewMatch(matchId: string): void {
  if (!sounded.has(matchId)) {
    sounded.add(matchId);
    playRole('g.match-start');
  }
  navigate({ kind: 'match', matchId });
}

/** Whether this page sounded the match's start, for the match's own sound telemetry. */
export function matchStartSounded(matchId: string): boolean {
  return sounded.has(matchId);
}

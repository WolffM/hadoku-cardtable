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
/** Every match this page has been carried into, by a room or a start. */
const followed = new Set<string>();

/**
 * A room carries its players into a match ONCE (the operator, 2026-10-19: *"the
 * initial force into the game should only happen once when the game starts"*):
 * whoever goes back to the room from it stays there, and goes back in from the
 * room's own link. A reload is a new page, and is carried in once again.
 */
export function followMatchOnce(matchId: string, isNew: boolean): void {
  if (followed.has(matchId)) return;
  if (isNew) openNewMatch(matchId);
  else {
    followed.add(matchId);
    navigate({ kind: 'match', matchId });
  }
}

export function openNewMatch(matchId: string): void {
  followed.add(matchId);
  if (!sounded.has(matchId)) {
    sounded.add(matchId);
    playRole('g.match-start');
  }
  navigate({ kind: 'match', matchId });
}

/** A fresh page's memory — what each test stands for. */
export function forgetMatchesFollowed(): void {
  followed.clear();
}

/** Whether this page sounded the match's start, for the match's own sound telemetry. */
export function matchStartSounded(matchId: string): boolean {
  return sounded.has(matchId);
}

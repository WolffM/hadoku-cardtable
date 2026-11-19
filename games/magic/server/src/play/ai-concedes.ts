/**
 * A testing room's AI opponent gives every game up at the start of its second turn (the operator,
 * 2026-11-19: *"opponent concedes after turn1 … that way i can see all of it"*), so one person can
 * walk a whole series, its sideboarding and the rounds after it, in minutes. The option is the
 * room's (`room/lobby.ts`'s `CreateRoomInput.aiConcedes`, kept only on a `testing` room), read each
 * time the game moves on: a match restored after a deploy still ends the same way.
 */
import type { Lobby } from '../room/lobby.js';
import type { Match } from './match.js';

/** The AI's own turn it gives up at the start of: it has played one whole turn, and so has the other seat. */
export const AI_CONCEDES_ON_ITS_TURN = 2;

/**
 * `MatchDeps.liveChanged`'s part in it. The concede is `defer`red out of the frame that told the
 * turn, which the match is still in the middle of reading.
 */
export function concedeForTestingRoom(
	match: Pick<Match, 'id' | 'aiTurn' | 'concedeAi'>,
	lobby: Pick<Lobby, 'aiConcedesIn'>,
	defer: (run: () => void) => void = setImmediate,
): void {
	const turn = match.aiTurn();
	if (turn === null || turn < AI_CONCEDES_ON_ITS_TURN || !lobby.aiConcedesIn(match.id)) return;
	defer(() => match.concedeAi());
}

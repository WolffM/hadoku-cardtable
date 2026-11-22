/**
 * Account erase's part in the live table (the operator's ruling, 2026-11-05):
 *
 * - A match they hold a seat in ends as their forfeit: conceded for their seat, so the opponent
 *   wins as they would from any concede (`endForfeitedGame`), or stopped when the seat cannot.
 * - A room where they are the only member is closed, as its owner closing it would.
 * - Any other room they are in, they leave by the room's own leave (leadership passes on; a
 *   tournament entrant's match is a drop).
 * - Every room that still names them afterwards (results, series, pairings) names their
 *   placeholder instead (`Lobby.anonymise`).
 *
 * The steps run in that order, so a room is never anonymised while they still sit in it.
 *
 * ## Account merge
 *
 * - A live match the merged-away account holds a seat in ends as that seat's forfeit, as an erase
 *   ends it. A live game binds its seats to the participant id inside the match (its sockets, the
 *   seat owners its recovery record keeps), and nothing carries a seat to another identity
 *   mid-game; leaving it running would only have the erase sweep that follows the merge forfeit it
 *   a moment later, after the room had already been moved to the kept account under it. A person
 *   merges by signing in to their real account, so their guest's game is one they just left.
 * - Every other room names the kept account instead (`Lobby.merge`): its seat, its series, its
 *   lead, the room itself when they were alone in it. Nothing is closed and nobody leaves.
 * - A room that already names the kept account (both accounts sat in it) is the kept account's:
 *   the merge leaves it, and the erase sweep closes, leaves and anonymises the merged-away
 *   account's place in it exactly as above.
 */

import type { ParticipantId } from '@wolffm/rooms-protocol';
import type { ErasedPerson, EraseStep, MergedAccounts } from './index.js';
import type { IdMove } from './anonymise.js';

export interface LiveMatch {
	seatOf(participantId: ParticipantId): number | null;
}

/** What this file reads off a room — `FileLobby.list()`'s own `RoomView[]` satisfies this structurally. */
interface RoomSummary {
	id: string;
	members: readonly { id: string }[];
}

/** `room/lobby.ts`'s own `LeaveResult`/`CloseRoomResult`, narrowed to what this file reads; `FileLobby` satisfies both structurally. */
type RoomsLeaveResult = { ok: true; forfeited?: { tableId: string; matchIds: string[] } } | { ok: false };
type RoomsCloseResult = { ok: true; matches: string[] } | { ok: false };

/** A narrow slice of `room/lobby.ts`'s `Lobby` — declared here, not imported, so this platform file carries no edge into the tangled lobby. */
interface RoomsLobby {
	list(): readonly RoomSummary[];
	leave(roomId: string, memberId: string): RoomsLeaveResult;
	close(roomId: string, callerId: string): RoomsCloseResult;
	anonymise(ids: ReadonlySet<string>, to: string): number;
	/** Account merge: every room naming the merged-away account, and not the kept one, names the kept one. */
	merge(move: IdMove): number;
	removed(): Promise<void>;
}

export interface RoomsEraseDeps<M extends LiveMatch> {
	lobby: RoomsLobby;
	/** Every match still being played. */
	liveMatches(): readonly M[];
	/** End a live match as `loser`'s forfeit (`table-actions.ts`'s `endForfeitedGame`). */
	forfeit(match: M, loser: ParticipantId): void;
	/** A room just closed: stop its matches and drop its draft (`index.ts`'s `roomClosed`). */
	closed(roomId: string, matches: readonly string[]): void;
	/** A tournament entrant's leave dropped them from a match: end its games (`http/rooms.ts`'s `forfeited`). */
	forfeited(roomId: string, tableId: string, loser: string, matches: readonly string[]): void;
}

/** The steps, in the order the module header gives. */
export function roomsEraseSteps<M extends LiveMatch>(deps: RoomsEraseDeps<M>): EraseStep[] {
	const forfeitAll = (participantId: ParticipantId): number => {
		let n = 0;
		for (const match of deps.liveMatches()) {
			if (match.seatOf(participantId) === null) continue;
			deps.forfeit(match, participantId);
			n++;
		}
		return n;
	};
	return [
		{
			what: 'matchesForfeited',
			erase: ({ participantId }: ErasedPerson) => forfeitAll(participantId),
			merge: ({ from }: MergedAccounts) => forfeitAll(from.participantId),
		},
		{
			what: 'roomsClosed',
			erase: async ({ participantId }: ErasedPerson) => {
				let n = 0;
				for (const room of deps.lobby.list()) {
					if (room.members.length !== 1 || room.members[0]?.id !== participantId) continue;
					const closed = deps.lobby.close(room.id, participantId);
					if (!closed.ok) continue;
					deps.closed(room.id, closed.matches);
					n++;
				}
				// A closed room's file names them until it is deleted: answer only once it is.
				await deps.lobby.removed();
				return n;
			},
			// A merge closes nothing: a room they were alone in moves to the kept account whole (`roomsMoved`).
			merge: () => ({}),
		},
		{
			what: 'roomsLeft',
			erase: ({ participantId }: ErasedPerson) => {
				let n = 0;
				for (const room of deps.lobby.list()) {
					if (!room.members.some((m) => m.id === participantId)) continue;
					const left = deps.lobby.leave(room.id, participantId);
					if (!left.ok) continue;
					if (left.forfeited !== undefined) deps.forfeited(room.id, left.forfeited.tableId, participantId, left.forfeited.matchIds);
					n++;
				}
				return n;
			},
			// A merge leaves nothing: their place moves to the kept account (`roomsMoved`), and a room the
			// kept account is already in is left to the erase sweep, which leaves it for them.
			merge: () => ({}),
		},
		{
			what: 'roomsAnonymised',
			erase: ({ ids, placeholder }: ErasedPerson) => deps.lobby.anonymise(ids, placeholder),
			merge: (accounts: MergedAccounts) => ({ roomsMoved: deps.lobby.merge(accounts) }),
		},
	];
}

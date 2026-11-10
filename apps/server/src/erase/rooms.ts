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
 */

import type { ParticipantId } from '@wolffm/rooms-protocol';
import type { ErasedPerson, EraseStep } from './index.js';

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
export interface RoomsLobby {
	list(): readonly RoomSummary[];
	leave(roomId: string, memberId: string): RoomsLeaveResult;
	close(roomId: string, callerId: string): RoomsCloseResult;
	anonymise(ids: ReadonlySet<string>, to: string): number;
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
	return [
		{
			what: 'matchesForfeited',
			erase: ({ participantId }: ErasedPerson) => {
				let n = 0;
				for (const match of deps.liveMatches()) {
					if (match.seatOf(participantId) === null) continue;
					deps.forfeit(match, participantId);
					n++;
				}
				return n;
			},
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
		},
		{ what: 'roomsAnonymised', erase: ({ ids, placeholder }: ErasedPerson) => deps.lobby.anonymise(ids, placeholder) },
	];
}

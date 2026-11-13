/**
 * A room's record as every game's room has it: who is in it, who leads it, which game it plays, who
 * holds each of that game's seats, and the game's own part, which this file never looks inside
 * (`docs/planning/room-record-generic.md`).
 *
 * The password's salt and hash are not here: a lobby keeps them beside the record, so nothing that
 * builds a view from a record can reach them. Ready is per member, in the membership ledger.
 */
import type { MembershipLedger } from '@wolffm/rooms-server';

import type { MemberRow } from './membership.ts';

/**
 * The holder of each game seat, by seat number: a member id, a marker the game type owns for a seat
 * no member holds (an AI's, a closed one), or null for an open seat. A member who holds no seat is
 * watching.
 */
export type GameSeats = (string | null)[];

/** What every member record has, whatever the game. */
export interface PlatformMember extends MemberRow {
	/** The registry userId. null for a member the edge named nobody. */
	userId: string | null;
	joinedAt: number;
	/** The member's own per-room state, opaque here (a deck choice, say). */
	state: unknown;
}

export interface PlatformRoomRecord<G, M extends PlatformMember = PlatformMember> {
	id: string;
	name: string;
	creator: string;
	/** Mirrors `ledger.leaderId`, kept non-null; it moves only when the leader leaves (`membership.ts`). */
	leader: string;
	gameType: string;
	/** A seeded, admin-only room: never swept (`room-list.ts`). */
	testing: boolean;
	/** When its event starts (`events.ts`). Absent for a room no event made. */
	scheduledFor?: number;
	createdAt: number;
	/** Last mutation, in ms. What the sweep ages a room out on. */
	updatedAt: number;
	members: M[];
	/** Membership, ready and leader. In memory only, rebuilt from `members` and `leader` on restore. */
	ledger: MembershipLedger;
	/** The game seats (`GameSeats`). */
	seats: GameSeats;
	/** The game type's own part of the record. */
	game: G;
}

/**
 * The seat `memberId` holds in the room's game, or null when they hold none (they are watching, or
 * not in the room). A seat whose holder is not a member counts as nobody's.
 */
export function gameSeatOf(room: Pick<PlatformRoomRecord<unknown>, 'seats' | 'members'>, memberId: string): number | null {
	if (!room.members.some((m) => m.id === memberId)) return null;
	const seat = room.seats.indexOf(memberId);
	return seat === -1 ? null : seat;
}

/** The game seats by seat number with every seat no member holds read as open. */
export function memberSeats(room: Pick<PlatformRoomRecord<unknown>, 'seats' | 'members'>): GameSeats {
	return room.seats.map((s) => (s !== null && room.members.some((m) => m.id === s) ? s : null));
}

/** `memberId` takes `seat`, giving up any other game seat they held. The caller has checked the seat is theirs to take. */
export function takeGameSeat(room: Pick<PlatformRoomRecord<unknown>, 'seats'>, memberId: string, seat: number): void {
	const seats = [...room.seats];
	const held = seats.indexOf(memberId);
	if (held !== -1) seats[held] = null;
	seats[seat] = memberId;
	room.seats = seats;
}

/** `memberId` gives their game seat back; it stays open. False when they held none. */
export function leaveGameSeat(room: Pick<PlatformRoomRecord<unknown>, 'seats'>, memberId: string): boolean {
	const held = room.seats.indexOf(memberId);
	if (held === -1) return false;
	room.seats = room.seats.map((s, i) => (i === held ? null : s));
	return true;
}

/** `seat` holds `holder` now: a seat marker the game owns, or null to open it. */
export function setGameSeat(room: Pick<PlatformRoomRecord<unknown>, 'seats'>, seat: number, holder: string | null): void {
	room.seats = room.seats.map((s, i) => (i === seat ? holder : s));
}

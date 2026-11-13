/**
 * The generic room-membership core: who is in a room, who leads it, whether a
 * member is ready, and whether a password opens it. Every mutator here works
 * on a GENERIC member/room shape — no `gameType`, pod, draft, format or
 * tournament field appears anywhere in this file — so it stays behind in
 * `games/magic/server/src/room/` when stage 2b moves the rest of `lobby.ts`'s Magic
 * content to `games/magic/server` (wave 110 §L, phase 2).
 *
 * Split out of `room/lobby.ts`'s `join`/`leave`/`setReady`/`viewOf`/`#persist`.
 * These wrap `@wolffm/rooms-server`'s `MembershipLedger` functions, which
 * already did the real work (leadership succession, readiness) — what moved
 * here is the GLUE: adding a member also means maybe inheriting the room's
 * leadership (an emptied room's new arrival leads it); removing one also
 * means maybe passing it on (whoever remains joined EARLIEST, R16).
 *
 * Every mutator mutates in place and returns nothing but what the caller
 * cannot otherwise observe — the same discipline `lobby.ts`'s own mutators
 * keep. The caller still owns persisting the result and anything about the
 * member's GAME state (a pod seat, a table, a series) — this file only ever
 * touches `members`, `leader` and `ledger`.
 */
import { addMember, memberLeft, isReady, setReady as ledgerSetReady, type MembershipLedger } from '@wolffm/rooms-server';

import { passwordMatches, type Secret } from './provisioning.ts';

/** The minimal shape a member record needs to be one, whatever game it plays. */
export interface MemberRow {
	id: string;
}

/** The minimal shape a room needs to carry generic membership. */
export interface MembershipRoom<M extends MemberRow> {
	members: M[];
	leader: string;
	ledger: MembershipLedger;
}

/** Whether `id` already holds a seat at the table, so to speak — already a member of the room. */
export function isRoomMember<M extends MemberRow>(room: Pick<MembershipRoom<M>, 'members'>, id: string): boolean {
	return room.members.some((m) => m.id === id);
}

/**
 * Add `member`, and give them the room's leadership exactly when the ledger
 * says the room was empty before they joined (`ledger.leaderId`'s own rule —
 * an emptied room's new arrival leads it). Mutates `room.members`,
 * `room.leader` and `room.ledger`. The caller still owns auto-seating them
 * and persisting the room.
 */
export function addRoomMember<M extends MemberRow>(room: MembershipRoom<M>, member: M, joinedAt: number): void {
	addMember(room.ledger, member.id, joinedAt);
	room.leader = room.ledger.leaderId ?? room.leader;
	room.members.push(member);
}

/**
 * Remove the member `id` — answers the removed row, or `undefined` when they
 * were never a member. If they held the room's leadership, it passes to
 * whoever remains joined EARLIEST (`memberLeft`'s own rule, R16); the last
 * member out leaves `room.leader` stale, for the caller's sweep to read.
 * Mutates `room.members`, `room.leader` and `room.ledger`. The caller still
 * owns anything about the leaving member's GAME state (a pod drop, a table
 * seat, a series) and persisting the room.
 */
export function removeRoomMember<M extends MemberRow>(room: MembershipRoom<M>, id: string): M | undefined {
	const index = room.members.findIndex((m) => m.id === id);
	if (index === -1) return undefined;
	const removed = room.members[index]!;
	room.members.splice(index, 1);
	const newLeader = memberLeft(room.ledger, id);
	if (newLeader !== null) room.leader = newLeader;
	return removed;
}

/** `memberId`'s readiness for whatever the room is about to start. */
export function isMemberReady(room: Pick<MembershipRoom<MemberRow>, 'ledger'>, memberId: string): boolean {
	return isReady(room.ledger, memberId);
}

/** Sets `memberId`'s readiness. The caller still owns every side effect a readiness change has on ITS game (a pod auto-seat, a tournament lock, …) and persisting the room. */
export function setMemberReady(room: Pick<MembershipRoom<MemberRow>, 'ledger'>, memberId: string, ready: boolean): void {
	ledgerSetReady(room.ledger, memberId, ready);
}

/**
 * Whether `password` opens a room sealed with `secret` — no secret at all
 * opens to anybody. The password is privacy between friends, not
 * authentication (`room/lobby.ts`'s own header): this is the one place that
 * reads as a refusal rather than a credential check.
 */
export function passwordAdmits(secret: Secret | undefined, password: string | undefined): boolean {
	return secret === undefined || passwordMatches(secret, password ?? '');
}

/**
 * The room-list projection and the idle-sweep rule — generic to every room,
 * whatever it plays: creation-order sorting, the front page's "worth
 * advertising" rule, and "has this room sat idle long enough to forget."
 *
 * Each rule has exactly one Magic-specific exception (a draft room stays
 * offered while dealing; a pod room's default idle window and its post-deal
 * grace are a tournament's own), reached through `RoomBusyHook` rather than
 * this file importing pods or drafts itself — the same hook pattern
 * `useGameType`/`onRelayRoomOpened` already use. A non-Magic room (bomberman's)
 * that wires no hook gets `NO_BUSY_HOOK`'s plain rule: no extra reason to stay
 * offered past staleness, the casual idle window, never spared.
 *
 * Split out of `room/lobby.ts`'s `list`/`offered`/`sweep` (wave 110 §L, phase 3).
 * Every function here is pure; the caller still owns persisting anything and
 * iterating its own room map.
 */

/** The minimal shape a room needs to be listed, offered or swept. */
export interface ListableRoom {
	id: string;
	createdAt: number;
	updatedAt: number;
	scheduledFor?: number;
	testing: boolean;
	members: { length: number };
	tables: readonly { matchId: string | null }[];
}

/**
 * The one seam `isOfferedRoom`/`isSweepableRoom` read a game's own busy-ness
 * through, rather than naming a game type's fields directly. `lobby.ts`
 * wires Magic's own (`usesPod`, `draftStartedAt`, `POD_SPARED_MS`,
 * `ROOM_IDLE_MS`, `CASUAL_ROOM_IDLE_MS`).
 */
export interface RoomBusyHook<R> {
	/** An extra reason — beyond a live match — `room` counts as busy enough to stay offered past `staleMs` (Magic: a draft under way). */
	extraOffered(room: R): boolean;
	/** The idle window `isSweepableRoom` uses when the caller gives none (Magic: a tournament's `ROOM_IDLE_MS`, else the casual one). */
	defaultIdleMs(room: R): number;
	/** Whether `room` is spared this sweep despite sitting past its idle window (Magic: a pod dealt within `POD_SPARED_MS`). */
	sparedFromSweep(room: R, now: number): boolean;
}

/** The plain rule: no extra reason to stay offered, an 8-hour idle window, never spared. What a room wires if its game has nothing extra to say. */
export const NO_BUSY_HOOK: RoomBusyHook<unknown> = {
	extraOffered: () => false,
	defaultIdleMs: () => 8 * 60 * 60_000,
	sparedFromSweep: () => false,
};

/** Creation order, with the (random) room id as a tie-break for two rooms made in the same millisecond — `list()`'s and `offered()`'s shared sort. */
export function sortRoomsByCreation<R extends { id: string; createdAt: number }>(rooms: readonly R[]): R[] {
	return [...rooms].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/**
 * Whether `room` belongs on the front page right now: a seeded testing room
 * always; an empty room never (R16 — hidden the instant its last member
 * leaves, not after `staleMs`); otherwise a live match, the hook's own extra
 * reason, or simply not yet stale since `touchedAt` (`updatedAt`, the last
 * poll, or the event's own start, whichever is latest).
 */
export function isOfferedRoom<R extends ListableRoom>(room: R, hook: RoomBusyHook<R>, now: number, staleMs: number, touchedAt: number | undefined): boolean {
	if (room.testing) return true;
	if (room.members.length === 0) return false;
	if (room.tables.some((t) => t.matchId !== null)) return true;
	if (hook.extraOffered(room)) return true;
	const cutoff = now - staleMs;
	return Math.max(room.updatedAt, touchedAt ?? 0, room.scheduledFor ?? 0) > cutoff;
}

/**
 * Whether the idle sweep should forget `room` now: never a seeded testing
 * room, never one with a live match (its own end is a different clock's
 * job), never one the hook says is spared, and otherwise only once it has
 * sat untouched — from its event's start if it has one — for longer than
 * `idleMs` (or the hook's own default, absent an override).
 */
export function isSweepableRoom<R extends ListableRoom>(room: R, hook: RoomBusyHook<R>, now: number, idleMs: number | undefined): boolean {
	if (room.testing) return false;
	if (room.tables.some((t) => t.matchId !== null)) return false;
	const idle = idleMs ?? hook.defaultIdleMs(room);
	if (Math.max(room.updatedAt, room.scheduledFor ?? 0) > now - idle) return false;
	if (hook.sparedFromSweep(room, now)) return false;
	return true;
}

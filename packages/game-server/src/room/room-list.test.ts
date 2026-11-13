/**
 * The room-list projection and the idle-sweep rule in isolation — split out
 * of `room/lobby.ts` (wave 110 §L, phase 3), whose own `lobby.test.ts`
 * already covers all of this indirectly through `list`/`offered`/`sweep`.
 */
import { describe, expect, it } from 'vitest';

import { isOfferedRoom, isSweepableRoom, NO_BUSY_HOOK, sortRoomsByCreation, type ListableRoom } from './room-list.ts';

function roomOf(partial: Partial<ListableRoom> & { id: string }): ListableRoom {
	return { createdAt: 0, updatedAt: 0, testing: false, members: { length: 1 }, ...partial };
}

/** A game whose every room has a live match. */
const LIVE = { ...NO_BUSY_HOOK, liveMatch: () => true };

describe('sortRoomsByCreation', () => {
	it('sorts by createdAt, then by id as a tie-break', () => {
		const a = { id: 'r-b', createdAt: 100 };
		const b = { id: 'r-a', createdAt: 100 };
		const c = { id: 'r-z', createdAt: 50 };
		expect(sortRoomsByCreation([a, b, c]).map((r) => r.id)).toEqual(['r-z', 'r-a', 'r-b']);
	});
});

describe('isOfferedRoom', () => {
	it('always offers a seeded testing room, empty or not', () => {
		const room = roomOf({ id: 'r-1', testing: true, members: { length: 0 } });
		expect(isOfferedRoom(room, NO_BUSY_HOOK, 1000, 500, undefined)).toBe(true);
	});

	it('never offers an empty room, however recently updated', () => {
		const room = roomOf({ id: 'r-1', members: { length: 0 }, updatedAt: 999 });
		expect(isOfferedRoom(room, NO_BUSY_HOOK, 1000, 500, undefined)).toBe(false);
	});

	it('offers a room with a live match regardless of staleness', () => {
		const room = roomOf({ id: 'r-1', updatedAt: 0 });
		expect(isOfferedRoom(room, LIVE, 1_000_000, 500, undefined)).toBe(true);
		expect(isOfferedRoom(room, NO_BUSY_HOOK, 1_000_000, 500, undefined)).toBe(false);
	});

	it("offers past staleness when the hook's extraOffered says so", () => {
		const room = roomOf({ id: 'r-1', updatedAt: 0 });
		expect(isOfferedRoom(room, { ...NO_BUSY_HOOK, extraOffered: () => true }, 1_000_000, 500, undefined)).toBe(true);
	});

	it('is offered while fresh, and hidden once stale — by updatedAt, touchedAt or scheduledFor, whichever is latest', () => {
		const room = roomOf({ id: 'r-1', updatedAt: 1000 });
		expect(isOfferedRoom(room, NO_BUSY_HOOK, 1499, 500, undefined)).toBe(true);
		expect(isOfferedRoom(room, NO_BUSY_HOOK, 1501, 500, undefined)).toBe(false);
		expect(isOfferedRoom(room, NO_BUSY_HOOK, 1900, 500, 1600)).toBe(true);
		expect(isOfferedRoom(room, NO_BUSY_HOOK, 1900, 500, undefined)).toBe(false);
	});
});

describe('isSweepableRoom', () => {
	it('never sweeps a seeded testing room', () => {
		const room = roomOf({ id: 'r-1', testing: true, updatedAt: 0 });
		expect(isSweepableRoom(room, NO_BUSY_HOOK, 1_000_000, 100)).toBe(false);
	});

	it('never sweeps a room with a live match', () => {
		const room = roomOf({ id: 'r-1', updatedAt: 0 });
		expect(isSweepableRoom(room, LIVE, 1_000_000, 100)).toBe(false);
		expect(isSweepableRoom(room, NO_BUSY_HOOK, 1_000_000, 100)).toBe(true);
	});

	it('sweeps once idle past idleMs (or the event start, whichever is later), never before', () => {
		const room = roomOf({ id: 'r-1', updatedAt: 1000 });
		expect(isSweepableRoom(room, NO_BUSY_HOOK, 1099, 100)).toBe(false);
		expect(isSweepableRoom(room, NO_BUSY_HOOK, 1101, 100)).toBe(true);
	});

	it("falls back to the hook's own default idle window absent an override", () => {
		const room = roomOf({ id: 'r-1', updatedAt: 0 });
		const hook = { ...NO_BUSY_HOOK, defaultIdleMs: () => 1000 };
		expect(isSweepableRoom(room, hook, 999, undefined)).toBe(false);
		expect(isSweepableRoom(room, hook, 1001, undefined)).toBe(true);
	});

	it("never sweeps a room the hook says is spared, however idle", () => {
		const room = roomOf({ id: 'r-1', updatedAt: 0 });
		expect(isSweepableRoom(room, { ...NO_BUSY_HOOK, sparedFromSweep: () => true }, 1_000_000, 100)).toBe(false);
	});
});

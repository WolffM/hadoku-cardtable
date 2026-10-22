/**
 * Wave 32 Q6: *"watchparty chat and the game are desynced when i change
 * avatars."* A seat's avatar is the avatar of the room member who holds it —
 * the room is the one place an avatar is stored — so a change in the room only
 * has to tell the running match that the seat's face changed.
 *
 * And the operator, 2026-10-17, mid-game: *"i noticed a reconnecting, and then
 * i noticed our avatars reverted. And now, when we try to change avatars it
 * doesn't work in the game."* A deploy restarted the server, play adopted the
 * match, and the room had forgotten it was playing it.
 */

import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { openLobby } from '../room/lobby.js';
import { loadTablesLibrary } from './library.js';
import { attachTables, relayAvatarToMatch, type TablesMatches, type TablesRooms } from './routes.js';

const library = loadTablesLibrary(resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'));

type Change = { roomId: string; memberId: string; avatarId: string | null };

/** A registry holding the given matches, each seated `owners` and in `status`. */
function registry(live: Record<string, { owners: string[]; status?: string }>): TablesMatches & { calls: [string, number][] } {
	const calls: [string, number][] = [];
	return {
		calls,
		active: () => [],
		get: (id) => {
			const m = live[id];
			if (m === undefined) return undefined;
			return {
				status: m.status ?? 'running',
				claim: () => ({ ok: false, error: 'unused' }),
				seatOf: (who) => {
					const i = m.owners.indexOf(who);
					return i < 0 ? null : i;
				},
				seatAvatarChanged: (seat) => void calls.push([id, seat]),
				stop: () => undefined,
				outcome: () => null,
			};
		},
	};
}

function fixture(opts: { matchId?: string | null; owners?: string[]; status?: string } = {}) {
	let listener: ((c: Change) => void) | null = null;
	const matchId = opts.matchId === undefined ? 'm-1' : opts.matchId;
	const rooms = {
		get: () => ({
			id: 'r-1',
			tables: [
				{ id: 't-1', players: [], matchId, series: { length: 1, wins: [0, 0], games: [], phase: matchId !== null ? 'playing' : 'seating' } },
			],
		}),
		onAvatarChange: (l: (c: Change) => void) => {
			listener = l;
			return () => undefined;
		},
	} as unknown as TablesRooms;
	const matches = registry({ 'm-1': { owners: opts.owners ?? ['alice', 'bob'], ...(opts.status === undefined ? {} : { status: opts.status }) } });
	return { rooms, matches, fire: (c: Change) => listener?.(c) };
}

describe('an avatar change reaches the running match (Q6)', () => {
	it('tells the match the seat the member holds, and no other', () => {
		const f = fixture();
		relayAvatarToMatch(f.rooms, f.matches, { roomId: 'r-1', memberId: 'bob' });
		expect(f.matches.calls).toEqual([['m-1', 1]]);
	});

	it.each([
		['a room with no match', { matchId: null }],
		['a match that is over', { status: 'over' }],
		['a member with no seat', { owners: ['x', 'y'] }],
	])('does nothing for %s', (_label, opts) => {
		const f = fixture(opts);
		relayAvatarToMatch(f.rooms, f.matches, { roomId: 'r-1', memberId: 'alice' });
		expect(f.matches.calls).toEqual([]);
	});

	it('is wired: attachTables subscribes to the room and relays through the lazy registry', () => {
		const f = fixture();
		attachTables(express.Router(), {
			library,
			draftRooms: null,
			log: () => undefined,
			rooms: f.rooms,
			matches: () => f.matches,
		});
		f.fire({ roomId: 'r-1', memberId: 'alice', avatarId: 'knight' });
		expect(f.matches.calls).toEqual([['m-1', 0]]);
	});
});

describe('a room and its match across a restart', () => {
	const ALICE = { id: 'fk:1111111111111111', name: 'user-alice' };
	const BOB = { id: 'fk:2222222222222222', name: 'user-bob' };
	const dirs: string[] = [];

	afterAll(async () => {
		for (const dir of dirs) await rm(dir, { recursive: true, force: true });
	});

	/** Two rooms, each mid-match, written to disk by the process that is about to die. */
	async function beforeTheDeploy() {
		const dir = await mkdtemp(join(tmpdir(), 'cardtable-restart-test-'));
		dirs.push(dir);
		const first = await openLobby({ dir, log: () => undefined });
		const rooms: string[] = [];
		for (const matchId of ['m-adopted0001', 'm-died0000001']) {
			const made = first.create(ALICE, { name: matchId, gameType: 'constructed-1v1', clientMode: 'builtin' });
			if (!made.ok) throw new Error('create failed');
			first.join(made.room.id, BOB);
			first.setAvatar(made.room.id, ALICE.id, 'sage');
			first.setAvatar(made.room.id, BOB.id, 'herald');
			const tableId = made.room.tables[0]!.id;
			first.sit(made.room.id, tableId, ALICE.id);
			first.sit(made.room.id, tableId, BOB.id);
			first.setSeatReady(made.room.id, tableId, ALICE.id, true);
			first.setTableMatch(made.room.id, tableId, matchId);
			rooms.push(made.room.id);
		}
		return { dir, adoptedRoom: rooms[0]!, diedRoom: rooms[1]! };
	}

	/** The next process: the lobby reopened, play adopting only the first match, tables over both. */
	async function afterTheDeploy() {
		const before = await beforeTheDeploy();
		const lobby = await openLobby({ dir: before.dir, log: () => undefined });
		const matches = registry({ 'm-adopted0001': { owners: [ALICE.id, BOB.id] } });
		const tables = attachTables(express.Router(), {
			library,
			draftRooms: null,
			log: () => undefined,
			rooms: lobby,
			matches: () => matches,
		});
		tables.releaseGoneMatches();
		return { ...before, lobby, matches, tables };
	}

	it("still knows the match it was playing, so a member's avatar change reaches their seat", async () => {
		const t = await afterTheDeploy();
		expect(t.lobby.get(t.adoptedRoom)?.matchId).toBe('m-adopted0001');
		t.lobby.setAvatar(t.adoptedRoom, BOB.id, 'rogue');
		expect(t.matches.calls).toEqual([['m-adopted0001', 1]]);
	});

	it("answers each adopted seat's avatar from the room as it is now, not as it was at the start", async () => {
		const t = await afterTheDeploy();
		expect(t.tables.seatAvatar('m-adopted0001', BOB.id)).toBe('herald');
		t.lobby.setAvatar(t.adoptedRoom, BOB.id, 'rogue');
		expect(t.tables.seatAvatar('m-adopted0001', BOB.id)).toBe('rogue');
		t.lobby.setAvatar(t.adoptedRoom, BOB.id, null);
		expect(t.tables.seatAvatar('m-adopted0001', BOB.id)).toBeUndefined();
		expect(t.tables.seatAvatar('m-adopted0001', 'fk:not-a-member0000'), 'nobody in the room').toBeUndefined();
		expect(t.tables.seatAvatar('m-no-such-room', BOB.id), 'a match no room started').toBeUndefined();
	});

	it('lets go of a match that did not come back, so the room is not "playing" for ever', async () => {
		const t = await afterTheDeploy();
		const died = t.lobby.get(t.diedRoom);
		expect(died?.matchId).toBeNull();
		expect(t.lobby.seats(t.diedRoom, died!.tables[0]!.id).map((s) => s.ready), 'the start that made it spent the Readys').toEqual([false, false]);
		expect(t.lobby.list().find((r) => r.id === t.diedRoom)?.matchId).toBeNull();
		// Still the room that started it, for that match's result screen.
		expect(t.lobby.roomOfMatch('m-died0000001')?.id).toBe(t.diedRoom);
	});
});

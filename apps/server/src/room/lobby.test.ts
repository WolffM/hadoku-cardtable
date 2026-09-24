/**
 * The lobby's own tests, at the `Lobby` interface rather than over HTTP.
 *
 * `http/rooms.test.ts` exercises the same lobby through a real express stack;
 * this file is for the properties that live BELOW the wire — chiefly the
 * restore path, where a room written by a previous build has to read back as
 * something this build understands.
 *
 * ## The pre-wave-18 room is a FIXTURE, never a live file
 *
 * A room created before `clientMode` existed has no such key in its stored
 * `app` blob, and must read back `builtin`. Proving that needs a snapshot from
 * before the field — so the test WRITES one, into a temp dir it made, through
 * room-store's own `saveSync`. That is byte-for-byte how the old build wrote a
 * room, minus the one key it did not know about. Nothing here reads
 * `data/rooms`, a deployed tree, or any file this process did not create.
 */

import { FileRoomStore, STORE_VERSION, type RoomSnapshot } from '@hadoku/room-store';
import { createSeatTable } from '@wolffm/rooms-protocol';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	CLIENT_MODES,
	DEFAULT_CLIENT_MODE,
	openLobby,
	ROOM_IDLE_MS,
	type ClientMode,
	type Lobby,
	type RoomView,
} from './lobby.ts';

const ALICE = { id: 'fk:1111111111111111', name: 'user-alice' };
const BOB = { id: 'fk:2222222222222222', name: 'user-bob' };

const dirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'cardtable-lobby-test-'));
	dirs.push(dir);
	return dir;
}

afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/**
 * Write one room snapshot into `dir` the way a previous process would have.
 *
 * `app` is passed through verbatim, so a caller can leave `clientMode` out
 * entirely — which is the whole point: a room from before the field existed
 * cannot be produced by calling today's `create`.
 */
function writeFixtureRoom(dir: string, roomId: string, app: Record<string, unknown>, updatedAt = 1_700_000_000_000): void {
	const snapshot: RoomSnapshot = {
		storeVersion: STORE_VERSION,
		roomId,
		roomKey: roomId,
		lastEventSeq: 0,
		createdAt: 1_700_000_000_000,
		updatedAt,
		members: [{ participantId: ALICE.id, joinedAt: 1_700_000_000_000, lastSeen: 1_700_000_000_000, name: ALICE.name, app: null }],
		usedAvatars: [],
		clientNames: {},
		seats: createSeatTable(null),
		app,
		appVersion: 1,
	};
	new FileRoomStore(dir).saveSync(snapshot);
}

/** Exactly the room-level blob the pre-wave-18 build wrote: no `clientMode` key at all. */
function legacyApp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: 'Kitchen table',
		creator: ALICE.id,
		leader: ALICE.id,
		gameType: 'constructed-1v1',
		matchId: null,
		secret: null,
		...overrides,
	};
}

/* ── the vocabulary ──────────────────────────────────────────────────── */

describe('ClientMode', () => {
	it('is exactly two modes, and the default is builtin', () => {
		expect([...CLIENT_MODES]).toEqual(['builtin', 'streamed']);
		expect(DEFAULT_CLIENT_MODE).toBe('builtin');
	});
});

/* ── create is the only place the mode is set ────────────────────────── */

describe('Lobby.create', () => {
	it('stores the mode it was given, and both list() and get() carry it', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made: RoomView[] = [];
		for (const clientMode of CLIENT_MODES) {
			const result = lobby.create(ALICE, { name: `room-${clientMode}`, gameType: 'constructed-1v1', clientMode });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.room.clientMode).toBe(clientMode);
			made.push(result.room);
		}
		expect(lobby.list().map((r) => r.clientMode)).toEqual(['builtin', 'streamed']);
		for (const room of made) {
			expect(lobby.get(room.id)?.clientMode).toBe(room.clientMode);
		}
	});

	it('survives a restart with the mode it was created with', async () => {
		const dir = await tempDir();
		const first = await openLobby({ dir });
		const streamed = first.create(BOB, { name: 'Forge night', gameType: 'draft', clientMode: 'streamed' });
		const builtin = first.create(BOB, { name: 'Our table', gameType: 'draft', clientMode: 'builtin' });
		expect(streamed.ok && builtin.ok).toBe(true);
		if (!streamed.ok || !builtin.ok) return;

		const second = await openLobby({ dir });
		expect(second.get(streamed.room.id)?.clientMode).toBe('streamed');
		expect(second.get(builtin.room.id)?.clientMode).toBe('builtin');
	});
});

/* ── the room that predates the field ────────────────────────────────── */

describe('a room stored before clientMode existed', () => {
	it('reads back as builtin, from a fixture snapshot with no such key', async () => {
		const dir = await tempDir();
		writeFixtureRoom(dir, 'r-aaaaaaaaaaaa', legacyApp());
		// The fixture really is missing the field — otherwise this test proves nothing.
		expect(Object.keys(legacyApp())).not.toContain('clientMode');

		const lobby = await openLobby({ dir });
		expect(lobby.list()).toHaveLength(1);
		expect(lobby.list()[0].clientMode).toBe('builtin');
		expect(lobby.get('r-aaaaaaaaaaaa')?.clientMode).toBe('builtin');
		// Everything else about the old room came back untouched.
		expect(lobby.get('r-aaaaaaaaaaaa')?.name).toBe('Kitchen table');
		expect(lobby.get('r-aaaaaaaaaaaa')?.gameType).toBe('constructed-1v1');
		expect(lobby.get('r-aaaaaaaaaaaa')?.members.map((m) => m.name)).toEqual([ALICE.name]);
	});

	it('is rewritten WITH the field once anything touches it, and still reads builtin', async () => {
		const dir = await tempDir();
		writeFixtureRoom(dir, 'r-bbbbbbbbbbbb', legacyApp());
		const first = await openLobby({ dir });
		expect(first.setMatch('r-bbbbbbbbbbbb', 'match-1')).toBe(true);
		// The write happened, in this process: the match is live here.
		expect(first.get('r-bbbbbbbbbbbb')?.matchId).toBe('match-1');

		const second = await openLobby({ dir });
		expect(second.get('r-bbbbbbbbbbbb')?.clientMode).toBe('builtin');
		// But NOT across the restart. A match is a child JVM this process owns;
		// it dies with the process, so a restored room that kept its match id
		// advertised "playing" about a game that no longer exists. This used to
		// assert 'match-1' and that was the bug, not the contract.
		expect(second.get('r-bbbbbbbbbbbb')?.matchId).toBeNull();
	});

	it('quarantines a record whose clientMode is present and unknown, rather than defaulting it away', async () => {
		const dir = await tempDir();
		writeFixtureRoom(dir, 'r-cccccccccccc', legacyApp({ clientMode: 'telepathy' }));
		const logged: Record<string, unknown>[] = [];
		const lobby = await openLobby({ dir, log: (e) => void logged.push(e) });

		expect(lobby.list()).toEqual([]);
		const quarantined = logged.filter((e) => e.event === 'room-quarantined');
		expect(quarantined).toHaveLength(1);
		expect(String(quarantined[0].reason)).toContain('clientMode');
		// The reason names the FIELD, never the value it found.
		expect(JSON.stringify(quarantined)).not.toContain('telepathy');
	});
});

/* ── nothing else may change it ──────────────────────────────────────── */

describe('clientMode is immutable once a room exists', () => {
	it('is unchanged by every mutating call the Lobby interface has', async () => {
		const dir = await tempDir();
		const lobby: Lobby = await openLobby({ dir });
		const created = lobby.create(ALICE, { name: 'Forge night', gameType: 'constructed-1v1', clientMode: 'streamed' });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const id = created.room.id;

		// Every mutator on the interface, in turn. `setGameType` is the only one
		// that touches the room's own shape, and it must touch only the game type.
		expect(lobby.join(id, BOB).ok).toBe(true);
		expect(lobby.setPlayerState(id, BOB.id, { deck: 'mono-red' })).toBe(true);
		expect(lobby.setMatch(id, 'match-7')).toBe(true);
		expect(lobby.setGameType(id, ALICE.id, 'draft').ok).toBe(true);

		const after = lobby.get(id);
		expect(after?.clientMode).toBe<ClientMode>('streamed');
		expect(after?.gameType).toBe('draft');
		expect(after?.matchId).toBe('match-7');

		// And it is still streamed after a restart, so nothing above wrote a
		// snapshot that lost or flipped it.
		const reopened = await openLobby({ dir });
		expect(reopened.get(id)?.clientMode).toBe('streamed');
	});
});

/* ── a room is not immortal ──────────────────────────────────────────── */

describe('Lobby.sweep', () => {
	/*
	 * `create` had no opposite for the lobby's whole life — no leave, no close,
	 * no expiry — so every room ever made stayed on the front page. The operator
	 * found a four-day-old test room still listed, still advertising a match
	 * whose JVM had died in the first nightly restart after it.
	 */
	it('forgets a room nobody has touched, from memory AND from disk', async () => {
		const dir = await tempDir();
		const now = 2_000_000_000_000;
		writeFixtureRoom(dir, 'r-stale00000001', legacyApp({ name: 'test 1v1' }), now - ROOM_IDLE_MS - 1);
		writeFixtureRoom(dir, 'r-fresh00000002', legacyApp({ name: 'tonight' }), now - 60_000);

		const lobby = await openLobby({ dir, now: () => now });
		expect(lobby.list().map((r) => r.id).sort()).toEqual(['r-fresh00000002', 'r-stale00000001']);

		expect(lobby.sweep()).toEqual(['r-stale00000001']);
		expect(lobby.list().map((r) => r.id)).toEqual(['r-fresh00000002']);
		expect(lobby.get('r-stale00000001')).toBeUndefined();

		// And it must not come back at the next boot, which is the half that
		// makes this a fix rather than a filter on the list.
		await new Promise((r) => setTimeout(r, 50));
		const rebooted = await openLobby({ dir, now: () => now });
		expect(rebooted.list().map((r) => r.id)).toEqual(['r-fresh00000002']);
	});

	it('keeps a room that was touched inside the window, and a brand new one', async () => {
		const dir = await tempDir();
		let clock = 3_000_000_000_000;
		const lobby = await openLobby({ dir, now: () => clock });
		const made = lobby.create(ALICE, { name: 'tonight', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(made.ok).toBe(true);

		// A room made this instant must never be swept by the sweep that runs
		// at boot moments later.
		expect(lobby.sweep()).toEqual([]);

		// Still inside the window after most of it has passed.
		clock += ROOM_IDLE_MS - 1;
		expect(lobby.sweep()).toEqual([]);
		expect(lobby.list()).toHaveLength(1);

		// A join is a touch: it resets the clock rather than ageing out under
		// somebody who just arrived.
		if (!made.ok) return;
		lobby.join(made.room.id, BOB);
		clock += ROOM_IDLE_MS - 1;
		expect(lobby.sweep()).toEqual([]);

		clock += 2;
		expect(lobby.sweep()).toEqual([made.room.id]);
		expect(lobby.list()).toEqual([]);
	});
});

/* ── a match never outlives the process that ran it ──────────────────── */

describe('a restored room is never still playing', () => {
	it('drops a matchId written before the restart', async () => {
		const dir = await tempDir();
		// Exactly the shape the operator's stale room had on disk: a live-looking
		// match id, pointing at a child JVM that died with the process.
		writeFixtureRoom(dir, 'r-played0000001', legacyApp({ name: 'test 1v1', matchId: 'm-b2853c882395' }));

		const lobby = await openLobby({ dir });
		const room = lobby.get('r-played0000001');
		expect(room?.matchId, 'a room claimed to be playing a match that cannot exist').toBeNull();
		// The list is what the front page reads, so assert it there too.
		expect(lobby.list()[0]?.matchId).toBeNull();
	});
});

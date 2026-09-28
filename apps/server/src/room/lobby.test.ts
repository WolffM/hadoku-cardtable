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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadTablesLibrary } from '../http/library.ts';
import {
	CLIENT_MODES,
	DEFAULT_CLIENT_MODE,
	draftIdOfPool,
	draftPoolId,
	newestFormat,
	openLobby,
	ROOM_IDLE_MS,
	type ClientMode,
	type Lobby,
	type RoomView,
} from './lobby.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/** The real frozen pools, oldest first (`http/library.ts`). Derived, never restated. */
const POOLS = loadTablesLibrary(REPO_ROOT).formats.map((f) => f.id);

const CAROL = { id: 'fk:3333333333333333', name: 'user-carol' };

/** A draft room with `members` in it, all of them ready, and its draft started. */
async function startedDraft(lobby: Lobby, members: Array<{ id: string; name: string }> = [ALICE]): Promise<string> {
	const made = lobby.create(members[0], { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
	expect(made.ok).toBe(true);
	if (!made.ok) throw new Error(made.reason);
	for (const member of members.slice(1)) expect(lobby.join(made.room.id, member).ok).toBe(true);
	for (const member of members) expect(lobby.setReady(made.room.id, member.id, true)).toBe(true);
	const started = lobby.startDraft(made.room.id, members[0].id);
	expect(started.ok).toBe(true);
	return made.room.id;
}

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
		// The wave-23 fields are additive too: a member blob of `null` is not
		// ready, and a room-level blob with no `draftStartedAt` is in its lobby.
		expect(Object.keys(legacyApp())).not.toContain('draftStartedAt');
		expect(lobby.get('r-aaaaaaaaaaaa')?.members.map((m) => m.ready)).toEqual([false]);
		expect(lobby.get('r-aaaaaaaaaaaa')?.draftStartedAt).toBeNull();
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
		expect(lobby.setFormat(id, ALICE.id, POOLS[0]).ok).toBe(true);

		const after = lobby.get(id);
		expect(after?.clientMode).toBe<ClientMode>('streamed');
		expect(after?.format).toBe(POOLS[0]);
		expect(after?.gameType).toBe('draft');
		expect(after?.matchId).toBe('match-7');

		// And it is still streamed after a restart, so nothing above wrote a
		// snapshot that lost or flipped it.
		const reopened = await openLobby({ dir });
		expect(reopened.get(id)?.clientMode).toBe('streamed');
	});
});

/* ── the room's pool (wave 25 §A) ────────────────────────────────────── */

describe('a room’s format', () => {
	it('starts on the NEWEST frozen pool, not the oldest', async () => {
		// The fact under test is the operator's: newest, not `formats[0]`. Both ends
		// are read off the real pool directory, so a new frozen pool moves this test
		// instead of failing it.
		expect(POOLS.length).toBeGreaterThan(1);
		expect(newestFormat()).toBe(POOLS[POOLS.length - 1]);
		expect(newestFormat()).not.toBe(POOLS[0]);

		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		expect(made.room.format).toBe(POOLS[POOLS.length - 1]);
		// Every body that carries a room carries it, list as well as get.
		expect(lobby.list().map((r) => r.format)).toEqual([POOLS[POOLS.length - 1]]);
		expect(lobby.get(made.room.id)?.format).toBe(POOLS[POOLS.length - 1]);
	});

	it('survives a restart, because the decks it checked survive with it', async () => {
		const dir = await tempDir();
		const first = await openLobby({ dir, defaultFormat: POOLS[POOLS.length - 1] });
		const made = first.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		expect(first.setFormat(made.room.id, ALICE.id, POOLS[0]).ok).toBe(true);
		first.setPlayerState(made.room.id, ALICE.id, { deck: 'held-under-the-old-pool' });

		// A room that came back on a different pool from the one its players loaded
		// their decks against is the bug this field exists to prevent — and the deck
		// hold comes back, so the pool has to.
		const second = await openLobby({ dir, defaultFormat: POOLS[POOLS.length - 1] });
		expect(second.get(made.room.id)?.format).toBe(POOLS[0]);
		expect(second.playerState(made.room.id, ALICE.id)).toEqual({ deck: 'held-under-the-old-pool' });
	});

	it('reads back on the newest pool for a record written before the field', async () => {
		const dir = await tempDir();
		writeFixtureRoom(dir, 'r-preformat0001', legacyApp());
		// The fixture really is missing the field — otherwise this proves nothing.
		expect(Object.keys(legacyApp())).not.toContain('format');

		const lobby = await openLobby({ dir, defaultFormat: POOLS[POOLS.length - 1] });
		expect(lobby.get('r-preformat0001')?.format).toBe(POOLS[POOLS.length - 1]);
		// And it is written WITH the field once anything touches the room.
		expect(lobby.setMatch('r-preformat0001', 'm-1')).toBe(true);
		const second = await openLobby({ dir, defaultFormat: 'a-different-default' });
		expect(second.get('r-preformat0001')?.format).toBe(POOLS[POOLS.length - 1]);
	});

	it('quarantines a record whose format is present and not a format id', async () => {
		for (const [roomId, format] of [
			['r-badformat0001', 42],
			['r-badformat0002', ''],
			['r-badformat0003', null],
		] as [string, unknown][]) {
			const dir = await tempDir();
			writeFixtureRoom(dir, roomId, legacyApp({ format }));
			const logged: Record<string, unknown>[] = [];
			const lobby = await openLobby({ dir, log: (e) => void logged.push(e), defaultFormat: POOLS[0] });

			expect(lobby.list(), JSON.stringify(format)).toEqual([]);
			const quarantined = logged.filter((e) => e.event === 'room-quarantined');
			expect(quarantined).toHaveLength(1);
			// The reason names the FIELD, as every other reason here does.
			expect(String(quarantined[0].reason)).toContain('format');
		}
	});
});

describe('Lobby.setFormat', () => {
	/** A room with ALICE leading, BOB in it, both ready and both holding a deck. */
	async function loadedRoom(lobby: Lobby): Promise<string> {
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) throw new Error(made.reason);
		expect(lobby.join(made.room.id, BOB).ok).toBe(true);
		for (const who of [ALICE, BOB]) {
			expect(lobby.setReady(made.room.id, who.id, true)).toBe(true);
			// The table's own ready flag and verdict, in the blob `http/routes.ts`
			// owns. Opaque here on purpose: this file drops it, it never reads it.
			expect(lobby.setPlayerState(made.room.id, who.id, { v: 1, ready: true, verdict: { legal: true } })).toBe(true);
		}
		return made.room.id;
	}

	it('refuses a non-leader with not-leader, and changes nothing', async () => {
		const lobby = await openLobby({ dir: await tempDir(), defaultFormat: POOLS[POOLS.length - 1] });
		const id = await loadedRoom(lobby);

		expect(lobby.setFormat(id, BOB.id, POOLS[0])).toEqual({ ok: false, reason: 'not-leader' });
		expect(lobby.setFormat(id, CAROL.id, POOLS[0])).toEqual({ ok: false, reason: 'not-leader' });
		expect(lobby.setFormat('r-000000000000', ALICE.id, POOLS[0])).toEqual({ ok: false, reason: 'no-room' });

		// The refusals cost the table nothing: same pool, same flags, same holds.
		expect(lobby.get(id)?.format).toBe(POOLS[POOLS.length - 1]);
		expect(lobby.get(id)?.members.map((m) => m.ready)).toEqual([true, true]);
		expect(lobby.playerState(id, BOB.id)).toEqual({ v: 1, ready: true, verdict: { legal: true } });
	});

	it('clears every readiness flag and every deck hold when the pool changes', async () => {
		const dir = await tempDir();
		const lobby = await openLobby({ dir, defaultFormat: POOLS[POOLS.length - 1] });
		const id = await loadedRoom(lobby);

		const moved = lobby.setFormat(id, ALICE.id, POOLS[0]);
		expect(moved.ok).toBe(true);
		if (!moved.ok) return;
		expect(moved.room.format).toBe(POOLS[0]);
		// The ROOM's flag, for everybody including the leader who moved it.
		expect(moved.room.members.map((m) => m.ready)).toEqual([false, false]);
		// And the TABLE's, which is the whole hold: the deck choice, the verdict and
		// the checked text were all produced in the pool that just went away.
		expect(lobby.playerState(id, ALICE.id)).toBeUndefined();
		expect(lobby.playerState(id, BOB.id)).toBeUndefined();
		// On disk as well as in memory.
		const second = await openLobby({ dir, defaultFormat: POOLS[POOLS.length - 1] });
		expect(second.get(id)?.format).toBe(POOLS[0]);
		expect(second.get(id)?.members.map((m) => m.ready)).toEqual([false, false]);
		expect(second.playerState(id, ALICE.id)).toBeUndefined();
	});

	/**
	 * A drafted pool is a pool: the leader sets it through the same setter, it
	 * clears the same holds, and it survives the same restart.
	 *
	 * Wave 26 §F. What the lobby knows about it is the string and nothing else —
	 * the POD is looked up by `http/routes.ts`, which is where the draft registry
	 * is, so a room can be on a pod this process has never heard of and the lobby
	 * has no opinion (`unknownPool` answers 409 for that).
	 */
	it('moves the pool to a DRAFTED pool, clearing the same holds, and stores it', async () => {
		const dir = await tempDir();
		const lobby = await openLobby({ dir, defaultFormat: POOLS[POOLS.length - 1] });
		const id = await loadedRoom(lobby);
		const pool = draftPoolId('amber-lantern-k7q4');

		const moved = lobby.setFormat(id, ALICE.id, pool);
		expect(moved.ok).toBe(true);
		if (!moved.ok) return;
		expect(moved.room.format).toBe(pool);
		expect(draftIdOfPool(moved.room.format)).toBe('amber-lantern-k7q4');
		expect(moved.room.members.map((m) => m.ready)).toEqual([false, false]);
		expect(lobby.playerState(id, BOB.id)).toBeUndefined();

		// And a non-leader still cannot move it, drafted pool or not.
		expect(lobby.setFormat(id, BOB.id, POOLS[0])).toEqual({ ok: false, reason: 'not-leader' });
		expect(lobby.get(id)?.format).toBe(pool);

		const second = await openLobby({ dir, defaultFormat: POOLS[POOLS.length - 1] });
		expect(second.get(id)?.format).toBe(pool);
	});

	it('clears nothing when the pool it is set to is the one the room is on', async () => {
		const lobby = await openLobby({ dir: await tempDir(), defaultFormat: POOLS[POOLS.length - 1] });
		const id = await loadedRoom(lobby);

		const same = lobby.setFormat(id, ALICE.id, POOLS[POOLS.length - 1]);
		expect(same.ok).toBe(true);
		// A leader clicking the option that is already selected must not un-ready
		// the table under everybody.
		expect(lobby.get(id)?.members.map((m) => m.ready)).toEqual([true, true]);
		expect(lobby.playerState(id, ALICE.id)).toEqual({ v: 1, ready: true, verdict: { legal: true } });
	});

	it('refuses to move the pool while a draft is running', async () => {
		const lobby = await openLobby({ dir: await tempDir(), defaultFormat: POOLS[POOLS.length - 1] });
		const id = await startedDraft(lobby, [ALICE]);
		expect(lobby.setFormat(id, ALICE.id, POOLS[0])).toEqual({ ok: false, reason: 'draft-started' });
		expect(lobby.get(id)?.format).toBe(POOLS[POOLS.length - 1]);
		expect(lobby.get(id)?.members.map((m) => m.ready)).toEqual([true]);
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

/* ── readiness, which is what a draft starts on ──────────────────────── */

describe('Lobby.setReady', () => {
	it('persists a member’s flag, reads it back, and refuses a non-member', async () => {
		const dir = await tempDir();
		const lobby = await openLobby({ dir });
		const made = lobby.create(ALICE, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		const id = made.room.id;
		// A new member starts not ready, and says so in the view every client reads.
		expect(made.room.members.map((m) => m.ready)).toEqual([false]);

		expect(lobby.join(id, BOB).ok).toBe(true);
		expect(lobby.setReady(id, ALICE.id, true)).toBe(true);
		expect(lobby.get(id)?.members.map((m) => m.ready)).toEqual([true, false]);

		// Nobody who is not a member of this room may set a flag in it, and
		// neither may anyone against a room that does not exist.
		expect(lobby.setReady(id, CAROL.id, true)).toBe(false);
		expect(lobby.setReady('r-000000000000', ALICE.id, true)).toBe(false);
		expect(lobby.get(id)?.members.map((m) => m.ready)).toEqual([true, false]);

		// It is a flag, not a latch.
		expect(lobby.setReady(id, ALICE.id, false)).toBe(true);
		expect(lobby.get(id)?.members.map((m) => m.ready)).toEqual([false, false]);

		// And it survives a restart: a deploy mid-lobby does not make everybody
		// click again.
		expect(lobby.setReady(id, BOB.id, true)).toBe(true);
		const second = await openLobby({ dir });
		expect(second.get(id)?.members.map((m) => [m.name, m.ready])).toEqual([
			[ALICE.name, false],
			[BOB.name, true],
		]);
	});
});

describe('Lobby.startDraft', () => {
	it('refuses all four ways: no room, not a member, not a draft, not everyone ready', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		expect(lobby.startDraft('r-000000000000', ALICE.id)).toEqual({ ok: false, reason: 'no-room' });

		const draft = lobby.create(ALICE, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		const table = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(draft.ok && table.ok).toBe(true);
		if (!draft.ok || !table.ok) return;

		// Not a member. CAROL never joined.
		expect(lobby.startDraft(draft.room.id, CAROL.id)).toEqual({ ok: false, reason: 'not-member' });
		// Not a draft. A constructed room starts through the tables API.
		expect(lobby.setReady(table.room.id, ALICE.id, true)).toBe(true);
		expect(lobby.startDraft(table.room.id, ALICE.id)).toEqual({ ok: false, reason: 'not-draft' });
		// Nobody ready at all.
		expect(lobby.startDraft(draft.room.id, ALICE.id)).toEqual({ ok: false, reason: 'not-ready' });
		// One of two ready is not "everyone": BOB has not said yes.
		expect(lobby.join(draft.room.id, BOB).ok).toBe(true);
		expect(lobby.setReady(draft.room.id, ALICE.id, true)).toBe(true);
		expect(lobby.startDraft(draft.room.id, ALICE.id)).toEqual({ ok: false, reason: 'not-ready' });
		// None of those refusals started anything.
		expect(lobby.get(draft.room.id)?.draftStartedAt).toBeNull();

		expect(lobby.setReady(draft.room.id, BOB.id, true)).toBe(true);
		const started = lobby.startDraft(draft.room.id, BOB.id);
		expect(started.ok).toBe(true);
		// ANY member may start it, not only the leader: both browsers ask and the
		// server answers one start to both.
		if (!started.ok) return;
		expect(typeof started.room.draftStartedAt).toBe('string');
	});

	it('starts for one member who readied alone — "everyone" is every member, and one is enough', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const id = await startedDraft(lobby, [ALICE]);
		const room = lobby.get(id);
		expect(room?.members).toHaveLength(1);
		expect(Date.parse(String(room?.draftStartedAt))).not.toBeNaN();
	});

	it('is idempotent: a second call answers ok and does not re-stamp the start', async () => {
		let clock = 1_800_000_000_000;
		const lobby = await openLobby({ dir: await tempDir(), now: () => clock });
		const id = await startedDraft(lobby, [ALICE, BOB]);
		const first = lobby.get(id)?.draftStartedAt;

		clock += 60_000;
		const again = lobby.startDraft(id, BOB.id);
		expect(again.ok).toBe(true);
		if (!again.ok) return;
		expect(again.room.draftStartedAt).toBe(first);

		// Even after somebody stands down mid-draft, which is what makes the
		// idempotence check have to come BEFORE the readiness check.
		expect(lobby.setReady(id, BOB.id, false)).toBe(true);
		const third = lobby.startDraft(id, ALICE.id);
		expect(third.ok).toBe(true);
		if (!third.ok) return;
		expect(third.room.draftStartedAt).toBe(first);
	});
});

describe('Lobby.setGameType and readiness', () => {
	it('clears every ready flag, because readiness is readiness for a particular game', async () => {
		const dir = await tempDir();
		const lobby = await openLobby({ dir });
		const made = lobby.create(ALICE, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		expect(lobby.join(made.room.id, BOB).ok).toBe(true);
		expect(lobby.setReady(made.room.id, ALICE.id, true)).toBe(true);
		expect(lobby.setReady(made.room.id, BOB.id, true)).toBe(true);

		const switched = lobby.setGameType(made.room.id, ALICE.id, 'constructed-1v1');
		expect(switched.ok).toBe(true);
		if (!switched.ok) return;
		// Including the leader who made the change.
		expect(switched.room.members.map((m) => m.ready)).toEqual([false, false]);
		expect(lobby.get(made.room.id)?.members.map((m) => m.ready)).toEqual([false, false]);
		// Cleared on disk too, not only in memory.
		const second = await openLobby({ dir });
		expect(second.get(made.room.id)?.members.map((m) => m.ready)).toEqual([false, false]);
	});

	it('refuses to change the game type while a draft is running', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const id = await startedDraft(lobby, [ALICE]);
		expect(lobby.setGameType(id, ALICE.id, 'constructed-1v1')).toEqual({ ok: false, reason: 'draft-started' });
		// The room is untouched: still a draft, still started, still ready.
		expect(lobby.get(id)?.gameType).toBe('draft');
		expect(lobby.get(id)?.draftStartedAt).not.toBeNull();
		expect(lobby.get(id)?.members.map((m) => m.ready)).toEqual([true]);
	});
});

/* ── a live draft is not swept, and does not survive a restart ───────── */

describe('a draft that has started', () => {
	it('is spared by the sweep, however long the lobby has sat untouched', async () => {
		const dir = await tempDir();
		let clock = 4_000_000_000_000;
		const lobby = await openLobby({ dir, now: () => clock });
		const drafting = await startedDraft(lobby, [ALICE]);
		const idle = lobby.create(BOB, { name: 'nobody here', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(idle.ok).toBe(true);
		if (!idle.ok) return;

		// A pod runs for the better part of an hour with nobody touching the
		// lobby; a forty-minute draft is well inside the window, so push the
		// clock past it entirely.
		clock += ROOM_IDLE_MS + 1;
		expect(lobby.sweep()).toEqual([idle.room.id]);
		expect(lobby.list().map((r) => r.id)).toEqual([drafting]);
		expect(lobby.get(drafting)?.draftStartedAt).not.toBeNull();
	});

	it('is back in its lobby phase after a restart, with the ready flags intact', async () => {
		const dir = await tempDir();
		const first = await openLobby({ dir });
		const id = await startedDraft(first, [ALICE, BOB]);
		expect(first.get(id)?.draftStartedAt).not.toBeNull();

		// The draft itself lives in this process's memory (`draftRooms.ts` keeps
		// nothing on disk), so a restored `draftStartedAt` would point at a pod
		// that cannot exist — the same mistake `matchId` used to make. The room
		// comes back as a lobby everybody is already ready in.
		const second = await openLobby({ dir });
		expect(second.get(id)?.draftStartedAt).toBeNull();
		expect(second.get(id)?.members.map((m) => m.ready)).toEqual([true, true]);
		expect(second.get(id)?.gameType).toBe('draft');
		// And now it is sweepable again, so sparing a live draft cannot make a
		// room immortal.
		const third = await openLobby({ dir, now: () => Date.now() + ROOM_IDLE_MS + 1 });
		expect(third.sweep()).toEqual([id]);
	});
});

/*
 * A room's pool is a frozen era OR a drafted pool, and one string carries both
 * (wave 26 §F).
 *
 * The discrimination is a colon, and it can never be ambiguous: `ROOM_ID_RE`
 * allows no colon, so no pod id and no era date can be read as the other. The
 * validation is the part worth pinning — a stored `draft:` followed by anything
 * a room id is not resolves to NO pod rather than reaching the draft registry as
 * a key.
 */
describe('a drafted pool id', () => {
	it('round-trips a pod id and nothing else', () => {
		expect(draftPoolId('amber-lantern-k7q4')).toBe('draft:amber-lantern-k7q4');
		expect(draftIdOfPool('draft:amber-lantern-k7q4')).toBe('amber-lantern-k7q4');
		// A frozen era is not a drafted pool, and every real era id answers so.
		for (const era of POOLS) expect(draftIdOfPool(era)).toBeNull();
	});

	it('refuses anything a room id is not, rather than handing it on as a key', () => {
		for (const bad of [
			'draft:',
			'draft:../../etc/passwd',
			'draft:Amber-Lantern',
			'draft:has space',
			'draft:draft:x',
			`draft:${'x'.repeat(41)}`,
		]) {
			expect(draftIdOfPool(bad), bad).toBeNull();
		}
		// And a name that merely starts with the word is not a drafted pool either.
		expect(draftIdOfPool('drafted-2011-07-01')).toBeNull();
	});
});

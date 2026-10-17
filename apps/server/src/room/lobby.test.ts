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
	AVATAR_ID_MAX,
	AVATAR_POOL,
	CLIENT_MODES,
	DEFAULT_CLIENT_MODE,
	draftIdOfPool,
	draftPoolId,
	newestFormat,
	NO_FORMAT,
	openLobby,
	randomFormat,
	ROOM_IDLE_MS,
	ROOM_MATCHES_KEPT,
	ROOM_STALE_MS,
	type ClientMode,
	type Lobby,
	type RoomView,
} from './lobby.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/**
 * The real frozen STANDARD pools, oldest first (`http/library.ts`). Derived,
 * never restated. Filtered by `family`, not just "every format": wave 48 put
 * Modern and Legacy eras in the same catalog, and `newestFormat()`'s own
 * contract is the newest STANDARD era, never just the catalog's last entry.
 */
/** Every catalogued era, in catalog order — what a new room's format is drawn from. */
const CATALOG = loadTablesLibrary(REPO_ROOT).formats.map(({ id, family }) => ({ id, family }));
const POOLS = CATALOG.filter((f) => f.family === 'standard').map((f) => f.id);

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
		// And across the restart: a match outlives the process that started it
		// (play adopts it), so the room's pointer to it does too. Whether that
		// match came back is play's registry's answer, not the lobby's — see
		// `http/routes.ts`'s `releaseGoneMatches`.
		expect(second.get('r-bbbbbbbbbbbb')?.matchId).toBe('match-1');
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
	it('newestFormat() is the newest Standard era of the real catalog, not the oldest', () => {
		// Both ends are read off the real pool directory, so a new frozen pool moves
		// this test instead of failing it.
		expect(POOLS.length).toBeGreaterThan(1);
		expect(newestFormat()).toBe(POOLS[POOLS.length - 1]);
		expect(newestFormat()).not.toBe(POOLS[0]);
		// AF41 put Type 2's 1995 summer at the front of the catalog.
		expect(POOLS[0]).toBe('1995-07-01');
	});

	/*
	 * The operator, 2026-10-16: "when the room opens, pick a random format from
	 * (standard/modern/legacy) and pick a random year to open to on default".
	 */
	it('a new room opens on a family drawn uniformly, then an era of it drawn uniformly', async () => {
		const families = [...new Set(CATALOG.map((f) => f.family))];
		expect(families.sort()).toEqual(['legacy', 'modern', 'standard']);
		/** Each room makes two draws, family then era: the ends of [0, 1) reach the first and the last of each. */
		const draws = [0, 0, 0.999999, 0.999999];
		const lobby = await openLobby({ dir: await tempDir(), random: () => draws.shift()! });
		const first = lobby.create(ALICE, { name: 'Low', gameType: 'constructed-1v1', clientMode: 'builtin' });
		const last = lobby.create(ALICE, { name: 'High', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!first.ok || !last.ok) throw new Error('create refused');
		const familyOf = (family: string): string[] => CATALOG.filter((f) => f.family === family).map((f) => f.id);
		const order = [...new Set(CATALOG.map((f) => f.family))];
		expect(first.room.format).toBe(familyOf(order[0]!)[0]);
		expect(last.room.format).toBe(familyOf(order.at(-1)!).at(-1));
		expect(draws).toEqual([]);
		// Every body that carries a room carries it, list as well as get.
		expect(lobby.list().map((r) => r.format)).toEqual([first.room.format, last.room.format]);
		expect(lobby.get(first.room.id)?.format).toBe(first.room.format);
	});

	it('draws the family before the era, so the family with the most eras is no likelier', () => {
		const catalog = [
			{ id: '2012-07-13', family: 'standard' as const },
			{ id: '2013-07-19', family: 'standard' as const },
			{ id: '2014-07-18', family: 'standard' as const },
			{ id: 'modern-2012-07-13', family: 'modern' as const },
			{ id: 'legacy-2016-07-22', family: 'legacy' as const },
		];
		const at = (...draws: number[]) => randomFormat(() => draws.shift()!, catalog);
		// A family is a third of [0, 1) whatever its era count.
		expect(at(0, 0)).toBe('2012-07-13');
		expect(at(0.33, 0.99)).toBe('2014-07-18');
		expect(at(0.34, 0.99)).toBe('modern-2012-07-13');
		expect(at(0.67, 0)).toBe('legacy-2016-07-22');
		// Within a family, an era is a share of [0, 1) by its count.
		expect(at(0, 0.34)).toBe('2013-07-19');
		expect(randomFormat(() => 0, [])).toBe(NO_FORMAT);
	});

	it('a fixed defaultFormat wins over the draw, for every new room', async () => {
		const lobby = await openLobby({ dir: await tempDir(), defaultFormat: POOLS[0], random: () => 0.999999 });
		for (const name of ['One', 'Two']) {
			const made = lobby.create(ALICE, { name, gameType: 'constructed-1v1', clientMode: 'builtin' });
			if (!made.ok) throw new Error(made.reason);
			expect(made.room.format).toBe(POOLS[0]);
		}
	});

	/*
	 * Wave 48 §U: *"can we go backwards another 5yrs for standard decks? and
	 * then also backfill modern & legacy as well?"* Modern and Legacy eras now
	 * sit in the same catalog as Standard's, so `newestFormat` must stay the
	 * newest STANDARD era even when the catalog's last entry, by insertion
	 * order, is a Legacy or Modern one. Built against a FIXTURE
	 * `formats` list, never the real catalog, so this is true regardless of
	 * what order T's `LIBRARY` ends up declaring eras in.
	 */
	it('picks the newest STANDARD era even when a Legacy era sorts after it (w48 §U)', () => {
		const mixed = [
			{ id: '2012-07-13', family: 'standard' as const },
			{ id: '2014-07-18', family: 'standard' as const }, // the newest Standard era here
			{ id: 'modern-2012-07-13', family: 'modern' as const },
			{ id: 'legacy-2016-07-22', family: 'legacy' as const }, // the catalog's LAST entry
		];
		expect(newestFormat(mixed)).toBe('2014-07-18');
		// Pinned directly against "last element": the fixture's last entry is a
		// Legacy era, so a reverted implementation (`formats.at(-1)?.id`) would
		// answer that instead of the newest Standard one.
		expect(newestFormat(mixed)).not.toBe(mixed.at(-1)!.id);
	});

	it('answers NO_FORMAT for a catalog with no Standard era at all', () => {
		expect(newestFormat([{ id: 'modern-2012-07-13', family: 'modern' as const }])).toBe(NO_FORMAT);
		expect(newestFormat([])).toBe(NO_FORMAT);
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

describe('Lobby.setSettings', () => {
	async function twoReady(lobby: Lobby): Promise<string> {
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error(made.reason);
		expect(lobby.join(made.room.id, BOB).ok).toBe(true);
		for (const who of [ALICE, BOB]) {
			expect(lobby.setReady(made.room.id, who.id, true)).toBe(true);
			expect(lobby.setPlayerState(made.room.id, who.id, { v: 1, ready: true })).toBe(true);
		}
		return made.room.id;
	}

	it('starts a new room with hand smoothing on, in every body that carries the room', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error(made.reason);
		expect(made.room.settings).toEqual({ handSmoothing: true });
		expect(lobby.list().map((r) => r.settings)).toEqual([{ handSmoothing: true }]);
	});

	it('lets only the leader change it, and leaves every readiness flag and deck hold alone', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const id = await twoReady(lobby);
		expect(lobby.setSettings(id, BOB.id, { handSmoothing: false })).toEqual({ ok: false, reason: 'not-leader' });
		expect(lobby.setSettings('r-000000000000', ALICE.id, { handSmoothing: false })).toEqual({ ok: false, reason: 'no-room' });
		expect(lobby.get(id)?.settings.handSmoothing).toBe(true);

		const off = lobby.setSettings(id, ALICE.id, { handSmoothing: false });
		expect(off.ok && off.room.settings).toEqual({ handSmoothing: false });
		// A setting is not a deck question: nobody is stood down by it.
		expect(lobby.get(id)?.members.map((m) => m.ready)).toEqual([true, true]);
		expect(lobby.playerState(id, BOB.id)).toEqual({ v: 1, ready: true });
	});

	it('refuses a change while a draft is running', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const id = await startedDraft(lobby, [ALICE]);
		expect(lobby.setSettings(id, ALICE.id, { handSmoothing: false })).toEqual({ ok: false, reason: 'draft-started' });
	});

	it('survives a restart', async () => {
		const dir = await tempDir();
		const first = await openLobby({ dir });
		const made = first.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error(made.reason);
		expect(first.setSettings(made.room.id, ALICE.id, { handSmoothing: false }).ok).toBe(true);
		const second = await openLobby({ dir });
		expect(second.get(made.room.id)?.settings).toEqual({ handSmoothing: false });
	});

	it('reads a record written before settings existed back on the defaults', async () => {
		const dir = await tempDir();
		writeFixtureRoom(dir, 'r-presettings01', legacyApp());
		expect(Object.keys(legacyApp())).not.toContain('settings');
		const lobby = await openLobby({ dir });
		expect(lobby.get('r-presettings01')?.settings).toEqual({ handSmoothing: true });
	});

	it('quarantines a record whose settings hold a value this build does not understand', async () => {
		const dir = await tempDir();
		writeFixtureRoom(dir, 'r-dddddddddddd', legacyApp({ settings: { handSmoothing: 'yes' } }));
		writeFixtureRoom(dir, 'r-eeeeeeeeeeee', legacyApp({ settings: { psychic: true } }));
		const logged: Record<string, unknown>[] = [];
		const lobby = await openLobby({ dir, log: (e) => void logged.push(e) });
		expect(lobby.list()).toEqual([]);
		const quarantined = logged.filter((e) => e.event === 'room-quarantined');
		expect(quarantined.map((e) => String(e.reason))).toEqual([expect.stringContaining('settings'), expect.stringContaining('settings')]);
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

/* ── a match outlives the process that started it ───────────────────── */

describe("a restored room keeps its match", () => {
	it('restores the matchId written before the restart', async () => {
		const dir = await tempDir();
		// The operator's room at 01:49Z on 2026-10-17: mid-game when the deploy
		// restarted the server, and play adopted the match a moment later.
		writeFixtureRoom(dir, 'r-played0000001', legacyApp({ name: 'test 1v1', matchId: 'm-b2853c882395' }));

		const lobby = await openLobby({ dir });
		expect(lobby.get('r-played0000001')?.matchId).toBe('m-b2853c882395');
		expect(lobby.list()[0]?.matchId).toBe('m-b2853c882395');
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

/*
 * The avatar a friend picked in watchparty's room (item 4 of the 2026-09-28 play
 * test: *"i noticed you're still not pulling in the watchparty selected avatars.
 * why not?"*).
 *
 * `@wolffm/rooms-protocol` types the field `avatarId?: string | null`, which is
 * THREE states, and they do not mean the same thing:
 *
 *   absent  the member never set one
 *   null    it was explicitly cleared upstream
 *   string  a real character id
 *
 * The rule this lobby settled on, and the reason it is a test rather than a
 * comment: **three states in, two states out.** `setAvatar` accepts all three —
 * a string sets, `null` clears, and `''`/whitespace/over-long read as a clear —
 * and every view it answers with carries either a non-blank string or NO KEY AT
 * ALL. `null` collapses to absent because to anything drawing a face they are
 * the same instruction, and an EMPTY STRING must never leave here: it survives a
 * `!== undefined` check and then resolves to a sprite URL ending `square_.png`.
 *
 * `toHaveProperty` rather than `toBeUndefined`, throughout. These are in-process
 * `RoomView` objects, and `avatarId: undefined` satisfies `toBeUndefined()` while
 * being precisely the shape that makes an object reader and a JSON reader
 * disagree about whether the member has an avatar.
 */
describe('a member\'s avatar', () => {
	const avatarOf = (room: RoomView | undefined, memberId: string) =>
		room?.members.find((m) => m.id === memberId);

	it('is handed out on joining, the first character no member wears, and a pick replaces it on every view of the room', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		// A member who has never picked one wears the room's first free character,
		// on the create result and on every later read.
		expect(made.room.members[0]?.avatarId).toBe('sage');
		expect(lobby.join(made.room.id, BOB).ok).toBe(true);
		expect(lobby.join(made.room.id, CAROL).ok).toBe(true);
		expect(lobby.get(made.room.id)?.members.map((m) => m.avatarId)).toEqual(['sage', 'herald', 'cleric']);

		expect(lobby.setAvatar(made.room.id, ALICE.id, 'wanderer')).toBe(true);
		expect(avatarOf(lobby.get(made.room.id), ALICE.id)?.avatarId).toBe('wanderer');
		// `list()` and `get()` are two builders of the same view; the field has to
		// be on both or the front page and the room screen disagree.
		expect(avatarOf(lobby.list()[0], ALICE.id)?.avatarId).toBe('wanderer');
	});

	it('tells a subscriber when it CHANGES, and stays quiet for a re-assert (Q6)', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Live', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		const heard: unknown[] = [];
		const off = lobby.onAvatarChange((c) => heard.push(c));
		lobby.setAvatar(made.room.id, ALICE.id, 'mage');
		lobby.setAvatar(made.room.id, ALICE.id, 'mage');
		lobby.setAvatar(made.room.id, ALICE.id, null);
		expect(heard).toEqual([
			{ roomId: made.room.id, memberId: ALICE.id, avatarId: 'mage' },
			{ roomId: made.room.id, memberId: ALICE.id, avatarId: null },
		]);
		off();
		lobby.setAvatar(made.room.id, ALICE.id, 'rogue');
		expect(heard).toHaveLength(2);
	});

	it('is each member\'s own — setting one leaves everybody else alone', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Two of us', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		expect(lobby.join(made.room.id, BOB).ok).toBe(true);

		expect(lobby.setAvatar(made.room.id, BOB.id, 'rogue')).toBe(true);
		expect(avatarOf(lobby.get(made.room.id), BOB.id)?.avatarId).toBe('rogue');
		expect(avatarOf(lobby.get(made.room.id), ALICE.id)?.avatarId).toBe('sage');
	});

	it('moves a handed-out character to the next free one when another member picks it, and never moves a pick', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Picks', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		const id = made.room.id;
		expect(lobby.join(id, BOB).ok).toBe(true);
		const heard: unknown[] = [];
		lobby.onAvatarChange((c) => heard.push(c));

		// Bob picks alice's handed-out sage: he wears it, she is handed the next free.
		expect(lobby.setAvatar(id, BOB.id, 'sage')).toBe(true);
		expect(avatarOf(lobby.get(id), BOB.id)?.avatarId).toBe('sage');
		expect(avatarOf(lobby.get(id), ALICE.id)?.avatarId).toBe('herald');
		expect(heard).toEqual([
			{ roomId: id, memberId: BOB.id, avatarId: 'sage' },
			{ roomId: id, memberId: ALICE.id, avatarId: 'herald' },
		]);

		// Alice picks; bob then picking hers takes nothing from her.
		expect(lobby.setAvatar(id, ALICE.id, 'knight')).toBe(true);
		expect(lobby.setAvatar(id, BOB.id, 'knight')).toBe(true);
		expect(lobby.get(id)?.members.map((m) => m.avatarId)).toEqual(['knight', 'knight']);
	});

	it('is handed out only while a character is free, and a leaver frees theirs', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const callers = [ALICE, BOB, CAROL, ...Array.from({ length: AVATAR_POOL.length - 2 }, (_, i) => ({ id: `fk:${String(i + 4).repeat(16).slice(0, 16)}`, name: `user-${i + 4}` }))];
		const made = lobby.create(callers[0]!, { name: 'Crowd', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		const id = made.room.id;
		for (const c of callers.slice(1)) expect(lobby.join(id, c).ok).toBe(true);
		const members = lobby.get(id)?.members ?? [];
		expect(members.slice(0, AVATAR_POOL.length).map((m) => m.avatarId)).toEqual([...AVATAR_POOL]);
		// One more member than characters: they go without, as in watchparty.
		expect(members[AVATAR_POOL.length]).not.toHaveProperty('avatarId');

		lobby.leave(id, BOB.id);
		const late = { id: 'fk:eeeeeeeeeeeeeeee', name: 'user-late' };
		expect(lobby.join(id, late).ok).toBe(true);
		expect(avatarOf(lobby.get(id), late.id)?.avatarId).toBe('herald');
	});

	it('survives a restart, because it is persisted beside the name and not in the opaque blob', async () => {
		const dir = await tempDir();
		const first = await openLobby({ dir });
		const made = first.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		expect(first.join(made.room.id, BOB).ok).toBe(true);
		expect(first.setAvatar(made.room.id, ALICE.id, 'knight')).toBe(true);

		// Room-store's `SerializedMember.avatarId` is what carries it; nothing in
		// the per-member `app` blob does, so this also pins that the field went to
		// the right half of the snapshot.
		const second = await openLobby({ dir });
		expect(avatarOf(second.get(made.room.id), ALICE.id)?.avatarId).toBe('knight');
		// A handed-out one is persisted the same way: bob keeps his face across a deploy.
		expect(avatarOf(second.get(made.room.id), BOB.id)?.avatarId).toBe('herald');
	});

	it('folds null and every blank spelling to ABSENT, never to an empty string', async () => {
		const dir = await tempDir();
		const lobby = await openLobby({ dir });
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		const id = made.room.id;

		for (const blank of ['', '   ', '\t', 'x'.repeat(AVATAR_ID_MAX + 1)]) {
			expect(lobby.setAvatar(id, ALICE.id, blank), blank).toBe(true);
			expect(avatarOf(lobby.get(id), ALICE.id), blank).not.toHaveProperty('avatarId');
		}

		// And `null` on a member who HAS one clears it back to absent rather than
		// to a third state — the whole reason this collapse is a decision and not
		// an oversight.
		expect(lobby.setAvatar(id, ALICE.id, 'mage')).toBe(true);
		expect(avatarOf(lobby.get(id), ALICE.id)?.avatarId).toBe('mage');
		expect(lobby.setAvatar(id, ALICE.id, null)).toBe(true);
		expect(avatarOf(lobby.get(id), ALICE.id)).not.toHaveProperty('avatarId');
		// Cleared on disk too. A clear that only happened in memory would come
		// back wearing the old face after the next deploy.
		const second = await openLobby({ dir });
		expect(avatarOf(second.get(id), ALICE.id)).not.toHaveProperty('avatarId');
	});

	it('is trimmed, and is NOT checked against watchparty\'s eight characters', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		expect(lobby.setAvatar(made.room.id, ALICE.id, '  cleric  ')).toBe(true);
		expect(avatarOf(lobby.get(made.room.id), ALICE.id)?.avatarId).toBe('cleric');

		// A ninth character watchparty adds must reach our seats rather than be
		// dropped by a list nobody remembered to update. Their own schema is
		// `z.string().min(1).max(32)`, not an enum, and so is this.
		expect(lobby.setAvatar(made.room.id, ALICE.id, 'necromancer')).toBe(true);
		expect(avatarOf(lobby.get(made.room.id), ALICE.id)?.avatarId).toBe('necromancer');
		expect(lobby.setAvatar(made.room.id, ALICE.id, 'x'.repeat(AVATAR_ID_MAX))).toBe(true);
		expect(avatarOf(lobby.get(made.room.id), ALICE.id)?.avatarId).toBe('x'.repeat(AVATAR_ID_MAX));
	});

	it('refuses a room that does not exist and a caller who is not a member', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		expect(lobby.setAvatar('r-nosuchroom', ALICE.id, 'mage')).toBe(false);
		expect(lobby.setAvatar(made.room.id, CAROL.id, 'mage')).toBe(false);
		// Nothing was invented for the non-member either.
		expect(lobby.get(made.room.id)?.members.map((m) => m.id)).toEqual([ALICE.id]);
	});

	it('reads an empty string stored by some other build back as ABSENT', async () => {
		const dir = await tempDir();
		// A snapshot this build would never write: room-store's field carries the
		// value, and a looser writer could put `''` in it. The restore path
		// re-normalises rather than trusting the file, so the one value that must
		// never reach a client cannot arrive from disk either.
		const snapshot: RoomSnapshot = {
			storeVersion: STORE_VERSION,
			roomId: 'r-blankavatar',
			roomKey: 'r-blankavatar',
			lastEventSeq: 0,
			createdAt: 1_700_000_000_000,
			updatedAt: 1_700_000_000_000,
			members: [
				{ participantId: ALICE.id, joinedAt: 1, lastSeen: 1, name: ALICE.name, avatarId: '', app: null },
				{ participantId: BOB.id, joinedAt: 2, lastSeen: 2, name: BOB.name, avatarId: 'herald', app: null },
			],
			usedAvatars: [],
			clientNames: {},
			seats: createSeatTable(null),
			app: legacyApp(),
			appVersion: 1,
		};
		new FileRoomStore(dir).saveSync(snapshot);

		const lobby = await openLobby({ dir });
		expect(avatarOf(lobby.get('r-blankavatar'), ALICE.id)).not.toHaveProperty('avatarId');
		expect(avatarOf(lobby.get('r-blankavatar'), BOB.id)?.avatarId).toBe('herald');
	});
});

/* ── R16: a room lets go of a finished match, and a member can leave ───── */

describe('Lobby.releaseMatch', () => {
	it('clears matchId and un-readies every member, keeping their table state (the deck a Rematch plays) — idempotent, false only for no such room', async () => {
		const dir = await tempDir();
		const lobby = await openLobby({ dir });
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'streamed' });
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		const id = made.room.id;
		expect(lobby.join(id, BOB).ok).toBe(true);
		for (const who of [ALICE, BOB]) {
			expect(lobby.setReady(id, who.id, true)).toBe(true);
			expect(lobby.setPlayerState(id, who.id, { v: 1, deck: 'mono-red', ready: true })).toBe(true);
		}
		expect(lobby.setMatch(id, 'm-finished')).toBe(true);

		expect(lobby.releaseMatch('r-000000000000')).toBe(false);
		expect(lobby.releaseMatch(id)).toBe(true);

		expect(lobby.get(id)?.matchId).toBeNull();
		expect(lobby.get(id)?.members.map((m) => m.ready)).toEqual([false, false]);
		// The table state is opaque here and kept whole: `http/routes.ts` owns
		// its `ready`, and spent it when the match started.
		expect(lobby.playerState(id, ALICE.id)).toEqual({ v: 1, deck: 'mono-red', ready: true });
		expect(lobby.playerState(id, BOB.id)).toEqual({ v: 1, deck: 'mono-red', ready: true });
		// Nothing else about the room moved — not even the field this exists to
		// prove is immutable everywhere else.
		expect(lobby.get(id)?.clientMode).toBe('streamed');

		// Idempotent: a room with no match left to release does nothing and
		// still answers true.
		expect(lobby.releaseMatch(id)).toBe(true);

		// Persisted, so a restart does not resurrect the finished match.
		const second = await openLobby({ dir });
		expect(second.get(id)?.matchId).toBeNull();
	});
});

describe('Lobby.leave', () => {
	it('removes the member and drops their hold with them; refuses a non-member and a missing room', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		const id = made.room.id;
		expect(lobby.join(id, BOB).ok).toBe(true);
		expect(lobby.setPlayerState(id, BOB.id, { deck: 'mono-red' })).toBe(true);
		expect(lobby.setReady(id, BOB.id, true)).toBe(true);

		expect(lobby.leave(id, CAROL.id)).toEqual({ ok: false, reason: 'not-member' });
		expect(lobby.leave('r-000000000000', ALICE.id)).toEqual({ ok: false, reason: 'no-room' });
		// Neither refusal touched anything.
		expect(lobby.get(id)?.members).toHaveLength(2);

		const left = lobby.leave(id, BOB.id);
		expect(left.ok).toBe(true);
		if (!left.ok) return;
		expect(left.room.members.map((m) => m.id)).toEqual([ALICE.id]);
		expect(lobby.isMember(id, BOB.id)).toBe(false);
		// Bob's hold and readiness left WITH him, not merely hidden behind his
		// missing membership.
		expect(lobby.playerState(id, BOB.id)).toBeUndefined();

		// And it is persisted: a restart does not bring him back.
		expect(lobby.get(id)?.members).toHaveLength(1);
	});

	it('hands leadership to whoever remains and joined EARLIEST, not to array order', async () => {
		let clock = 1_900_000_000_000;
		const lobby = await openLobby({ dir: await tempDir(), now: () => clock });
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		const id = made.room.id;
		// CAROL joins before BOB, so if ALICE leaves, CAROL leads — even though a
		// "next in the array" rule and a "joined earliest" rule agree here only
		// because join order and array order are the same thing today.
		clock += 1000;
		expect(lobby.join(id, CAROL).ok).toBe(true);
		clock += 1000;
		expect(lobby.join(id, BOB).ok).toBe(true);

		const left = lobby.leave(id, ALICE.id);
		expect(left.ok).toBe(true);
		if (!left.ok) return;
		expect(left.room.leader).toBe(CAROL.id);
		expect(lobby.get(id)?.leader).toBe(CAROL.id);

		// A non-leader leaving changes nothing about who leads.
		const second = lobby.leave(id, BOB.id);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.room.leader).toBe(CAROL.id);
	});

	it('is hidden from offered() the instant the last member leaves — no stale wait, no deletion', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		const id = made.room.id;
		expect(lobby.offered().map((r) => r.id)).toEqual([id]);

		const left = lobby.leave(id, ALICE.id);
		expect(left.ok).toBe(true);
		if (!left.ok) return;
		expect(left.room.members).toEqual([]);

		// Gone from the front page at once — not after ROOM_STALE_MS, not after
		// ROOM_IDLE_MS.
		expect(lobby.offered().map((r) => r.id)).toEqual([]);
		// But not deleted: `get` still finds it, and the ordinary idle sweep
		// still owns reaping it.
		expect(lobby.get(id)).not.toBeUndefined();
		expect(lobby.list().map((r) => r.id)).toEqual([id]);
	});
});

describe('Lobby.offered', () => {
	/*
	 * Wave 31. Rooms restore on boot and live `ROOM_IDLE_MS`, and the list shows a
	 * room's STORED members, so a dead table looked alive. The rule: a room nobody
	 * has touched or polled for `ROOM_STALE_MS` (30 minutes) is not offered.
	 */
	it('drops a restored room untouched for ROOM_STALE_MS and keeps a fresh one', async () => {
		const dir = await tempDir();
		const now = 2_500_000_000_000;
		writeFixtureRoom(dir, 'r-dead000000001', legacyApp({ name: 'hi there' }), now - ROOM_STALE_MS - 1);
		writeFixtureRoom(dir, 'r-live000000002', legacyApp({ name: 'tonight' }), now - ROOM_STALE_MS + 60_000);

		const lobby = await openLobby({ dir, now: () => now });
		expect(lobby.list().map((r) => r.id).sort()).toEqual(['r-dead000000001', 'r-live000000002']);
		expect(lobby.offered().map((r) => r.id)).toEqual(['r-live000000002']);
	});

	it('counts a member\'s poll as a touch, and nobody else\'s', async () => {
		const dir = await tempDir();
		const now = 2_600_000_000_000;
		writeFixtureRoom(dir, 'r-dead000000001', legacyApp({ name: 'hi there' }), now - ROOM_STALE_MS - 1);
		const lobby = await openLobby({ dir, now: () => now });

		lobby.touch('r-dead000000001', BOB.id);
		expect(lobby.offered()).toEqual([]);
		lobby.touch('r-dead000000001', ALICE.id);
		expect(lobby.offered().map((r) => r.id)).toEqual(['r-dead000000001']);
	});

	it('resolves a match id to its room', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'tonight', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		expect(lobby.roomOfMatch('m-1')).toBeUndefined();
		lobby.setMatch(made.room.id, 'm-1');
		expect(lobby.roomOfMatch('m-1')?.id).toBe(made.room.id);
	});

	it('still resolves a match after the room let go of it, after a rematch, and after a restart', async () => {
		// The operator's rematch (r-cae3103a30ac): one result screen asked which room its match was in
		// after the other screen's read had released it, found none, and greyed Rematch out.
		const dir = await tempDir();
		const lobby = await openLobby({ dir });
		const made = lobby.create(ALICE, { name: 'tonight', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		lobby.setMatch(made.room.id, 'm-first0000001');
		lobby.releaseMatch(made.room.id);
		expect(lobby.get(made.room.id)?.matchId).toBeNull();
		expect(lobby.roomOfMatch('m-first0000001')?.id, 'released').toBe(made.room.id);
		lobby.setMatch(made.room.id, 'm-second000001');
		expect(lobby.roomOfMatch('m-first0000001')?.id, 'after the rematch started').toBe(made.room.id);

		const rebooted = await openLobby({ dir });
		expect(rebooted.get(made.room.id)?.matchId, 'a restart restores the current match').toBe('m-second000001');
		expect(rebooted.roomOfMatch('m-first0000001')?.id, 'after a restart').toBe(made.room.id);
		expect(rebooted.roomOfMatch('m-second000001')?.id).toBe(made.room.id);
	});

	it(`remembers a room's last ${ROOM_MATCHES_KEPT} matches, and no more`, async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'tonight', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		for (let i = 0; i <= ROOM_MATCHES_KEPT; i += 1) lobby.setMatch(made.room.id, `m-${String(i).padStart(12, '0')}`);
		expect(lobby.roomOfMatch(`m-${'0'.repeat(12)}`), 'the oldest is forgotten').toBeUndefined();
		expect(lobby.roomOfMatch(`m-${String(1).padStart(12, '0')}`)?.id).toBe(made.room.id);
	});
});

/* ── what the room feed pushes from ──────────────────────────────────── */

describe('Lobby.onChange', () => {
	it('names the room on every write — create, join, ready, deck, match, release, leave — and never on a read', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const heard: string[] = [];
		const stop = lobby.onChange((id) => heard.push(id));
		const made = lobby.create(ALICE, { name: 'tonight', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		expect(heard).toEqual([id]);

		lobby.join(id, BOB);
		lobby.setReady(id, BOB.id, true);
		lobby.setPlayerState(id, ALICE.id, { deck: 'x' });
		lobby.setMatch(id, 'm-000000000001');
		lobby.releaseMatch(id);
		lobby.leave(id, BOB.id);
		expect(heard).toHaveLength(7);
		expect(new Set(heard)).toEqual(new Set([id]));

		lobby.get(id);
		lobby.list();
		lobby.offered();
		lobby.touch(id, ALICE.id);
		lobby.roomOfMatch('m-000000000001');
		lobby.releaseMatch(id);
		expect(heard, 'reads, and a release with nothing to release, are not changes').toHaveLength(7);

		stop();
		lobby.setReady(id, ALICE.id, true);
		expect(heard, 'unsubscribed').toHaveLength(7);
	});

	it('names a room the sweep forgets', async () => {
		let clock = 4_000_000_000_000;
		const lobby = await openLobby({ dir: await tempDir(), now: () => clock });
		const made = lobby.create(ALICE, { name: 'tonight', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const heard: string[] = [];
		lobby.onChange((id) => heard.push(id));
		clock += ROOM_IDLE_MS + 1;
		expect(lobby.sweep()).toEqual([made.room.id]);
		expect(heard).toEqual([made.room.id]);
	});

	it('a listener that throws does not undo the write or stop the next listener', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const heard: string[] = [];
		lobby.onChange(() => {
			throw new Error('broken subscriber');
		});
		lobby.onChange((id) => heard.push(id));
		const made = lobby.create(ALICE, { name: 'tonight', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		expect(heard).toEqual([made.room.id]);
		expect(lobby.get(made.room.id)?.name).toBe('tonight');
	});
});

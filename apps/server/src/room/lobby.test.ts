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
import { createSeatTable, humanSeats } from '@wolffm/rooms-protocol';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { poolFixturePath, type LibraryCollection } from '@hadoku/deck/library';
import { loadTablesLibrary } from '../http/library.ts';
import { createDraftRooms } from './draftRooms.ts';
import type { Tournament } from './tournaments.ts';
import { loadPool } from './pool.ts';
import { POD_SEATS } from '@hadoku/shared';
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
	POD_AI,
	randomFormat,
	POD_SPARED_MS,
	ROOM_IDLE_MS,
	ROOM_MATCHES_KEPT,
	ROOM_STALE_MS,
	type ClientMode,
	type Lobby,
	type PodChecks,
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

/** The cube the app ships with — for the one test that drives a REAL `DraftRooms` off `podHumans` (wave 72 §P). */
const CUBE_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../ui/src/draft/pool.json');

/** A draft room with `members` in it, all of them ready, and its draft started. */
async function startedDraft(lobby: Lobby, members: Array<{ id: string; name: string }> = [ALICE]): Promise<string> {
	const made = lobby.create(members[0], { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
	expect(made.ok).toBe(true);
	if (!made.ok) throw new Error(made.reason);
	for (const member of members.slice(1)) expect(lobby.join(made.room.id, member).ok).toBe(true);
	for (const member of members) expect(lobby.setReady(made.room.id, member.id, true)).toBe(true);
	fillWithAi(lobby, made.room.id, members[0].id);
	const started = lobby.startDraft(made.room.id, members[0].id);
	expect(started.ok).toBe(true);
	return made.room.id;
}

/** The AI button on every open pod seat: the draft deals only once none is open. */
function fillWithAi(lobby: Lobby, roomId: string, by: string): void {
	const seats = lobby.get(roomId)?.pod?.seats ?? [];
	seats.forEach((occupant, seat) => {
		if (occupant === null) expect(lobby.aiPod(roomId, by, seat, true).ok).toBe(true);
	});
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
		const migratedTable = first.get('r-bbbbbbbbbbbb')!.tables[0]!.id;
		expect(first.setTableMatch('r-bbbbbbbbbbbb', migratedTable, 'match-1')).toBe(true);
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
		expect(lobby.setTableMatch(id, lobby.get(id)!.tables[0]!.id, 'match-7')).toBe(true);
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
		expect(newestFormat(CATALOG)).toBe(POOLS[POOLS.length - 1]);
		expect(newestFormat(CATALOG)).not.toBe(POOLS[0]);
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
		const lobby = await openLobby({ dir: await tempDir(), random: () => draws.shift()!, formats: CATALOG });
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

	/*
	 * A pool fixture that will not parse is a `fault` of the server's library, not
	 * one of its `formats` — and the lobby draws from those same `formats`, so no
	 * room ever opens on, or restores onto, an era the tables routes cannot serve.
	 */
	it('never opens or restores a room on an era whose pool fixture failed to parse', async () => {
		const root = await tempDir();
		mkdirSync(join(root, 'decks', 'pools'), { recursive: true });
		const fixture = (date: string) => ({ date, name: `Test (${date})`, effective: date, source: 'test', sets: ['AAA'], banned: [], cards: ['Test Card'], manaCost: {}, colors: {} });
		writeFileSync(join(root, poolFixturePath('2012-07-13', 'standard')), JSON.stringify(fixture('2012-07-13')));
		writeFileSync(join(root, poolFixturePath('2014-07-18', 'standard')), '{ not json');
		const collection = (date: string): LibraryCollection => ({ id: `fx-${date}`, directory: `decks/fx-${date}`, event: date, format: date, date, source: 'test', decks: [], family: 'standard' });
		const library = loadTablesLibrary(root, [collection('2012-07-13'), collection('2014-07-18')]);
		expect(library.faults).toHaveLength(1);
		expect(library.faults[0]).toContain('2014-07-18');

		const dir = await tempDir();
		writeFixtureRoom(dir, 'before-format', legacyApp());
		// The top of [0, 1) is the catalog's last era — the broken one, were it offered.
		const lobby = await openLobby({ dir, random: () => 0.999999, formats: library.formats });
		const made = lobby.create(ALICE, { name: 'Fresh', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error(made.reason);
		expect(made.room.format).toBe('2012-07-13');
		expect(lobby.get('before-format')?.format).toBe('2012-07-13');
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
		expect(lobby.setTableMatch('r-preformat0001', lobby.get('r-preformat0001')!.tables[0]!.id, 'm-1')).toBe(true);
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
		expect(made.room.settings).toEqual({ handSmoothing: true, matchLength: 'bo1', sideboarding: false });
		expect(lobby.list().map((r) => r.settings)).toEqual([{ handSmoothing: true, matchLength: 'bo1', sideboarding: false }]);
	});

	it('lets only the leader change it, and leaves every readiness flag and deck hold alone', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const id = await twoReady(lobby);
		expect(lobby.setSettings(id, BOB.id, { handSmoothing: false })).toEqual({ ok: false, reason: 'not-leader' });
		expect(lobby.setSettings('r-000000000000', ALICE.id, { handSmoothing: false })).toEqual({ ok: false, reason: 'no-room' });
		expect(lobby.get(id)?.settings.handSmoothing).toBe(true);

		const off = lobby.setSettings(id, ALICE.id, { handSmoothing: false });
		expect(off.ok && off.room.settings).toEqual({ handSmoothing: false, matchLength: 'bo1', sideboarding: false });
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
		expect(second.get(made.room.id)?.settings).toEqual({ handSmoothing: false, matchLength: 'bo1', sideboarding: false });
	});

	it('reads a record written before settings existed back on the defaults', async () => {
		const dir = await tempDir();
		writeFixtureRoom(dir, 'r-presettings01', legacyApp());
		expect(Object.keys(legacyApp())).not.toContain('settings');
		const lobby = await openLobby({ dir });
		expect(lobby.get('r-presettings01')?.settings).toEqual({ handSmoothing: true, matchLength: 'bo1', sideboarding: false });
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
		// Everyone seated is ready, and six seats are still open: no deal with an open seat.
		expect(lobby.startDraft(draft.room.id, BOB.id)).toEqual({ ok: false, reason: 'not-ready' });
		fillWithAi(lobby, draft.room.id, BOB.id);
		const started = lobby.startDraft(draft.room.id, BOB.id);
		expect(started.ok).toBe(true);
		// ANY member may start it, not only the leader: both browsers ask and the
		// server answers one start to both.
		if (!started.ok) return;
		expect(typeof started.room.draftStartedAt).toBe('string');
	});

	it('starts for one member who readied alone, with the AI in every other seat', async () => {
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

/* ── a live draft is not swept, and survives a restart ──────────────── */

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
		// A pod survives restarts, so the spare ends with its age: a day on, it ages out like any room.
		clock += POD_SPARED_MS;
		expect(lobby.sweep()).toEqual([drafting]);
	});

	// The audit of 2026-10-19: every deploy wiped a running pod, though the draft
	// itself has been on disk since P6 (`draftRooms.ts`'s snapshots).
	it('resumes after a restart — the draft, who pressed Play, and the rounds', async () => {
		const dir = await tempDir();
		const checks = fakeChecks({ draftComplete: true, built: new Set([ALICE.id, BOB.id]) });
		const first = await openLobby({ dir });
		const made = first.create(ALICE, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		expect(first.join(id, BOB).ok).toBe(true);
		expect(first.sitPod(id, ALICE.id, 0).ok).toBe(true);
		expect(first.sitPod(id, BOB.id, 1).ok).toBe(true);
		for (const m of [ALICE, BOB]) expect(first.setReady(id, m.id, true)).toBe(true);
		fillWithAi(first, id, ALICE.id);
		expect(first.startDraft(id, ALICE.id).ok).toBe(true);
		first.setPodChecks(checks);
		expect(first.playPod(id, ALICE.id).ok).toBe(true);
		expect(first.get(id)?.pod?.phase).toBe('building');

		// Mid-build: Alice's Play survives, so Bob's is the one that deals round 1.
		const second = await openLobby({ dir });
		second.setPodChecks(checks);
		expect(second.get(id)?.draftStartedAt).not.toBeNull();
		expect(second.get(id)?.pod?.phase).toBe('building');
		expect(second.get(id)?.pod?.built).toEqual([ALICE.id]);
		expect(second.playPod(id, BOB.id).ok).toBe(true);
		expect(second.get(id)?.pod?.phase).toBe('rounds');

		// Mid-rounds: the round and its pairing come back.
		const third = await openLobby({ dir });
		third.setPodChecks(checks);
		expect(third.get(id)?.pod).toMatchObject({ phase: 'rounds', round: 1 });
		expect(third.get(id)?.pod?.pairings).toEqual(second.get(id)?.pod?.pairings);
		expect(third.releaseLostDrafts(() => true)).toEqual([]);
	});

	it('goes back to its lobby, ready flags intact, when its draft did not come back', async () => {
		const dir = await tempDir();
		const first = await openLobby({ dir });
		const id = await startedDraft(first, [ALICE, BOB]);

		const second = await openLobby({ dir });
		expect(second.releaseLostDrafts(() => false)).toEqual([id]);
		expect(second.get(id)?.draftStartedAt).toBeNull();
		expect(second.get(id)?.members.map((m) => m.ready)).toEqual([true, true]);
		expect(second.get(id)?.gameType).toBe('draft');
		// Released on disk too, and sweepable again, so sparing a live draft cannot make a room immortal.
		const third = await openLobby({ dir, now: () => Date.now() + ROOM_IDLE_MS + 1 });
		expect(third.get(id)?.draftStartedAt).toBeNull();
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

/* ── R16: a table lets go of a finished match, and a member can leave ───── */

describe('Lobby.releaseTableMatch', () => {
	it('clears matchId and un-readies only the table\'s own seated members, keeping their table state (the deck a Rematch plays) — idempotent, false only for no such room or table', async () => {
		const dir = await tempDir();
		const lobby = await openLobby({ dir });
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'streamed' });
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		const id = made.room.id;
		const tableId = made.room.tables[0]!.id;
		expect(lobby.join(id, BOB).ok).toBe(true);
		for (const who of [ALICE, BOB]) {
			expect(lobby.setReady(id, who.id, true)).toBe(true);
			expect(lobby.setPlayerState(id, who.id, { v: 1, deck: 'mono-red', ready: true })).toBe(true);
		}
		expect(lobby.setTableSeats(id, tableId, [ALICE.id, BOB.id])).toBe(true);
		expect(lobby.setTableMatch(id, tableId, 'm-finished')).toBe(true);

		expect(lobby.releaseTableMatch('r-000000000000', tableId)).toBe(false);
		expect(lobby.releaseTableMatch(id, 'not-a-table')).toBe(false);
		expect(lobby.releaseTableMatch(id, tableId)).toBe(true);

		expect(lobby.get(id)?.matchId).toBeNull();
		expect(lobby.get(id)?.members.map((m) => m.ready)).toEqual([false, false]);
		// The table state is opaque here and kept whole: `http/routes.ts` owns
		// its `ready`, and spent it when the match started.
		expect(lobby.playerState(id, ALICE.id)).toEqual({ v: 1, deck: 'mono-red', ready: true });
		expect(lobby.playerState(id, BOB.id)).toEqual({ v: 1, deck: 'mono-red', ready: true });
		// Nothing else about the room moved — not even the field this exists to
		// prove is immutable everywhere else.
		expect(lobby.get(id)?.clientMode).toBe('streamed');

		// Idempotent: a table with no match left to release does nothing and
		// still answers true.
		expect(lobby.releaseTableMatch(id, tableId)).toBe(true);

		// Persisted, so a restart does not resurrect the finished match.
		const second = await openLobby({ dir });
		expect(second.get(id)?.matchId).toBeNull();
	});

	it('un-readies only the FINISHED table\'s members, not a second table\'s, in the same room', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Big room', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		const table1 = made.room.tables[0]!.id;
		expect(lobby.join(id, BOB).ok).toBe(true);
		expect(lobby.join(id, CAROL).ok).toBe(true);
		const added = lobby.addTable(id, ALICE.id);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const table2 = added.table.id;

		expect(lobby.setReady(id, ALICE.id, true)).toBe(true);
		expect(lobby.setReady(id, BOB.id, true)).toBe(true);
		expect(lobby.setReady(id, CAROL.id, true)).toBe(true);
		expect(lobby.setTableSeats(id, table1, [ALICE.id, BOB.id])).toBe(true);
		expect(lobby.setTableSeats(id, table2, [CAROL.id, null])).toBe(true);
		expect(lobby.setTableMatch(id, table1, 'm-table-1')).toBe(true);

		expect(lobby.releaseTableMatch(id, table1)).toBe(true);
		const after = lobby.get(id);
		expect(after?.members.find((m) => m.id === ALICE.id)?.ready).toBe(false);
		expect(after?.members.find((m) => m.id === BOB.id)?.ready).toBe(false);
		expect(after?.members.find((m) => m.id === CAROL.id)?.ready, 'not at the table that released').toBe(true);
	});
});

describe('Lobby.recordGameResult — the bo1/bo3 series transition (§D bullet 3)', () => {
	/** A room with two members, the first table seated and a game under way. */
	async function playingTable(matchLength?: 'bo1' | 'bo3') {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		const tableId = made.room.tables[0]!.id;
		expect(lobby.join(id, BOB).ok).toBe(true);
		if (matchLength !== undefined) expect(lobby.setSettings(id, ALICE.id, { matchLength }).ok).toBe(true);
		expect(lobby.setTableSeats(id, tableId, [ALICE.id, BOB.id])).toBe(true);
		expect(lobby.setTableMatch(id, tableId, 'm-game-1')).toBe(true);
		return { lobby, id, tableId };
	}

	it('bo1: one decided game ends the series at once, phase done, no sideboarding step', async () => {
		const { lobby, id, tableId } = await playingTable('bo1');
		const result = lobby.recordGameResult(id, tableId, { matchId: 'm-game-1', winner: 0 });
		expect(result).toMatchObject({ ok: true, phase: 'done' });
		const table = lobby.get(id)?.tables[0];
		expect(table).toMatchObject({ matchId: null, series: { length: 1, wins: [1, 0], phase: 'done' } });
		expect(table?.series.games).toEqual([{ matchId: 'm-game-1', winner: 0 }]);
	});

	it('bo3: nobody has two wins yet, so a decided game goes straight to sideboarding — no Rematch press needed', async () => {
		const { lobby, id, tableId } = await playingTable('bo3');
		const result = lobby.recordGameResult(id, tableId, { matchId: 'm-game-1', winner: 1 });
		expect(result).toMatchObject({ ok: true, phase: 'sideboarding' });
		const table = lobby.get(id)?.tables[0];
		expect(table).toMatchObject({ matchId: null, series: { length: 3, wins: [0, 1], phase: 'sideboarding' } });
	});

	it('bo3: the second win for the SAME seat ends the series 2–0, phase done', async () => {
		const { lobby, id, tableId } = await playingTable('bo3');
		lobby.recordGameResult(id, tableId, { matchId: 'm-game-1', winner: 1 });
		expect(lobby.setTableMatch(id, tableId, 'm-game-2')).toBe(true);
		// Continuing a series (from `sideboarding`) does not reset wins/games.
		expect(lobby.get(id)?.tables[0]?.series).toMatchObject({ wins: [0, 1], phase: 'playing' });
		const result = lobby.recordGameResult(id, tableId, { matchId: 'm-game-2', winner: 1 });
		expect(result).toMatchObject({ ok: true, phase: 'done' });
		expect(lobby.get(id)?.tables[0]?.series).toMatchObject({ wins: [0, 2], phase: 'done' });
		expect(lobby.get(id)?.tables[0]?.series.games).toHaveLength(2);
	});

	it('a game with no attributable winner is recorded with winner null and still advances the phase', async () => {
		const { lobby, id, tableId } = await playingTable('bo1');
		const result = lobby.recordGameResult(id, tableId, { matchId: 'm-game-1', winner: null });
		expect(result).toMatchObject({ ok: true, phase: 'done' });
		expect(lobby.get(id)?.tables[0]?.series).toMatchObject({ wins: [0, 0] });
	});

	it('a new series (Rematch after done) resets wins and games and re-snapshots the length', async () => {
		const { lobby, id, tableId } = await playingTable('bo1');
		lobby.recordGameResult(id, tableId, { matchId: 'm-game-1', winner: 0 });
		// The leader switches the room to bo3 between series — the NEXT series is
		// sized by the setting as it stands when that series starts, not when
		// the room was created.
		expect(lobby.setSettings(id, ALICE.id, { matchLength: 'bo3' }).ok).toBe(true);
		expect(lobby.setTableMatch(id, tableId, 'm-game-2')).toBe(true);
		expect(lobby.get(id)?.tables[0]?.series).toMatchObject({ length: 3, wins: [0, 0], games: [], phase: 'playing' });
	});

	it('false only for no such room or table', async () => {
		const { lobby, id } = await playingTable('bo1');
		expect(lobby.recordGameResult('r-000000000000', 'anything', { matchId: 'm-x', winner: 0 })).toEqual({ ok: false, reason: 'no-room' });
		expect(lobby.recordGameResult(id, 'not-a-table', { matchId: 'm-x', winner: 0 })).toEqual({ ok: false, reason: 'no-such-table' });
	});
});

describe('Lobby.beginSideboarding — the Rematch gesture into a bo1 sideboard step (§D bullet 3)', () => {
	/** A room with two members, a table whose one-game series is already DONE. */
	async function doneTable(opts: { matchLength?: 'bo1' | 'bo3'; sideboarding?: boolean; winner?: 0 | 1 | null } = {}) {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		const tableId = made.room.tables[0]!.id;
		expect(lobby.join(id, BOB).ok).toBe(true);
		expect(lobby.setSettings(id, ALICE.id, { matchLength: opts.matchLength ?? 'bo1', sideboarding: opts.sideboarding ?? false }).ok).toBe(true);
		expect(lobby.setTableSeats(id, tableId, [ALICE.id, BOB.id])).toBe(true);
		const winner = opts.winner ?? 0;
		// bo1 is done after its one game; bo3 needs the SAME seat to win twice.
		const games = opts.matchLength === 'bo3' ? 2 : 1;
		for (let i = 0; i < games; i += 1) {
			expect(lobby.setTableMatch(id, tableId, `m-game-${String(i + 1)}`)).toBe(true);
			expect(lobby.recordGameResult(id, tableId, { matchId: `m-game-${String(i + 1)}`, winner })).toMatchObject({ ok: true });
		}
		expect(lobby.get(id)?.tables[0]?.series.phase).toBe('done');
		return { lobby, id, tableId };
	}

	it('bo1 + sideboarding on: a done table moves to sideboarding, wins/games reset, length re-snapshotted', async () => {
		const { lobby, id, tableId } = await doneTable({ matchLength: 'bo1', sideboarding: true, winner: 0 });
		expect(lobby.beginSideboarding(id, tableId)).toBe(true);
		expect(lobby.get(id)?.tables[0]?.series).toMatchObject({ length: 1, wins: [0, 0], games: [], phase: 'sideboarding' });
	});

	it('bo1 + sideboarding off: a done table stays done — the no-sideboarding Rematch path, unchanged', async () => {
		const { lobby, id, tableId } = await doneTable({ matchLength: 'bo1', sideboarding: false });
		expect(lobby.beginSideboarding(id, tableId)).toBe(false);
		expect(lobby.get(id)?.tables[0]?.series.phase).toBe('done');
	});

	it("bo3: a FINISHED series' Rematch is never routed through here — bo3's own sideboarding happens BETWEEN a series' games (`recordGameResult`), never between two series", async () => {
		const { lobby, id, tableId } = await doneTable({ matchLength: 'bo3' }); // effectiveSideboarding is always true for bo3, which is exactly why matchLength alone must gate this
		expect(lobby.beginSideboarding(id, tableId)).toBe(false);
		expect(lobby.get(id)?.tables[0]?.series.phase).toBe('done');
	});

	it('no-ops for a table that is not (or is no longer) done, and for no such room or table', async () => {
		const { lobby, id, tableId } = await doneTable({ matchLength: 'bo1', sideboarding: true });
		expect(lobby.beginSideboarding(id, tableId)).toBe(true); // consumes the `done` state
		expect(lobby.beginSideboarding(id, tableId), 'now sideboarding, not done — a second call is a no-op').toBe(false);
		expect(lobby.beginSideboarding('r-000000000000', tableId)).toBe(false);
		expect(lobby.beginSideboarding(id, 'not-a-table')).toBe(false);
	});

	/**
	 * Claw run 39046554773, 2026-10-17: `beginSideboarding` resets `games` to
	 * `[]`, which used to erase the just-finished game's winner along with
	 * it — so `http/routes.ts`'s `startFromRoom` could never ask the LOSER
	 * play-or-draw for this rematch's game (the operator's acceptance). Fixed
	 * by `rematchOf`, carried past the reset and read exactly once.
	 */
	it('rematchOf carries the just-finished game’s winner past the reset, and setTableMatch clears it once the next game starts', async () => {
		const { lobby, id, tableId } = await doneTable({ matchLength: 'bo1', sideboarding: true, winner: 1 });
		expect(lobby.rematchOf(id, tableId)).toBeNull(); // nothing carried before the Rematch gesture
		expect(lobby.beginSideboarding(id, tableId)).toBe(true);
		expect(lobby.rematchOf(id, tableId)).toBe(1); // seat 1 won the game that just ended
		expect(lobby.get(id)?.tables[0]?.series).toMatchObject({ games: [], phase: 'sideboarding' });

		expect(lobby.setTableMatch(id, tableId, 'm-rematch-game')).toBe(true);
		expect(lobby.rematchOf(id, tableId)).toBeNull(); // read once, then cleared

		expect(lobby.rematchOf('r-000000000000', tableId)).toBeNull();
		expect(lobby.rematchOf(id, 'not-a-table')).toBeNull();
	});

	/**
	 * The bo3 path this must NOT touch: its OWN mid-series sideboarding step
	 * goes through `recordGameResult`, never `beginSideboarding` (the test
	 * above's sibling, "bo3: a FINISHED series' Rematch is never routed
	 * through here", already covers that `beginSideboarding` itself no-ops)
	 * — so `rematchOf` stays `null` through a whole bo3 series.
	 */
	it('stays null through a bo3 series — recordGameResult never sets it', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		const tableId = made.room.tables[0]!.id;
		expect(lobby.join(id, BOB).ok).toBe(true);
		expect(lobby.setSettings(id, ALICE.id, { matchLength: 'bo3', sideboarding: true }).ok).toBe(true);
		expect(lobby.setTableSeats(id, tableId, [ALICE.id, BOB.id])).toBe(true);
		expect(lobby.setTableMatch(id, tableId, 'm-1')).toBe(true);
		expect(lobby.recordGameResult(id, tableId, { matchId: 'm-1', winner: 0 })).toMatchObject({ phase: 'sideboarding' });
		expect(lobby.rematchOf(id, tableId)).toBeNull();
	});
});

describe('Lobby.addTable / removeTable', () => {
	it('leader only; a new table starts seating, empty, sized to the room\'s matchLength', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Pod', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		expect(lobby.join(id, BOB).ok).toBe(true);

		expect(lobby.addTable(id, BOB.id)).toEqual({ ok: false, reason: 'not-leader' });
		expect(lobby.addTable('r-000000000000', ALICE.id)).toEqual({ ok: false, reason: 'no-room' });

		const added = lobby.addTable(id, ALICE.id);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		expect(added.table).toMatchObject({ players: [], matchId: null, series: { length: 1, wins: [0, 0], games: [], phase: 'seating' } });
		expect(lobby.get(id)?.tables.map((t) => t.id)).toEqual([made.room.tables[0]!.id, added.table.id]);
		// The first table's id never moves, even once a second exists.
		expect(lobby.get(id)?.tables[0]?.id).toBe(made.room.tables[0]!.id);
	});

	it('removes an empty, idle table other than the first; refuses the first, an occupied one, and a mid-series one', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Pod', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		const added = lobby.addTable(id, ALICE.id);
		if (!added.ok) throw new Error('addTable failed');
		const emptyTable = added.table.id;

		expect(lobby.removeTable(id, ALICE.id, made.room.tables[0]!.id)).toEqual({ ok: false, reason: 'first-table' });
		expect(lobby.removeTable(id, ALICE.id, 'not-a-table')).toEqual({ ok: false, reason: 'no-such-table' });

		expect(lobby.setTableSeats(id, emptyTable, [ALICE.id, null])).toBe(true);
		expect(lobby.removeTable(id, ALICE.id, emptyTable)).toEqual({ ok: false, reason: 'not-idle' });
		expect(lobby.setTableSeats(id, emptyTable, [null, null])).toBe(true);

		expect(lobby.setTableMatch(id, emptyTable, 'm-1')).toBe(true);
		expect(lobby.removeTable(id, ALICE.id, emptyTable)).toEqual({ ok: false, reason: 'not-idle' });
		lobby.recordGameResult(id, emptyTable, { matchId: 'm-1', winner: 0 });
		// bo1, so the series is `done` now — idle again.
		expect(lobby.get(id)?.tables[1]?.series.phase).toBe('done');
		expect(lobby.removeTable(id, ALICE.id, emptyTable)).toMatchObject({ ok: true });
		expect(lobby.get(id)?.tables).toHaveLength(1);
	});
});

describe('Lobby.setTableSeats', () => {
	it('is idempotent and self-heals a stale mirror without a persist each time', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		const tableId = made.room.tables[0]!.id;
		expect(lobby.setTableSeats('r-000000000000', tableId, [ALICE.id, null])).toBe(false);
		expect(lobby.setTableSeats(id, 'not-a-table', [ALICE.id, null])).toBe(false);
		expect(lobby.setTableSeats(id, tableId, [ALICE.id, null])).toBe(true);
		expect(lobby.get(id)?.tables[0]?.players).toEqual([{ memberId: ALICE.id, name: ALICE.name }]);
		// A second identical write is a no-op (idempotent).
		expect(lobby.setTableSeats(id, tableId, [ALICE.id, null])).toBe(true);
	});
});

describe('RoomSettings.matchLength / sideboarding — wave 71', () => {
	it('defaults bo1, no sideboarding; bo3 reads sideboarding as true without storing it', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		expect(made.room.settings).toEqual({ handSmoothing: true, matchLength: 'bo1', sideboarding: false });

		const bo3 = lobby.setSettings(made.room.id, ALICE.id, { matchLength: 'bo3' });
		expect(bo3.ok).toBe(true);
		if (!bo3.ok) return;
		expect(bo3.room.settings).toEqual({ handSmoothing: true, matchLength: 'bo3', sideboarding: true });

		// Explicitly turning sideboarding off under bo1 is honoured; under bo3 it
		// is not — `bo3` IMPLIES it, per the operator's ruling.
		const back = lobby.setSettings(made.room.id, ALICE.id, { matchLength: 'bo1', sideboarding: false });
		expect(back.ok).toBe(true);
		if (!back.ok) return;
		expect(back.room.settings).toEqual({ handSmoothing: true, matchLength: 'bo1', sideboarding: false });
	});

	it('a draft room always reads bo3 / sideboarding true, whatever is stored', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		expect(made.room.settings).toEqual({ handSmoothing: true, matchLength: 'bo3', sideboarding: true });
		expect(made.room.tables[0]?.series.length).toBe(3);
	});
});

describe('the codec migrates a stored room with no tables', () => {
	it('synthesizes one table holding the old matchId, with a stable id across a restart', async () => {
		const dir = await tempDir();
		writeFixtureRoom(dir, 'r-notables0001', legacyApp({ matchId: 'm-legacy0001' }));
		expect(Object.keys(legacyApp())).not.toContain('tables');

		const lobby = await openLobby({ dir });
		const view = lobby.get('r-notables0001');
		expect(view?.tables).toHaveLength(1);
		expect(view?.tables[0]).toMatchObject({ matchId: 'm-legacy0001', players: [], series: { length: 1, phase: 'playing' } });
		expect(view?.matchId).toBe('m-legacy0001');

		const tableId = view!.tables[0]!.id;
		const second = await openLobby({ dir });
		// Stable across a restart that touches nothing: the SAME id comes back,
		// not a freshly minted one each boot.
		expect(second.get('r-notables0001')?.tables[0]?.id).toBe(tableId);
	});

	it('synthesizes an empty, seating table for a legacy room with no live match', async () => {
		const dir = await tempDir();
		writeFixtureRoom(dir, 'r-notables0002', legacyApp());
		const lobby = await openLobby({ dir });
		expect(lobby.get('r-notables0002')?.tables[0]).toMatchObject({ matchId: null, series: { phase: 'seating' } });
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
		lobby.setTableMatch(made.room.id, made.room.tables[0]!.id, 'm-1');
		expect(lobby.roomOfMatch('m-1')?.id).toBe(made.room.id);
	});

	it('still resolves a match after the room let go of it, after a rematch, and after a restart', async () => {
		// The operator's rematch (r-cae3103a30ac): one result screen asked which room its match was in
		// after the other screen's read had released it, found none, and greyed Rematch out.
		const dir = await tempDir();
		const lobby = await openLobby({ dir });
		const made = lobby.create(ALICE, { name: 'tonight', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const tableId = made.room.tables[0]!.id;
		lobby.setTableMatch(made.room.id, tableId, 'm-first0000001');
		lobby.releaseTableMatch(made.room.id, tableId);
		expect(lobby.get(made.room.id)?.matchId).toBeNull();
		expect(lobby.roomOfMatch('m-first0000001')?.id, 'released').toBe(made.room.id);
		lobby.setTableMatch(made.room.id, tableId, 'm-second000001');
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
		const tableId = made.room.tables[0]!.id;
		for (let i = 0; i <= ROOM_MATCHES_KEPT; i += 1) {
			lobby.releaseTableMatch(made.room.id, tableId);
			lobby.setTableMatch(made.room.id, tableId, `m-${String(i).padStart(12, '0')}`);
		}
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
		const tableId = made.room.tables[0]!.id;
		expect(heard).toEqual([id]);

		lobby.join(id, BOB);
		lobby.setReady(id, BOB.id, true);
		lobby.setPlayerState(id, ALICE.id, { deck: 'x' });
		lobby.setTableMatch(id, tableId, 'm-000000000001');
		lobby.releaseTableMatch(id, tableId);
		lobby.leave(id, BOB.id);
		expect(heard).toHaveLength(7);
		expect(new Set(heard)).toEqual(new Set([id]));

		lobby.get(id);
		lobby.list();
		lobby.offered();
		lobby.touch(id, ALICE.id);
		lobby.roomOfMatch('m-000000000001');
		lobby.releaseTableMatch(id, tableId);
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

/* ── wave 72 §P: the pod ──────────────────────────────────────────────────── */

/** A `PodChecks` fake. `built` answers true for every id in `built`; `seatState` answers a marker a test can recognise. */
function fakeChecks(opts: { draftComplete?: boolean; built?: Set<string> } = {}): PodChecks {
	const built = opts.built ?? new Set<string>();
	const draftComplete = opts.draftComplete ?? true;
	return {
		draftComplete: () => draftComplete,
		built: (_podId, memberId) => built.has(memberId),
		seatState: (_podId, memberId, tableId) => ({ seatedFor: memberId, table: tableId }),
	};
}

describe('Lobby.sitPod / standPod', () => {
	it('refuses no room, not a member, not a draft room, a bad seat, a taken seat, and a full pod', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		expect(lobby.sitPod('r-000000000000', ALICE.id)).toEqual({ ok: false, reason: 'no-room' });

		const draft = lobby.create(ALICE, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		const table = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(draft.ok && table.ok).toBe(true);
		if (!draft.ok || !table.ok) return;

		expect(lobby.sitPod(draft.room.id, CAROL.id)).toEqual({ ok: false, reason: 'not-member' });
		expect(lobby.sitPod(table.room.id, ALICE.id)).toEqual({ ok: false, reason: 'not-draft' });

		expect(lobby.join(draft.room.id, BOB).ok).toBe(true);
		expect(lobby.sitPod(draft.room.id, ALICE.id, -1)).toEqual({ ok: false, reason: 'bad-seat' });
		expect(lobby.sitPod(draft.room.id, ALICE.id, 8)).toEqual({ ok: false, reason: 'bad-seat' });

		const first = lobby.sitPod(draft.room.id, ALICE.id, 0);
		expect(first.ok).toBe(true);
		if (first.ok) expect(first.room.pod?.seats[0]).toEqual({ memberId: ALICE.id, name: ALICE.name });

		expect(lobby.sitPod(draft.room.id, BOB.id, 0)).toEqual({ ok: false, reason: 'seat-taken' });
		const second = lobby.sitPod(draft.room.id, BOB.id, 1);
		expect(second.ok).toBe(true);

		// A member who sits again MOVES: leaves the old seat, takes the new one.
		const moved = lobby.sitPod(draft.room.id, ALICE.id, 2);
		expect(moved.ok).toBe(true);
		if (moved.ok) {
			expect(moved.room.pod?.seats[0]).toBeNull();
			expect(moved.room.pod?.seats[2]).toEqual({ memberId: ALICE.id, name: ALICE.name });
		}

		// Omitting `seat` takes the first free one.
		const members = Array.from({ length: 7 }, (_, i) => ({ id: `fk:seat-filler-${String(i)}`, name: `filler${String(i)}` }));
		for (const m of members) expect(lobby.join(draft.room.id, m).ok).toBe(true);
		for (const m of members.slice(0, 6)) expect(lobby.sitPod(draft.room.id, m.id).ok).toBe(true);
		// Seats taken so far: 1 (BOB), 2 (ALICE), and the first free one six times — 0,3,4,5,6,7. Every seat is full.
		expect(lobby.get(draft.room.id)?.pod?.seats.filter((s) => s !== null)).toHaveLength(8);
		expect(lobby.sitPod(draft.room.id, members[6]!.id)).toEqual({ ok: false, reason: 'pod-full' });

		expect(lobby.standPod(draft.room.id, BOB.id).ok).toBe(true);
		expect(lobby.get(draft.room.id)?.pod?.seats[1]).toBeNull();
		// Idempotent: standing again (or never having sat) is not a failure.
		expect(lobby.standPod(draft.room.id, BOB.id).ok).toBe(true);
		expect(lobby.standPod('r-000000000000', ALICE.id)).toEqual({ ok: false, reason: 'no-room' });
		expect(lobby.standPod(draft.room.id, CAROL.id)).toEqual({ ok: false, reason: 'not-member' });
	});

	it('refuses sit and stand once the draft has started — seats are fixed from there', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const id = await startedDraft(lobby, [ALICE]);
		expect(lobby.sitPod(id, ALICE.id)).toEqual({ ok: false, reason: 'not-lobby' });
		expect(lobby.standPod(id, ALICE.id)).toEqual({ ok: false, reason: 'not-lobby' });
	});
});

describe('Lobby.startDraft — no open seat, and only the seated are waited on', () => {
	// The operator, 2026-10-19: "drafts should not immediately start with open
	// seats", "the room should not wait on spectators to be ready".
	async function room(): Promise<{ lobby: Lobby; id: string }> {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		expect(lobby.join(made.room.id, BOB).ok).toBe(true);
		return { lobby, id: made.room.id };
	}

	it('does not deal while a seat is open, and deals once the AI holds every other one', async () => {
		const { lobby, id } = await room();
		expect(lobby.setReady(id, ALICE.id, true)).toBe(true);
		expect(lobby.get(id)?.pod?.seats[0]).toEqual({ memberId: ALICE.id, name: ALICE.name });
		expect(lobby.startDraft(id, ALICE.id)).toEqual({ ok: false, reason: 'not-ready' });
		for (let seat = 1; seat < 7; seat++) expect(lobby.aiPod(id, BOB.id, seat, true).ok).toBe(true);
		expect(lobby.startDraft(id, ALICE.id), 'one seat still open').toEqual({ ok: false, reason: 'not-ready' });
		expect(lobby.aiPod(id, ALICE.id, 7, true).ok).toBe(true);
		// Every character is taken by now (two members, six AI seats): the last AI seat shares one with a member.
		expect(lobby.get(id)?.pod?.seats[7]).toEqual({ memberId: POD_AI, name: 'Sage' });
		// BOB never sat: a spectator, not ready, and not waited on.
		expect(lobby.startDraft(id, ALICE.id)).toMatchObject({ ok: true });
		expect(lobby.get(id)?.pod?.drafters).toEqual([ALICE.id]);
	});

	it('waits on a seated member who is not ready, and takes the AI back out of a seat', async () => {
		const { lobby, id } = await room();
		expect(lobby.sitPod(id, BOB.id, 1).ok).toBe(true);
		expect(lobby.setReady(id, ALICE.id, true)).toBe(true);
		fillWithAi(lobby, id, ALICE.id);
		expect(lobby.startDraft(id, ALICE.id)).toEqual({ ok: false, reason: 'not-ready' });
		expect(lobby.aiPod(id, ALICE.id, 1, true)).toEqual({ ok: false, reason: 'seat-taken' });
		expect(lobby.aiPod(id, ALICE.id, 5, false).ok).toBe(true);
		expect(lobby.get(id)?.pod?.seats[5]).toBeNull();
		expect(lobby.sitPod(id, BOB.id, 5).ok).toBe(true);
		expect(lobby.get(id)?.pod?.seats[1]).toBeNull();
	});

	it('seats a member who readies in the first open seat, and leaves one who readies in a full pod watching', async () => {
		const { lobby, id } = await room();
		for (let seat = 0; seat < POD_SEATS; seat++) if (seat !== 3) expect(lobby.aiPod(id, ALICE.id, seat, true).ok).toBe(true);
		expect(lobby.setReady(id, BOB.id, true)).toBe(true);
		expect(lobby.get(id)?.pod?.seats[3]).toEqual({ memberId: BOB.id, name: BOB.name });
		expect(lobby.setReady(id, ALICE.id, true)).toBe(true);
		expect(lobby.get(id)?.pod?.seats.some((s) => s?.memberId === ALICE.id)).toBe(false);
		expect(lobby.startDraft(id, ALICE.id)).toMatchObject({ ok: true });
	});
});

describe("a draft room's pod — phase, wave 72 §P", () => {
	it('moves lobby → drafting → building → a bo3 against the AI → done for a single drafter', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		expect(lobby.get(id)?.pod?.phase).toBe('lobby');
		expect(lobby.get(id)?.pod?.seats[0]).toBeNull();
		expect(lobby.get(id)?.pod?.drafters).toEqual([]);

		expect(lobby.sitPod(id, ALICE.id, 0).ok).toBe(true);
		expect(lobby.get(id)?.pod?.seats[0]).toEqual({ memberId: ALICE.id, name: ALICE.name });
		expect(lobby.setReady(id, ALICE.id, true)).toBe(true);
		fillWithAi(lobby, id, ALICE.id);
		expect(lobby.startDraft(id, ALICE.id).ok).toBe(true);

		// Unwired PodChecks (the default, and the instant before `attachTables`
		// has run): a drafting room can only wait longer, never show the wrong
		// phase the other way.
		expect(lobby.get(id)?.pod?.phase).toBe('drafting');
		// Seats are the lobby's own field (`draft-pods-plan.md`'s "lobby phase:
		// the 8 pod seats"): once drafting starts, who is where is the draft
		// engine's business, not this field's.
		expect(lobby.get(id)?.pod?.seats.every((s) => s === null)).toBe(true);
		// Who is drafting is still the room's to say: the list `built` and the rounds gate are checked against.
		expect(lobby.get(id)?.pod?.drafters).toEqual([ALICE.id]);
		lobby.setPodChecks(fakeChecks({ draftComplete: false }));
		expect(lobby.get(id)?.pod?.phase).toBe('drafting');

		lobby.setPodChecks(fakeChecks({ draftComplete: true, built: new Set() }));
		expect(lobby.get(id)?.pod?.phase).toBe('building');
		expect(lobby.get(id)?.pod?.drafters).toEqual([ALICE.id]);
		expect(lobby.get(id)?.pod?.built).toEqual([]);

		lobby.setPodChecks(fakeChecks({ draftComplete: true, built: new Set([ALICE.id]) }));
		// A legal saved deck is not "done building": that is the editor's Play.
		expect(lobby.get(id)?.pod?.built).toEqual([]);

		const started = lobby.playPod(id, ALICE.id);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		// One drafter, seven bots: one table, against the AI, dealt by her own Play.
		expect(started.room.pod?.built).toEqual([ALICE.id]);
		expect(started.room.pod?.drafters).toEqual([ALICE.id]);
		expect(started.room.pod?.phase).toBe('rounds');
		expect(started.room.pod?.rounds).toBe(1);
		const pairing = started.room.pod!.pairings[0]!;
		expect(started.room.pod?.pairings).toHaveLength(1);
		expect(pairing.players).toEqual([ALICE.id, POD_AI]);
		expect(lobby.playerState(id, ALICE.id)).toEqual({ seatedFor: ALICE.id, table: pairing.tableId });

		lobby.recordGameResult(id, pairing.tableId, { matchId: 'm-ai-g1', winner: 1 });
		expect(lobby.get(id)?.pod?.phase).toBe('rounds');
		lobby.recordGameResult(id, pairing.tableId, { matchId: 'm-ai-g2', winner: 1 });
		const done = lobby.get(id)!;
		expect(done.pod?.phase).toBe('done');
		// The AI won 2-0: it ranks first, and her standing says so under it.
		expect(done.pod?.results).toEqual([{ round: 1, playerA: ALICE.id, playerB: POD_AI, gamesA: 0, gamesB: 2 }]);
		expect(done.pod?.standings).toEqual([
			expect.objectContaining({ id: POD_AI, matchPoints: 3, gameWinPct: 1, rank: 1 }),
			expect.objectContaining({ id: ALICE.id, matchPoints: 0, gameWinPct: 0, rank: 2 }),
		]);
	});
});

/** Every drafter presses Play; the last press is what deals round 1. */
function playAll(lobby: Lobby, id: string, members: readonly { id: string }[]): ReturnType<Lobby['playPod']> {
	let last: ReturnType<Lobby['playPod']> = { ok: false, reason: 'no-room' };
	for (const m of members) last = lobby.playPod(id, m.id);
	return last;
}

describe('Lobby.playPod', () => {
	async function buildingPod(): Promise<{ lobby: Lobby; id: string }> {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		expect(lobby.join(id, BOB).ok).toBe(true);
		expect(lobby.join(id, CAROL).ok).toBe(true);
		expect(lobby.sitPod(id, ALICE.id, 0).ok).toBe(true);
		expect(lobby.sitPod(id, BOB.id, 1).ok).toBe(true);
		expect(lobby.sitPod(id, CAROL.id, 2).ok).toBe(true);
		for (const m of [ALICE, BOB, CAROL]) expect(lobby.setReady(id, m.id, true)).toBe(true);
		fillWithAi(lobby, id, ALICE.id);
		expect(lobby.startDraft(id, ALICE.id).ok).toBe(true);
		return { lobby, id };
	}

	it('refuses no room, a non-drafter, still drafting, and an unbuilt deck', async () => {
		const { lobby, id } = await buildingPod();
		expect(lobby.playPod('r-000000000000', ALICE.id)).toEqual({ ok: false, reason: 'no-room' });

		// Still drafting: the default PodChecks has never been wired.
		expect(lobby.playPod(id, ALICE.id)).toEqual({ ok: false, reason: 'not-drafter' });

		lobby.setPodChecks(fakeChecks({ draftComplete: true, built: new Set([ALICE.id, BOB.id]) }));
		expect(lobby.get(id)?.pod?.phase).toBe('building');
		expect(lobby.playPod(id, 'fk:0000000000000000')).toEqual({ ok: false, reason: 'not-drafter' });
		expect(lobby.playPod(id, CAROL.id)).toEqual({ ok: false, reason: 'not-built' });
	});

	it('deals round 1 on the LAST drafter’s press, with nobody else’s say, and answers a late press ok', async () => {
		const { lobby, id } = await buildingPod();
		lobby.setPodChecks(fakeChecks({ draftComplete: true, built: new Set([ALICE.id, BOB.id, CAROL.id]) }));
		expect(lobby.playPod(id, BOB.id)).toMatchObject({ ok: true, room: { pod: { phase: 'building', built: [BOB.id] } } });
		expect(lobby.playPod(id, CAROL.id)).toMatchObject({ ok: true, room: { pod: { phase: 'building' } } });
		// Pressing twice changes nothing.
		expect(lobby.playPod(id, CAROL.id)).toMatchObject({ ok: true, room: { pod: { phase: 'building' } } });
		expect(lobby.playPod(id, ALICE.id)).toMatchObject({ ok: true, room: { pod: { phase: 'rounds', round: 1 } } });
		expect(lobby.playPod(id, BOB.id)).toMatchObject({ ok: true, room: { pod: { phase: 'rounds', round: 1 } } });
	});

	/**
	 * `no-players` is still reachable in principle (the check stays, defensive
	 * against `podSeats` somehow ending up empty) — but NOT this way any more.
	 * `startDraft`'s fallback gate auto-seats whoever it gated on the instant
	 * it succeeds (the manager's review catch: without it, a room that never
	 * pressed Sit could draft but could never reach `rounds`), so a room that
	 * reaches `building` through `startedDraft`'s own helper always has at
	 * least one seated human from here on.
	 */
	it('a member who never sat is auto-seated by startDraft, so playPod deals her a table against the AI', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const id = await startedDraft(lobby, [ALICE]);
		expect(lobby.podHumans(id).map((h) => h.id)).toEqual([ALICE.id]);
		lobby.setPodChecks(fakeChecks({ draftComplete: true, built: new Set([ALICE.id]) }));
		expect(lobby.get(id)?.pod?.phase).toBe('building');
		const started = lobby.playPod(id, ALICE.id);
		expect(started.ok).toBe(true);
		if (started.ok) expect(started.room.pod?.pairings[0]?.players).toEqual([ALICE.id, POD_AI]);
	});
});

describe('a 3-human pod with a bye, through two rounds — wave 72 §P', () => {
	async function threeHumanPod(): Promise<{ lobby: Lobby; id: string }> {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		expect(lobby.join(id, BOB).ok).toBe(true);
		expect(lobby.join(id, CAROL).ok).toBe(true);
		expect(lobby.sitPod(id, ALICE.id, 0).ok).toBe(true);
		expect(lobby.sitPod(id, BOB.id, 1).ok).toBe(true);
		expect(lobby.sitPod(id, CAROL.id, 2).ok).toBe(true);
		for (const m of [ALICE, BOB, CAROL]) expect(lobby.setReady(id, m.id, true)).toBe(true);
		fillWithAi(lobby, id, ALICE.id);
		expect(lobby.startDraft(id, ALICE.id).ok).toBe(true);
		lobby.setPodChecks(fakeChecks({ draftComplete: true, built: new Set([ALICE.id, BOB.id, CAROL.id]) }));
		return { lobby, id };
	}

	it('pairs round 1 across the table, gives the middle seat the bye, and seats both players with their built deck', async () => {
		const { lobby, id } = await threeHumanPod();
		const started = playAll(lobby, id, [ALICE, BOB, CAROL]);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		expect(started.room.pod?.phase).toBe('rounds');
		expect(started.room.pod?.round).toBe(1);
		expect(started.room.pod?.rounds).toBe(2); // roundsFor(3) === ceil(log2(3)) === 2
		expect(started.room.pod?.bye).toBe(BOB.id);
		expect(started.room.pod?.results).toEqual([{ round: 1, playerA: BOB.id, playerB: null, gamesA: 2, gamesB: 0 }]);
		expect(started.room.pod?.pairings).toHaveLength(1);
		const pairing = started.room.pod!.pairings[0]!;
		expect(pairing.players).toEqual([ALICE.id, CAROL.id]);

		// Seated with their built deck — the exact marker `fakeChecks`'s `seatState` answered.
		expect(lobby.playerState(id, ALICE.id)).toEqual({ seatedFor: ALICE.id, table: pairing.tableId });
		expect(lobby.playerState(id, CAROL.id)).toEqual({ seatedFor: CAROL.id, table: pairing.tableId });
	});

	it("plays round 1, advances BY ITSELF to round 2 paired by score with a NEW bye, then finishes done with standings ranked", async () => {
		const { lobby, id } = await threeHumanPod();
		const started = playAll(lobby, id, [ALICE, BOB, CAROL]);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		const table1 = started.room.pod!.pairings[0]!.tableId;

		lobby.recordGameResult(id, table1, { matchId: 'm-r1-g1', winner: 0 });
		// One win of a bo3 (needs 2): round 1 is not over yet.
		let view = lobby.get(id)!;
		expect(view.pod?.round).toBe(1);
		expect(view.pod?.pairings).toHaveLength(1);

		lobby.recordGameResult(id, table1, { matchId: 'm-r1-g2', winner: 0 });
		view = lobby.get(id)!;
		// Advanced itself — no route, no leader action, just the table going done.
		expect(view.pod?.round).toBe(2);
		// BOB had round 1's bye; CAROL has not had one, and ranks below ALICE
		// (round 1 winner) and BOB (bye) on match points — CAROL gets round 2's.
		expect(view.pod?.bye).toBe(CAROL.id);
		expect(view.pod?.pairings).toHaveLength(1);
		expect(view.pod?.pairings[0]?.players).toEqual([ALICE.id, BOB.id]);
		expect(view.pod?.results).toEqual([
			{ round: 1, playerA: BOB.id, playerB: null, gamesA: 2, gamesB: 0 },
			{ round: 1, playerA: ALICE.id, playerB: CAROL.id, gamesA: 2, gamesB: 0 },
			{ round: 2, playerA: CAROL.id, playerB: null, gamesA: 2, gamesB: 0 },
		]);
		// Not a repeat of round 1's pairing: ALICE already played CAROL.
		expect(view.pod?.pairings.some((p) => p.players.includes(CAROL.id))).toBe(false);

		const table2 = view.pod!.pairings[0]!.tableId;
		lobby.recordGameResult(id, table2, { matchId: 'm-r2-g1', winner: 0 });
		const finished = lobby.recordGameResult(id, table2, { matchId: 'm-r2-g2', winner: 0 });
		expect(finished.ok).toBe(true);

		const done = lobby.get(id)!;
		expect(done.pod?.phase).toBe('done');
		// `podPhaseOf`'s own internal sentinel is one past `rounds` (3), but the
		// WIRE view clamps `round` to `rounds` once done — "round 2 of 2", never
		// "round 3 of 2" — so `phase` is the only place "done" shows.
		expect(done.pod?.round).toBe(2);
		expect(done.pod?.pairings).toEqual([]);
		expect(done.pod?.bye).toBeNull();
		expect(done.pod?.results).toHaveLength(4);

		// ALICE won both her rounds (6 match points) and ranks first; BOB and
		// CAROL each won one bye and lost one game (3 points each) — the exact
		// order between them is the tiebreak's answer, not asserted here.
		expect(done.pod?.standings).toHaveLength(3);
		expect(done.pod?.standings.map((r) => r.rank)).toEqual([1, 2, 3]);
		expect(done.pod?.standings[0]).toMatchObject({ id: ALICE.id, matchPoints: 6, rank: 1 });
		expect(new Set(done.pod?.standings.slice(1).map((r) => r.id))).toEqual(new Set([BOB.id, CAROL.id]));
		expect(done.pod?.standings.slice(1).every((r) => r.matchPoints === 3)).toBe(true);
	});
});

describe('a 3-member draft room that never sits still reaches rounds — wave 72 §P', () => {
	/**
	 * The gap the manager caught in review: the fallback ready gate ("nobody
	 * sat → every member") lets `startDraft` succeed with `podSeats` all
	 * null — and every LATER reader of `podSeats` (`podHumans`, `built`,
	 * `playPod`) would then see nobody seated, so a room that never
	 * pressed Sit could draft but could never reach `rounds`. `startDraft`
	 * now seats the fallback's own members, in join order, at the moment it
	 * sets `draftStartedAt` — this proves the WHOLE chain agrees from
	 * there: `podHumans`, `playPod`'s pairing, AND a REAL `DraftRooms`
	 * wired to `podHumans` exactly as `http/routes.ts`'s `attachTables` wires
	 * it (`setHumansLookup`), with the actual shipped cube.
	 */
	it("auto-seats every member at startDraft, so playPod pairs them and a REAL DraftRooms deals to exactly those three", async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		expect(lobby.join(id, BOB).ok).toBe(true);
		expect(lobby.join(id, CAROL).ok).toBe(true);
		// Nobody ever calls sitPod.
		for (const m of [ALICE, BOB, CAROL]) expect(lobby.setReady(id, m.id, true)).toBe(true);
		fillWithAi(lobby, id, ALICE.id);
		expect(lobby.startDraft(id, ALICE.id).ok).toBe(true);

		// The fallback gate's own gap, closed: without the auto-seat this would
		// be `[]`, and the pod could never pair a round.
		expect(lobby.podHumans(id).map((h) => h.id)).toEqual([ALICE.id, BOB.id, CAROL.id]);

		lobby.setPodChecks(fakeChecks({ draftComplete: true, built: new Set([ALICE.id, BOB.id, CAROL.id]) }));
		expect(lobby.get(id)?.pod?.phase).toBe('building');

		const started = playAll(lobby, id, [ALICE, BOB, CAROL]);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		expect(started.room.pod?.phase).toBe('rounds');
		expect(started.room.pod?.pairings).toHaveLength(1);
		expect(started.room.pod?.bye).not.toBeNull();
		expect(new Set([...started.room.pod!.pairings[0]!.players, started.room.pod!.bye])).toEqual(
			new Set([ALICE.id, BOB.id, CAROL.id]),
		);

		// `humansLookup` reads `Lobby.podHumans`, exactly as `http/routes.ts`'s
		// `attachTables` wires it (`deps.draftRooms?.setHumansLookup((podId) =>
		// (rooms?.podHumans?.(podId) ?? []).map(...))`) — wired here by hand,
		// against the REAL cube and a REAL `DraftRooms`, to prove the data
		// `startDraft`'s auto-seat produced is what the draft engine actually
		// deals to.
		const load = loadPool(CUBE_FILE);
		if (!load.ok) throw new Error(`the bundled cube pool did not load: ${load.detail}`);
		const draftRooms = createDraftRooms({ pool: load.pool.cards, cube: load.pool.meta, now: () => 1_700_000_000_000 });
		draftRooms.setHumansLookup((podId) => lobby.podHumans(podId).map((h) => ({ participantId: h.id, displayName: h.name })));
		const room = draftRooms.open(id);
		expect(
			humanSeats(room.seats)
				.map((s) => s.participantId)
				.sort(),
		).toEqual([ALICE.id, BOB.id, CAROL.id].sort());

		// Reverted (comment out the `if (seated.length === 0) { ... }` auto-seat
		// block in `Lobby.startDraft`): `podHumans(id)` above comes back `[]`,
		// `playPod` refuses `not-drafter`, and the `DraftRooms` deals to
		// nobody (every seat a bot). 3 failed (the three assertions after the
		// gap would first bite). Restored: passes, all assertions above hold.
	});
});

describe('Lobby.close, and the tournaments a pod leaves behind', () => {
	async function podInRound1(): Promise<{ lobby: Lobby; id: string; kept: Tournament[] }> {
		const kept: Tournament[] = [];
		const lobby = await openLobby({ dir: await tempDir(), now: () => 1_700_000_000_000, onTournament: (t) => void kept.push(t) });
		const made = lobby.create(ALICE, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		expect(lobby.join(id, BOB).ok).toBe(true);
		expect(lobby.sitPod(id, ALICE.id, 0).ok).toBe(true);
		expect(lobby.sitPod(id, BOB.id, 4).ok).toBe(true);
		for (const m of [ALICE, BOB]) expect(lobby.setReady(id, m.id, true)).toBe(true);
		fillWithAi(lobby, id, ALICE.id);
		expect(lobby.startDraft(id, ALICE.id).ok).toBe(true);
		lobby.setPodChecks(fakeChecks({ draftComplete: true, built: new Set([ALICE.id, BOB.id]) }));
		expect(playAll(lobby, id, [ALICE, BOB]).ok).toBe(true);
		return { lobby, id, kept };
	}

	it('only the owner closes the room; it is forgotten and the matches it was playing are handed back', async () => {
		const { lobby, id } = await podInRound1();
		const table = lobby.get(id)!.pod!.pairings[0]!.tableId;
		expect(lobby.setTableMatch(id, table, 'm-live')).toBe(true);

		expect(lobby.close(id, BOB.id)).toEqual({ ok: false, reason: 'not-leader' });
		expect(lobby.get(id)).toBeDefined();

		expect(lobby.close(id, ALICE.id)).toEqual({ ok: true, matches: ['m-live'] });
		expect(lobby.get(id)).toBeUndefined();
		expect(lobby.list().some((r) => r.id === id)).toBe(false);
		expect(lobby.close(id, ALICE.id)).toEqual({ ok: false, reason: 'no-room' });
	});

	it('a finished pod is kept once, with names and standings — closing it afterwards keeps nothing twice', async () => {
		const { lobby, id, kept } = await podInRound1();
		const table = lobby.get(id)!.pod!.pairings[0]!.tableId;
		lobby.recordGameResult(id, table, { matchId: 'g1', winner: 0 });
		expect(kept).toEqual([]);
		lobby.recordGameResult(id, table, { matchId: 'g2', winner: 0 });
		expect(lobby.get(id)?.pod?.phase).toBe('done');

		expect(kept).toHaveLength(1);
		expect(kept[0]).toMatchObject({
			id: `${id}-1700000000000`,
			name: 'Cube night',
			closed: false,
			rounds: 1,
			names: { [ALICE.id]: ALICE.name, [BOB.id]: BOB.name, ai: expect.any(String) },
			standings: [expect.objectContaining({ id: ALICE.id, matchPoints: 3, rank: 1 }), expect.objectContaining({ id: BOB.id, matchPoints: 0, rank: 2 })],
		});
		expect(lobby.close(id, ALICE.id).ok).toBe(true);
		expect(kept).toHaveLength(2);
		expect(kept[1]!.id).toBe(kept[0]!.id);
	});

	it('a pod closed before any match finished keeps nothing; one closed mid-way is kept as closed', async () => {
		const early = await podInRound1();
		expect(early.lobby.close(early.id, ALICE.id).ok).toBe(true);
		expect(early.kept).toEqual([]);

		const kept: Tournament[] = [];
		const three = await (async () => {
			const l = await openLobby({ dir: await tempDir(), onTournament: (t) => void kept.push(t) });
			const made = l.create(ALICE, { name: 'Three', gameType: 'draft', clientMode: 'builtin' });
			if (!made.ok) throw new Error('create failed');
			for (const m of [BOB, CAROL]) expect(l.join(made.room.id, m).ok).toBe(true);
			for (const [i, m] of [ALICE, BOB, CAROL].entries()) expect(l.sitPod(made.room.id, m.id, i).ok).toBe(true);
			for (const m of [ALICE, BOB, CAROL]) expect(l.setReady(made.room.id, m.id, true)).toBe(true);
			fillWithAi(l, made.room.id, ALICE.id);
			expect(l.startDraft(made.room.id, ALICE.id).ok).toBe(true);
			l.setPodChecks(fakeChecks({ draftComplete: true, built: new Set([ALICE.id, BOB.id, CAROL.id]) }));
			expect(playAll(l, made.room.id, [ALICE, BOB, CAROL]).ok).toBe(true);
			return { l, id: made.room.id };
		})();
		const table = three.l.get(three.id)!.pod!.pairings[0]!.tableId;
		three.l.recordGameResult(three.id, table, { matchId: 'g1', winner: 0 });
		three.l.recordGameResult(three.id, table, { matchId: 'g2', winner: 0 });
		expect(three.l.get(three.id)?.pod?.round).toBe(2);
		expect(three.l.close(three.id, ALICE.id).ok).toBe(true);
		expect(kept).toHaveLength(1);
		expect(kept[0]).toMatchObject({ closed: true, rounds: 2 });
	});
});

describe('the AI seats play as the room’s characters', () => {
	it('gives each AI seat a character nobody in the room wears, keeps it through a restart, and names the draft’s bots and the opponent after them', async () => {
		const dir = await tempDir();
		const lobby = await openLobby({ dir });
		const made = lobby.create(ALICE, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		expect(lobby.sitPod(id, ALICE.id, 0).ok).toBe(true);
		const worn = lobby.get(id)!.members[0]!.avatarId;
		for (let seat = 1; seat < 8; seat++) expect(lobby.aiPod(id, ALICE.id, seat, true).ok).toBe(true);
		const names = lobby.get(id)!.pod!.seats.slice(1).map((s) => s!.name);
		expect(new Set(names).size, 'seven different characters').toBe(7);
		expect(names.map((n) => n.toLowerCase()), 'none of them the one Alice wears').not.toContain(worn);
		expect(names.every((n) => /^[A-Z][a-z]+$/.test(n))).toBe(true);
		expect(lobby.podBotNames(id)).toEqual(names);
		// Across the table from the one human (draft seat 4, the fourth bot): who the AI plays as.
		expect(lobby.get(id)!.ai.name).toBe(names[3]);

		// Taken out and put back, a seat gets a character again; the others keep theirs.
		expect(lobby.aiPod(id, ALICE.id, 2, false).ok).toBe(true);
		expect(lobby.aiPod(id, ALICE.id, 2, true).ok).toBe(true);
		const again = lobby.get(id)!.pod!.seats.slice(1).map((s) => s!.name);
		expect(again.filter((n, i) => i !== 1)).toEqual(names.filter((n, i) => i !== 1));

		const reopened = await openLobby({ dir });
		expect(reopened.get(id)!.pod!.seats.slice(1).map((s) => s!.name), 'kept through a restart').toEqual(again);
		expect(reopened.get(id)!.ai).toEqual(lobby.get(id)!.ai);
	});

	it('a 1v1 room’s AI is a character none of its members wears', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const worn = made.room.members[0]!.avatarId;
		expect(made.room.ai.avatarId).not.toBe(worn);
		expect(made.room.ai.name.toLowerCase()).toBe(made.room.ai.avatarId);
	});
});

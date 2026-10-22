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

import { newGauntlet } from './gauntlet.ts';
import { FileRoomStore, STORE_VERSION, type RoomSnapshot } from '@hadoku/room-store';
import { createSeatTable, humanSeats, seatOf } from '@wolffm/rooms-protocol';
import { packOf, pick, pickNumberOf, type DraftState } from '@hadoku/draft';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { poolFixturePath, type LibraryCollection } from '@hadoku/deck/library';
import { loadTablesLibrary } from '../http/library.ts';
import { createDraftRooms, DEFAULT_PLAN, singlePoolResolver, stateOf } from './draftRooms.ts';
import { loadPool } from './pool.ts';
import { planDisplayName } from './plan.ts';
import { AVATAR_ID_MAX, CLIENT_MODES, DEFAULT_CLIENT_MODE, POD_SEATS, type ClientMode, type PoolVerdict, type Tournament } from '@hadoku/shared';
import {
	AVATAR_POOL,
	draftIdOfPool,
	draftPoolId,
	newestFormat,
	NO_FORMAT,
	openLobby,
	POD_AI,
	POD_CLOSED,
	randomFormat,
	POD_SPARED_MS,
	ROOM_IDLE_MS,
	ROOM_MATCHES_KEPT,
	ROOM_STALE_MS,
	type Lobby,
	type PodChecks,
	type RoomView,
	type SeriesEnd,
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

/** The cube the app ships with — for the tests that drive a REAL `DraftRooms` off `podDraft`. */
const CUBE_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../ui/src/draft/pool.json');

/** A draft room with `members` in it, all of them ready, and its draft started. */
/** A draft room with `members` in it, all ready, no seat open — `startDraft`'s OWN gates are all clear, but its plan verdict is still whatever the lobby gave it (null, absent a `checkPlan`). */
async function readyToStart(lobby: Lobby, members: Array<{ id: string; name: string }> = [ALICE]): Promise<string> {
	const made = lobby.create(members[0], { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
	expect(made.ok).toBe(true);
	if (!made.ok) throw new Error(made.reason);
	for (const member of members.slice(1)) expect(lobby.join(made.room.id, member).ok).toBe(true);
	for (const member of members) expect(lobby.setReady(made.room.id, member.id, true)).toBe(true);
	fillWithAi(lobby, made.room.id, members[0].id);
	return made.room.id;
}

async function startedDraft(lobby: Lobby, members: Array<{ id: string; name: string }> = [ALICE]): Promise<string> {
	const id = await readyToStart(lobby, members);
	approvePlan(lobby, id);
	const started = lobby.startDraft(id, members[0].id);
	expect(started.ok).toBe(true);
	return id;
}

/**
 * A plan verdict that lets `startDraft` succeed, set directly through the
 * same `setPodPlan` a PUT uses — most tests in this file are not ABOUT plan
 * verdicts, so they set one by hand rather than wiring `checkPlan` and
 * waiting for a background check (`Lobby.startDraft`'s own
 * `plan-not-ready` gate, wave 73 §A follow-up).
 */
function approvePlan(lobby: Lobby, roomId: string): void {
	const room = lobby.get(roomId);
	if (room === undefined) return;
	const plan = room.pod?.plan ?? DEFAULT_PLAN;
	lobby.setPodPlan(roomId, room.leader, plan, { ok: true, cards: 1 });
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
		expect(lobby.setGameType(id, ALICE.id, 'draft').ok).toBe(true);
		expect(lobby.setFormat(id, ALICE.id, POOLS[0]).ok).toBe(true);
		expect(lobby.setTableMatch(id, lobby.get(id)!.tables[0]!.id, 'match-7')).toBe(true);

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

	/*
	 * Before 2026-10-20 a leader could put a constructed room on a pod; such a room
	 * waited forever on a pod socket that no longer answered (prod r-763d04bedb4a).
	 */
	it('brings a constructed room left on a pod back on the newest era, its deck holds dropped', async () => {
		const dir = await tempDir();
		const first = await openLobby({ dir, defaultFormat: POOLS[POOLS.length - 1] });
		const made = first.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) return;
		expect(first.setFormat(made.room.id, ALICE.id, 'draft:r-6a708794c832').ok).toBe(true);
		first.setPlayerState(made.room.id, ALICE.id, { deck: 'held-under-the-pod' });

		const logged: Record<string, unknown>[] = [];
		const second = await openLobby({ dir, defaultFormat: POOLS[0], log: (e) => void logged.push(e) });
		expect(second.get(made.room.id)?.format).toBe(POOLS[0]);
		expect(second.playerState(made.room.id, ALICE.id)).toBeUndefined();
		expect(logged).toContainEqual({ event: 'room-format-off-pod', roomId: made.room.id, format: 'draft:r-6a708794c832' });
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
	/** A room with ALICE leading, BOB in it, both seated, both ready and both holding a deck. */
	async function loadedRoom(lobby: Lobby): Promise<string> {
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) throw new Error(made.reason);
		expect(lobby.join(made.room.id, BOB).ok).toBe(true);
		const tableId = made.room.tables[0]!.id;
		for (const who of [ALICE, BOB]) {
			expect(lobby.setReady(made.room.id, who.id, true)).toBe(true);
			expect(lobby.sit(made.room.id, tableId, who.id) && lobby.setSeatReady(made.room.id, tableId, who.id, true)).toBe(true);
			// The deck's verdict, in the blob `http/routes.ts` owns. Opaque here on
			// purpose: this file drops it, it never reads it.
			expect(lobby.setPlayerState(made.room.id, who.id, { v: 1, verdict: { legal: true } })).toBe(true);
		}
		return made.room.id;
	}
	const seatReadys = (lobby: Lobby, id: string) => lobby.seats(id, lobby.get(id)!.tables[0]!.id).map((s) => s.ready);

	it('refuses a non-leader with not-leader, and changes nothing', async () => {
		const lobby = await openLobby({ dir: await tempDir(), defaultFormat: POOLS[POOLS.length - 1] });
		const id = await loadedRoom(lobby);

		expect(lobby.setFormat(id, BOB.id, POOLS[0])).toEqual({ ok: false, reason: 'not-leader' });
		expect(lobby.setFormat(id, CAROL.id, POOLS[0])).toEqual({ ok: false, reason: 'not-leader' });
		expect(lobby.setFormat('r-000000000000', ALICE.id, POOLS[0])).toEqual({ ok: false, reason: 'no-room' });

		// The refusals cost the table nothing: same pool, same flags, same holds.
		expect(lobby.get(id)?.format).toBe(POOLS[POOLS.length - 1]);
		expect(lobby.get(id)?.members.map((m) => m.ready)).toEqual([true, true]);
		expect(seatReadys(lobby, id)).toEqual([true, true]);
		expect(lobby.playerState(id, BOB.id)).toEqual({ v: 1, verdict: { legal: true } });
	});

	it('clears every readiness flag, every seat and every deck hold when the pool changes', async () => {
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
		expect(seatReadys(lobby, id)).toEqual([]);
		// On disk as well as in memory.
		const second = await openLobby({ dir, defaultFormat: POOLS[POOLS.length - 1] });
		expect(second.get(id)?.format).toBe(POOLS[0]);
		expect(second.get(id)?.members.map((m) => m.ready)).toEqual([false, false]);
		expect(second.playerState(id, ALICE.id)).toBeUndefined();
		expect(seatReadys(second, id)).toEqual([]);
	});

	it('clears nothing when the pool it is set to is the one the room is on', async () => {
		const lobby = await openLobby({ dir: await tempDir(), defaultFormat: POOLS[POOLS.length - 1] });
		const id = await loadedRoom(lobby);

		const same = lobby.setFormat(id, ALICE.id, POOLS[POOLS.length - 1]);
		expect(same.ok).toBe(true);
		// A leader clicking the option that is already selected must not un-ready
		// the table under everybody.
		expect(lobby.get(id)?.members.map((m) => m.ready)).toEqual([true, true]);
		expect(seatReadys(lobby, id)).toEqual([true, true]);
		expect(lobby.playerState(id, ALICE.id)).toEqual({ v: 1, verdict: { legal: true } });
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
		// Everyone seated is ready, and six seats are still open: no deal with an open seat.
		expect(lobby.startDraft(draft.room.id, BOB.id)).toEqual({ ok: false, reason: 'not-ready' });
		fillWithAi(lobby, draft.room.id, BOB.id);
		approvePlan(lobby, draft.room.id);
		const started = lobby.startDraft(draft.room.id, BOB.id);
		expect(started.ok).toBe(true);
		// ANY member may start it, not only the leader: both browsers ask and the
		// server answers one start to both.
		if (!started.ok) return;
		expect(typeof started.room.draftStartedAt).toBe('string');
	});

	/*
	 * Manager, 2026-10-22: "it shouldn't even get to the drafting stage" is a
	 * SERVER rule, not a UI one — B's Start button being disabled on a bad
	 * verdict proves nothing about a direct POST. Everyone seated and ready
	 * is necessary but not sufficient: the room's plan must also have passed
	 * its check.
	 */
	it('refuses to start a pod whose plan has no verdict yet — a check still running, or never run', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const id = await readyToStart(lobby, [ALICE]);
		// No approvePlan: the Settled default's `planVerdict` is still null — no
		// checkPlan is wired on this lobby, so nothing ever set one.
		expect(lobby.get(id)?.pod?.verdict).toBeNull();
		expect(lobby.startDraft(id, ALICE.id)).toEqual({ ok: false, reason: 'plan-not-ready' });
		expect(lobby.get(id)?.draftStartedAt).toBeNull();
	});

	it('refuses to start a pod whose plan verdict is refused', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const id = await readyToStart(lobby, [ALICE]);
		const room = lobby.get(id);
		if (room === undefined) throw new Error('room missing');
		const refusal = lobby.setPodPlan(id, room.leader, room.pod!.plan, { ok: false, unplayable: ['Not A Real Card'], missingText: [] });
		// setPodPlan itself refuses a bad verdict (409 { verdict } at the route) —
		// the room's planVerdict is still null, the same as never having checked.
		expect(refusal.ok).toBe(false);
		expect(lobby.startDraft(id, ALICE.id)).toEqual({ ok: false, reason: 'plan-not-ready' });
	});

	it('starts once the plan verdict is ok — approvePlan is the one thing this gate needed', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const id = await readyToStart(lobby, [ALICE]);
		approvePlan(lobby, id);
		expect(lobby.startDraft(id, ALICE.id).ok).toBe(true);
	});

	it('starts for real once a BACKGROUND check (no PUT at all) lands the verdict', async () => {
		const dir = await tempDir();
		const checkPlan = async (): Promise<PoolVerdict> => ({ ok: true, cards: 1 });
		const lobby = await openLobby({ dir, checkPlan });
		const id = await readyToStart(lobby, [ALICE]);
		await vi.waitFor(() => expect(lobby.get(id)?.pod?.verdict).toEqual({ ok: true, cards: 1 }));
		expect(lobby.startDraft(id, ALICE.id).ok).toBe(true);
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
		approvePlan(first, id);
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
			expect(lobby.setPlayerState(id, who.id, { v: 1, deck: 'mono-red' })).toBe(true);
			expect(lobby.sit(id, tableId, who.id) && lobby.setSeatReady(id, tableId, who.id, true)).toBe(true);
		}
		expect(lobby.setTableMatch(id, tableId, 'm-finished')).toBe(true);
		expect(lobby.seats(id, tableId).map((s) => s.ready), 'the start spends both Readys').toEqual([false, false]);
		expect(lobby.setSeatReady(id, tableId, ALICE.id, true)).toBe(true);

		expect(lobby.releaseTableMatch('r-000000000000', tableId)).toBe(false);
		expect(lobby.releaseTableMatch(id, 'not-a-table')).toBe(false);
		expect(lobby.releaseTableMatch(id, tableId)).toBe(true);

		expect(lobby.get(id)?.matchId).toBeNull();
		expect(lobby.seats(id, tableId)).toEqual([
			{ memberId: ALICE.id, ready: false },
			{ memberId: BOB.id, ready: false },
		]);
		// The table state is opaque here and kept whole.
		expect(lobby.playerState(id, ALICE.id)).toEqual({ v: 1, deck: 'mono-red' });
		expect(lobby.playerState(id, BOB.id)).toEqual({ v: 1, deck: 'mono-red' });
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

		expect(lobby.sit(id, table1, ALICE.id) && lobby.sit(id, table1, BOB.id)).toBe(true);
		expect(lobby.sit(id, table2, CAROL.id) && lobby.setSeatReady(id, table2, CAROL.id, true)).toBe(true);
		expect(lobby.setTableMatch(id, table1, 'm-table-1')).toBe(true);
		expect(lobby.setSeatReady(id, table1, ALICE.id, true) && lobby.setSeatReady(id, table1, BOB.id, true)).toBe(true);

		expect(lobby.releaseTableMatch(id, table1)).toBe(true);
		expect(lobby.seats(id, table1).map((s) => s.ready)).toEqual([false, false]);
		expect(lobby.seats(id, table2), 'not at the table that released').toEqual([{ memberId: CAROL.id, ready: true }]);
	});
});

describe('a Constructed series — Bo1, a Rematch converts it to Bo3, and its result is recorded once', () => {
	/** A room with Alice and Bob seated at the first table and game 1 under way; `ended` collects every series result. */
	async function playingTable(opts: { checks?: PodChecks } = {}) {
		const ended: SeriesEnd[] = [];
		const logged: Record<string, unknown>[] = [];
		const lobby = await openLobby({ dir: await tempDir(), onSeriesEnd: (end) => ended.push(end), log: (e) => void logged.push(e) });
		if (opts.checks !== undefined) lobby.setPodChecks(opts.checks);
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		const tableId = made.room.tables[0]!.id;
		expect(lobby.join(id, BOB).ok).toBe(true);
		expect(lobby.sit(id, tableId, ALICE.id) && lobby.sit(id, tableId, BOB.id)).toBe(true);
		expect(lobby.setTableMatch(id, tableId, 'm-game-1')).toBe(true);
		return { lobby, id, tableId, ended, logged };
	}

	it('starts as Bo1 and is done after one game; the result waits for the room to move on', async () => {
		const { lobby, id, tableId, ended } = await playingTable();
		expect(lobby.get(id)?.tables[0]?.series).toMatchObject({ length: 1, phase: 'playing' });
		expect(lobby.recordGameResult(id, tableId, { matchId: 'm-game-1', winner: 0 })).toMatchObject({ ok: true, phase: 'done' });
		expect(lobby.get(id)?.tables[0]).toMatchObject({ matchId: null, series: { length: 1, wins: [1, 0], games: [{ matchId: 'm-game-1', winner: 0 }], phase: 'done' } });
		expect(ended).toEqual([]);
	});

	it('Rematch converts it in place: Bo3, game 1 kept, 1-0, sideboarding — and game 2 continues the same series', async () => {
		const { lobby, id, tableId, ended } = await playingTable();
		lobby.recordGameResult(id, tableId, { matchId: 'm-game-1', winner: 1 });
		expect(lobby.beginSideboarding(id, tableId)).toBe(true);
		expect(lobby.get(id)?.tables[0]?.series).toEqual({ length: 3, wins: [0, 1], games: [{ matchId: 'm-game-1', winner: 1 }], phase: 'sideboarding' });
		expect(lobby.beginSideboarding(id, tableId), 'sideboarding, not done: a second press is a no-op').toBe(false);
		expect(lobby.setTableMatch(id, tableId, 'm-game-2')).toBe(true);
		expect(lobby.get(id)?.tables[0]?.series).toMatchObject({ length: 3, wins: [0, 1], phase: 'playing' });
		expect(lobby.recordGameResult(id, tableId, { matchId: 'm-game-2', winner: 0 })).toMatchObject({ phase: 'sideboarding' });
		expect(ended).toEqual([]);
		expect(lobby.setTableMatch(id, tableId, 'm-game-3')).toBe(true);
		expect(lobby.recordGameResult(id, tableId, { matchId: 'm-game-3', winner: 1 })).toMatchObject({ phase: 'done' });
		expect(ended).toEqual([
			{
				roomId: id,
				tableId,
				mode: 'classic',
				bestOf: 3,
				seats: [
					{ memberId: ALICE.id, name: ALICE.name },
					{ memberId: BOB.id, name: BOB.name },
				],
				wins: [1, 2],
				games: [
					{ matchId: 'm-game-1', winner: 1 },
					{ matchId: 'm-game-2', winner: 0 },
					{ matchId: 'm-game-3', winner: 1 },
				],
				winner: 1,
			},
		]);
		// Recorded once: nothing the room does afterwards records it again.
		expect(lobby.stand(id, tableId, BOB.id)).toBe(true);
		expect(lobby.close(id, ALICE.id).ok).toBe(true);
		expect(ended).toHaveLength(1);
	});

	it('an All Random room’s Bo1 converts on Rematch exactly as a Classic one does', async () => {
		const { lobby, id, tableId } = await playingTable();
		lobby.recordGameResult(id, tableId, { matchId: 'm-game-1', winner: 0 });
		expect(lobby.setMode(id, ALICE.id, { mode: 'random', modeOptions: { pool: 'modern' } }).ok).toBe(true);
		expect(lobby.setTableMatch(id, tableId, 'm-random-1')).toBe(true);
		expect(lobby.get(id)?.tables[0]?.series).toMatchObject({ length: 1, phase: 'playing' });
		lobby.recordGameResult(id, tableId, { matchId: 'm-random-1', winner: 1 });
		expect(lobby.beginSideboarding(id, tableId)).toBe(true);
		expect(lobby.get(id)?.tables[0]?.series).toMatchObject({ length: 3, wins: [0, 1], phase: 'sideboarding' });
	});

	it('a finished Bo3’s Rematch is not converted again: the next series starts as Bo1', async () => {
		const { lobby, id, tableId } = await playingTable();
		lobby.recordGameResult(id, tableId, { matchId: 'm-game-1', winner: 0 });
		expect(lobby.beginSideboarding(id, tableId)).toBe(true);
		expect(lobby.setTableMatch(id, tableId, 'm-game-2')).toBe(true);
		lobby.recordGameResult(id, tableId, { matchId: 'm-game-2', winner: 0 });
		expect(lobby.get(id)?.tables[0]?.series).toMatchObject({ length: 3, wins: [2, 0], phase: 'done' });
		expect(lobby.beginSideboarding(id, tableId)).toBe(false);
		expect(lobby.setTableMatch(id, tableId, 'm-game-3')).toBe(true);
		expect(lobby.get(id)?.tables[0]?.series).toEqual({ length: 1, wins: [0, 0], games: [], phase: 'playing' });
	});

	it('a Bo1 ends as Bo1 when a seat leaves the table, and can no longer be converted', async () => {
		const { lobby, id, tableId, ended } = await playingTable();
		lobby.recordGameResult(id, tableId, { matchId: 'm-game-1', winner: 0 });
		expect(lobby.stand(id, tableId, BOB.id)).toBe(true);
		expect(ended).toEqual([
			expect.objectContaining({ mode: 'classic', bestOf: 1, wins: [1, 0], winner: 0, games: [{ matchId: 'm-game-1', winner: 0 }] }),
		]);
		expect(lobby.sit(id, tableId, BOB.id)).toBe(true);
		expect(lobby.beginSideboarding(id, tableId), 'Bob sitting back down does not revive a recorded series').toBe(false);
		expect(ended).toHaveLength(1);
	});

	it('a Bo1 ends as Bo1 when a player leaves the room', async () => {
		const { lobby, id, tableId, ended } = await playingTable();
		lobby.recordGameResult(id, tableId, { matchId: 'm-game-1', winner: 1 });
		expect(lobby.leave(id, BOB.id).ok).toBe(true);
		expect(ended).toEqual([expect.objectContaining({ bestOf: 1, winner: 1 })]);
	});

	it('a Bo1 ends as Bo1 when a seat no longer holds the deck it played (a deck or format change)', async () => {
		const checks: PodChecks = { ...fakeChecks(), holdsSeriesDeck: (state) => (state as { same?: boolean } | undefined)?.same !== false };
		const { lobby, id, tableId, ended } = await playingTable({ checks });
		lobby.recordGameResult(id, tableId, { matchId: 'm-game-1', winner: 0 });
		expect(lobby.setPlayerState(id, ALICE.id, { same: true })).toBe(true);
		expect(ended).toEqual([]);
		expect(lobby.setPlayerState(id, BOB.id, { same: false })).toBe(true);
		expect(ended).toEqual([expect.objectContaining({ bestOf: 1, winner: 0 })]);
		expect(lobby.beginSideboarding(id, tableId)).toBe(false);
	});

	it('a Bo1 ends as Bo1, under the mode it was played in, when the leader changes the mode — and a Gauntlet’s next series is Bo3', async () => {
		const { lobby, id, tableId, ended } = await playingTable({ checks: { ...fakeChecks(), holdsSeriesDeck: (state) => state !== undefined } });
		expect(lobby.setPlayerState(id, ALICE.id, { held: true })).toBe(true);
		expect(lobby.setPlayerState(id, BOB.id, { held: true })).toBe(true);
		lobby.recordGameResult(id, tableId, { matchId: 'm-game-1', winner: 1 });
		expect(ended).toEqual([]);
		expect(lobby.setMode(id, ALICE.id, { mode: 'gauntlet', modeOptions: {} }).ok).toBe(true);
		expect(ended).toEqual([expect.objectContaining({ mode: 'classic', bestOf: 1, winner: 1 })]);
		expect(lobby.setTableMatch(id, tableId, 'm-gauntlet-1')).toBe(true);
		expect(lobby.get(id)?.tables[0]?.series).toMatchObject({ length: 3, phase: 'playing' });
		expect(lobby.recordGameResult(id, tableId, { matchId: 'm-gauntlet-1', winner: 0 })).toMatchObject({ phase: 'between' });
	});

	it('a Bo1 ends as Bo1 when the room closes, or is swept', async () => {
		const closed = await playingTable();
		closed.lobby.recordGameResult(closed.id, closed.tableId, { matchId: 'm-game-1', winner: 0 });
		expect(closed.lobby.close(closed.id, ALICE.id).ok).toBe(true);
		expect(closed.ended).toEqual([expect.objectContaining({ bestOf: 1, winner: 0 })]);

		const swept = await playingTable();
		swept.lobby.recordGameResult(swept.id, swept.tableId, { matchId: 'm-game-1', winner: null });
		expect(swept.lobby.sweep(-1)).toEqual([swept.id]);
		expect(swept.ended).toEqual([expect.objectContaining({ bestOf: 1, winner: null, wins: [0, 0] })]);
	});

	it('against the AI: the AI seat is null, the one player’s Rematch converts it, and a Bo3 the room closes on records its finished game as a Bo1', async () => {
		const ended: SeriesEnd[] = [];
		const lobby = await openLobby({ dir: await tempDir(), onSeriesEnd: (end) => ended.push(end) });
		const made = lobby.create(ALICE, { name: 'Solo', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		const tableId = made.room.tables[0]!.id;
		expect(lobby.sit(id, tableId, ALICE.id)).toBe(true);
		expect(lobby.setTableMatch(id, tableId, 'm-bot-1')).toBe(true);
		lobby.recordGameResult(id, tableId, { matchId: 'm-bot-1', winner: 0 });
		expect(lobby.beginSideboarding(id, tableId)).toBe(true);
		expect(lobby.get(id)?.tables[0]?.series).toMatchObject({ length: 3, wins: [1, 0], phase: 'sideboarding' });
		expect(lobby.close(id, ALICE.id).ok).toBe(true);
		expect(ended).toEqual([
			{
				roomId: id,
				tableId,
				mode: 'classic',
				bestOf: 1,
				seats: [{ memberId: ALICE.id, name: ALICE.name }, null],
				wins: [1, 0],
				games: [{ matchId: 'm-bot-1', winner: 0 }],
				winner: 0,
			},
		]);
	});

	/*
	 * Rulings 10 and 14 (`constructed-modes-plan.md`). A Bo3 that ends undecided
	 * — its players leave it, or the room changes under it — records what was
	 * finished: one game is a Bo1 of that game; two (1-1) are still the Bo3, a
	 * draw. A game still in play counts for nothing.
	 */
	describe('a Bo3 that ends undecided: one finished game is a Bo1, 1-1 is a drawn Bo3', () => {
		/** Alice and Bob in a Bo3 (a Rematch) at 1-1, game 3 under way. */
		async function oneAllAndPlaying() {
			const t = await playingTable();
			t.lobby.recordGameResult(t.id, t.tableId, { matchId: 'm-game-1', winner: 0 });
			expect(t.lobby.beginSideboarding(t.id, t.tableId)).toBe(true);
			expect(t.lobby.setTableMatch(t.id, t.tableId, 'm-game-2')).toBe(true);
			t.lobby.recordGameResult(t.id, t.tableId, { matchId: 'm-game-2', winner: 1 });
			expect(t.lobby.setTableMatch(t.id, t.tableId, 'm-game-3')).toBe(true);
			return t;
		}
		const bo1 = (id: string, tableId: string, matchId: string, winner: 0 | 1) => ({
			roomId: id,
			tableId,
			mode: 'classic',
			bestOf: 1,
			seats: [
				{ memberId: ALICE.id, name: ALICE.name },
				{ memberId: BOB.id, name: BOB.name },
			],
			wins: winner === 0 ? [1, 0] : [0, 1],
			games: [{ matchId, winner }],
			winner,
		});
		const drawnBo3 = (id: string, tableId: string, mode = 'classic') => ({
			...bo1(id, tableId, 'm-game-1', 0),
			mode,
			bestOf: 3,
			wins: [1, 1],
			games: [
				{ matchId: 'm-game-1', winner: 0 },
				{ matchId: 'm-game-2', winner: 1 },
			],
			winner: null,
		});
		/** Alice and Bob at 1-1 in sideboarding for game 3, nothing in play. */
		async function oneAllBetween() {
			const t = await playingTable();
			t.lobby.recordGameResult(t.id, t.tableId, { matchId: 'm-game-1', winner: 0 });
			expect(t.lobby.beginSideboarding(t.id, t.tableId)).toBe(true);
			expect(t.lobby.setTableMatch(t.id, t.tableId, 'm-game-2')).toBe(true);
			expect(t.lobby.recordGameResult(t.id, t.tableId, { matchId: 'm-game-2', winner: 1 })).toMatchObject({ phase: 'sideboarding' });
			return t;
		}

		it('a player leaves the room mid-game at 1-1: the Bo3 is recorded as a draw, game 3 is discarded, and the table moves on', async () => {
			const { lobby, id, tableId, ended } = await oneAllAndPlaying();
			expect(lobby.leave(id, BOB.id).ok).toBe(true);
			expect(ended).toEqual([drawnBo3(id, tableId)]);
			expect(lobby.get(id)?.tables[0]?.series, 'the abandoned series is over').toMatchObject({ phase: 'done', games: [{ matchId: 'm-game-1' }, { matchId: 'm-game-2' }] });
			// Game 3 ends after the leave: nothing is recorded for it.
			expect(lobby.recordGameResult(id, tableId, { matchId: 'm-game-3', winner: 0 })).toMatchObject({ ok: true, phase: 'done' });
			expect(lobby.get(id)?.tables[0]).toMatchObject({ matchId: null, series: { wins: [1, 1], games: [{ matchId: 'm-game-1' }, { matchId: 'm-game-2' }] } });
			expect(lobby.beginSideboarding(id, tableId)).toBe(false);
			// The next start is a new Bo1 series, and closing the room records nothing more.
			expect(lobby.setTableMatch(id, tableId, 'm-next')).toBe(true);
			expect(lobby.get(id)?.tables[0]?.series).toMatchObject({ length: 1, wins: [0, 0], games: [], phase: 'playing' });
			expect(lobby.close(id, ALICE.id).ok).toBe(true);
			expect(ended).toHaveLength(1);
		});

		it('a player stands up between games: the same, the way a Bo1 ends when its seat is left', async () => {
			const { lobby, id, tableId, ended } = await playingTable();
			lobby.recordGameResult(id, tableId, { matchId: 'm-game-1', winner: 1 });
			expect(lobby.beginSideboarding(id, tableId)).toBe(true);
			expect(lobby.stand(id, tableId, BOB.id)).toBe(true);
			expect(ended).toEqual([bo1(id, tableId, 'm-game-1', 1)]);
			expect(lobby.get(id)?.tables[0]?.series.phase).toBe('done');
		});

		it('a player leaves the room during sideboarding: game 1 is recorded as a Bo1 and the match is closed', async () => {
			const { lobby, id, tableId, ended } = await playingTable();
			lobby.recordGameResult(id, tableId, { matchId: 'm-game-1', winner: 0 });
			expect(lobby.beginSideboarding(id, tableId)).toBe(true);
			expect(lobby.leave(id, BOB.id).ok).toBe(true);
			expect(ended).toEqual([bo1(id, tableId, 'm-game-1', 0)]);
			expect(lobby.get(id)?.tables[0]?.series.phase).toBe('done');
			expect(lobby.beginSideboarding(id, tableId)).toBe(false);
		});

		it('a Gauntlet left after game 1 records game 1 as a Gauntlet Bo1', async () => {
			const { lobby, id, tableId, ended } = await playingTable();
			lobby.recordGameResult(id, tableId, { matchId: 'm-game-1', winner: 0 });
			expect(lobby.setMode(id, ALICE.id, { mode: 'gauntlet', modeOptions: {} }).ok).toBe(true);
			// A mode change gives every seat back; both sit down again to play it.
			expect(lobby.seats(id, tableId)).toEqual([]);
			expect(lobby.sit(id, tableId, ALICE.id) && lobby.sit(id, tableId, BOB.id)).toBe(true);
			ended.length = 0;
			expect(lobby.setTableMatch(id, tableId, 'm-gauntlet-1')).toBe(true);
			expect(lobby.recordGameResult(id, tableId, { matchId: 'm-gauntlet-1', winner: 1 })).toMatchObject({ phase: 'between' });
			expect(lobby.leave(id, ALICE.id).ok).toBe(true);
			expect(ended).toEqual([{ ...bo1(id, tableId, 'm-gauntlet-1', 1), mode: 'gauntlet' }]);
		});

		it('the room is swept mid-series at 1-1: a drawn Bo3, and the game in play is not one of its games', async () => {
			const { lobby, id, tableId, ended } = await oneAllAndPlaying();
			expect(lobby.sweep(-1)).toEqual([id]);
			expect(ended).toEqual([drawnBo3(id, tableId)]);
		});

		describe('a room change the series cannot continue through interrupts it (ruling 14)', () => {
			const changes: [string, (lobby: Lobby, id: string) => { ok: boolean }][] = [
				['the mode', (lobby, id) => lobby.setMode(id, ALICE.id, { mode: 'random', modeOptions: { pool: 'full' } })],
				['the game type', (lobby, id) => lobby.setGameType(id, ALICE.id, 'draft')],
				['the pool', (lobby, id) => lobby.setFormat(id, ALICE.id, lobby.get(id)?.format === POOLS[0] ? POOLS[1]! : POOLS[0]!)],
			];

			for (const [what, change] of changes) {
				it(`changing ${what} in sideboarding at 1-0 records game 1 as a Bo1, logs it interrupted, and leaves the table clean`, async () => {
					const { lobby, id, tableId, ended, logged } = await playingTable();
					lobby.recordGameResult(id, tableId, { matchId: 'm-game-1', winner: 0 });
					expect(lobby.beginSideboarding(id, tableId)).toBe(true);
					expect(change(lobby, id).ok).toBe(true);
					expect(ended).toEqual([bo1(id, tableId, 'm-game-1', 0)]);
					expect(logged).toContainEqual(expect.objectContaining({ event: 'table-series-ended', tableId, undecided: 'interrupted' }));
					// Nothing of the old series is left to continue or to rematch.
					expect(lobby.seats(id, tableId)).toEqual([]);
					expect(lobby.get(id)?.tables[0]).toMatchObject({ players: [], matchId: null, series: { wins: [0, 0], games: [], phase: 'seating' } });
					expect(lobby.beginSideboarding(id, tableId)).toBe(false);
				});

				it(`changing ${what} at 1-1 between games records the drawn Bo3`, async () => {
					const { lobby, id, tableId, ended } = await oneAllBetween();
					expect(change(lobby, id).ok).toBe(true);
					expect(ended).toEqual([drawnBo3(id, tableId)]);
				});

				it(`changing ${what} is refused while a game is in play, and the series carries on`, async () => {
					const { lobby, id, tableId, ended } = await oneAllAndPlaying();
					expect(change(lobby, id)).toEqual({ ok: false, reason: 'mode-locked' });
					expect(ended).toEqual([]);
					expect(lobby.seats(id, tableId)).toHaveLength(2);
					expect(lobby.get(id)?.tables[0]).toMatchObject({ matchId: 'm-game-3', series: { length: 3, wins: [1, 1], phase: 'playing' } });
				});
			}

			it('changing the mode options interrupts it too, and the next start is a fresh series in the new options', async () => {
				const { lobby, id, tableId, ended } = await playingTable();
				expect(lobby.recordGameResult(id, tableId, { matchId: 'm-game-1', winner: 1 })).toMatchObject({ phase: 'done' });
				expect(lobby.setMode(id, ALICE.id, { mode: 'random', modeOptions: { pool: 'full' } }).ok).toBe(true);
				ended.length = 0;
				expect(lobby.sit(id, tableId, ALICE.id) && lobby.sit(id, tableId, BOB.id)).toBe(true);
				expect(lobby.setTableMatch(id, tableId, 'm-random-1')).toBe(true);
				lobby.recordGameResult(id, tableId, { matchId: 'm-random-1', winner: 0 });
				expect(lobby.beginSideboarding(id, tableId)).toBe(true);
				expect(lobby.setMode(id, ALICE.id, { mode: 'random', modeOptions: { pool: 'modern' } }).ok).toBe(true);
				expect(ended).toEqual([{ ...bo1(id, tableId, 'm-random-1', 0), mode: 'random' }]);
				expect(lobby.sit(id, tableId, ALICE.id) && lobby.sit(id, tableId, BOB.id)).toBe(true);
				expect(lobby.setTableMatch(id, tableId, 'm-random-2')).toBe(true);
				expect(lobby.get(id)?.tables[0]?.series).toMatchObject({ length: 1, wins: [0, 0], games: [], phase: 'playing' });
			});

			it('a decided Bo1 the room moves on from is still its one Bo1, not an interruption', async () => {
				const { lobby, id, tableId, ended, logged } = await playingTable();
				lobby.recordGameResult(id, tableId, { matchId: 'm-game-1', winner: 1 });
				expect(lobby.setGameType(id, ALICE.id, 'draft').ok).toBe(true);
				expect(ended).toEqual([bo1(id, tableId, 'm-game-1', 1)]);
				expect(logged.filter((e) => e.event === 'table-series-ended')).toEqual([expect.not.objectContaining({ undecided: expect.anything() })]);
			});
		});

		it('a decided Bo3 is still one Bo3 when a player leaves after it', async () => {
			const { lobby, id, tableId, ended } = await oneAllAndPlaying();
			lobby.recordGameResult(id, tableId, { matchId: 'm-game-3', winner: 1 });
			expect(lobby.leave(id, BOB.id).ok).toBe(true);
			expect(ended).toEqual([expect.objectContaining({ bestOf: 3, wins: [1, 2], winner: 1 })]);
		});
	});

	it('a draft pod table is Bo3 with sideboarding from its first game', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		expect(made.room.tables[0]?.series.length).toBe(3);
		const tableId = made.room.tables[0]!.id;
		expect(lobby.join(made.room.id, BOB).ok && lobby.sit(made.room.id, tableId, ALICE.id) && lobby.sit(made.room.id, tableId, BOB.id)).toBe(true);
		expect(lobby.setTableMatch(made.room.id, tableId, 'm-pod-1')).toBe(true);
		expect(lobby.recordGameResult(made.room.id, tableId, { matchId: 'm-pod-1', winner: 0 })).toMatchObject({ phase: 'sideboarding' });
	});

	it('false only for no such room or table', async () => {
		const { lobby, id, tableId } = await playingTable();
		expect(lobby.recordGameResult('r-000000000000', 'anything', { matchId: 'm-x', winner: 0 })).toEqual({ ok: false, reason: 'no-room' });
		expect(lobby.recordGameResult(id, 'not-a-table', { matchId: 'm-x', winner: 0 })).toEqual({ ok: false, reason: 'no-such-table' });
		expect(lobby.beginSideboarding('r-000000000000', tableId)).toBe(false);
		expect(lobby.beginSideboarding(id, 'not-a-table')).toBe(false);
	});

	it('survives a restart: a pending Bo1 still converts, and a recorded one is not recorded again', async () => {
		const dir = await tempDir();
		const ended: SeriesEnd[] = [];
		const first = await openLobby({ dir, onSeriesEnd: (end) => ended.push(end) });
		const made = first.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		const tableId = made.room.tables[0]!.id;
		expect(first.join(id, BOB).ok).toBe(true);
		expect(first.sit(id, tableId, ALICE.id) && first.sit(id, tableId, BOB.id)).toBe(true);
		expect(first.setTableMatch(id, tableId, 'm-game-1')).toBe(true);
		first.recordGameResult(id, tableId, { matchId: 'm-game-1', winner: 0 });

		const second = await openLobby({ dir, onSeriesEnd: (end) => ended.push(end) });
		expect(second.beginSideboarding(id, tableId)).toBe(true);
		expect(second.setTableMatch(id, tableId, 'm-game-2')).toBe(true);
		second.recordGameResult(id, tableId, { matchId: 'm-game-2', winner: 0 });
		expect(ended).toEqual([expect.objectContaining({ bestOf: 3, wins: [2, 0] })]);

		const third = await openLobby({ dir, onSeriesEnd: (end) => ended.push(end) });
		expect(third.close(id, ALICE.id).ok).toBe(true);
		expect(ended).toHaveLength(1);
	});
});

describe('a room stored with the old match-length settings', () => {
	it('still parses, and its settings read as hand smoothing alone', async () => {
		const dir = await tempDir();
		writeFixtureRoom(dir, 'r-oldsettings1', legacyApp({ settings: { handSmoothing: false, matchLength: 'bo3', sideboarding: true } }));
		const lobby = await openLobby({ dir });
		expect(lobby.get('r-oldsettings1')?.settings).toEqual({ handSmoothing: false });
		expect(lobby.get('r-oldsettings1')?.tables[0]?.series).toMatchObject({ length: 1, phase: 'seating' });
	});
});

describe('Lobby.addTable / removeTable', () => {
	it('leader only; a new table starts seating, empty, sized to the room\'s series format', async () => {
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

		expect(lobby.sit(id, emptyTable, ALICE.id)).toBe(true);
		expect(lobby.removeTable(id, ALICE.id, emptyTable)).toEqual({ ok: false, reason: 'not-idle' });
		expect(lobby.stand(id, emptyTable, ALICE.id)).toBe(true);

		expect(lobby.setTableMatch(id, emptyTable, 'm-1')).toBe(true);
		expect(lobby.removeTable(id, ALICE.id, emptyTable)).toEqual({ ok: false, reason: 'not-idle' });
		lobby.recordGameResult(id, emptyTable, { matchId: 'm-1', winner: 0 });
		// bo1, so the series is `done` now — idle again.
		expect(lobby.get(id)?.tables[1]?.series.phase).toBe('done');
		expect(lobby.removeTable(id, ALICE.id, emptyTable)).toMatchObject({ ok: true });
		expect(lobby.get(id)?.tables).toHaveLength(1);
	});
});

describe('Lobby.sit / stand / setSeatReady', () => {
	it('seats members in the order they sat, two at most, and a stand moves the other up with their Ready', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		const tableId = made.room.tables[0]!.id;
		lobby.join(id, BOB);
		lobby.join(id, CAROL);
		expect(lobby.sit('r-000000000000', tableId, ALICE.id)).toBe(false);
		expect(lobby.sit(id, 'not-a-table', ALICE.id)).toBe(false);
		expect(lobby.sit(id, tableId, 'fk:not-a-member')).toBe(false);
		expect(lobby.setSeatReady(id, tableId, BOB.id, true), 'no seat to ready').toBe(false);
		expect(lobby.sit(id, tableId, BOB.id) && lobby.sit(id, tableId, ALICE.id)).toBe(true);
		expect(lobby.sit(id, tableId, ALICE.id), 'a seat already held').toBe(true);
		expect(lobby.sit(id, tableId, CAROL.id), 'a full table').toBe(false);
		expect(lobby.get(id)?.tables[0]?.players.map((p) => p.memberId)).toEqual([BOB.id, ALICE.id]);
		expect(lobby.setSeatReady(id, tableId, ALICE.id, true)).toBe(true);
		expect(lobby.stand(id, tableId, BOB.id)).toBe(true);
		expect(lobby.seats(id, tableId)).toEqual([{ memberId: ALICE.id, ready: true }]);
		expect(lobby.stand(id, tableId, BOB.id), 'standing with no seat is a no-op').toBe(true);
	});

	it('moves a member who sits at another table, and leaving the room gives the seat back', async () => {
		const dir = await tempDir();
		const lobby = await openLobby({ dir });
		const made = lobby.create(ALICE, { name: 'Big room', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		lobby.join(id, BOB);
		const first = made.room.tables[0]!.id;
		const added = lobby.addTable(id, ALICE.id);
		if (!added.ok) throw new Error('addTable failed');
		expect(lobby.sit(id, first, ALICE.id) && lobby.setSeatReady(id, first, ALICE.id, true)).toBe(true);
		expect(lobby.sit(id, first, BOB.id)).toBe(true);
		expect(lobby.sit(id, added.table.id, ALICE.id)).toBe(true);
		expect(lobby.seats(id, first)).toEqual([{ memberId: BOB.id, ready: false }]);
		expect(lobby.seats(id, added.table.id)).toEqual([{ memberId: ALICE.id, ready: false }]);
		expect(lobby.leave(id, BOB.id).ok).toBe(true);
		expect(lobby.seats(id, first)).toEqual([]);
		const second = await openLobby({ dir });
		expect(second.seats(id, added.table.id)).toEqual([{ memberId: ALICE.id, ready: false }]);
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

	it('poolNamesChanged names every draft room, and only draft rooms — a plan name read before the names warmed is read again', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const draft = lobby.create(ALICE, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		const duel = lobby.create(BOB, { name: 'tonight', gameType: 'constructed-1v1', clientMode: 'builtin' });
		if (!draft.ok || !duel.ok) throw new Error('create failed');
		const heard: string[] = [];
		lobby.onChange((id) => heard.push(id));
		lobby.poolNamesChanged();
		expect(heard).toEqual([draft.room.id]);
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
		seatState: (_podId, memberId) => ({ seatedFor: memberId }),
		holdsSeriesDeck: () => true,
		planNameOf: (plan) => planDisplayName(plan, (source) => (source.kind === 'cube' ? source.cubeId : `${source.code} (${source.style})`)),
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
		expect(lobby.get(id)?.pod?.seats[7]).toEqual({ memberId: POD_AI, name: 'Sage', avatarId: 'sage' });
		approvePlan(lobby, id);
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
		approvePlan(lobby, id);
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
		approvePlan(lobby, id);
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
		expect(lobby.playerState(id, ALICE.id)).toEqual({ seatedFor: ALICE.id });
		expect(lobby.seats(id, pairing.tableId).map((s) => s.memberId)).toContain(ALICE.id);

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
		approvePlan(lobby, id);
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
		expect(lobby.podDraft(id)?.humans.map((h) => h.participantId)).toEqual([ALICE.id]);
		lobby.setPodChecks(fakeChecks({ draftComplete: true, built: new Set([ALICE.id]) }));
		expect(lobby.get(id)?.pod?.phase).toBe('building');
		const started = lobby.playPod(id, ALICE.id);
		expect(started.ok).toBe(true);
		if (started.ok) expect(started.room.pod?.pairings[0]?.players).toEqual([ALICE.id, POD_AI]);
	});

	it('two players in a pod of eight, six of them AI, play each other — the AI drafts but never takes a table', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		expect(lobby.join(id, BOB).ok).toBe(true);
		expect(lobby.sitPod(id, ALICE.id, 2).ok).toBe(true);
		expect(lobby.sitPod(id, BOB.id, 3).ok).toBe(true);
		for (const m of [ALICE, BOB]) expect(lobby.setReady(id, m.id, true)).toBe(true);
		fillWithAi(lobby, id, ALICE.id);
		expect(lobby.podDraft(id)?.bots).toHaveLength(6);
		approvePlan(lobby, id);
		expect(lobby.startDraft(id, ALICE.id).ok).toBe(true);
		lobby.setPodChecks(fakeChecks({ draftComplete: true, built: new Set([ALICE.id, BOB.id]) }));
		const started = playAll(lobby, id, [ALICE, BOB]);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		expect(started.room.pod).toMatchObject({ phase: 'rounds', round: 1, rounds: 1, bye: null, results: [] });
		expect(started.room.pod?.pairings.map((p) => p.players)).toEqual([[ALICE.id, BOB.id]]);
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
		approvePlan(lobby, id);
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
		expect(lobby.playerState(id, ALICE.id)).toEqual({ seatedFor: ALICE.id });
		expect(lobby.seats(id, pairing.tableId).map((s) => s.memberId)).toContain(ALICE.id);
		expect(lobby.playerState(id, CAROL.id)).toEqual({ seatedFor: CAROL.id });
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
	 * null — and every LATER reader of `podSeats` (`podDraft`, `built`,
	 * `playPod`) would then see nobody seated, so a room that never
	 * pressed Sit could draft but could never reach `rounds`. `startDraft`
	 * now seats the fallback's own members, in join order, at the moment it
	 * sets `draftStartedAt` — this proves the WHOLE chain agrees from
	 * there: `podDraft`, `playPod`'s pairing, AND a REAL `DraftRooms`
	 * wired to `podDraft` exactly as `http/routes.ts`'s `attachTables` wires
	 * it (`setPodLookup`), with the actual shipped cube.
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
		approvePlan(lobby, id);
		expect(lobby.startDraft(id, ALICE.id).ok).toBe(true);

		// The fallback gate's own gap, closed: without the auto-seat this would
		// be `[]`, and the pod could never pair a round.
		expect(lobby.podDraft(id)?.humans.map((h) => h.participantId)).toEqual([ALICE.id, BOB.id, CAROL.id]);

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

		// The pod lookup reads `Lobby.podDraft`, exactly as `http/routes.ts`'s
		// `attachTables` wires it — wired here by hand,
		// against the REAL cube and a REAL `DraftRooms`, to prove the data
		// `startDraft`'s auto-seat produced is what the draft engine actually
		// deals to.
		const load = loadPool(CUBE_FILE);
		if (!load.ok) throw new Error(`the bundled cube pool did not load: ${load.detail}`);
		const draftRooms = createDraftRooms({ ...singlePoolResolver(load.pool), now: () => 1_700_000_000_000 });
		draftRooms.setPodLookup((podId) => lobby.podDraft(podId));
		const room = draftRooms.open(id);
		expect(
			humanSeats(room.seats)
				.map((s) => s.participantId)
				.sort(),
		).toEqual([ALICE.id, BOB.id, CAROL.id].sort());

		// Reverted (comment out the `if (seated.length === 0) { ... }` auto-seat
		// block in `Lobby.startDraft`): `podDraft(id)` above has no humans,
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
		approvePlan(lobby, id);
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
			approvePlan(l, made.room.id);
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
		// Each seat is dealt as a player: the name, and the character drawn for it in the pod.
		const avatars = lobby.get(id)!.pod!.seats.slice(1).map((s) => s!.name.toLowerCase());
		expect(lobby.podDraft(id)).toEqual({
			seats: 8,
			humans: [{ participantId: ALICE.id, displayName: ALICE.name, seat: 0, ...(worn === undefined ? {} : { avatarId: worn }) }],
			bots: names.map((name, i) => ({ name, avatarId: avatars[i] })),
			plan: DEFAULT_PLAN,
		});
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

describe('closed pod seats', () => {
	async function draftRoom(): Promise<{ lobby: Lobby; id: string }> {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		expect(lobby.join(made.room.id, BOB).ok).toBe(true);
		return { lobby, id: made.room.id };
	}

	it('the owner closes an empty seat and opens it again; nobody else may, and a taken seat cannot be', async () => {
		const { lobby, id } = await draftRoom();
		expect(lobby.closePod(id, BOB.id, 5, true)).toEqual({ ok: false, reason: 'not-leader' });
		expect(lobby.sitPod(id, BOB.id, 4).ok).toBe(true);
		expect(lobby.closePod(id, ALICE.id, 4, true)).toEqual({ ok: false, reason: 'seat-taken' });
		expect(lobby.closePod(id, ALICE.id, 5, true).ok).toBe(true);
		expect(lobby.get(id)?.pod?.seats[5]).toEqual({ memberId: POD_CLOSED, name: '' });
		expect(lobby.sitPod(id, BOB.id, 5)).toMatchObject({ ok: false });
		expect(lobby.aiPod(id, BOB.id, 5, true)).toEqual({ ok: false, reason: 'seat-taken' });
		expect(lobby.closePod(id, ALICE.id, 5, false).ok).toBe(true);
		expect(lobby.get(id)?.pod?.seats[5]).toBeNull();
	});

	it('leaves at least two seats open', async () => {
		const { lobby, id } = await draftRoom();
		for (let seat = 2; seat < 8; seat++) expect(lobby.closePod(id, ALICE.id, seat, true).ok).toBe(true);
		expect(lobby.closePod(id, ALICE.id, 1, true)).toEqual({ ok: false, reason: 'too-few' });
	});

	it('a pod of four deals a draft of four — two players and two AI — and is dealt once the four are filled', async () => {
		const { lobby, id } = await draftRoom();
		for (const seat of [4, 5, 6, 7]) expect(lobby.closePod(id, ALICE.id, seat, true).ok).toBe(true);
		expect(lobby.sitPod(id, ALICE.id, 0).ok).toBe(true);
		expect(lobby.sitPod(id, BOB.id, 1).ok).toBe(true);
		for (const m of [ALICE, BOB]) expect(lobby.setReady(id, m.id, true)).toBe(true);
		expect(lobby.startDraft(id, ALICE.id), 'two seats still open').toEqual({ ok: false, reason: 'not-ready' });
		for (const seat of [2, 3]) expect(lobby.aiPod(id, ALICE.id, seat, true).ok).toBe(true);
		const deal = lobby.podDraft(id)!;
		expect(deal.seats).toBe(4);
		expect(deal.bots).toHaveLength(2);
		approvePlan(lobby, id);
		expect(lobby.startDraft(id, ALICE.id)).toMatchObject({ ok: true });
		expect(lobby.podDraft(id)?.humans.map((h) => h.participantId)).toEqual([ALICE.id, BOB.id]);

		const load = loadPool(CUBE_FILE);
		if (!load.ok) throw new Error(`the bundled cube pool did not load: ${load.detail}`);
		const draftRooms = createDraftRooms({ ...singlePoolResolver(load.pool), now: () => 1_700_000_000_000 });
		draftRooms.setPodLookup((podId) => lobby.podDraft(podId));
		const room = draftRooms.open(id);
		expect(room.seats.capacity ?? room.seats.seats.length).toBe(4);
		expect(humanSeats(room.seats).map((s) => s.participantId).sort()).toEqual([ALICE.id, BOB.id].sort());
	});
});

describe('the pod seat is the draft table', () => {
	/** Every seat takes the first card of the pack in front of it. */
	function everyonePicks(state: DraftState): DraftState {
		let next = state;
		for (let seat = 0; seat < next.seatCount; seat++) {
			const result = pick(next, seat, packOf(next, seat)[0]!.cardId);
			if (!result.ok) throw new Error(`seat ${seat} could not pick: ${result.reason}`);
			next = result.state;
		}
		return next;
	}

	it('players in seats 1, 4 and 6 draft from those seats: pack 1 passes from seat 1 to seat 2, and seat 4 receives from seat 3', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		for (const m of [BOB, CAROL]) expect(lobby.join(id, m).ok).toBe(true);
		// Seats 1, 4 and 6 of the table, 0-based.
		expect(lobby.sitPod(id, ALICE.id, 0).ok).toBe(true);
		expect(lobby.sitPod(id, BOB.id, 3).ok).toBe(true);
		expect(lobby.sitPod(id, CAROL.id, 5).ok).toBe(true);
		for (const seat of [1, 2, 4, 6, 7]) expect(lobby.aiPod(id, ALICE.id, seat, true).ok).toBe(true);
		for (const m of [ALICE, BOB, CAROL]) expect(lobby.setReady(id, m.id, true)).toBe(true);
		approvePlan(lobby, id);
		expect(lobby.startDraft(id, ALICE.id)).toMatchObject({ ok: true });

		const load = loadPool(CUBE_FILE);
		if (!load.ok) throw new Error(`the bundled cube pool did not load: ${load.detail}`);
		const draftRooms = createDraftRooms({ ...singlePoolResolver(load.pool), now: () => 1_700_000_000_000 });
		draftRooms.setPodLookup((podId) => lobby.podDraft(podId));
		const room = draftRooms.open(id);
		const dealt = stateOf(room);
		expect([ALICE, BOB, CAROL].map((m) => seatOf(dealt.table, m.id)), 'each player drafts from the seat they sat in').toEqual([0, 3, 5]);

		const opened = dealt.queues.map((_, seat) => packOf(dealt, seat).map((c) => c.cardId));
		const passed = everyonePicks(dealt);
		expect(pickNumberOf(passed, 0)).toBe(2);
		// Pack 1 passes left: seat 1's pack, less its first pick, is now in front of seat 2 ...
		expect(packOf(passed, 1).map((c) => c.cardId)).toEqual(opened[0]!.slice(1));
		// ... and the player in seat 4 holds what seat 3 opened.
		expect(packOf(passed, seatOf(passed.table, BOB.id)!).map((c) => c.cardId)).toEqual(opened[2]!.slice(1));
	});

	it('a player alone at the pod plays the AI that drafted across the table from the seat they chose', async () => {
		const lobby = await openLobby({ dir: await tempDir() });
		const made = lobby.create(ALICE, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		const id = made.room.id;
		expect(lobby.sitPod(id, ALICE.id, 3).ok).toBe(true);
		for (const seat of [0, 1, 2, 4, 5, 6, 7]) expect(lobby.aiPod(id, ALICE.id, seat, true).ok).toBe(true);
		// Seat 4 of eight faces seat 8.
		expect(lobby.get(id)!.ai.name).toBe(lobby.get(id)!.pod!.seats[7]!.name);
	});
});

describe('a constructed room’s mode', () => {
	/** ALICE leading, BOB in it, both holding a deck; `seated` sits them at the first table. */
	async function constructedRoom(lobby: Lobby, seated: boolean): Promise<{ id: string; tableId: string }> {
		const made = lobby.create(ALICE, { name: 'Kitchen table', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(made.ok).toBe(true);
		if (!made.ok) throw new Error(made.reason);
		expect(lobby.join(made.room.id, BOB).ok).toBe(true);
		const tableId = made.room.tables[0]!.id;
		for (const who of [ALICE, BOB]) {
			expect(lobby.setPlayerState(made.room.id, who.id, { v: 1, verdict: { legal: true } })).toBe(true);
			if (seated) expect(lobby.sit(made.room.id, tableId, who.id)).toBe(true);
		}
		return { id: made.room.id, tableId };
	}

	it('is null until chosen, and a create may choose it with its options', async () => {
		const dir = await tempDir();
		const lobby = await openLobby({ dir, defaultFormat: POOLS[POOLS.length - 1] });
		const open = lobby.create(ALICE, { name: 'Open', gameType: 'constructed-1v1', clientMode: 'builtin' });
		expect(open.ok && [open.room.mode, open.room.modeOptions]).toEqual([null, null]);

		const chosen = lobby.create(ALICE, {
			name: 'Gauntlet night',
			gameType: 'constructed-1v1',
			clientMode: 'builtin',
			mode: { mode: 'gauntlet', modeOptions: { family: 'modern' } },
		});
		expect(chosen.ok).toBe(true);
		if (!chosen.ok) return;
		expect([chosen.room.mode, chosen.room.modeOptions]).toEqual(['gauntlet', { family: 'modern' }]);
		const second = await openLobby({ dir, defaultFormat: POOLS[POOLS.length - 1] });
		expect([second.get(chosen.room.id)?.mode, second.get(chosen.room.id)?.modeOptions]).toEqual(['gauntlet', { family: 'modern' }]);
	});

	it('is the leader’s to set, and only in a constructed room', async () => {
		const lobby = await openLobby({ dir: await tempDir(), defaultFormat: POOLS[POOLS.length - 1] });
		const { id } = await constructedRoom(lobby, false);
		const random = { mode: 'random', modeOptions: { pool: 'legacy' } } as const;
		expect(lobby.setMode(id, BOB.id, random)).toEqual({ ok: false, reason: 'not-leader' });
		expect(lobby.setMode('r-000000000000', ALICE.id, random)).toEqual({ ok: false, reason: 'no-room' });
		expect(lobby.get(id)?.mode).toBeNull();

		const draft = lobby.create(ALICE, { name: 'Cube night', gameType: 'draft', clientMode: 'builtin' });
		if (!draft.ok) throw new Error(draft.reason);
		expect(lobby.setMode(draft.room.id, ALICE.id, random)).toEqual({ ok: false, reason: 'not-constructed' });
	});

	it('clears every readiness flag, every seat and every deck hold when it changes, and nothing when it does not', async () => {
		const dir = await tempDir();
		const lobby = await openLobby({ dir, defaultFormat: POOLS[POOLS.length - 1] });
		const { id, tableId } = await constructedRoom(lobby, true);
		expect(lobby.setReady(id, BOB.id, true)).toBe(true);

		const set = lobby.setMode(id, ALICE.id, { mode: 'random', modeOptions: { pool: 'full' } });
		expect(set.ok).toBe(true);
		if (!set.ok) return;
		expect([set.room.mode, set.room.modeOptions]).toEqual(['random', { pool: 'full' }]);
		expect(set.room.members.map((m) => m.ready)).toEqual([false, false]);
		expect(lobby.playerState(id, ALICE.id)).toBeUndefined();
		expect(lobby.playerState(id, BOB.id)).toBeUndefined();
		expect(lobby.seats(id, tableId)).toEqual([]);

		// The same mode with the same options again changes nothing and clears nothing.
		expect(lobby.setPlayerState(id, BOB.id, { v: 1 })).toBe(true);
		expect(lobby.sit(id, tableId, BOB.id)).toBe(true);
		expect(lobby.setMode(id, ALICE.id, { mode: 'random', modeOptions: { pool: 'full' } }).ok).toBe(true);
		expect(lobby.playerState(id, BOB.id)).toEqual({ v: 1 });
		expect(lobby.seats(id, tableId)).toEqual([{ memberId: BOB.id, ready: false }]);
		// New options for the same mode are a change.
		expect(lobby.setMode(id, ALICE.id, { mode: 'random', modeOptions: { pool: 'modern' } }).ok).toBe(true);
		expect(lobby.playerState(id, BOB.id)).toBeUndefined();

		const second = await openLobby({ dir, defaultFormat: POOLS[POOLS.length - 1] });
		expect([second.get(id)?.mode, second.get(id)?.modeOptions]).toEqual(['random', { pool: 'modern' }]);
	});

	it('is locked once any seated player is ready, and the refusal changes nothing', async () => {
		const lobby = await openLobby({ dir: await tempDir(), defaultFormat: POOLS[POOLS.length - 1] });
		const { id, tableId } = await constructedRoom(lobby, false);
		expect(lobby.setMode(id, ALICE.id, { mode: 'classic', modeOptions: {} }).ok).toBe(true);
		expect(lobby.sit(id, tableId, ALICE.id) && lobby.sit(id, tableId, BOB.id)).toBe(true);
		expect(lobby.setSeatReady(id, tableId, BOB.id, true)).toBe(true);

		expect(lobby.setMode(id, ALICE.id, { mode: 'gauntlet', modeOptions: {} })).toEqual({ ok: false, reason: 'mode-locked' });
		expect(lobby.get(id)?.mode).toBe('classic');
		expect(lobby.seats(id, tableId)).toEqual([
			{ memberId: ALICE.id, ready: false },
			{ memberId: BOB.id, ready: true },
		]);

		// Standing down unlocks it.
		expect(lobby.setSeatReady(id, tableId, BOB.id, false)).toBe(true);
		expect(lobby.setMode(id, ALICE.id, { mode: 'gauntlet', modeOptions: {} }).ok).toBe(true);
	});

	it('is locked once a Gauntlet seat readies or its reveal has started, opens again when it is done, and a new mode forgets it', async () => {
		const dir = await tempDir();
		const lobby = await openLobby({ dir, defaultFormat: POOLS[POOLS.length - 1] });
		const { id, tableId } = await constructedRoom(lobby, false);
		expect(lobby.setMode(id, ALICE.id, { mode: 'gauntlet', modeOptions: {} }).ok).toBe(true);
		const classic = { mode: 'classic', modeOptions: {} } as const;

		expect(lobby.sit(id, tableId, ALICE.id) && lobby.setSeatReady(id, tableId, ALICE.id, true)).toBe(true);
		expect(lobby.setGauntlet(id, newGauntlet())).toBe(true);
		expect(lobby.setMode(id, ALICE.id, classic)).toEqual({ ok: false, reason: 'mode-locked' });
		expect(lobby.setSeatReady(id, tableId, ALICE.id, false)).toBe(true);

		const revealing = { ...newGauntlet(), phase: 'reveal' as const };
		expect(lobby.setGauntlet(id, revealing)).toBe(true);
		expect(lobby.setMode(id, ALICE.id, classic)).toEqual({ ok: false, reason: 'mode-locked' });
		// A restart keeps the draw and the lock.
		const second = await openLobby({ dir, defaultFormat: POOLS[POOLS.length - 1] });
		expect(second.gauntlet(id)?.phase).toBe('reveal');
		expect(second.setMode(id, ALICE.id, classic)).toEqual({ ok: false, reason: 'mode-locked' });

		expect(lobby.setGauntlet(id, { ...revealing, phase: 'done', winner: 0 })).toBe(true);
		expect(lobby.setMode(id, ALICE.id, classic).ok).toBe(true);
		expect(lobby.gauntlet(id)).toBeNull();
	});

	it('goes back to unchosen when the room switches game type', async () => {
		const lobby = await openLobby({ dir: await tempDir(), defaultFormat: POOLS[POOLS.length - 1] });
		const { id } = await constructedRoom(lobby, false);
		expect(lobby.setMode(id, ALICE.id, { mode: 'random', modeOptions: { pool: 'standard' } }).ok).toBe(true);
		const drafted = lobby.setGameType(id, ALICE.id, 'draft');
		expect(drafted.ok && [drafted.room.mode, drafted.room.modeOptions]).toEqual([null, null]);
	});

	it('locks the game type exactly when the mode is locked: a ready seat or a Gauntlet under way, freed once it is done', async () => {
		const lobby = await openLobby({ dir: await tempDir(), defaultFormat: POOLS[POOLS.length - 1] });
		const { id, tableId } = await constructedRoom(lobby, false);
		expect(lobby.setMode(id, ALICE.id, { mode: 'gauntlet', modeOptions: {} }).ok).toBe(true);
		expect(lobby.sit(id, tableId, BOB.id)).toBe(true);

		expect(lobby.setSeatReady(id, tableId, BOB.id, true)).toBe(true);
		expect(lobby.setGameType(id, ALICE.id, 'draft')).toEqual({ ok: false, reason: 'mode-locked' });
		expect(lobby.get(id)?.gameType).toBe('constructed-1v1');
		expect(lobby.setSeatReady(id, tableId, BOB.id, false)).toBe(true);

		const revealing = { ...newGauntlet(), phase: 'reveal' as const };
		expect(lobby.setGauntlet(id, revealing)).toBe(true);
		expect(lobby.setGameType(id, ALICE.id, 'draft')).toEqual({ ok: false, reason: 'mode-locked' });

		expect(lobby.setGauntlet(id, { ...revealing, phase: 'done', winner: 0 })).toBe(true);
		const drafted = lobby.setGameType(id, ALICE.id, 'draft');
		expect(drafted.ok && drafted.room.gameType).toBe('draft');
		const back = lobby.setGameType(id, ALICE.id, 'constructed-1v1');
		expect(back.ok && [back.room.gameType, back.room.mode]).toEqual(['constructed-1v1', null]);
	});

	it('restores a constructed room stored before modes existed as classic, and logs it', async () => {
		const dir = await tempDir();
		writeFixtureRoom(dir, 'r-mmmmmmmmmmm1', legacyApp());
		writeFixtureRoom(dir, 'r-mmmmmmmmmmm2', legacyApp({ gameType: 'draft' }));
		expect(Object.keys(legacyApp())).not.toContain('mode');
		const logged: Record<string, unknown>[] = [];
		const lobby = await openLobby({ dir, log: (e) => void logged.push(e) });

		expect([lobby.get('r-mmmmmmmmmmm1')?.mode, lobby.get('r-mmmmmmmmmmm1')?.modeOptions]).toEqual(['classic', {}]);
		expect([lobby.get('r-mmmmmmmmmmm2')?.mode, lobby.get('r-mmmmmmmmmmm2')?.modeOptions]).toEqual([null, null]);
		expect(logged.filter((e) => e.event === 'room-mode-restored')).toEqual([
			{ event: 'room-mode-restored', roomId: 'r-mmmmmmmmmmm1', mode: 'classic' },
		]);
	});

	it('restores a stored unchosen mode as unchosen, and quarantines a mode it does not know', async () => {
		const dir = await tempDir();
		writeFixtureRoom(dir, 'r-mmmmmmmmmmm3', legacyApp({ mode: null, modeOptions: null }));
		writeFixtureRoom(dir, 'r-mmmmmmmmmmm4', legacyApp({ mode: 'sealed', modeOptions: {} }));
		writeFixtureRoom(dir, 'r-mmmmmmmmmmm5', legacyApp({ mode: 'random', modeOptions: { pool: 'vintage' } }));
		const logged: Record<string, unknown>[] = [];
		const lobby = await openLobby({ dir, log: (e) => void logged.push(e) });

		expect(lobby.get('r-mmmmmmmmmmm3')?.mode).toBeNull();
		expect(logged.filter((e) => e.event === 'room-mode-restored')).toEqual([]);
		expect(lobby.get('r-mmmmmmmmmmm4')).toBeUndefined();
		expect(lobby.get('r-mmmmmmmmmmm5')).toBeUndefined();
		const quarantined = logged.filter((e) => e.event === 'room-quarantined');
		expect(quarantined.map((e) => e.roomId).sort()).toEqual(['r-mmmmmmmmmmm4', 'r-mmmmmmmmmmm5']);
		expect(quarantined.every((e) => String(e.reason).includes('app.mode'))).toBe(true);
	});
});

/*
 * wave 73 §A follow-up (manager, 2026-10-22): a new room's default plan has
 * `verdict: null` until a PUT runs one — but nothing PUTs on a room nobody
 * has touched yet, so `planVerdict` stayed null forever and B's Start gate
 * (disabled unless `verdict.ok`) could never open. A room whose plan has no
 * verdict — just created, or just restored with one still null — is checked
 * in the BACKGROUND, the result lands via `#persist` (disk + `onChange`,
 * same as any other pod mutation), and concurrent checks of the identical
 * plan are deduped to one call.
 */
describe("a room's plan checks itself — created or restored, not only PUT", () => {
	it('a newly created draft room gets its verdict with no PUT at all, and the change is observable', async () => {
		const dir = await tempDir();
		let calls = 0;
		const checkPlan = async (): Promise<PoolVerdict> => {
			calls++;
			return { ok: true, cards: 42 };
		};
		const lobby = await openLobby({ dir, checkPlan });
		const changed: string[] = [];
		lobby.onChange((id) => changed.push(id));
		const made = lobby.create(ALICE, { name: 'auto-check', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		// Not synchronous: the create answers before the background check lands.
		expect(made.room.pod?.verdict).toBeNull();
		await vi.waitFor(() => expect(lobby.get(made.room.id)?.pod?.verdict).toEqual({ ok: true, cards: 42 }));
		expect(calls).toBe(1);
		expect(changed).toContain(made.room.id);
	});

	it('dedupes concurrent checks of the identical plan across rooms — one call, not two', async () => {
		const dir = await tempDir();
		let calls = 0;
		let resolveCheck: ((v: PoolVerdict) => void) | null = null;
		const checkPlan = (): Promise<PoolVerdict> => {
			calls++;
			return new Promise((resolve) => {
				resolveCheck = resolve;
			});
		};
		const lobby = await openLobby({ dir, checkPlan });
		const a = lobby.create(ALICE, { name: 'a', gameType: 'draft', clientMode: 'builtin' });
		const b = lobby.create(BOB, { name: 'b', gameType: 'draft', clientMode: 'builtin' });
		if (!a.ok || !b.ok) throw new Error('create failed');
		// Both rooms open on the identical DEFAULT_PLAN — one in-flight check, not two.
		expect(calls).toBe(1);
		resolveCheck!({ ok: true, cards: 1 });
		await vi.waitFor(() => {
			expect(lobby.get(a.room.id)?.pod?.verdict).toEqual({ ok: true, cards: 1 });
			expect(lobby.get(b.room.id)?.pod?.verdict).toEqual({ ok: true, cards: 1 });
		});
	});

	it("a constructed room's plan field is never checked — it drafts nothing", async () => {
		const dir = await tempDir();
		const checkPlan = vi.fn();
		const lobby = await openLobby({ dir, checkPlan });
		lobby.create(ALICE, { name: 'c', gameType: 'constructed-1v1', clientMode: 'builtin' });
		await new Promise((r) => setTimeout(r, 20));
		expect(checkPlan).not.toHaveBeenCalled();
	});

	it('a room restored with a null verdict (the checker never answered before the process died) is checked again at boot', async () => {
		const dir = await tempDir();
		// Never resolves — simulates a process that died mid-check, leaving the
		// snapshot on disk with `planVerdict: null`.
		const first = await openLobby({ dir, checkPlan: () => new Promise<PoolVerdict>(() => {}) });
		const made = first.create(ALICE, { name: 'r', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		expect(made.room.pod?.verdict).toBeNull();

		let resolved = 0;
		const second = await openLobby({
			dir,
			checkPlan: async () => {
				resolved++;
				return { ok: true, cards: 7 };
			},
		});
		await vi.waitFor(() => expect(second.get(made.room.id)?.pod?.verdict).toEqual({ ok: true, cards: 7 }));
		expect(resolved).toBe(1);
	});

	it("a room restored with a verdict is checked again at boot — the saved one was this catalog's and this Forge pin's, not the next process's", async () => {
		const dir = await tempDir();
		const first = await openLobby({ dir, checkPlan: async () => ({ ok: true, cards: 534 }) });
		const made = first.create(ALICE, { name: 'r', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		await vi.waitFor(() => expect(first.get(made.room.id)?.pod?.verdict).toEqual({ ok: true, cards: 534 }));

		// The next process no longer has that cube: a shortlist swap, or an importer's delete.
		const refused: PoolVerdict = { ok: false, unplayable: ['unknown cube: mtgo-vintage-cube-2025-12'], missingText: [] };
		const second = await openLobby({ dir, checkPlan: async () => refused });
		await vi.waitFor(() => expect(second.get(made.room.id)?.pod?.verdict).toEqual(refused));
	});

	it('a failed check logs rather than throwing, and leaves the verdict null for a later check to pick up', async () => {
		const dir = await tempDir();
		const logged: Record<string, unknown>[] = [];
		const checkPlan = async (): Promise<PoolVerdict> => {
			throw new Error('forge pool service unreachable');
		};
		const lobby = await openLobby({ dir, checkPlan, log: (e) => void logged.push(e) });
		const made = lobby.create(ALICE, { name: 'fails', gameType: 'draft', clientMode: 'builtin' });
		if (!made.ok) throw new Error('create failed');
		await vi.waitFor(() => expect(logged.some((e) => e.event === 'plan-check-failed')).toBe(true));
		expect(lobby.get(made.room.id)?.pod?.verdict).toBeNull();
	});
});

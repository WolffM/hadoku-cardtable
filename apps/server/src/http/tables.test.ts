/**
 * The deck gate, end to end through the REAL play route.
 *
 * A real express app mounted the way `index.ts` mounts it — provenance, the
 * tier floor, `/api`, then `attachTables` BEFORE `attachPlay` — with play's
 * Forge replaced by the recorded-transcript `ReplayHost`, wrapped so the test
 * sees the exact `MatchSpec` Forge would have been launched with. So "the
 * illegal deck never reached Forge" is asserted on the host factory, not
 * inferred from a status code.
 *
 * The decks and pools are the committed library (`decks/`), read by the same
 * loader production uses. The illegal case is real history, not an invented
 * card: Standard as of 2011-07-15 banned Jace, the Mind Sculptor and
 * Stoneforge Mystic, and 2010's UG Polymorph (Antoine Ruel) played four Jaces
 * a year earlier, when it was still legal.
 */

import express from 'express';
import { readFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { moveToMain } from '@hadoku/deck';

import { deckFromPool, dckTextOf } from '../../../ui/src/draft/deckFromPool.ts';
import type { MatchReport } from '@wolffm/prefs-client/games';
import type { ClientFrame } from '@hadoku/forge-wire';
import { MATCH_CLOCK_MS, type ClockSetting } from '@hadoku/shared';
import type { MatchRecord, MatchHostFactory, MatchSpec } from '../play/host.js';
import type { MatchRegistry } from '../play/match.js';
import {
	MATCH_EVENTS,
	type DraftCard,
	type RoomModeState,
	type RoomTable,
} from '@hadoku/shared';
import { loadTranscript, replayFactory, type ReplayHost } from '../play/fixtures/transcript.js';
import { botPoolAcross, createDraftRooms, joinDraftRoom, singlePoolResolver, stateOf, type DraftRooms } from '../room/draftRooms.js';
import { botDeckText } from '../room/botDeck.js';
import { isBotSeat } from '@hadoku/draft';
import { draftPoolId } from '../room/lobby.js';
import { convertToBo3, newSeries, recordGame, seriesFormatOf } from '../room/series.js';
import { leaveSeat, readySeat, seatList, sitAt, type TableSeats } from '../room/seats.js';
import { identityFromHeaders } from '../room/identity.js';
import { loadPool } from '../room/pool.js';
import { act, choose, drawGauntlet, gameOver, gauntletEras, newGauntlet, startBanpick, viewOfGauntlet, type GauntletState } from '../room/gauntlet.js';
import { createKeyBook, createMatchStats, createStatsReporter } from '../stats/index.js';
import { checkSeat, type SeatVerdict } from './gate.js';
import type { TablesRooms } from './routes.js';
import { LIBRARY, formatIdOf, type LibraryCollection } from '@hadoku/deck/library';
import { loadTablesLibrary } from './library.js';

const EDGE_SECRET = 'test-edge-auth-secret';
const HERE = dirname(fileURLToPath(import.meta.url));
// @reads decks/ apps/ui/src/draft/pool.json
const REPO_ROOT = resolve(HERE, '../../../..');
const CUBE_FILE = resolve(REPO_ROOT, 'apps/ui/src/draft/pool.json');

/**
 * Real cross-era history, the way `library.test.ts`'s own "failure path"
 * section uses it: 2010's UG Polymorph (Antoine Ruel) plays four Jace, the
 * Mind Sculptor, legal in its own era (`Standard (M11)`, 2010-07-16) and
 * banned the moment `Standard (M12)` (2011-07-15) takes effect — two of its
 * other cards (Essence Scatter, Polymorph) are ALSO illegal there, rotated out
 * independently of the ban, which is real Magic history and not tidied away.
 */
const UG_POLYMORPH = 'power-2010-3-antoine-ruel-ug-polymorph';
const POWER_2010 = '2010-07-16';
const POWER_2011 = '2011-07-15';
const POWER_2012 = '2012-07-13';
/**
 * Two more real decks, because a room has ONE pool (wave 25 §A) and a test
 * that needs one legal deck and one illegal one now needs both of them in the
 * SAME pool. `ELDRAZI_GREEN` is one of the twelve decks the 2011 era's own
 * catalogue carries, so it is legal in `POWER_2011` by construction
 * (`validate-library.ts`, 0 issues) — the same pool `UG_POLYMORPH` fails.
 */
const ELDRAZI_GREEN = 'power-2011-1-daniel-royde-eldrazi-green';
/**
 * The generic "second real deck", legal in `POWER_2010` alongside
 * `UG_POLYMORPH` (both native to the 2010 era), used wherever a test needs
 * "another deck" and nothing more specific — including every `bothLoaded`
 * call, which opens a room on `POWER_2010` by default.
 */
const SECOND_DECK = 'power-2010-1-emanuele-giusti-jund';
/** A real deck native to the 2011 era, used ONLY for the one test that needs a deck legal in `POWER_2011` and not in `POWER_2010`. */
const CAW_BLADE = 'power-2011-1-marcello-calvetta-caw-blade';
/**
 * Legal in literally any pool: a basic land is exempt from both the
 * pool-membership check and the copy limit (`format.ts`), so sixty Islands
 * passes every era's gate with zero issues. Used where a test needs a SECOND
 * deck that stays legal across a room's format change — no real two decks in
 * this library's nine eras are guaranteed to both survive a jump between two
 * of them, because each era is deliberately the far side of a full rotation
 * from its neighbours (`catalog.ts`'s own header).
 */
const ALWAYS_LEGAL_DCK = '[metadata]\nName=Basics\nDeck Type=Constructed\n[Main]\n60 Island\n';

let routesMod: typeof import('./routes.ts');
let playMod: typeof import('../play/socket.ts');
let edgeMod: typeof import('../edge-auth.ts');

beforeAll(async () => {
	// config.ts reads the environment once, at load — same dance as play/socket.test.ts.
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	routesMod = await import('./routes.ts');
	playMod = await import('../play/socket.ts');
	edgeMod = await import('../edge-auth.ts');
});

function edgeHeaders(user: string, tier = 'friend'): Record<string, string> {
	return {
		'x-edge-auth': EDGE_SECRET,
		'x-hadoku-tier': tier,
		'x-user-id': `user-${user}`,
		'x-user-key': `friend-key-${user}`,
	};
}

/* ── the library, as production loads it ─────────────────────────────── */

const library = loadTablesLibrary(REPO_ROOT);

describe('the library', () => {
	it('loads every frozen pool and every catalogued deck, with no faults', () => {
		expect(library.faults).toEqual([]);
		// Derived, not hardcoded. These assertions were rewritten on each of the
		// first three collections added, every time for the same reason: a count
		// pinned here duplicates a fact `LIBRARY` already states. The shape pin
		// that SHOULD fail when a collection appears lives in
		// `packages/deck/src/library/library.test.ts`, once, on purpose.
		expect(library.formats.map((f) => f.id)).toContain(POWER_2010);
		expect(library.formats.map((f) => f.id)).toContain(POWER_2012);
		expect(library.formats.map((f) => f.pool.name)).toContain('Standard (M11)');
		expect(library.decks).toHaveLength(LIBRARY.flatMap((c: LibraryCollection) => c.decks).length);
	});

	it('names a file that will not load instead of refusing to boot', () => {
		const broken = loadTablesLibrary(REPO_ROOT, [
			{
				id: 'broken',
				family: 'standard',
				directory: 'decks/no-such-collection',
				event: 'nothing',
				format: 'Standard (M11)',
				date: POWER_2010,
				source: 'nowhere',
				decks: [{ id: 'ghost', file: 'ghost.dck' }],
			},
		]);
		expect(broken.decks).toEqual([]);
		expect(broken.faults).toHaveLength(1);
		expect(broken.faults[0]).toContain('ghost.dck');
		// The format still loads: one broken deck costs one entry, not the picker.
		// Exactly one, because the loader reads pools for the PASSED-IN library's
		// own dates (wave 34 §D), and this synthetic library names only one.
		expect(broken.formats).toHaveLength(1);
		expect(broken.formats[0]?.id).toBe(POWER_2010);
	});
});

/* ── the one check ───────────────────────────────────────────────────── */

describe('checkSeat', () => {
	const ctx = { library, draftPool: null };

	// Every deck, checked against ITS OWN collection's format rather than one
	// hardcoded date. The previous version iterated the whole library against
	// POWER_2010, which was correct only while the library held one collection —
	// the same shape of bug as asserting a collection's size against a
	// library-wide total. A DKA deck is legal in DKA and is not legal in a 2011
	// pool, and both of those are the right answer.
	it('passes every deck in the format it was actually played in', () => {
		// Each deck against ITS OWN collection's id, looked up rather than
		// guessed from the id — the prefix test that preceded this was a third
		// hardcoding of the same fact. `formatIdOf`, not the bare `c.date` (w48
		// §U): a Modern or Legacy deck's own era shares its date with Standard's
		// same-year era, and the bare date names the WRONG (Standard) pool.
		const formatOf = new Map<string, string>(
			LIBRARY.flatMap((c: LibraryCollection) => c.decks.map((d) => [d.id, formatIdOf(c)] as [string, string])),
		);
		for (const d of library.decks) {
			const format = formatOf.get(d.id) ?? POWER_2010;
			const v = checkSeat({ deck: { library: d.id }, rules: { kind: 'standard', format } }, ctx);
			expect(v, `${d.id} in ${format}`).toMatchObject({ legal: true, issues: [], note: null });
		}
	});

	/*
	 * The data behind the picker's era filter (wave 22 §B.4).
	 *
	 * `ConstructedScreen` narrows the deck dropdown to the decks legal in the
	 * chosen era, and it does so by asking THIS — one `POST /api/tables/check`
	 * per deck per era — rather than by arithmetic over the set list the browser
	 * is sent. That makes the filter the gate's answer instead of a guess, and
	 * it makes this test the thing that says the answer is usable: **no era
	 * narrows the list to nothing**, and **no deck is unreachable** through some
	 * era, so neither end of the picker has a dead option in it.
	 *
	 * Also the cost, measured rather than assumed: the whole matrix is 441 gate
	 * runs and this test is one of the fast ones. What the browser pays is round
	 * trips, which is why the screen asks once per era and remembers.
	 *
	 * Every count here is derived. A new collection or a new frozen pool moves
	 * all of them and must not fail this.
	 */
	// Every deck against every era: 1,459 decks by 67 eras since the library ran to 2025,
	// near 100,000 checks, so it gets the time that takes rather than the default 5 s.
	it('answers the era filter for every deck and every era, with no dead option at either end', { timeout: 30_000 }, () => {
		const offered = new Map<string, string[]>();
		for (const format of library.formats) {
			const legal = library.decks
				.filter((d) => {
					const v = checkSeat({ deck: { library: d.id }, rules: { kind: 'standard', format: format.id } }, ctx);
					return 'legal' in v && v.legal;
				})
				.map((d) => d.id);
			offered.set(format.id, legal);
		}

		// An era that offered nothing would be a dead end a person can select.
		expect([...offered].filter(([, ids]) => ids.length === 0).map(([id]) => id)).toEqual([]);
		// A deck no era offers could never be chosen at all.
		const reachable = new Set([...offered.values()].flat());
		expect(library.decks.filter((d) => !reachable.has(d.id)).map((d) => d.id)).toEqual([]);

		// And the filter does NARROW: a deck offered by its own era is not
		// necessarily offered by another — UG Polymorph is legal in 2010 and the
		// bans (plus the rotation that comes with a year passing) cost it 2011.
		// Comparing the two eras' TOTAL counts would not show this: 2011 offers
		// more decks overall than 2010 simply because it has more decks native to
		// it (12 against 8), which has nothing to do with the ban.
		expect(offered.get(POWER_2010)).toContain(UG_POLYMORPH);
		expect(offered.get(POWER_2011)).not.toContain(UG_POLYMORPH);
	});

	it('refuses the same deck a year later, naming the banned card and the rotation', () => {
		const v = checkSeat({ deck: { library: UG_POLYMORPH }, rules: { kind: 'standard', format: POWER_2011 } }, ctx) as SeatVerdict;
		expect(v.legal).toBe(false);
		// Real cross-era history, not tidied: Essence Scatter and Polymorph rotated
		// out independently of the ban, so the deck fails three ways, not one.
		expect(v.issues.map((i) => [i.kind, i.cardName])).toEqual([
			['not-in-pool', 'Essence Scatter'],
			['not-in-pool', 'Polymorph'],
			['banned', 'Jace, the Mind Sculptor'],
		]);
		expect(v.issues.find((i) => i.kind === 'banned')?.message).toBe(
			'plays 4x Jace, the Mind Sculptor, which Standard (M12) bans',
		);
		// Not a fault in the deck, and said separately.
		expect(v.note).toContain('is built for "Standard (M11)"');
	});

	it('checks pasted .dck text the same way as a library deck', () => {
		const text = library.deck(UG_POLYMORPH)?.text ?? '';
		const pasted = checkSeat({ deck: { dck: text }, rules: { kind: 'standard', format: POWER_2011 } }, ctx) as SeatVerdict;
		const byId = checkSeat({ deck: { library: UG_POLYMORPH }, rules: { kind: 'standard', format: POWER_2011 } }, ctx) as SeatVerdict;
		expect(pasted.issues).toEqual(byId.issues);
		expect(pasted.text).toBe(byId.text);
	});

	it('answers an unknown deck or format as unresolved, not as an illegal deck', () => {
		expect(checkSeat({ deck: { library: 'nope' }, rules: { kind: 'standard', format: POWER_2010 } }, ctx)).toEqual({
			error: 'no library deck "nope"',
		});
		expect(checkSeat({ deck: { library: UG_POLYMORPH }, rules: { kind: 'standard', format: '1999-01-01' } }, ctx)).toEqual({
			error: 'no format "1999-01-01"',
		});
	});
});

/* ── through the real play route ─────────────────────────────────────── */

/** Forge's recorded opening, up to its first question: enough for the route to answer 201. */
const TRANSCRIPT = loadTranscript();
const OPENING = TRANSCRIPT.slice(0, TRANSCRIPT.findIndex((l) => l.t === 'frame' && (l.frame as { kind: string }).kind === 'ask'));

/* ── a stand-in for lane A's lobby ───────────────────────────────────── */

/**
 * The A↔C room contract as an in-memory fake. `apps/server/src/room/lobby.ts`
 * is lane A's file and was not on the branch when this was written, so the
 * routes take the subset they need (`TablesRooms`) as a structural type and
 * this implements it. When A lands, `index.ts` passes the real `Lobby`.
 */
interface FakeRoom {
	id: string;
	name: string;
	gameType: string;
	/** The room's pool: one per table, for both seats. Mutable here, so a test can put a room in a state the leader's setter would never leave it in. */
	format: string;
	settings: { handSmoothing: boolean; clock?: ClockSetting };
	leader: string;
	/** `avatarId` optional and never blank, exactly as `RoomViewLike` states it. */
	members: { id: string; name: string; avatarId?: string }[];
	/** Wave 71: always at least one. The real `RoomTable` shape — `players` already resolved, as `viewOf` resolves it. */
	tables: RoomTable[];
	/** Every match this room started, on any table, as `Lobby.roomOfMatch` remembers them. */
	matches: string[];
	state: Map<string, unknown>;
	/** Each table's seats and Readys, by table id, through `room/seats.ts` as the real lobby keeps them; `tables[].players` is drawn from it. */
	seats: Map<string, TableSeats>;
	/** Wave 72 §P: `RoomViewLike` carries it now, but no test in this file plays a pod — every fake room is constructed and this stays `null`. */
	pod: { phase: string } | null;
	/** A Constructed room's mode and its options (`@hadoku/shared`'s `RoomModeState`); absent reads as no mode chosen. The mode sizes its series (`room/series.ts`'s `seriesFormatOf`). */
	mode?: RoomModeState['mode'];
	modeOptions?: RoomModeState['modeOptions'];
	/** `Lobby.gauntlet`'s stored Gauntlet; absent reads as none. */
	gauntlet?: GauntletState | null;
	/** `room/lobby.ts`'s `RoomRecord.scenario` — absent is every room a friend ever opens. Mutable directly, same as `settings` above: no fake setter exists for a field only `room/testing-rooms.ts` ever sets on the real lobby. */
	scenario?: string;
	/** `room/lobby.ts`'s `RoomRecord.testing` — absent is every room a friend ever opens. Mutable directly, same reasoning as `scenario` above. */
	testing?: boolean;
}

interface FakeLobby extends TablesRooms {
	open(id: string, members: FakeRoom['members'], gameType?: string, format?: string): FakeRoom;
	room(id: string): FakeRoom | undefined;
}

/** An empty, `seating` table — what a new room's first table, and `addTable`, both start as. */
function emptyTable(id: string, length: 1 | 3): RoomTable {
	return { id, players: [], matchId: null, series: { length, wins: [0, 0], games: [], phase: 'seating' } };
}

function fakeLobby(): FakeLobby {
	const held = new Map<string, FakeRoom>();
	/** Each table's series clock pool, as `Lobby.seriesClockMs` keeps it. */
	const clocks = new Map<string, [number, number]>();
	const member = (roomId: string, memberId: string): FakeRoom | undefined => {
		const room = held.get(roomId);
		return room !== undefined && room.members.some((m) => m.id === memberId) ? room : undefined;
	};
	let nextTableId = 0;
	const mintTable = () => `t-fake${String(nextTableId++).padStart(4, '0')}`;
	/** A table's seats, made empty on first use. */
	const seatsAt = (roomId: string, tableId: string): { room: FakeRoom; table: RoomTable; seats: TableSeats } | undefined => {
		const room = held.get(roomId);
		const table = room?.tables.find((t) => t.id === tableId);
		if (room === undefined || table === undefined) return undefined;
		let seats = room.seats.get(tableId);
		if (seats === undefined) room.seats.set(tableId, (seats = { seats: [null, null], ready: [false, false] }));
		return { room, table, seats };
	};
	/** Redraw `RoomTable.players` from the seats, as the real lobby's `viewOf` does. */
	const drawSeats = (at: { room: FakeRoom; table: RoomTable; seats: TableSeats }): true => {
		at.table.players = seatList(at.seats).map(({ memberId }) => ({ memberId, name: at.room.members.find((m) => m.id === memberId)?.name ?? '' }));
		return true;
	};
	return {
		open(id, members, gameType = 'constructed-1v1', format = POWER_2010) {
			// The first member is the leader, as `lobby.create` makes the creator one.
			const room: FakeRoom = {
				id,
				name: `room ${id}`,
				gameType,
				format,
				settings: { handSmoothing: true },
				leader: members[0]?.id ?? '',
				members,
				tables: [emptyTable(mintTable(), seriesFormatOf({ gameType }).length)],
				matches: [],
				state: new Map(),
				seats: new Map(),
				pod: null,
			};
			held.set(id, room);
			return room;
		},
		room: (id) => held.get(id),
		gauntlet: (id) => held.get(id)?.gauntlet ?? null,
		setGauntlet(id, gauntlet) {
			const room = held.get(id);
			if (room === undefined) return false;
			room.gauntlet = gauntlet;
			return true;
		},
		get: (id) => held.get(id),
		list: () => [...held.values()],
		roomOfMatch: (matchId) => [...held.values()].find((r) => r.tables.some((t) => t.matchId === matchId) || r.matches.includes(matchId)),
		playerState: (roomId, memberId) => member(roomId, memberId)?.state.get(memberId),
		setPlayerState(roomId, memberId, state) {
			const room = member(roomId, memberId);
			if (room === undefined) return false;
			// Through JSON, as a persisted lobby would: a state this route cannot
			// read back after a restart is a state it must not depend on. `undefined`
			// clears the row, exactly as `Lobby.setPlayerState` does.
			if (state === undefined) room.state.delete(memberId);
			else room.state.set(memberId, JSON.parse(JSON.stringify(state)) as unknown);
			return true;
		},
		seats: (roomId, tableId) => {
			const at = seatsAt(roomId, tableId);
			return at === undefined ? [] : seatList(at.seats);
		},
		sit(roomId, tableId, memberId) {
			const at = seatsAt(roomId, tableId);
			if (at === undefined || !at.room.members.some((m) => m.id === memberId)) return false;
			const every = at.room.tables.map((t) => seatsAt(roomId, t.id)!);
			if (!sitAt(every.map((t) => t.seats), at.seats, memberId)) return false;
			return every.every(drawSeats);
		},
		stand(roomId, tableId, memberId) {
			const at = seatsAt(roomId, tableId);
			if (at === undefined) return false;
			leaveSeat(at.seats, memberId);
			return drawSeats(at);
		},
		setSeatReady(roomId, tableId, memberId, ready) {
			const at = seatsAt(roomId, tableId);
			return at !== undefined && readySeat(at.seats, memberId, ready);
		},
		// The series through `room/series.ts`'s own rules, so this fake never
		// restates them; who played and whether it is recorded are the real
		// lobby's, and are not kept here.
		setTableMatch(roomId, tableId, matchId) {
			const room = held.get(roomId);
			const table = room?.tables.find((t) => t.id === tableId);
			if (room === undefined || table === undefined || table.matchId !== null) return false;
			if (table.series.phase === 'seating' || table.series.phase === 'done') {
				const { length, wins, games } = newSeries(room, [], 'playing');
				table.series = { length, wins, games, phase: 'playing' };
			} else {
				table.series = { ...table.series, phase: 'playing' };
			}
			table.matchId = matchId;
			seatsAt(roomId, tableId)!.seats.ready = [false, false];
			if (!room.matches.includes(matchId)) room.matches.push(matchId);
			return true;
		},
		releaseTableMatch(roomId, tableId) {
			const room = held.get(roomId);
			const table = room?.tables.find((t) => t.id === tableId);
			if (room === undefined || table === undefined) return false;
			table.matchId = null;
			// Every member's table state (the deck hold) is opaque to this fake,
			// same as the real lobby: kept whole. The seats are un-readied.
			seatsAt(roomId, tableId)!.seats.ready = [false, false];
			return true;
		},
		recordGameResult(roomId, tableId, result) {
			const room = held.get(roomId);
			const table = room?.tables.find((t) => t.id === tableId);
			if (room === undefined || table === undefined) return { ok: false };
			table.matchId = null;
			seatsAt(roomId, tableId)!.seats.ready = [false, false];
			const { length, wins, games, phase } = recordGame({ ...table.series, played: [null, null], mode: 'classic', settled: false }, seriesFormatOf(room), result);
			table.series = { length, wins, games, phase };
			if (result.clockMs !== undefined) clocks.set(`${roomId}/${tableId}`, result.clockMs);
			return { ok: true };
		},
		seriesClockMs: (roomId, tableId) => clocks.get(`${roomId}/${tableId}`) ?? null,
		beginSideboarding(roomId, tableId) {
			const room = held.get(roomId);
			const table = room?.tables.find((t) => t.id === tableId);
			if (room === undefined || table === undefined) return false;
			const converted = convertToBo3({ ...table.series, played: [null, null], mode: 'classic', settled: false });
			if (converted === null) return false;
			table.series = { length: converted.length, wins: converted.wins, games: converted.games, phase: converted.phase };
			return true;
		},
		addTable(roomId, callerId) {
			const room = held.get(roomId);
			if (room === undefined) return { ok: false, reason: 'no-room' };
			if (room.leader !== callerId) return { ok: false, reason: 'not-leader' };
			const table = emptyTable(mintTable(), seriesFormatOf(room).length);
			room.tables.push(table);
			return { ok: true, table };
		},
		removeTable(roomId, callerId, tableId) {
			const room = held.get(roomId);
			if (room === undefined) return { ok: false, reason: 'no-room' };
			if (room.leader !== callerId) return { ok: false, reason: 'not-leader' };
			if (room.tables[0]?.id === tableId) return { ok: false, reason: 'first-table' };
			const index = room.tables.findIndex((t) => t.id === tableId);
			if (index === -1) return { ok: false, reason: 'no-such-table' };
			const table = room.tables[index]!;
			const idle = table.matchId === null && (table.series.phase === 'seating' || table.series.phase === 'done');
			if (table.players.length > 0 || !idle) return { ok: false, reason: 'not-idle' };
			room.tables.splice(index, 1);
			return { ok: true };
		},
	};
}

const idOf = (user: string): string => identityFromHeaders(edgeHeaders(user), `http-${user}`);
const ALICE = idOf('alice');
const BOB = idOf('bob');
const CAROL = idOf('carol');

interface Harness {
	port: number;
	specs: MatchSpec[];
	hosts: ReplayHost[];
	rooms: DraftRooms;
	lobby: FakeLobby;
	matches: MatchRegistry;
	/** What the match stats sent to the game-stats store, wired as `index.ts` wires them. */
	reports: MatchReport[];
	statsLogs: Record<string, unknown>[];
	playLogs: Record<string, unknown>[];
	/** The handle `index.ts` holds. */
	tables: ReturnType<typeof routesMod.attachTables>;
	close: () => Promise<void>;
}

let harness: Harness | null = null;

afterEach(async () => {
	if (harness !== null) await harness.close();
	harness = null;
});

/**
 * One server process. `lobby` is what a restart restores from disk (the same
 * rooms), and `host` stands in for the JVM pool — a restart's re-attaches
 * through its `orphans`/`attach`.
 */
async function boot(opts: { lobby?: FakeLobby; host?: MatchHostFactory } = {}): Promise<Harness> {
	const cube = loadPool(CUBE_FILE);
	if (!cube.ok) throw new Error(`cube pool did not load: ${cube.detail}`);
	const rooms = createDraftRooms({ ...singlePoolResolver(cube.pool), now: () => 1_700_000_000_000 });

	const { factory, hosts } = replayFactory();
	const specs: MatchSpec[] = [];
	const lobby = opts.lobby ?? fakeLobby();
	const app = express();
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	const api = express.Router();
	api.use(express.json({ limit: '1mb' }));
	app.use('/api', api);
	const keys = createKeyBook();
	api.use(keys.remember);
	const reports: MatchReport[] = [];
	const statsLogs: Record<string, unknown>[] = [];
	const playLogs: Record<string, unknown>[] = [];
	const http: HttpServer = createServer(app);
	const io = new SocketIOServer(http, { serveClient: false });

	// The order index.ts uses, and the order that matters: the gate first. Play
	// is attached after, so the gate reads its registry lazily — the same wiring
	// index.ts will have.
	let attached: ReturnType<typeof playMod.attachPlay> | null = null;
	const tables = routesMod.attachTables(api, {
		// The library loaded once above, as production loads it once at boot: re-reading
		// 67 eras' pools for every booted stack ran a 2 GB worker out of heap.
		library,
		draftRooms: rooms,
		log: () => {},
		rooms: lobby,
		matches: () => attached?.matches ?? null,
	});
	const stats = createMatchStats({
		keys,
		log: (e) => statsLogs.push(e),
		reporter: createStatsReporter({ record: async (r) => (reports.push(r), { duplicate: false }), log: (e) => statsLogs.push(e) }),
		startOf: tables.matchStart,
	});
	const play = playMod.attachPlay(io, api, {
		minTier: 'friend',
		host:
			opts.host ??
			((id, spec, events) => {
				specs.push(spec);
				return factory(id, spec, events);
			}),
		log: (e) => playLogs.push(e),
		startTimeoutMs: 5000,
		seatAvatar: tables.seatAvatar,
		// The composition `index.ts` wires on its one `onGameOver` line (wave 72
		// §P step 1): the stats report, and the table's own series ledger,
		// recorded from the SAME event rather than waiting for a `/api/tables`
		// read to notice the match ended.
		onGameOver: (match) => {
			stats.gameOver(match);
			tables.gameOver(match);
		},
		keys,
	});
	attached = play;

	await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
	const port = (http.address() as AddressInfo).port;
	harness = {
		port,
		specs,
		hosts,
		rooms,
		lobby,
		matches: play.matches,
		reports,
		statsLogs,
		playLogs,
		tables,
		close: async () => {
			play.close();
			io.close();
			await new Promise<void>((done) => http.close(() => done()));
		},
	};
	return harness;
}

async function call(
	h: Harness,
	method: 'GET' | 'POST' | 'PUT' | 'DELETE',
	path: string,
	body?: unknown,
	headers: Record<string, string> = edgeHeaders('alice'),
	contentType = 'application/json',
): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await fetch(`http://127.0.0.1:${h.port}${path}`, {
		method,
		headers: { ...headers, 'content-type': contentType },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	return { status: res.status, body: text.startsWith('{') ? (JSON.parse(text) as Record<string, unknown>) : { text } };
}

/**
 * Until the harness has made its `count`th host, or `pending` is answered without
 * one: a refusal answers at once and a start waits on the host it makes, so the
 * test's own timeout is the only bound. A fixed 3 s window here spent 3 s on every
 * refused start, which carried those cases past the 5 s budget on a loaded host,
 * and fed no opening to a start slower than the window.
 */
async function untilHost(h: Harness, count: number, pending: Promise<unknown>): Promise<void> {
	let answered = false;
	void pending.then(
		() => (answered = true),
		() => (answered = true),
	);
	while (h.hosts.length < count && !answered) await new Promise((r) => setTimeout(r, 5));
}

/**
 * POST a match that should START: feed the host Forge's recorded opening once
 * it exists, as `play/socket.test.ts` does, so play's route can answer.
 */
async function start(
	h: Harness,
	body: unknown,
	path = '/api/play/matches',
	contentType = 'application/json',
	headers: Record<string, string> = edgeHeaders('alice'),
): Promise<{ status: number; body: Record<string, unknown> }> {
	const pending = call(h, 'POST', path, body, headers, contentType);
	await untilHost(h, 1, pending);
	if (h.hosts.length > 0) (h.hosts.at(-1) as ReplayHost).push(...OPENING);
	return pending;
}

const standard = (deck: string, format: string) => ({ deck: { library: deck }, rules: { kind: 'standard', format } });

// The operator, 2026-10-20, after a watcher sat on "Connecting…" with nothing logged: "we absolutely need logging".
describe('POST /api/play/matches/:id/report', () => {
	it("logs a board's trouble with who sent it, and refuses a report it does not know", async () => {
		const h = await boot();
		try {
			const ok = await call(h, 'POST', '/api/play/matches/m-0123456789ab/report', { what: 'no-snapshot', ui: '0.32.404', detail: { connected: false, afterMs: 10000 } });
			expect(ok.status).toBe(204);
			expect(h.playLogs.filter((e) => e.evt === 'client-report')).toEqual([
				expect.objectContaining({ matchId: 'm-0123456789ab', what: 'no-snapshot', ui: '0.32.404', detail: { connected: false, afterMs: 10000 }, participantId: expect.any(String) }),
			]);
			const bad = await call(h, 'POST', '/api/play/matches/m-0123456789ab/report', { what: 'anything', detail: {} });
			expect(bad.status).toBe(400);
			expect(h.playLogs.filter((e) => e.evt === 'client-report')).toHaveLength(1);
		} finally {
			await h.close();
		}
	});
});

describe('POST /api/play/matches, gated', () => {
	it('starts a match against the AI with two legal library decks, handing Forge the files byte for byte', async () => {
		const h = await boot();
		const res = await start(h, {
			opponent: 'ai',
			seats: [standard(UG_POLYMORPH, POWER_2010), standard(SECOND_DECK, POWER_2010)],
		});
		expect(res.status).toBe(201);
		expect(typeof res.body.matchId).toBe('string');
		expect(h.specs).toHaveLength(1);
		expect(h.specs[0]?.seats.map((s) => s.deck)).toEqual([
			readFileSync(resolve(REPO_ROOT, 'decks/standard-2010/3-antoine-ruel-ug-polymorph.dck'), 'utf8'),
			readFileSync(resolve(REPO_ROOT, 'decks/standard-2010/1-emanuele-giusti-jund.dck'), 'utf8'),
		]);
	});

	it('refuses an illegal deck with the offending card named, and never launches Forge', async () => {
		const h = await boot();
		const res = await call(h, 'POST', '/api/play/matches', {
			opponent: 'ai',
			seats: [standard(UG_POLYMORPH, POWER_2011), standard(SECOND_DECK, POWER_2011)],
		});
		expect(res.status).toBe(422);
		expect(res.body.error).toBe(
			'Seat 1\'s deck "UG Polymorph (Antoine Ruel)" is not legal in Standard (M12): ' +
				'plays 1x Essence Scatter, which is not in Standard (M12) (and 2 more)',
		);
		const seats = res.body.seats as { legal: boolean; issues: { cardName: string }[] }[];
		// Both of these 2010 decks have rotated out of the 2011 pool; the refusal leads with seat 1.
		expect(seats.map((s) => s.legal)).toEqual([false, false]);
		expect(seats[0]?.issues.map((i) => i.cardName)).toEqual(['Essence Scatter', 'Polymorph', 'Jace, the Mind Sculptor']);
		// The .dck text stays on the server.
		expect(JSON.stringify(res.body)).not.toContain('[metadata]');
		expect(h.specs).toEqual([]);
	});

	it('refuses a raw .dck that skipped the gate', async () => {
		const h = await boot();
		const text = library.deck(UG_POLYMORPH)?.text;
		const res = await call(h, 'POST', '/api/play/matches', { opponent: 'ai', decks: [text, null] });
		expect(res.status).toBe(422);
		expect(res.body.error).toContain('a deck must be checked');
		expect(h.specs).toEqual([]);
	});

	it("passes Forge's own random precons through untouched", async () => {
		const h = await boot();
		const res = await start(h, { opponent: 'human' });
		expect(res.status).toBe(201);
		expect(h.specs[0]?.seats.map((s) => s.deck)).toEqual([null, null]);
	});

	it('answers a malformed body or an unknown deck with 400, not a verdict', async () => {
		const h = await boot();
		const bad = await call(h, 'POST', '/api/play/matches', { seats: [standard(UG_POLYMORPH, POWER_2010)] });
		expect(bad).toMatchObject({ status: 400, body: { error: 'seats is a two-element array' } });
		const unknown = await call(h, 'POST', '/api/play/matches', {
			opponent: 'ai',
			seats: [standard(UG_POLYMORPH, POWER_2010), standard('nope', POWER_2010)],
		});
		expect(unknown).toMatchObject({ status: 400, body: { error: 'seat 2: no library deck "nope"', seat: 1 } });
		expect(h.specs).toEqual([]);
	});

	it('is behind the friend floor like every other route', async () => {
		const h = await boot();
		const res = await call(
			h,
			'POST',
			'/api/play/matches',
			{ seats: [standard(UG_POLYMORPH, POWER_2010), standard(SECOND_DECK, POWER_2010)] },
			edgeHeaders('mallory', 'public'),
		);
		expect(res.status).toBe(404);
		expect((await call(h, 'GET', '/api/tables/formats', undefined, edgeHeaders('mallory', 'public'))).status).toBe(404);
		expect(h.specs).toEqual([]);
	});
});

describe('the catalog routes', () => {
	it('lists the formats and the decks', async () => {
		const h = await boot();
		const formats = await call(h, 'GET', '/api/tables/formats');
		expect(formats.status).toBe(200);
		const rows = (formats.body.formats as { id: string; banned: string[] }[]).map((f) => [f.id, f.banned]);
		expect(rows).toContainEqual([POWER_2010, []]);
		expect(rows).toContainEqual([POWER_2011, ['Jace, the Mind Sculptor', 'Stoneforge Mystic']]);
		expect(rows).toContainEqual([POWER_2012, []]);
		// The era's ruleset family (w48 §U) — every era on main today is Standard,
		// and the UI groups its tabs on this, never on a parsed `name`.
		const families = (formats.body.formats as { family: string }[]).map((f) => f.family);
		expect(families.length).toBeGreaterThan(0);
		expect(families.every((f) => f === 'standard' || f === 'modern' || f === 'legacy')).toBe(true);
		const decks = await call(h, 'GET', '/api/tables/decks');
		const list = decks.body.decks as { id: string; name: string; main: { count: number }[] }[];
		expect(list).toHaveLength(LIBRARY.flatMap((c: LibraryCollection) => c.decks).length);
		// The very first deck in catalog order: the oldest era, first deck chosen.
		// Derived from the loaded library itself, never a hardcoded id/name — w48
		// moved this exact pin once already (2008 → 2003, Standard backfilled five
		// more years), and a count fact restated here is a second copy free to go
		// stale the next time an era is added at the front.
		expect(list[0]).toMatchObject({ id: library.decks[0]!.id, name: library.decks[0]!.deck.name });
		expect(list[0]?.main.reduce((n, e) => n + e.count, 0)).toBe(60);
	});

	// Free pick lists an era's decks by this id. Joined on name + date, Legacy 2019, 2020, 2023 and 2025
	// and Modern 2020, 2023 and 2025 listed none: their events came after the ruleset began.
	it('gives every library deck the id of an era it serves', async () => {
		const h = await boot();
		const formats = await call(h, 'GET', '/api/tables/formats');
		const ids = new Set((formats.body.formats as { id: string }[]).map((f) => f.id));
		const decks = await call(h, 'GET', '/api/tables/decks');
		const list = decks.body.decks as { id: string; era: string }[];
		expect(list.filter((d) => !ids.has(d.era) || d.era === 'free')).toEqual([]);
		expect(list.find((d) => d.id === 'power-legacy-2025-1-ivan-ibanez-lands')?.era).toBe('legacy-2025-06-30');
	});

	it('names every library deck’s archetype and pilot apart, Goggles Ramp by Aleksa Telaron among them', async () => {
		const h = await boot();
		const decks = await call(h, 'GET', '/api/tables/decks');
		const list = decks.body.decks as { name: string; archetype: string; pilot: string }[];
		expect(list.find((d) => d.name === 'Goggles Ramp (Aleksa Telaron)')).toMatchObject({
			archetype: 'Goggles Ramp',
			pilot: 'Aleksa Telaron',
		});
		expect(list.filter((d) => d.archetype === '' || d.pilot === '')).toEqual([]);
	});

	// Every era against every deck, by the route and one deck at a time: about 21,000 legality
	// checks. 0.95 s on the host; past vitest's 5 s default on a CI runner under the full check
	// (CI run 37588858089, 2026-10-07). The budget below is the measurement with room, not a pin.
	it('answers an era’s own legal decks in one call, the same answer as checking each deck', { timeout: 30_000 }, async () => {
		const h = await boot();
		const ctx = { library, draftPool: null };
		for (const format of library.formats) {
			const res = await call(h, 'GET', `/api/tables/legal/${encodeURIComponent(format.id)}`);
			expect(res.status, format.id).toBe(200);
			const oneByOne = library.decks
				.filter((d) => {
					if (d.era !== format.id) return false;
					const v = checkSeat({ deck: { library: d.id }, rules: { kind: 'standard', format: format.id } }, ctx);
					return 'legal' in v && v.legal;
				})
				.map((d) => d.id);
			expect(res.body, format.id).toEqual({ format: format.id, legal: oneByOne });
		}
		expect(h.specs).toEqual([]);
	});

	// The operator, 2026-10-09: "every year of modern has the same decks". Legality
	// alone offered every year the same Modern-legal Standard decks first.
	it('offers each Modern year its own decks, and no two years the same list', async () => {
		const h = await boot();
		const lists: string[] = [];
		for (const format of library.formats.filter((f) => f.family === 'modern')) {
			const res = await call(h, 'GET', `/api/tables/legal/${encodeURIComponent(format.id)}`);
			const ids = (res.body as { legal: string[] }).legal;
			expect(ids.length, format.id).toBeGreaterThan(0);
			for (const id of ids) expect(library.deck(id)?.era, `${format.id} offers ${id}`).toBe(format.id);
			lists.push(ids.join());
		}
		expect(lists.length).toBeGreaterThan(1);
		expect(new Set(lists).size).toBe(lists.length);
	});

	// The operator, 2026-10-13: "let's go further back with the formats, try to back as far as
	// possible." Type 2's first summer in Forge's archive (1995, Chronicles) and Modern's first
	// (2011, the summer of its first Pro Tour) are the earliest years mtgtop8 has decks for.
	it.each([
		['1995-07-01', 'standard', 'Type 2 (CHR)', 'power-1995-'],
		['modern-2011-07-15', 'modern', 'Modern (M12)', 'power-modern-2011-'],
	])('offers %s, the earliest %s year, with its own legal decks', async (id, family, name, prefix) => {
		const h = await boot();
		const formats = (await call(h, 'GET', '/api/tables/formats')).body as { formats: { id: string; family: string; name: string }[] };
		expect(formats.formats.find((f) => f.id === id)).toMatchObject({ family, name });
		const oldest = formats.formats.filter((f) => f.family === family).map((f) => f.id).sort()[0];
		expect(oldest, `${family}'s oldest era`).toBe(id);
		const res = await call(h, 'GET', `/api/tables/legal/${encodeURIComponent(id)}`);
		expect(res.status).toBe(200);
		const legal = (res.body as { legal: string[] }).legal;
		expect(legal.length).toBeGreaterThan(0);
		for (const deck of legal) expect(deck.startsWith(prefix), deck).toBe(true);
		expect(legal).toEqual(library.decks.filter((d) => d.era === id).map((d) => d.id));
	});

	it('offers the whole library on Free pick', async () => {
		const h = await boot();
		const res = await call(h, 'GET', '/api/tables/legal/free');
		expect(res.status).toBe(200);
		expect((res.body as { legal: string[] }).legal).toEqual(library.decks.map((d) => d.id));
		const formats = (await call(h, 'GET', '/api/tables/formats')).body as { formats: { id: string; source: string }[] };
		expect(formats.formats.filter((f) => f.id === 'free')).toEqual([expect.objectContaining({ name: 'Free pick', source: 'free' })]);
	});

	it('refuses an era it does not have', async () => {
		const h = await boot();
		const res = await call(h, 'GET', '/api/tables/legal/1999-01-01');
		expect(res.status).toBe(400);
		expect(res.body).toEqual({ error: 'no format "1999-01-01"' });
	});

	it('checks a deck without starting anything', async () => {
		const h = await boot();
		const res = await call(h, 'POST', '/api/tables/check', standard(UG_POLYMORPH, POWER_2011));
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ legal: false, rulesName: 'Standard (M12)' });
		expect(h.specs).toEqual([]);
	});
});

/* ── the drafted deck takes the same path ────────────────────────────── */

describe('a drafted deck', () => {
	/** Seat alice in a pod and hand her seat 45 cube cards, as a finished draft would. */
	function draftedPool(h: Harness, draftId: string) {
		const room = h.rooms.open(draftId);
		const alice = identityFromHeaders(edgeHeaders('alice'), 'sock-a');
		const seat = joinDraftRoom(room, 'sock-a', alice, 'friend').seat;
		if (seat === null) throw new Error('alice was not seated');
		const state = stateOf(room);
		const pool = state.queues.flat(2).slice(0, 45);
		state.pools[seat] = pool;
		return pool;
	}

	/** The deck the BROWSER writes: the UI's own `deckFromPool` and `.dck` writer. */
	function builtDeck(draftId: string, pool: ReturnType<typeof draftedPool>, extra?: string): string {
		let deck = deckFromPool(draftId, pool);
		for (const card of pool.slice(0, 40)) {
			const entry = deck.sideboard.find((e) => e.card.name === card.name && e.card.set === (card.setCode || null));
			if (entry !== undefined) deck = moveToMain(deck, entry.card, 1);
		}
		const text = dckTextOf(deck);
		return extra === undefined ? text : text.replace('[Main]\n', `[Main]\n${extra}\n`).replace('[main]\n', `[main]\n${extra}\n`);
	}

	it('starts a match through the same gate, checked against the caller’s own pool', async () => {
		const h = await boot();
		const pool = draftedPool(h, 'amber-lantern-k7q4');
		const text = builtDeck('amber-lantern-k7q4', pool);
		const res = await start(h, {
			opponent: 'ai',
			seats: [
				{ deck: { dck: text }, rules: { kind: 'draft', draftId: 'amber-lantern-k7q4' } },
				standard(SECOND_DECK, POWER_2010),
			],
		});
		expect(res.status).toBe(201);
		// The convergence, asserted: one request, a drafted 40-of-45 in seat 1 and a
		// prebuilt 60 in seat 2, and both arrive in the SAME field of the SAME spec
		// Forge is launched with — each exactly the text its own rule checked.
		expect(h.specs).toHaveLength(1);
		expect(h.specs[0]?.seats.map((s) => s.deck)).toEqual([text, library.deck(SECOND_DECK)?.text]);
	});

	it('refuses to start a drafted build under forty', async () => {
		const h = await boot();
		const pool = draftedPool(h, 'amber-lantern-k7q4');
		let deck = deckFromPool('amber-lantern-k7q4', pool);
		for (const card of pool.slice(0, 24)) {
			const entry = deck.sideboard.find((e) => e.card.name === card.name && e.card.set === (card.setCode || null));
			if (entry !== undefined) deck = moveToMain(deck, entry.card, 1);
		}
		const res = await start(h, {
			opponent: 'ai',
			seats: [
				{ deck: { dck: dckTextOf(deck) }, rules: { kind: 'draft', draftId: 'amber-lantern-k7q4' } },
				standard(SECOND_DECK, POWER_2010),
			],
		});
		expect(res.status).toBe(422);
		expect(res.body.error).toContain('maindeck has 24 cards, needs at least 40');
		expect(h.specs).toEqual([]);
	});

	it('refuses a card the caller did not draft, by name', async () => {
		const h = await boot();
		const pool = draftedPool(h, 'amber-lantern-k7q4');
		const text = builtDeck('amber-lantern-k7q4', pool, '1 Black Lotus|LEA');
		const res = await call(h, 'POST', '/api/tables/check', {
			deck: { dck: text },
			rules: { kind: 'draft', draftId: 'amber-lantern-k7q4' },
		});
		expect(res.status).toBe(200);
		expect(res.body.legal).toBe(false);
		expect(res.body.issues).toEqual([
			{ kind: 'more-copies-than-drafted', message: 'plays 1x Black Lotus but drafted 0', cardName: 'Black Lotus', count: 1, limit: 0 },
		]);
	});

	it('will not check a deck against someone else’s pool', async () => {
		const h = await boot();
		const pool = draftedPool(h, 'amber-lantern-k7q4');
		const text = builtDeck('amber-lantern-k7q4', pool);
		const res = await call(
			h,
			'POST',
			'/api/tables/check',
			{ deck: { dck: text }, rules: { kind: 'draft', draftId: 'amber-lantern-k7q4' } },
			edgeHeaders('bob'),
		);
		expect(res).toMatchObject({ status: 400, body: { error: 'you have no seat in draft "amber-lantern-k7q4"' } });
	});
});

/* ── every way a client might get a deck past the gate ───────────────── */

/**
 * Each case here posts a deck that must NOT reach Forge, by a different door,
 * and asserts three things: the answer is a refusal, it names the card, and
 * `specs` — what the host factory was handed — is empty. The smuggled card is
 * Black Lotus, which is in no Standard pool and in no cube pool we deal, so any
 * route that lets it through has let an unchecked card reach Forge.
 *
 * The `.dck`-shape cases were each run against a real Forge before the check
 * existed (Wave 11 lane D): `[Planes]` and a `\u00A0[junk]` header each gave
 * seat 1 a 64-card library with the Lotuses in it; `[main\u0001]` REPLACED the
 * main deck with the four Lotuses (library 4). All three were 201s.
 */
describe('bypass routes, each refused with the card named', () => {
	const LOTUS = '4 Black Lotus|LEA';
	const legalText = (): string => library.deck(SECOND_DECK)?.text ?? '';
	const seatsFor = (dck: string) => ({
		opponent: 'ai',
		seats: [{ deck: { dck }, rules: { kind: 'standard', format: POWER_2010 } }, standard(UG_POLYMORPH, POWER_2010)],
	});
	/** Put `insert` just before the sideboard, so the lines after it are the sideboard in both readers. */
	const beforeSideboard = (insert: string): string => {
		const text = legalText();
		const at = text.indexOf('[Sideboard]');
		return `${text.slice(0, at)}${insert}\n${text.slice(at)}`;
	};

	function expectRefusedNamingLotus(res: { status: number; body: Record<string, unknown> }, h: Harness): void {
		expect(res.status).toBe(422);
		const seats = res.body.seats as { legal: boolean; issues: { cardName: string | null }[] }[];
		expect(seats[0]?.legal).toBe(false);
		expect(seats[0]?.issues.map((i) => i.cardName)).toContain('Black Lotus');
		expect(h.specs).toEqual([]);
	}

	it('the legal base deck itself starts, so every refusal below is the smuggled part', async () => {
		const h = await boot();
		const res = await start(h, seatsFor(legalText()));
		expect(res.status).toBe(201);
		expect(h.specs[0]?.seats[0]?.deck).toBe(legalText());
	});

	/* ── the door: play's own body, and the path it is reached by ─────── */

	it("play's raw body with the unchecked deck in seat 2", async () => {
		const h = await boot();
		const res = await call(h, 'POST', '/api/play/matches', { opponent: 'ai', decks: [null, legalText() + `\n[Main]\n${LOTUS}\n`] });
		expect(res.status).toBe(422);
		expect(res.body.error).toContain('a deck must be checked');
		expect(h.specs).toEqual([]);
	});

	it("play's raw body with a one-element decks array", async () => {
		const h = await boot();
		const res = await call(h, 'POST', '/api/play/matches', { decks: [`[metadata]\nName=x\n[Main]\n${LOTUS}\n`] });
		expect(res.status).toBe(422);
		expect(h.specs).toEqual([]);
	});

	it('seats and a raw decks array in the same body', async () => {
		const h = await boot();
		const res = await call(h, 'POST', '/api/play/matches', { ...seatsFor(legalText()), decks: [`[Main]\n${LOTUS}`, null] });
		expect(res).toMatchObject({ status: 400, body: { error: 'body: unknown field decks' } });
		expect(h.specs).toEqual([]);
	});

	for (const path of ['/api/PLAY/Matches', '/api/play/matches/', '/api/Play/MATCHES/']) {
		it(`the same route spelled ${path}`, async () => {
			const h = await boot();
			const raw = await call(h, 'POST', path, { opponent: 'ai', decks: [`[metadata]\nName=x\n[Main]\n${LOTUS}\n`, null] });
			expect(raw.status).toBe(422);
			const seats = await call(h, 'POST', path, seatsFor(beforeSideboard(`[Planes]\n${LOTUS}`)));
			expectRefusedNamingLotus(seats, h);
		});
	}

	it('the route under a charset-qualified JSON content type', async () => {
		const h = await boot();
		const res = await call(
			h,
			'POST',
			'/api/play/matches',
			{ opponent: 'ai', decks: [`[metadata]\nName=x\n[Main]\n${LOTUS}\n`, null] },
			edgeHeaders('alice'),
			'application/json; charset=utf-8',
		);
		expect(res.status).toBe(422);
		expect(h.specs).toEqual([]);
	});

	it('a body that is not JSON to the gate is not JSON to play either: no deck reaches Forge', async () => {
		const h = await boot();
		const res = await start(
			h,
			{ opponent: 'ai', decks: [`[metadata]\nName=x\n[Main]\n${LOTUS}\n`, null] },
			'/api/play/matches',
			'text/plain',
		);
		// Neither parser reads text/plain, so play sees an empty body: Forge's random
		// precons, human v human. The Lotus text never reaches the host.
		expect(res.status).toBe(201);
		expect(h.specs.map((s) => s.seats.map((seat) => seat.deck))).toEqual([[null, null]]);
	});

	/* ── the deck: text our reader and Forge's read as two decks ──────── */

	const shapes: [string, () => string, string][] = [
		['a card in [Planes], which Forge moves into the main deck', () => beforeSideboard(`[Planes]\n${LOTUS}`), 'unchecked-section'],
		['a card in [Commander]', () => beforeSideboard(`[Commander]\n${LOTUS}`), 'unchecked-section'],
		['a card in [Avatar], at the end of the file', () => `${legalText()}\n[Avatar]\n${LOTUS}\n`, 'unchecked-section'],
		['a section Forge case-folds to Main and JS does not ([ma\u0130n])', () => `${legalText()}\n[ma\u0130n]\n${LOTUS}\n`, 'unchecked-section'],
		['a section Forge case-folds to Sideboard and JS does not ([\u017Fideboard])', () => `${legalText()}\n[\u017Fideboard]\n${LOTUS}\n`, 'unchecked-section'],
		['a control character Java trims and JS does not ([main\\u0001])', () => `${legalText()}\n[main\u0001]\n${LOTUS}\n`, 'ambiguous-character'],
		['a no-break space JS trims and Java does not (\\u00A0[junk])', () => beforeSideboard(`\u00A0[junk]\n${LOTUS}`), 'ambiguous-character'],
		['a byte-order mark before a header (\\uFEFF[junk])', () => beforeSideboard(`\uFEFF[junk]\n${LOTUS}`), 'ambiguous-character'],
	];

	for (const [what, text, kind] of shapes) {
		it(`${what}: refused by the start route and by /check`, async () => {
			const h = await boot();
			const res = await call(h, 'POST', '/api/play/matches', seatsFor(text()));
			expectRefusedNamingLotus(res, h);
			const seats = res.body.seats as { issues: { kind: string }[] }[];
			expect(seats[0]?.issues[0]?.kind).toBe(kind);
			expect(res.body.error).toMatch(/^Seat 1's deck "Jund \(Emanuele Giusti\)" is not legal in Standard \(M11\): plays 4x Black Lotus /);

			const check = await call(h, 'POST', '/api/tables/check', seatsFor(text()).seats[0]);
			expect(check.status).toBe(200);
			expect(check.body.legal).toBe(false);
			expect(h.specs).toEqual([]);
		});
	}

	it('the unchecked-section refusal says which card, where, and why', async () => {
		const h = await boot();
		const res = await call(h, 'POST', '/api/play/matches', seatsFor(beforeSideboard(`[Planes]\n${LOTUS}`)));
		expect(res.body.error).toBe(
			'Seat 1\'s deck "Jund (Emanuele Giusti)" is not legal in Standard (M11): plays 4x Black Lotus in [planes], ' +
				'which is not the main deck or sideboard — Forge would read it, and move ordinary cards from it into the main deck',
		);
	});

	it('a file without an exact [metadata] header, which Forge would not load at all', async () => {
		const h = await boot();
		const res = await call(h, 'POST', '/api/play/matches', seatsFor(legalText().replace('[metadata]', '[Metadata]')));
		expect(res.status).toBe(422);
		const seats = res.body.seats as { issues: { kind: string }[] }[];
		expect(seats[0]?.issues.map((i) => i.kind)).toEqual(['no-metadata']);
		expect(h.specs).toEqual([]);
	});

	it('the draft arm refuses the same smuggling', async () => {
		const h = await boot();
		const room = h.rooms.open('amber-lantern-k7q4');
		const alice = identityFromHeaders(edgeHeaders('alice'), 'sock-a');
		const seat = joinDraftRoom(room, 'sock-a', alice, 'friend').seat;
		if (seat === null) throw new Error('alice was not seated');
		const state = stateOf(room);
		const pool = state.queues.flat(2).slice(0, 45);
		state.pools[seat] = pool;
		let deck = deckFromPool('amber-lantern-k7q4', pool);
		for (const card of pool.slice(0, 40)) {
			const entry = deck.sideboard.find((e) => e.card.name === card.name && e.card.set === (card.setCode || null));
			if (entry !== undefined) deck = moveToMain(deck, entry.card, 1);
		}
		const text = `${dckTextOf(deck)}\n[Planes]\n${LOTUS}\n`;
		const res = await call(h, 'POST', '/api/play/matches', {
			opponent: 'ai',
			seats: [{ deck: { dck: text }, rules: { kind: 'draft', draftId: 'amber-lantern-k7q4' } }, standard(UG_POLYMORPH, POWER_2010)],
		});
		expectRefusedNamingLotus(res, h);
	});
});

/* ── the room's table: each player loads their own deck ──────────────── */

/**
 * Wave 13 §C, end to end through the same real play route: two members of one
 * room each load THEIR OWN deck, each readies up, and the server assembles the
 * two decks. The old shape — one body carrying two decks against a person — is
 * closed, and closed with a test rather than only removed from the screen.
 *
 * The lobby here is the in-memory `fakeLobby` above: lane A owns the real one,
 * and the routes take only the four methods they need as a structural type.
 */
describe('a room table', () => {
	const MEMBERS = [
		{ id: ALICE, name: 'user-alice' },
		{ id: BOB, name: 'user-bob' },
	];
	const ROOM = 'r-table';

	const openRoom = (h: Harness, gameType?: string, format?: string) =>
		h.lobby.open(ROOM, [...MEMBERS], gameType, format);
	const putDeck = (h: Harness, user: string, seat: unknown, roomId = ROOM) =>
		call(h, 'PUT', `/api/tables/rooms/${roomId}/deck`, seat, edgeHeaders(user));
	/**
	 * What a browser now sends: the deck, and no rules. The rules are the room's
	 * format, for both seats, and a body that names them is refused (§A.3).
	 */
	const deckBody = (deck: string) => ({ deck: { library: deck } });
	const setReady = (h: Harness, user: string, ready = true, roomId = ROOM) =>
		call(h, 'POST', `/api/tables/rooms/${roomId}/ready`, { ready }, edgeHeaders(user));
	const view = (h: Harness, user: string, roomId = ROOM) =>
		call(h, 'GET', `/api/tables/rooms/${roomId}`, undefined, edgeHeaders(user));
	const sit = (h: Harness, user: string, roomId = ROOM) =>
		call(h, 'POST', `/api/tables/rooms/${roomId}/sit`, {}, edgeHeaders(user));
	const stand = (h: Harness, user: string, roomId = ROOM) =>
		call(h, 'POST', `/api/tables/rooms/${roomId}/stand`, {}, edgeHeaders(user));
	const startRoom = (h: Harness, user: string, roomId = ROOM) =>
		start(h, { room: roomId }, '/api/play/matches', 'application/json', edgeHeaders(user));

	interface PlayerRow {
		seat: number;
		name: string;
		you: boolean;
		ready: boolean;
		/** On your own row only; null for a seat taken ahead of a deck. */
		deck?: { name: string; rulesName: string; legal: boolean; issueCount: number } | null;
		/** Present only for a player who has one — see the avatar test below. */
		avatarId?: string;
	}
	const players = (body: Record<string, unknown>): PlayerRow[] => body.players as PlayerRow[];
	/** The caller's own row's deck, as the table answers it to them. */
	const myDeck = (body: Record<string, unknown>) => players(body).find((p) => p.you)?.deck;

	/** Both members seated with a legal deck, each choosing only their own. */
	async function bothLoaded(h: Harness): Promise<void> {
		expect((await putDeck(h, 'alice', deckBody(UG_POLYMORPH))).status).toBe(200);
		expect((await putDeck(h, 'bob', deckBody(SECOND_DECK))).status).toBe(200);
	}

	it('starts the match from the room, each player in the seat their own deck is in', async () => {
		const h = await boot();
		openRoom(h);
		await bothLoaded(h);
		expect((await setReady(h, 'alice')).status).toBe(200);
		const second = await setReady(h, 'bob');
		expect(second.status).toBe(200);
		expect(players(second.body).map((p) => p.ready)).toEqual([true, true]);
		expect(myDeck((await view(h, 'alice')).body)?.name).toBe('UG Polymorph (Antoine Ruel)');
		expect(myDeck(second.body)?.name).toBe('Jund (Emanuele Giusti)');

		const res = await startRoom(h, 'alice');
		expect(res.status).toBe(201);
		const matchId = res.body.matchId as string;

		// The decks Forge is launched with, in the order the two players loaded
		// them — each the text that player's own rule checked, byte for byte.
		expect(h.specs).toHaveLength(1);
		expect(h.specs[0]?.seats.map((s) => s.deck)).toEqual([library.deck(UG_POLYMORPH)?.text, library.deck(SECOND_DECK)?.text]);

		// And the seats are BOUND, so neither browser can arrive into the other
		// player's deck: `Match.claim` is otherwise first-come-first-served.
		const match = h.matches.get(matchId);
		expect(match?.seatOf(ALICE)).toBe(0);
		expect(match?.seatOf(BOB)).toBe(1);
		expect(h.lobby.room(ROOM)?.tables[0]?.matchId).toBe(matchId);
	});

	it("deals a match against a person with the room's hand smoothing, on by default", async () => {
		const h = await boot();
		openRoom(h);
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		expect((await startRoom(h, 'alice')).status).toBe(201);
		expect(h.specs[0]?.handSmoothing).toBe(true);
	});

	it("deals a match against the AI with the room's hand smoothing, off when the leader turned it off", async () => {
		const h = await boot();
		h.lobby.open(ROOM, [{ id: ALICE, name: 'user-alice' }]).settings.handSmoothing = false;
		expect((await putDeck(h, 'alice', deckBody(UG_POLYMORPH))).status).toBe(200);
		expect((await start(h, { room: ROOM, bot: true }, '/api/play/matches', 'application/json', edgeHeaders('alice'))).status).toBe(201);
		expect(h.specs[0]?.handSmoothing).toBe(false);
	});

	// Lane testing-states, 2026-10-23: a board-state testing room's own
	// `RoomRecord.scenario` rides onto the match `startFromRoom` starts — the
	// one legitimate production path around `/api/play/matches`' own
	// `scenario-needs-probe` gate (`play/socket.ts`), since nothing about
	// THIS harness's `attachPlay` sets `probe: true`.
	it("carries a board-state room's own scenario onto the match it starts vs the AI, with no CARDTABLE_PLAY_PROBE needed", async () => {
		const h = await boot();
		const room = h.lobby.open(ROOM, [{ id: ALICE, name: 'user-alice' }]);
		const scenario = 'turn=1\nactiveplayer=human\nactivephase=MAIN1\nhumanlife=20\nailife=20\nhumanhand=\nhumanbattlefield=\nhumanlibrary=Mountain\nhumangraveyard=\naihand=\naibattlefield=\nailibrary=Mountain\naigraveyard=\n';
		room.scenario = scenario;
		expect((await putDeck(h, 'alice', deckBody(UG_POLYMORPH))).status).toBe(200);
		expect((await start(h, { room: ROOM, bot: true }, '/api/play/matches', 'application/json', edgeHeaders('alice'))).status).toBe(201);
		expect(h.specs[0]?.scenario).toBe(scenario);
		expect(h.specs[0]?.skipOpening).toBe(true);
	});

	// The operator, 2026-10-23: "i would have expected to see an active game
	// here". Entering a board room starts its game: the caller is seated, dealt
	// a library deck if they hold none, and the match opens on the board — no
	// coin toss, no mulligan.
	it('seats and deals the caller of a board-state room who holds no deck, and starts the AI on its board', async () => {
		const h = await boot();
		const room = h.lobby.open(ROOM, [{ id: ALICE, name: 'user-alice' }]);
		room.scenario = 'turn=1\nactiveplayer=human\nactivephase=MAIN1\nhumanlife=20\nailife=20\n';
		const res = await start(h, { room: ROOM, bot: true }, '/api/play/matches', 'application/json', edgeHeaders('alice'));
		expect(res.status).toBe(201);
		expect(h.specs[0]?.skipOpening).toBe(true);
		expect(h.specs[0]?.seats[0].deck).toEqual(expect.any(String));
		expect(h.specs[0]?.seats[1].deck).toEqual(expect.any(String));
	});

	it('still asks for a deck in an ordinary room — only a board room deals one', async () => {
		const h = await boot();
		h.lobby.open(ROOM, [{ id: ALICE, name: 'user-alice' }]);
		const res = await start(h, { room: ROOM, bot: true }, '/api/play/matches', 'application/json', edgeHeaders('alice'));
		expect(res.status).toBe(409);
		expect(h.specs).toHaveLength(0);
	});

	it('never carries a scenario onto an ordinary room’s match — `FakeRoom.scenario` absent is every room a friend ever opens', async () => {
		const h = await boot();
		openRoom(h);
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		expect((await startRoom(h, 'alice')).status).toBe(201);
		expect(h.specs[0]?.scenario).toBeUndefined();
		expect(h.specs[0]?.skipOpening).toBeUndefined();
	});

	// Lane testing-tourney, 2026-10-23: a testing room's own game never reaches
	// the real match-stats store — `tables.matchStart` (`stats.startOf`) is
	// where this is guarded, the SAME `null` answer it already gives for a
	// match no room started, so `matchStats.gameOver`'s own `stats-skipped` log
	// is the one place this is noticed. The room's OWN table/series ledger
	// (`tables.gameOver`, composed beside the stats report on `onGameOver` —
	// `index.ts`'s own doc) is a SEPARATE path and still runs: a testing room's
	// games still clear their table and advance their series normally, only the
	// EXTERNAL report is skipped.
	it("a testing room's game is skipped by matchStats, but the table's own matchId still clears", async () => {
		const h = await boot();
		const room = openRoom(h);
		room.testing = true;
		// A testing room is admin-only (`rooms.test.ts`'s "every room/table route
		// 404s as if they do not exist" for a friend) — every call here is an
		// admin's.
		const aliceDeck = await call(h, 'PUT', `/api/tables/rooms/${ROOM}/deck`, deckBody(UG_POLYMORPH), edgeHeaders('alice', 'admin'));
		expect(aliceDeck.status).toBe(200);
		const bobDeck = await call(h, 'PUT', `/api/tables/rooms/${ROOM}/deck`, deckBody(SECOND_DECK), edgeHeaders('bob', 'admin'));
		expect(bobDeck.status).toBe(200);
		await call(h, 'POST', `/api/tables/rooms/${ROOM}/ready`, { ready: true }, edgeHeaders('alice', 'admin'));
		await call(h, 'POST', `/api/tables/rooms/${ROOM}/ready`, { ready: true }, edgeHeaders('bob', 'admin'));
		const started = await start(h, { room: ROOM }, '/api/play/matches', 'application/json', edgeHeaders('alice', 'admin'));
		expect(started.status).toBe(201);
		const matchId = started.body.matchId as string;

		(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: 'Seat 1' });
		await vi.waitFor(() => expect(h.lobby.room(ROOM)?.tables[0]?.matchId).toBeNull());
		expect(h.reports).toEqual([]);
		expect(h.statsLogs).toContainEqual(expect.objectContaining({ evt: 'stats-skipped', matchId, reason: 'no room started this match' }));
	});

	// The operator, 2026-10-11: "let's make it 5 max per person".
	it('refuses a person a sixth match at once, by name, and a finished match frees the slot', async () => {
		const h = await boot();
		const startIn = async (roomId: string) => {
			h.lobby.open(roomId, [...MEMBERS]);
			expect((await putDeck(h, 'alice', deckBody(UG_POLYMORPH), roomId)).status).toBe(200);
			expect((await putDeck(h, 'bob', deckBody(SECOND_DECK), roomId)).status).toBe(200);
			await setReady(h, 'alice', true, roomId);
			await setReady(h, 'bob', true, roomId);
			return startNew(roomId);
		};
		// `start` feeds Forge's opening to the LAST host once there is one; for a sixth start the
		// last host is an earlier match's, so this waits for a new one or for the refusal.
		const startNew = async (roomId: string) => {
			const before = h.hosts.length;
			const pending = call(h, 'POST', '/api/play/matches', { room: roomId }, edgeHeaders('alice'));
			await untilHost(h, before + 1, pending);
			if (h.hosts.length > before) (h.hosts.at(-1) as ReplayHost).push(...OPENING);
			return pending;
		};
		for (let i = 1; i <= routesMod.MAX_MATCHES_PER_PERSON; i++) expect((await startIn(`r-cap-${String(i)}`)).status).toBe(201);
		const sixth = await startIn('r-cap-6');
		expect(sixth.status).toBe(409);
		expect(sixth.body.error).toBe(`user-alice is already playing ${routesMod.MAX_MATCHES_PER_PERSON} matches`);
		expect(h.specs).toHaveLength(routesMod.MAX_MATCHES_PER_PERSON);

		// One of them ends (a concession is a game over): it no longer counts.
		h.hosts[0]!.push({ t: 'gameover', winner: 'Seat 1' });
		await vi.waitFor(() => expect(h.matches.active().some((m) => m.status === 'over')).toBe(true));
		expect((await startNew('r-cap-6')).status).toBe(201);
	});

	// The operator, 2026-10-09: "a lobby toggle for 'Free pick' which allows anyone
	// to pick any deck regardless of format to play against each other".
	it('on Free pick, seats a Legacy deck against a Modern one and starts', async () => {
		const h = await boot();
		openRoom(h, undefined, 'free');
		const legacy = library.decks.find((d) => d.era.startsWith('legacy-'))!;
		const modern = library.decks.find((d) => d.era.startsWith('modern-'))!;
		const first = await putDeck(h, 'alice', deckBody(legacy.id));
		const loaded = await putDeck(h, 'bob', deckBody(modern.id));
		for (const res of [first, loaded]) expect(myDeck(res.body)).toMatchObject({ legal: true, rulesName: 'Free pick' });
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		expect((await startRoom(h, 'alice')).status).toBe(201);
		expect(h.specs[0]?.seats.map((s) => s.deck)).toEqual([legacy.text, modern.text]);
	});

	/*
	 * A bot (the operator, 2026-10-02): the room's only member plays Forge's AI.
	 * The bot's deck is a random library deck legal in the room's own pool, and
	 * the player is seated in their own deck's seat, exactly as a room start does.
	 */
	describe('against a bot', () => {
		const startBot = (h: Harness, user: string, body: Record<string, unknown> = { room: ROOM, bot: true }) =>
			start(h, body, '/api/play/matches', 'application/json', edgeHeaders(user));

		it("starts the room's only player against Forge's AI with a legal library deck in seat 2", async () => {
			const h = await boot();
			h.lobby.open(ROOM, [{ id: ALICE, name: 'user-alice', avatarId: 'wanderer' }]);
			expect((await putDeck(h, 'alice', deckBody(UG_POLYMORPH))).status).toBe(200);

			const res = await startBot(h, 'alice');
			expect(res.status).toBe(201);
			expect(h.specs).toHaveLength(1);
			const seats = h.specs[0]!.seats as { deck: string | null; ai: boolean; name?: string }[];
			expect(seats[0]?.deck).toBe(library.deck(UG_POLYMORPH)?.text);
			expect(seats[0]?.ai).toBe(false);
			const identities = h.matches.get(res.body.matchId as string)?.seatIdentities();
			expect(identities?.[0]?.avatarId).toBe('wanderer');
			expect(identities?.[1], "Forge's AI holds no room member's face").not.toHaveProperty('avatarId');
			expect(seats[1]?.ai).toBe(true);
			// The bot plays a real library deck, and one that is legal in this room's pool.
			const botDeck = library.decks.find((d) => d.text === seats[1]?.deck);
			expect(botDeck).toBeDefined();
			// Checked the way a player's own deck is, in a second room on the same pool.
			h.lobby.open('r-check', [{ id: ALICE, name: 'user-alice' }], undefined, h.lobby.room(ROOM)?.format);
			const verdict = await putDeck(h, 'alice', deckBody(botDeck!.id), 'r-check');
			expect(verdict.status).toBe(200);
			expect(myDeck(verdict.body)?.legal).toBe(true);

			const matchId = res.body.matchId as string;
			expect(h.matches.get(matchId)?.seatOf(ALICE)).toBe(0);
			expect(h.lobby.room(ROOM)?.tables[0]?.matchId).toBe(matchId);
		});

		it('plays a library deck from any era on Free pick', async () => {
			const h = await boot();
			h.lobby.open(ROOM, [{ id: ALICE, name: 'user-alice' }], undefined, 'free');
			expect((await putDeck(h, 'alice', deckBody(UG_POLYMORPH))).status).toBe(200);
			const res = await startBot(h, 'alice');
			expect(res.status).toBe(201);
			const seats = h.specs[0]!.seats as { deck: string | null }[];
			expect(library.decks.some((d) => d.text === seats[1]?.deck)).toBe(true);
		});

		it('is refused when a second person is SEATED: they play each other', async () => {
			const h = await boot();
			openRoom(h);
			await bothLoaded(h);
			const res = await startBot(h, 'alice');
			expect(res.status).toBe(409);
			expect(res.body.error).toMatch(/one seated player/);
			expect(h.specs).toHaveLength(0);
		});

		/*
		 * 2026-10-12: a watchparty room mounts the table for everyone at once, so
		 * "the only member" was never true at a party and the AI was unreachable
		 * there. The gate is on SEATS now: one seated human, who is the caller.
		 */
		it('starts with other people in the room, as long as only the caller is seated', async () => {
			const h = await boot();
			h.lobby.open(ROOM, [...MEMBERS, { id: CAROL, name: 'user-carol' }]);
			expect((await putDeck(h, 'alice', deckBody(UG_POLYMORPH))).status).toBe(200);
			// An unseated member cannot start a bot game for the seated one.
			const notMine = await startBot(h, 'bob');
			expect(notMine.status).toBe(409);
			expect(h.specs).toHaveLength(0);
			const res = await startBot(h, 'alice');
			expect(res.status).toBe(201);
			expect(h.specs).toHaveLength(1);
			expect(h.specs[0]!.seats[1]?.ai).toBe(true);
		});

		it('is refused for a seated caller who has not loaded a deck', async () => {
			const h = await boot();
			h.lobby.open(ROOM, [{ id: ALICE, name: 'user-alice' }]);
			expect((await sit(h, 'alice')).status).toBe(200);
			const res = await startBot(h, 'alice');
			expect(res).toMatchObject({ status: 409, body: { error: 'load a deck first' } });
			expect(h.specs).toHaveLength(0);
		});

		it('is refused until the player has loaded a deck', async () => {
			const h = await boot();
			h.lobby.open(ROOM, [{ id: ALICE, name: 'user-alice' }]);
			const res = await startBot(h, 'alice');
			expect(res.status).toBe(409);
			expect(h.specs).toHaveLength(0);
		});

		it('refuses a bot field that is not true', async () => {
			const h = await boot();
			h.lobby.open(ROOM, [{ id: ALICE, name: 'user-alice' }]);
			expect((await putDeck(h, 'alice', deckBody(UG_POLYMORPH))).status).toBe(200);
			const res = await startBot(h, 'alice', { room: ROOM, bot: 'yes' });
			expect(res.status).toBe(400);
			expect(h.specs).toHaveLength(0);
		});
	});

	/*
	 * Item 4's server half (wave 29 §B), one hop further than the table-view
	 * test below: each seat of the started match wears the avatar of the room
	 * member who holds it, in the same seat order as `decks`. Read from the room,
	 * never copied onto the spec Forge is launched with — so it is never on
	 * `seats[].name` either (`socket.ts`'s own note: "Forge shows these names to
	 * both seats; they are never an identity"), and never goes stale.
	 */
	it("gives each seat of the started match its holder's avatar from the room, and puts none on the spec", async () => {
		const h = await boot();
		const room = h.lobby.open(ROOM, [
			{ id: ALICE, name: 'user-alice', avatarId: 'wanderer' },
			{ id: BOB, name: 'user-bob' },
		]);
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');

		const res = await startRoom(h, 'alice');
		expect(res.status).toBe(201);
		expect(h.specs).toHaveLength(1);
		expect(JSON.stringify(h.specs[0]?.seats)).not.toContain('avatarId');
		const match = h.matches.get(res.body.matchId as string);
		// Alice's deck (`UG_POLYMORPH`) is seat 0 and bob's (`SECOND_DECK`) is seat 1
		// (`bothLoaded`), so this is also an assertion that the face travels with
		// the seat its holder's deck is in.
		expect(match?.seatIdentities()[0]?.avatarId).toBe('wanderer');
		// ABSENT, not `undefined`-as-a-value and not `''` (`D-avatar-field.md` §3).
		expect(match?.seatIdentities()[1]).not.toHaveProperty('avatarId');
		// A change in the room is what the seat wears from then on.
		room.members[1]!.avatarId = 'herald';
		expect(match?.seatIdentities()[1]?.avatarId).toBe('herald');
	});

	/*
	 * Wave 31 shape 1: the room's display names ride the start body (`names`, in
	 * `decks` order) and land on the Forge seats, so Forge's own prompts say
	 * "user-alice" and not "Seat 1".
	 */
	it("puts each member's display name on the seat their deck is in", async () => {
		const h = await boot();
		h.lobby.open(ROOM, [
			{ id: ALICE, name: 'user-alice' },
			{ id: BOB, name: 'user-bob' },
		]);
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');

		const res = await startRoom(h, 'alice');
		expect(res.status).toBe(201);
		const seats = h.specs[0]?.seats as { name: string }[];
		expect(seats.map((s) => s.name)).toEqual(['user-alice', 'user-bob']);
	});

	/*
	 * Item 4 of the 2026-09-28 play test: *"i noticed you're still not pulling in
	 * the watchparty selected avatars. why not?"*
	 *
	 * `avatarId` has been on `@wolffm/rooms-protocol`'s `RosterIdentity` and on
	 * `packages/room-store`'s `SerializedMember` all along; what was missing was
	 * this hop — the room member's field reaching the TABLE's players, beside the
	 * name the room already carried. `playersOf` hands the member row through
	 * verbatim and `tableView` spreads it, so both assertions below are about the
	 * same one line and the second is the one that can regress quietly.
	 *
	 * The three states of `avatarId?: string | null` collapse to TWO here — a
	 * non-blank string, or an ABSENT key — and the absence is asserted with
	 * `toHaveProperty`, not with `toBeUndefined()`: `avatarId: undefined` passes
	 * the latter and is exactly the shape that makes an in-process reader and a
	 * JSON reader disagree.
	 */
	it("carries a member's avatarId to the table view, and leaves the key off a member with none", async () => {
		const h = await boot();
		// Alice picked a character in watchparty's room; Bob never did. Both are
		// members of the same room, so one table answers both cases.
		h.lobby.open(ROOM, [
			{ id: ALICE, name: 'user-alice', avatarId: 'wanderer' },
			{ id: BOB, name: 'user-bob' },
		]);
		await bothLoaded(h);

		const seen = await view(h, 'alice');
		expect(seen.status).toBe(200);
		const rows = players(seen.body);
		expect(rows.map((p) => p.name)).toEqual(['user-alice', 'user-bob']);
		expect(rows[0]?.avatarId).toBe('wanderer');
		// ABSENT, not empty and not null. `call` parses the response TEXT, so a
		// key missing here is a key missing on the wire — and an empty string
		// would be the real hazard: it survives a `!== undefined` check and then
		// resolves to `…/square_.png`, which draws as a broken image exactly where
		// the caller wanted its fallback.
		expect(rows[1]).not.toHaveProperty('avatarId');
		const wire = JSON.stringify(seen.body);
		expect(wire).toContain('"avatarId":"wanderer"');
		expect(wire).not.toContain('"avatarId":""');
		expect(wire).not.toContain('"avatarId":null');

		// The other player's copy of the table says the same thing. A face is not
		// hidden information — both seats already read each other's names — so
		// unlike `choice` this field is not caller-scoped.
		const theirs = players((await view(h, 'bob')).body);
		expect(theirs[0]?.avatarId).toBe('wanderer');
		expect(theirs[1]).not.toHaveProperty('avatarId');
	});

	it('answers the same match to whoever presses start second, without a second JVM', async () => {
		const h = await boot();
		openRoom(h);
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		const first = await startRoom(h, 'alice');
		expect(first.status).toBe(201);
		const again = await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('bob'));
		expect(again).toMatchObject({ status: 200, body: { matchId: first.body.matchId } });
		expect(h.specs).toHaveLength(1);
	});

	it('launches one JVM when both players press start at the same moment', async () => {
		const h = await boot();
		openRoom(h);
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		// Both in flight before either is answered — no awaiting one first.
		const both = call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('alice'));
		const race = call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('bob'));
		await untilHost(h, 1, Promise.all([both, race]));
		(h.hosts.at(-1) as ReplayHost).push(...OPENING);
		const answers = await Promise.all([both, race]);

		// ONE JVM, and the second ask is never a refusal: whether it arrives while
		// the first is still starting (it waits and joins) or after (the room's
		// live match), it is answered the match that was started.
		expect(h.specs).toHaveLength(1);
		expect(answers.map((r) => r.status).sort()).toEqual([200, 201]);
		const started = answers.find((r) => r.status === 201)?.body.matchId;
		expect(typeof started).toBe('string');
		for (const answer of answers) expect(answer.body.matchId).toBe(started);
		expect(h.lobby.room(ROOM)?.tables[0]?.matchId).toBe(started);
		expect(h.matches.get(started as string)?.seatOf(ALICE)).toBe(0);
		expect(h.matches.get(started as string)?.seatOf(BOB)).toBe(1);
	});

	/** Both ready, alice's start in flight and Forge not yet up: what bob's browser meets when it asks too. */
	async function aliceStarting(h: Harness, signal?: AbortSignal): Promise<{ pending: Promise<Response> }> {
		openRoom(h);
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		const pending = fetch(`http://127.0.0.1:${h.port}/api/play/matches`, {
			method: 'POST',
			headers: { ...edgeHeaders('alice'), 'content-type': 'application/json' },
			body: JSON.stringify({ room: ROOM }),
			signal,
		});
		await untilHost(h, 1, pending);
		expect(h.hosts).toHaveLength(1);
		return { pending };
	}

	it('answers an ask made while the start is in flight with that same match once it is up, not a refusal', async () => {
		const h = await boot();
		const { pending: first } = await aliceStarting(h);
		const second = call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('bob'));
		await new Promise((r) => setTimeout(r, 50));
		h.hosts[0]!.push(...OPENING);
		const [a, b] = [await first, await second];
		const started = ((await a.json()) as { matchId: string }).matchId;
		expect(a.status).toBe(201);
		expect(b).toMatchObject({ status: 200, body: { matchId: started } });
		expect(h.specs).toHaveLength(1);
	});

	it('gives an ask that joined a failing start the same refusal', async () => {
		const h = await boot();
		const { pending: first } = await aliceStarting(h);
		const second = call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('bob'));
		await new Promise((r) => setTimeout(r, 50));
		h.hosts[0]!.exit('the JVM died');
		const [a, b] = [await first, await second];
		const refusal = (await a.json()) as { error: string };
		expect(a.status).toBe(500);
		expect(b.status).toBe(500);
		expect(b.body.error).toBe(refusal.error);
		// Freed: the next ask starts afresh.
		const again = call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('alice'));
		await untilHost(h, 2, again);
		h.hosts[1]!.push(...OPENING);
		expect((await again).status).toBe(201);
	});

	it('keeps one start when the asker reloads mid-start: the reloaded ask joins it rather than launching a second JVM', async () => {
		const h = await boot();
		const gone = new AbortController();
		const { pending: first } = await aliceStarting(h, gone.signal);
		gone.abort();
		await first.catch(() => undefined);
		await new Promise((r) => setTimeout(r, 50));
		const reloaded = call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('alice'));
		await new Promise((r) => setTimeout(r, 50));
		h.hosts[0]!.push(...OPENING);
		const answer = await reloaded;
		expect(answer.status).toBe(200);
		expect(h.specs).toHaveLength(1);
		expect(h.lobby.room(ROOM)?.tables[0]?.matchId).toBe(answer.body.matchId);
	});

	it('refuses a body that names two decks against a person, and says where a match starts', async () => {
		const h = await boot();
		const res = await call(h, 'POST', '/api/play/matches', {
			opponent: 'human',
			seats: [standard(UG_POLYMORPH, POWER_2010), standard(SECOND_DECK, POWER_2010)],
		});
		expect(res.status).toBe(422);
		expect(res.body.error).toContain('starts from a room');
		expect(h.specs).toEqual([]);
		// The default opponent is 'human', so the shape is closed without one too.
		const bare = await call(h, 'POST', '/api/play/matches', {
			seats: [standard(UG_POLYMORPH, POWER_2010), standard(SECOND_DECK, POWER_2010)],
		});
		expect(bare.status).toBe(422);
		expect(h.specs).toEqual([]);
	});

	it('answers a room that does not exist and a room you are not in the same way', async () => {
		const h = await boot();
		openRoom(h);
		const missing = await view(h, 'alice', 'r-nope');
		const outsider = await view(h, 'carol');
		expect(missing).toEqual({ status: 404, body: { error: 'no such room' } });
		expect(outsider).toEqual(missing);
		expect(await call(h, 'PUT', '/api/tables/rooms/r-nope/deck', deckBody(UG_POLYMORPH), edgeHeaders('alice'))).toEqual(
			missing,
		);
		expect(await putDeck(h, 'carol', deckBody(UG_POLYMORPH))).toEqual(missing);
		expect(await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('carol'))).toEqual(missing);
		expect(await call(h, 'POST', '/api/play/matches', { room: 'r-nope' }, edgeHeaders('alice'))).toEqual(missing);
		expect(h.specs).toEqual([]);
		expect(CAROL).not.toBe(ALICE);
	});

	it('blocks only the player whose deck is illegal, naming the card', async () => {
		const h = await boot();
		// One pool for the table, and UG_POLYMORPH is the deck the bans cost: alice is
		// illegal in it and ELDRAZI_GREEN is legal in the same pool, so the asymmetry under
		// test is between two decks rather than between two players' formats.
		openRoom(h, undefined, POWER_2011);
		const loaded = await putDeck(h, 'alice', deckBody(UG_POLYMORPH));
		expect(loaded.status).toBe(200);
		expect(myDeck(loaded.body)).toMatchObject({ legal: false, issueCount: 3 });
		// A count, not a list: the card is named once, by the refusal below.
		expect(myDeck(loaded.body)).not.toHaveProperty('issues');

		const refused = await setReady(h, 'alice');
		expect(refused.status).toBe(422);
		// The refusal leads with the FIRST issue, which for this deck is a
		// rotated-out card rather than the ban — both are real faults of the
		// same deck a year on.
		expect(refused.body.error).toContain('Essence Scatter');

		// The other player is untouched by it: they load, they ready.
		expect((await putDeck(h, 'bob', deckBody(ELDRAZI_GREEN))).status).toBe(200);
		expect((await setReady(h, 'bob')).status).toBe(200);

		const blocked = await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('bob'));
		expect(blocked.status).toBe(409);
		expect(blocked.body.error).toContain('user-alice');
		expect(h.specs).toEqual([]);

		// And a legal deck unblocks it: same player, same room, same pool — what
		// changes is the deck, because the pool is not the player's to change.
		expect((await putDeck(h, 'alice', deckBody(ELDRAZI_GREEN))).status).toBe(200);
		expect((await setReady(h, 'alice')).status).toBe(200);
		expect((await startRoom(h, 'bob')).status).toBe(201);
	});

	it('un-readies a player who loads a different deck', async () => {
		const h = await boot();
		openRoom(h);
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		const reloaded = await putDeck(h, 'alice', deckBody(SECOND_DECK));
		expect(players(reloaded.body).map((p) => p.ready)).toEqual([false, true]);
		const res = await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('bob'));
		expect(res).toMatchObject({ status: 409, body: { error: 'user-alice is not ready yet' } });
		expect(h.specs).toEqual([]);
	});

	it('will not seat a third member, and will not let anyone name another member’s deck', async () => {
		const h = await boot();
		h.lobby.open(ROOM, [...MEMBERS, { id: CAROL, name: 'user-carol' }]);
		await bothLoaded(h);
		const third = await putDeck(h, 'carol', deckBody(UG_POLYMORPH));
		expect(third).toMatchObject({ status: 409, body: { error: 'this table already has two players' } });
		// There is no field that names a member — a body that invents one is refused.
		const named = await putDeck(h, 'carol', { ...deckBody(UG_POLYMORPH), member: ALICE });
		expect(named).toMatchObject({ status: 400, body: { error: 'body: unknown field member' } });
		// Carol sees the table, as a member of the room who is not playing — and she
		// is not its leader either, which alice is.
		const seen = await view(h, 'carol');
		expect(seen.body.you).toEqual({ player: false, leader: false });
		expect(players(seen.body).map((p) => p.you)).toEqual([false, false]);
	});

	/*
	 * Seats as their own act (2026-10-12). The operator: "players should be able
	 * to give up their seat, but not after both players are ready. when both
	 * players are ready and the match is initiated then they are locked in until
	 * they concede". The lock is the server's — `room.locked` is the same bit the
	 * stand route refuses on — and nobody can stand anybody else up.
	 */
	describe('sitting and standing', () => {
		const THREE = [...MEMBERS, { id: CAROL, name: 'user-carol' }];
		const locked = (body: Record<string, unknown>): boolean => (body.room as { locked: boolean }).locked;

		it('seats a member without a deck, in the order people sat, and the deck may come later', async () => {
			const h = await boot();
			h.lobby.open(ROOM, THREE);
			const sat = await sit(h, 'carol');
			expect(sat.status).toBe(200);
			expect(sat.body.you).toEqual({ player: true, leader: false });
			expect(players(sat.body)).toEqual([{ seat: 0, name: 'user-carol', you: true, ready: false, deck: null }]);
			expect(locked(sat.body)).toBe(false);
			// Bob loads a deck without sitting first: that still takes the next seat,
			// behind carol, who sat before him.
			expect((await putDeck(h, 'bob', deckBody(SECOND_DECK))).status).toBe(200);
			// A seat without a deck cannot ready up.
			expect(await setReady(h, 'carol')).toMatchObject({ status: 409, body: { error: 'load a deck before you ready up' } });
			// Carol's deck lands in the seat she already holds.
			const loaded = await putDeck(h, 'carol', deckBody(UG_POLYMORPH));
			expect(players(loaded.body).map((p) => [p.name, p.deck?.name])).toEqual([
				['user-carol', 'UG Polymorph (Antoine Ruel)'],
				['user-bob', undefined],
			]);
			// Alice, the third, is refused a seat and sees herself as no player.
			expect(await sit(h, 'alice')).toMatchObject({ status: 409, body: { error: 'this table already has two players' } });
			expect((await view(h, 'alice')).body.you).toEqual({ player: false, leader: true });
			// Sitting again is a no-op answer, not a refusal.
			expect((await sit(h, 'carol')).status).toBe(200);
		});

		it('gives a seat back with its deck and ready flag, until both players are ready', async () => {
			const h = await boot();
			h.lobby.open(ROOM, THREE);
			await bothLoaded(h);
			expect((await setReady(h, 'alice')).status).toBe(200);
			// One ready player is not a lock: alice, ready, may still stand.
			const stood = await stand(h, 'alice');
			expect(stood.status).toBe(200);
			expect(stood.body.you).toEqual({ player: false, leader: true });
			expect(players(stood.body).map((p) => p.name)).toEqual(['user-bob']);
			// Her seat is free for the next person, who sits behind bob.
			expect(players((await sit(h, 'carol')).body).map((p) => [p.seat, p.name])).toEqual([
				[0, 'user-bob'],
				[1, 'user-carol'],
			]);
			// Standing when you hold no seat is a no-op answer.
			expect((await stand(h, 'alice')).status).toBe(200);
			// Both ready: the table locks, and the server refuses, not just the button.
			expect((await putDeck(h, 'carol', deckBody(UG_POLYMORPH))).status).toBe(200);
			expect((await setReady(h, 'bob')).status).toBe(200);
			const both = await setReady(h, 'carol');
			expect(locked(both.body)).toBe(true);
			expect(await stand(h, 'carol')).toMatchObject({ status: 409, body: { error: 'both players are ready — the table is locked' } });
			expect(players((await view(h, 'carol')).body)).toHaveLength(2);
		});

		it('keeps both seats for the whole match: no sitting, no standing, until it ends', async () => {
			const h = await boot();
			h.lobby.open(ROOM, THREE);
			await bothLoaded(h);
			await setReady(h, 'alice');
			await setReady(h, 'bob');
			expect((await startRoom(h, 'alice')).status).toBe(201);
			// The start spent both Readys, and the match itself is what locks now.
			const during = await view(h, 'bob');
			expect(players(during.body).map((p) => p.ready)).toEqual([false, false]);
			expect(locked(during.body)).toBe(true);
			expect(await stand(h, 'alice')).toMatchObject({ status: 409, body: { error: 'the match has already started' } });
			expect(await sit(h, 'carol')).toMatchObject({ status: 409, body: { error: 'the match has already started' } });
			expect(players((await view(h, 'carol')).body).map((p) => p.name)).toEqual(['user-alice', 'user-bob']);
		});

		it('refuses a start while a seated player has no deck, naming them', async () => {
			const h = await boot();
			openRoom(h);
			expect((await sit(h, 'alice')).status).toBe(200);
			expect((await putDeck(h, 'bob', deckBody(SECOND_DECK))).status).toBe(200);
			expect((await setReady(h, 'bob')).status).toBe(200);
			expect(await startRoom(h, 'alice')).toMatchObject({ status: 409, body: { error: 'user-alice has not loaded a deck' } });
			expect(h.specs).toEqual([]);
		});

		it('keeps the order people sat when two sit in the same millisecond', async () => {
			const h = await boot();
			h.lobby.open(ROOM, THREE);
			const now = vi.spyOn(Date, 'now').mockReturnValue(1_791_900_000_000);
			try {
				expect((await sit(h, 'carol')).status).toBe(200);
				const both = await sit(h, 'bob');
				expect(players(both.body).map((p) => p.name)).toEqual(['user-carol', 'user-bob']);
			} finally {
				now.mockRestore();
			}
		});

		it('still reads a seat row written before seats were their own act', async () => {
			const h = await boot();
			openRoom(h);
			expect((await putDeck(h, 'bob', deckBody(SECOND_DECK))).status).toBe(200);
			// What a pre-2026-10-12 deploy persisted: the deck's fields flat beside `ready`.
			const stored = h.lobby.room(ROOM)!.state.get(BOB) as { deck: Record<string, unknown> };
			const tableId = h.lobby.room(ROOM)!.tables[0]!.id;
			h.lobby.sit(ROOM, tableId, ALICE);
			h.lobby.setSeatReady(ROOM, tableId, ALICE, true);
			h.lobby.setPlayerState(ROOM, ALICE, { v: 1, ...stored.deck, ready: true, seatedAt: 1 });
			const seen = await view(h, 'alice');
			expect(players(seen.body).map((p) => [p.name, p.deck?.name, p.ready])).toEqual([
				['user-bob', undefined, false],
				['user-alice', 'Jund (Emanuele Giusti)', true],
			]);
			// And a start reads the migrated deck: both ready, it launches.
			expect((await setReady(h, 'bob')).status).toBe(200);
			expect((await startRoom(h, 'alice')).status).toBe(201);
		});
	});

	/*
	 * The operator, 2026-10-21: "don't reveal the deck that someone has picked in
	 * constructed rooms, that's giving away information. just showing whether or
	 * not they are ready is good enough." Every member's read of the table — the
	 * other player's, and a spectator's — carries another seat as its name and
	 * its ready flag, and nothing about its deck.
	 */
	it('tells nobody another player’s deck, only whether they are ready', async () => {
		const h = await boot();
		h.lobby.open(ROOM, [...MEMBERS, { id: CAROL, name: 'user-carol' }]);
		await bothLoaded(h);
		expect((await setReady(h, 'alice')).status).toBe(200);
		const alicesDeck = ['UG Polymorph', UG_POLYMORPH];
		const bobsDeck = ['Jund', SECOND_DECK];

		const bobs = await view(h, 'bob');
		expect(bobs.body.players).toEqual([
			{ seat: 0, name: 'user-alice', you: false, ready: true },
			{
				seat: 1,
				name: 'user-bob',
				you: true,
				ready: false,
				deck: {
					name: 'Jund (Emanuele Giusti)',
					rulesName: expect.any(String),
					legal: true,
					issueCount: 0,
					choice: { deck: { library: SECOND_DECK }, rules: expect.anything() },
				},
			},
		]);
		for (const word of alicesDeck) expect(JSON.stringify(bobs.body)).not.toContain(word);

		const alices = await view(h, 'alice');
		expect(players(alices.body)[1]).toEqual({ seat: 1, name: 'user-bob', you: false, ready: false });
		for (const word of bobsDeck) expect(JSON.stringify(alices.body)).not.toContain(word);

		// A member with no seat sees both seats the same way.
		const carols = await view(h, 'carol');
		expect(carols.body.players).toEqual([
			{ seat: 0, name: 'user-alice', you: false, ready: true },
			{ seat: 1, name: 'user-bob', you: false, ready: false },
		]);

		// The writes answer the same table: bob's own deck load tells him nothing of alice's.
		const reloaded = await putDeck(h, 'bob', deckBody(SECOND_DECK));
		for (const word of alicesDeck) expect(JSON.stringify(reloaded.body)).not.toContain(word);
	});

	it('names a seat without a deck to its owner as no deck', async () => {
		const h = await boot();
		openRoom(h);
		const sat = await sit(h, 'alice');
		expect(players(sat.body)).toEqual([{ seat: 0, name: 'user-alice', you: true, ready: false, deck: null }]);
	});

	it('refuses a table in a room that is not constructed 1v1', async () => {
		const h = await boot();
		h.lobby.open(ROOM, [...MEMBERS], 'draft');
		const res = await putDeck(h, 'alice', deckBody(UG_POLYMORPH));
		expect(res.status).toBe(409);
		expect(res.body.error).toContain('constructed-1v1');
		expect(await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('alice'))).toMatchObject({ status: 409 });
		expect(h.specs).toEqual([]);
	});

	it('forgets a match id the registry no longer has, so a restart does not strand the room', async () => {
		const h = await boot();
		const room = openRoom(h);
		room.tables[0]!.matchId = 'm-deadbeef0000';
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		const seen = await view(h, 'alice');
		expect((seen.body.room as { matchId: string | null }).matchId).toBeNull();
		expect((await startRoom(h, 'alice')).status).toBe(201);
	});

	/**
	 * The operator's game, 2026-10-10: a deploy mid-match restored the room
	 * without its match (rooms restore `matchId: null`; the match itself carried
	 * on) but WITH both players still ready, so the first table read after the
	 * game — one press of Rematch — started a new match with nobody else asking.
	 * A start spends both Readys, so a room that loses its match id finds
	 * nobody ready.
	 */
	it('a start spends both Readys: a room that loses its match id mid-game starts nothing on its own', async () => {
		const h = await boot();
		openRoom(h);
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		const started = await startRoom(h, 'alice');
		expect(started.status).toBe(201);
		const during = await view(h, 'bob');
		expect(players(during.body).map((p) => p.ready)).toEqual([false, false]);

		// What a restart's restore does to the room while the match plays on.
		h.lobby.releaseTableMatch(ROOM, h.lobby.room(ROOM)!.tables[0]!.id);
		const refused = await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('alice'));
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatch(/is not ready yet/);
	});

	/**
	 * R16. `over` sits for `overGraceMs` (ten minutes) before a host actually
	 * stops, and before this fix only `stopped`/`failed` released a room's
	 * match — so reading the room during that whole window (exactly what
	 * clicking "Rematch" does next) sent a returning player straight back into
	 * the match that just ended. A REAL `Match`, driven to `over` by a genuine
	 * `gameover` line on its host, not a fake registry: the fact under test is
	 * `match.ts`'s own status transition reaching `liveMatchId`.
	 */
	/**
	 * Every room match that ended after a deploy (seven in the logs, 2026-10-10
	 * to 10-17) was logged `stats-skipped: no start was captured for this
	 * match` and never reached the leaderboard: the start lived in the old
	 * process's memory, and the match did not. A restart here is the real one's
	 * shape: the old process goes, the rooms come back from disk (the same
	 * lobby), and the new process's play takes the JVM back from its record —
	 * `jvm.json`'s spec, owners, epoch and start time.
	 */
	describe('a match taken back after a restart', () => {
		async function restarted(): Promise<{ h: Harness; matchId: string; startedAt: string; jvm: () => ReplayHost }> {
			const before = await boot();
			openRoom(before);
			await bothLoaded(before);
			await setReady(before, 'alice');
			await setReady(before, 'bob');
			const started = await startRoom(before, 'alice');
			expect(started.status).toBe(201);
			const matchId = started.body.matchId as string;
			const old = before.matches.get(matchId)!;
			const startedAt = new Date().toISOString();
			const record: MatchRecord = {
				matchId,
				hostId: 'h-000000000000',
				startedAt,
				epoch: old.epoch,
				owners: [old.seats[0]!.owner, old.seats[1]!.owner],
				spec: before.specs[0]!,
				orphanedAt: startedAt,
			};
			const lobby = before.lobby;
			await before.close();
			harness = null;

			const { factory, hosts } = replayFactory();
			const host: MatchHostFactory = Object.assign(factory, {
				orphans: async () => [record],
				attach: (r: MatchRecord, events: Parameters<MatchHostFactory>[2]) => {
					const back = factory(r.matchId, r.spec!, events) as ReplayHost;
					back.push(...OPENING);
					return back;
				},
			});
			const h = await boot({ lobby, host });
			expect(h.matches.get(matchId)?.status).toBe('running');
			return { h, matchId, startedAt, jvm: () => hosts.at(-1)! };
		}

		it('is recorded when it ends, with who sat where, their decks and the room it was played in', async () => {
			const { h, matchId, startedAt, jvm } = await restarted();
			// Each player's page reads the room again once its socket is back.
			await view(h, 'alice');
			await view(h, 'bob');
			const match = h.matches.get(matchId)!;
			jvm().push({ t: 'gameover', winner: match.spec.seats[0].name });

			await vi.waitFor(() => expect(h.reports).toHaveLength(1));
			expect(h.statsLogs.filter((e) => e.evt === 'stats-skipped')).toEqual([]);
			const report = h.reports[0]!;
			expect(report).toMatchObject({
				matchId,
				mode: 'constructed',
				roomId: ROOM,
				rated: true,
				startedAt: Date.parse(startedAt),
				attrs: { format: library.format(h.lobby.room(ROOM)!.format)!.family, pool: h.lobby.room(ROOM)!.format, opponent: 'human', mode: 'classic', bestOf: 1 },
			});
			expect(report.seats.map((s) => [s.seat, s.kind, s.userKey, s.displayName, s.placement, s.attrs?.deck, s.attrs?.deckId])).toEqual([
				[0, 'user', 'friend-key-alice', 'user-alice', 1, 'UG Polymorph (Antoine Ruel)', UG_POLYMORPH],
				[1, 'user', 'friend-key-bob', 'user-bob', 2, 'Jund (Emanuele Giusti)', SECOND_DECK],
			]);
			expect(report.seats[0]!.counters?.cardsInDeck).toBe(60);
		});

		/**
		 * A hidden tab makes no /api request, but its match socket reconnects
		 * after every restart, and the edge stamps the same headers on that
		 * handshake. The seat it takes back is the proof that the socket names
		 * bob by the id the room minted for him over /api.
		 */
		it('names a player heard from only over the match socket by their key', async () => {
			const { h, matchId, jvm } = await restarted();
			await view(h, 'alice');
			const socket = ioClient(`http://127.0.0.1:${h.port}`, { transports: ['polling'], extraHeaders: edgeHeaders('bob'), forceNew: true, reconnection: false });
			try {
				const joined = (await socket.timeout(5000).emitWithAck(MATCH_EVENTS.join, { matchId })) as { seat?: number };
				expect(joined.seat).toBe(1);
				const match = h.matches.get(matchId)!;
				jvm().push({ t: 'gameover', winner: match.spec.seats[0].name });

				await vi.waitFor(() => expect(h.reports).toHaveLength(1));
				expect(h.reports[0]!.rated).toBe(true);
				expect(h.reports[0]!.seats.map((s) => [s.kind, s.userKey, s.displayName])).toEqual([
					['user', 'friend-key-alice', 'user-alice'],
					['user', 'friend-key-bob', 'user-bob'],
				]);
				expect(JSON.stringify(h.statsLogs)).not.toContain('friend-key-');
			} finally {
				socket.disconnect();
			}
		});

		it('names a player it has heard from nowhere since the restart as a guest, and so ranks nothing', async () => {
			const { h, matchId, jvm } = await restarted();
			// Only alice's page has read anything from the new process.
			await view(h, 'alice');
			const match = h.matches.get(matchId)!;
			jvm().push({ t: 'gameover', winner: match.spec.seats[1].name });

			await vi.waitFor(() => expect(h.reports).toHaveLength(1));
			expect(h.reports[0]!.rated).toBe(false);
			expect(h.reports[0]!.seats.map((s) => [s.kind, s.userKey, s.displayName])).toEqual([
				['user', 'friend-key-alice', 'user-alice'],
				['guest', undefined, 'user-bob'],
			]);
		});
	});

	it('releases the room once its match is OVER, not only once it is stopped or failed', async () => {
		const h = await boot();
		openRoom(h);
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		const started = await startRoom(h, 'alice');
		expect(started.status).toBe(201);
		const matchId = started.body.matchId as string;
		expect(h.matches.get(matchId)?.status).toBe('running');

		(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: null });
		expect(h.matches.get(matchId)?.status).toBe('over');

		const seen = await view(h, 'alice');
		expect((seen.body.room as { matchId: string | null }).matchId).toBeNull();
		// Un-matched, both decks still held for a Rematch, and nobody ready: the
		// start spent both Readys.
		expect(players(seen.body).map((p) => p.ready)).toEqual([false, false]);
		for (const who of ['alice', 'bob']) expect(myDeck((await view(h, who)).body), who).not.toBeNull();
		expect(h.lobby.room(ROOM)?.tables[0]?.matchId).toBeNull();

		// Reverted (comment out the `=== 'over'` arm of `finished` in
		// `liveMatchId`): this exact assertion is what fails — `matchId` comes
		// back as the finished match's id instead of null. 1 failed.
		// Restored: passes. 1 passed.

		// A Rematch: both ready again with the decks they hold, which converts
		// the Bo1 and goes to sideboarding; both ready from there, and the next
		// match starts.
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		expect(h.lobby.room(ROOM)?.tables[0]?.series.phase).toBe('sideboarding');
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		// NOT `startRoom`/`start()`: both assume `h.hosts` starts empty, which is
		// true for every OTHER test (one `boot()`, one match) and false here —
		// this is the SECOND match on one harness. Reused as-is, `start()` would
		// see `h.hosts.length` already > 0, skip waiting for the NEW host, and
		// push `OPENING` to the FIRST (already-finished) one instead — exactly
		// `socket.test.ts`'s own `startMatch` pattern, done by hand.
		const hostsBefore = h.hosts.length;
		const pending = call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('alice'));
		await untilHost(h, hostsBefore + 1, pending);
		(h.hosts.at(-1) as ReplayHost).push(...OPENING);
		const again = await pending;
		expect(again.status).toBe(201);
		expect(again.body.matchId).not.toBe(matchId);
	});

	/**
	 * The operator, 2026-10-21: "if a match was not brought to victory/defeat
	 * then it was not finished." A match the server ended — nobody came back
	 * (`match-not-rejoined`), the room closed, the JVM died — has no result,
	 * even when the bridge's gameover line was already in the pipe.
	 */
	describe('a game that ends without victory or defeat', () => {
		async function started(h: Harness): Promise<string> {
			openRoom(h);
			await bothLoaded(h);
			await setReady(h, 'alice');
			await setReady(h, 'bob');
			const res = await startRoom(h, 'alice');
			expect(res.status).toBe(201);
			return res.body.matchId as string;
		}

		it.each([
			['stopped', (h: Harness, id: string) => h.matches.get(id)!.stop()],
			['failed', (h: Harness) => (h.hosts.at(-1) as ReplayHost).push({ t: 'fatal', message: 'the JVM died' })],
		])('is not reported and not counted when the match was %s before its gameover line', async (_, end) => {
			const h = await boot();
			const id = await started(h);
			end(h, id);
			(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: h.matches.get(id)!.spec.seats[0].name });
			await view(h, 'alice');
			await new Promise((r) => setTimeout(r, 50));
			expect(h.reports).toEqual([]);
			expect(h.lobby.room(ROOM)?.tables[0]?.series.games).toEqual([]);
			expect(h.lobby.room(ROOM)?.tables[0]?.matchId).toBeNull();
		});

		it('a concede is a finished game: reported and counted as the conceder’s loss', async () => {
			const h = await boot();
			const id = await started(h);
			const match = h.matches.get(id)!;
			expect(match.fromClient(0, { kind: 'act', method: 'concede' } as ClientFrame)).toEqual({ ok: true });
			(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: null });
			await vi.waitFor(() => expect(h.reports).toHaveLength(1));
			expect(h.reports[0]!.seats.map((s) => s.placement)).toEqual([2, 1]);
			expect(h.lobby.room(ROOM)?.tables[0]?.series.games).toEqual([{ matchId: id, winner: 1 }]);
		});
	});

	/**
	 * Wave 72 §P step 1: the eager series. `GET /api/rooms/:id` is lane A's
	 * own route (`http/rooms.ts`) and calls `lobby.get` directly — it never
	 * touches this file's `tableView`/`liveMatchId`, so before this wave
	 * nothing told the room a match had ended until some request happened to
	 * hit a `/api/tables` route first. `h.lobby.get` stands in for that read
	 * here: it is the exact method `http/rooms.ts` calls, and `FakeLobby`'s
	 * header says it is lane A's stand-in. No `/api/tables` route — in
	 * particular `view()` — is called anywhere in this test.
	 */
	it("records a table's finished game at once, from play's own end event, with no /api/tables read in between", async () => {
		const h = await boot();
		openRoom(h);
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		const started = await startRoom(h, 'alice');
		expect(started.status).toBe(201);
		const matchId = started.body.matchId as string;
		expect(h.matches.get(matchId)?.status).toBe('running');

		(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: null });
		expect(h.matches.get(matchId)?.status).toBe('over');

		// No `view()` and no other `/api/tables` call anywhere in this test:
		// `onGameOver`'s own composition (`tables.gameOver`, wired in `boot()`
		// exactly as `index.ts` wires it) is what has to have already recorded
		// the game and cleared the table's match id, from the `gameover` push
		// above alone.
		const table = h.lobby.get(ROOM)?.tables[0];
		expect(table?.matchId).toBeNull();
		expect(table?.series.games).toEqual([{ matchId, winner: null }]);
		expect(table?.series.phase).toBe('done');

		// Reverted (comment out `tables.gameOver(match)` from `boot()`'s
		// composed `onGameOver`, or empty out `TablesHandle.gameOver`'s body in
		// `routes.ts`): both assertions above fail — `table?.matchId` is
		// still the finished match's id and `series.games` is empty, because
		// nothing but a `/api/tables` read would have cleared it. 2 failed.
		// Restored: 2 passed.
	});

	/** Ruling 13.4, for Classic: a decided series holds nothing — the start spent both Readys, and the match is over. */
	it('a decided Classic series leaves the table unlocked: both seats stand', async () => {
		const h = await boot();
		openRoom(h);
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		const started = await startRoom(h, 'alice');
		expect(started.status).toBe(201);
		(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: null });
		expect(h.lobby.get(ROOM)?.tables[0]?.series.phase).toBe('done');
		const read = await call(h, 'GET', `/api/tables/rooms/${ROOM}`, undefined, edgeHeaders('alice'));
		expect(read.body.room, 'a decided series leaves the table unlocked').toMatchObject({ locked: false, matchId: null });
		for (const user of ['alice', 'bob']) expect((await call(h, 'POST', `/api/tables/rooms/${ROOM}/stand`, {}, edgeHeaders(user))).status).toBe(200);
	});

	/**
	 * Wave 25 §A, the consequence stated: a drafted deck is not brought to a room
	 * table at all, because a room table's rules are its room's pool and a drafted
	 * pool is nobody's format. That path is `POST /api/play/matches` with `seats`
	 * against the AI, which still carries `rules` per seat — the describe block
	 * above exercises it, including the refusal of a card the caller did not draft.
	 *
	 * The hazard that shape used to carry is why the room's pool had to become the
	 * rule rather than a per-seat one: a `{ kind: 'draft' }` rule resolves the pool
	 * of whoever is making the REQUEST, so Bob pressing start would have had
	 * Alice's deck checked against Bob's (empty) pool. One pool per table, named by
	 * the room, cannot do that to anybody.
	 */
	it('refuses a drafted deck at a room table, because the room owns the rules', async () => {
		const h = await boot();
		openRoom(h);
		const draftId = 'amber-lantern-k7q4';
		const draftRoom = h.rooms.open(draftId);
		const seat = joinDraftRoom(draftRoom, 'sock-a', ALICE, 'friend').seat;
		if (seat === null) throw new Error('alice was not seated');
		const state = stateOf(draftRoom);
		const pool = state.queues.flat(2).slice(0, 45);
		state.pools[seat] = pool;
		let built = deckFromPool(draftId, pool);
		for (const card of pool.slice(0, 40)) {
			const entry = built.sideboard.find((e) => e.card.name === card.name && e.card.set === (card.setCode || null));
			if (entry !== undefined) built = moveToMain(built, entry.card, 1);
		}
		const text = dckTextOf(built);

		const refused = await putDeck(h, 'alice', { deck: { dck: text }, rules: { kind: 'draft', draftId } });
		expect(refused.status).toBe(400);
		expect(refused.body.error).toContain('unknown field rules');
		// Nothing was held: the refusal is whole, so alice is not a player.
		expect(players((await view(h, 'alice')).body)).toEqual([]);

		// The same `.dck`, with no rules, is checked against the ROOM's pool — and
		// a cube deck is not legal in a Standard pool, which is the honest answer
		// rather than a pool of the caller's choosing.
		const asIs = await putDeck(h, 'alice', { deck: { dck: text } });
		expect(asIs.status).toBe(200);
		expect(myDeck(asIs.body)).toMatchObject({ legal: false, rulesName: 'Standard (M11)' });

		// And `/api/tables/check` still takes rules, because it starts nothing and
		// belongs to no room: this is where a drafted deck is still checked.
		const checked = await call(
			h,
			'POST',
			'/api/tables/check',
			{ deck: { dck: text }, rules: { kind: 'draft', draftId } },
			edgeHeaders('alice'),
		);
		expect(checked).toMatchObject({ status: 200, body: { legal: true } });
		expect(h.specs).toEqual([]);
	});

	it('refuses a start before both players have loaded a deck', async () => {
		const h = await boot();
		openRoom(h);
		const empty = await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('alice'));
		expect(empty).toMatchObject({ status: 409, body: { error: 'both players have to load a deck first' } });
		await putDeck(h, 'alice', deckBody(UG_POLYMORPH));
		await setReady(h, 'alice');
		const alone = await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('alice'));
		expect(alone.status).toBe(409);
		expect(h.specs).toEqual([]);
	});

	it('answers a malformed room body with 400 rather than a room', async () => {
		const h = await boot();
		openRoom(h);
		expect(await call(h, 'POST', '/api/play/matches', { room: ROOM, decks: [null, null] }, edgeHeaders('alice'))).toMatchObject(
			{ status: 400, body: { error: 'body: unknown field decks' } },
		);
		expect(await call(h, 'POST', '/api/play/matches', { room: 42 }, edgeHeaders('alice'))).toMatchObject({ status: 400 });
		expect(await call(h, 'POST', `/api/tables/rooms/${ROOM}/ready`, {}, edgeHeaders('alice'))).toMatchObject({
			status: 400,
			body: { error: 'body is { ready: boolean, table?, rematch?: true }' },
		});
		expect(await call(h, 'POST', `/api/tables/rooms/${ROOM}/ready`, { ready: 'yes' }, edgeHeaders('alice'))).toMatchObject({
			status: 400,
		});
		expect(h.specs).toEqual([]);
	});

	/* ── the pool is the room's, and the leader's (wave 25 §A) ─────────── */

	it('refuses a PUT deck that carries rules', async () => {
		const h = await boot();
		openRoom(h);
		const refused = await putDeck(h, 'alice', standard(UG_POLYMORPH, POWER_2011));
		expect(refused.status).toBe(400);
		expect(refused.body.error).toBe(
			"body: unknown field rules — a table's rules are its room's format, which only the room leader changes",
		);
		// Refused WHOLE: no deck was held under the caller's own idea of the format.
		expect(players((await view(h, 'alice')).body)).toEqual([]);
		// And `rules` is refused even smuggled in beside a deck that would be fine,
		// which is what makes this a stated refusal rather than a silent ignore.
		expect((await putDeck(h, 'alice', { ...deckBody(UG_POLYMORPH), rules: null })).status).toBe(400);
		expect((await putDeck(h, 'alice', deckBody(UG_POLYMORPH))).status).toBe(200);
	});

	it('checks the deck against the ROOM’s pool, and says so in the verdict', async () => {
		const h = await boot();
		// The same deck, the same body, two rooms on two pools: the verdict follows
		// the ROOM. Nothing in the request says which pool, because nothing may.
		h.lobby.open('r-mbs', [...MEMBERS], undefined, POWER_2010);
		h.lobby.open('r-bans', [...MEMBERS], undefined, POWER_2011);

		const inMbs = await putDeck(h, 'alice', deckBody(UG_POLYMORPH), 'r-mbs');
		expect(inMbs.status).toBe(200);
		expect(myDeck(inMbs.body)).toMatchObject({ legal: true, rulesName: 'Standard (M11)' });
		expect((inMbs.body.room as { format: string }).format).toBe(POWER_2010);

		const inBans = await putDeck(h, 'alice', deckBody(UG_POLYMORPH), 'r-bans');
		expect(inBans.status).toBe(200);
		expect(myDeck(inBans.body)).toMatchObject({ legal: false, rulesName: 'Standard (M12)' });
		expect((inBans.body.room as { format: string }).format).toBe(POWER_2011);
	});

	it('refuses a start when a deck is illegal in the room’s pool though legal in another', async () => {
		const h = await boot();
		// Both legal in the 2011 era's pool: CAW_BLADE is native to it, and sixty
		// Islands is legal in any pool by construction (a basic is exempt from both
		// the pool-membership check and the copy limit). Both players ready, the
		// match would start. Then the room moves to the 2010 era's pool instead —
		// where CAW_BLADE plays cards (Mana Leak|M12, Gideon Jura, Timely
		// Reinforcements…) that did not exist yet, and the Islands still do.
		const room = openRoom(h, undefined, POWER_2011);
		expect((await putDeck(h, 'alice', deckBody(CAW_BLADE))).status).toBe(200);
		expect((await putDeck(h, 'bob', { deck: { dck: ALWAYS_LEGAL_DCK } })).status).toBe(200);
		expect((await setReady(h, 'alice')).status).toBe(200);
		expect((await setReady(h, 'bob')).status).toBe(200);

		// Set directly, which is a state the leader's setter would never leave
		// behind — it drops every hold and both ready flags. That is the point: the
		// start route does not trust the stored verdict, it checks the room's pool.
		room.format = POWER_2010;
		const refused = await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('bob'));
		expect(refused.status).toBe(422);
		expect(refused.body.error).toBe("user-alice's deck is not legal in Standard (M11)");
		// The card is NOT named: bob pressed start, and what is wrong with alice's
		// deck is alice's to read.
		expect(JSON.stringify(refused.body)).not.toContain('Squadron Hawk');
		expect(refused.body.verdict).toBeUndefined();
		expect(refused.body.issues).toBeUndefined();
		expect(h.specs).toEqual([]);

		// Back on the pool both decks are legal in, the same two holds start.
		room.format = POWER_2011;
		expect((await startRoom(h, 'bob')).status).toBe(201);
	});

	it('tells exactly one member the room is theirs to set: you.leader', async () => {
		const h = await boot();
		h.lobby.open(ROOM, [...MEMBERS, { id: CAROL, name: 'user-carol' }]);
		const seen = await Promise.all([view(h, 'alice'), view(h, 'bob'), view(h, 'carol')]);
		expect(seen.map((r) => (r.body.you as { leader: boolean }).leader)).toEqual([true, false, false]);
		// The flag is the room's leader and nothing else: alice leads without a deck.
		expect(seen.map((r) => r.body.you)).toEqual([
			{ player: false, leader: true },
			{ player: false, leader: false },
			{ player: false, leader: false },
		]);
	});

	it('answers 409 for a room whose pool this server does not have', async () => {
		const h = await boot();
		const room = openRoom(h, undefined, '1999-01-01');
		const loaded = await putDeck(h, 'alice', deckBody(UG_POLYMORPH));
		expect(loaded).toMatchObject({
			status: 409,
			body: { error: 'this room\'s format "1999-01-01" is not one this server has' },
		});
		// A room that goes unknown UNDER a loaded table refuses the start too, and
		// with the same sentence: nothing is checked against a pool nobody froze.
		room.format = POWER_2010;
		await bothLoaded(h);
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		room.format = 'unavailable';
		const started = await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('alice'));
		expect(started).toMatchObject({ status: 409, body: { error: 'this room\'s format "unavailable" is not one this server has' } });
		expect(h.specs).toEqual([]);
	});

	it('is behind the friend floor like every other route', async () => {
		const h = await boot();
		openRoom(h);
		expect((await view(h, 'alice')).status).toBe(200);
		const res = await call(h, 'GET', `/api/tables/rooms/${ROOM}`, undefined, edgeHeaders('alice', 'public'));
		expect(res.status).toBe(404);
		expect(res.body.error).not.toBe('no such room');
	});

	/*
	 * Wave 71 (`docs/planning/wave71-2026-10-17.md` §D): a room holds several
	 * tables, each with its own series. The wire contract: a request naming no
	 * `table` means `tables[0]`, so every test above (none of which ever names
	 * one) is itself proof that an unedited caller sees no change at all.
	 */
	describe('wave 71: a second table, a series, sideboarding and the chooser', () => {
		const addTable = (h: Harness, user: string) => call(h, 'POST', `/api/tables/rooms/${ROOM}/tables`, {}, edgeHeaders(user));
		const removeTable = (h: Harness, user: string, tableId: string) =>
			call(h, 'DELETE', `/api/tables/rooms/${ROOM}/tables/${tableId}`, undefined, edgeHeaders(user));

		it('adds and removes a table, leader only; the first table can never be removed', async () => {
			const h = await boot();
			openRoom(h);
			expect((await addTable(h, 'bob')).status).toBe(403);
			const added = await addTable(h, 'alice');
			expect(added.status).toBe(201);
			const tableId = (added.body as { id: string }).id;
			expect(added.body).toMatchObject({ players: [], matchId: null, series: { length: 1, wins: [0, 0], games: [], phase: 'seating' } });
			expect(h.lobby.room(ROOM)?.tables.map((t) => t.id)).toEqual([h.lobby.room(ROOM)!.tables[0]!.id, tableId]);

			expect((await removeTable(h, 'bob', tableId)).status).toBe(403);
			expect((await removeTable(h, 'alice', tableId)).status).toBe(204);
			expect(h.lobby.room(ROOM)?.tables).toHaveLength(1);
			const firstId = h.lobby.room(ROOM)!.tables[0]!.id;
			expect((await removeTable(h, 'alice', firstId)).status).toBe(409);
		});

		it('sits and loads a deck at a SECOND table, independently of the first', async () => {
			const h = await boot();
			h.lobby.open(ROOM, [...MEMBERS, { id: CAROL, name: 'user-carol' }]);
			const added = await addTable(h, 'alice');
			const table2 = (added.body as { id: string }).id;

			await bothLoaded(h); // alice + bob at table 1, by omitting `table` entirely
			expect((await call(h, 'POST', `/api/tables/rooms/${ROOM}/sit`, { table: table2 }, edgeHeaders('carol'))).status).toBe(200);
			const loaded = await call(h, 'PUT', `/api/tables/rooms/${ROOM}/deck`, { ...deckBody(ELDRAZI_GREEN), table: table2 }, edgeHeaders('carol'));
			expect(loaded.status).toBe(200);
			expect(players(loaded.body).map((p) => p.name)).toEqual(['user-carol']);

			// Table 1's own view is untouched by table 2's seating.
			expect(players((await view(h, 'alice')).body).map((p) => p.name)).toEqual(['user-alice', 'user-bob']);
			// And table 2, read by its own id, shows carol and only carol.
			const table2View = await call(h, 'GET', `/api/tables/rooms/${ROOM}?table=${table2}`, undefined, edgeHeaders('carol'));
			expect(players(table2View.body).map((p) => p.name)).toEqual(['user-carol']);
			// The wire mirror (`RoomTable.players`) agrees, for both tables.
			expect(h.lobby.room(ROOM)?.tables[0]?.players.map((p) => p.memberId).sort()).toEqual([ALICE, BOB].sort());
			expect(h.lobby.room(ROOM)?.tables[1]?.players.map((p) => p.memberId)).toEqual([CAROL]);
		});

		it('refuses a table id that names no table of this room, and an empty one', async () => {
			const h = await boot();
			openRoom(h);
			const bad = await call(h, 'GET', `/api/tables/rooms/${ROOM}?table=t-nope0000`, undefined, edgeHeaders('alice'));
			expect(bad).toMatchObject({ status: 404, body: { error: 'no such table' } });
			const blank = await call(h, 'PUT', `/api/tables/rooms/${ROOM}/deck`, { ...deckBody(UG_POLYMORPH), table: '' }, edgeHeaders('alice'));
			expect(blank.status).toBe(400);
		});

		it('sideboarding: a resubmission of the SAME 75 is accepted; a different deck is refused even though it is legal in the pool', async () => {
			const h = await boot();
			openRoom(h);
			await bothLoaded(h); // alice: UG_POLYMORPH, bob: SECOND_DECK
			await setReady(h, 'alice');
			await setReady(h, 'bob');
			// As if game 1 of the series just ended: the table is `sideboarding`
			// and alice's series baseline is the deck she just played.
			h.lobby.room(ROOM)!.tables[0]!.series.phase = 'sideboarding';
			const aliceState = h.lobby.playerState(ROOM, ALICE) as Record<string, unknown>;
			h.lobby.setPlayerState(ROOM, ALICE, { ...aliceState, seriesDeck: library.deck(UG_POLYMORPH)!.text });

			expect((await putDeck(h, 'alice', deckBody(UG_POLYMORPH))).status).toBe(200);
			const different = await putDeck(h, 'alice', deckBody(SECOND_DECK));
			expect(different.status).toBe(409);
			expect(different.body.error).toContain('sideboard');
		});

		/**
		 * Lane Q's report, 2026-10-17: a library-deck seat's sideboard step
		 * 409'd EVERY resubmission, even an untouched deck. The baseline
		 * (`seriesDeck`) is the library `.dck` text WITH a set code per card
		 * ("4 Mana Leak|8E"); `GET /tables/decks` sends the browser only
		 * `{count, name}` (never a set code), so the browser's own
		 * resubmission is bare names. `multisetOf` keyed by `cardKey`
		 * (set/collector/art included), so every one of its cards read as a
		 * DIFFERENT card from the baseline's. The rule is "the same cards,
		 * only re-split" and printing never mattered to it — the fix
		 * keys by name alone.
		 */
		it('sideboarding: a library-deck resubmission in BARE NAMES (no set code — exactly what GET /tables/decks gives the browser) is accepted untouched and re-split, but adding a card is still refused', async () => {
			const h = await boot();
			openRoom(h);
			await bothLoaded(h); // alice: UG_POLYMORPH, bob: SECOND_DECK
			await setReady(h, 'alice');
			await setReady(h, 'bob');
			h.lobby.room(ROOM)!.tables[0]!.series.phase = 'sideboarding';
			const canonicalText = library.deck(UG_POLYMORPH)!.text;
			const aliceState = h.lobby.playerState(ROOM, ALICE) as Record<string, unknown>;
			h.lobby.setPlayerState(ROOM, ALICE, { ...aliceState, seriesDeck: canonicalText });

			// The browser's own reconstruction: strip every "|SET" segment, the
			// same information loss `GET /tables/decks`'s `{count, name}` rows
			// already have.
			const bareText = canonicalText.replace(/\|\S+/g, '');
			expect(bareText).not.toContain('|');
			expect(bareText).toContain('1 Scalding Tarn\n');

			const untouched = await putDeck(h, 'alice', { deck: { dck: bareText } });
			expect(untouched.status).toBe(200);

			// Re-split: move ONE card, Scalding Tarn, from the main deck to the
			// sideboard — the same 75, only re-split.
			const resplit = bareText.replace('1 Scalding Tarn\n', '').replace('[Sideboard]\n', '[Sideboard]\n1 Scalding Tarn\n');
			expect(resplit.split('[Sideboard]')[0]).not.toContain('Scalding Tarn');
			expect(resplit).toContain('1 Scalding Tarn');
			const moved = await putDeck(h, 'alice', { deck: { dck: resplit } });
			expect(moved.status).toBe(200);

			// A second copy of a card already in the 75 (still within the 4-copy
			// limit, so legality alone would accept it) changes the TOTAL for
			// that name — refused, same as before.
			const added = resplit.replace('1 Scalding Tarn\n', '2 Scalding Tarn\n');
			const refused = await putDeck(h, 'alice', { deck: { dck: added } });
			expect(refused.status).toBe(409);
			expect(refused.body.error).toContain('sideboard');

			// Reverted (key `multisetOf` by `cardKey(e.card)` instead of
			// `e.card.name`): `untouched` above 409s — the baseline's
			// "Scalding Tarn|ZEN" and the bare resubmission's "Scalding Tarn"
			// are different keys though they are the same card. 1 failed.
			// Restored: passes, 200. 1 passed.
		});

		/**
		 * `start`'s own `untilHost` waits for the FIRST host unconditionally — fine
		 * for a harness's first match, wrong for any match after it (it would see
		 * `h.hosts.length` already > 0 and push `OPENING` to the wrong, already-
		 * finished, host). The "sixth match" test's own by-hand pattern, factored
		 * out for every test below that starts a SECOND or later match.
		 */
		async function startAnother(h: Harness, user: string): Promise<{ status: number; body: Record<string, unknown> }> {
			const before = h.hosts.length;
			const pending = call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders(user));
			await untilHost(h, before + 1, pending);
			if (h.hosts.length > before) (h.hosts.at(-1) as ReplayHost).push(...OPENING);
			return pending;
		}

		/**
		 * Classic Bo1 → Rematch: the Rematch gesture IS `POST …/ready` — there is
		 * no other one on this API — so `Lobby.beginSideboarding` is wired into
		 * that route, called on every `ready: true` and deciding for itself.
		 */
		it('Bo1 → Rematch: the finished game stays game 1, the series is Bo3 at 1-0 in sideboarding — the deck gate applies, and the LOSER of game 1 is asked play-or-draw for game 2', async () => {
			const h = await boot();
			openRoom(h);
			await bothLoaded(h); // alice: UG_POLYMORPH, bob: SECOND_DECK
			await setReady(h, 'alice');
			await setReady(h, 'bob');
			const game1 = await startRoom(h, 'alice');
			expect(game1.status).toBe(201);
			expect(h.specs[0]).not.toHaveProperty('chooser');

			(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: 'user-alice' });
			expect(h.matches.get(game1.body.matchId as string)?.status).toBe('over');
			await view(h, 'alice'); // `liveMatchId` finalizes the game into the series ledger
			expect(h.lobby.room(ROOM)?.tables[0]?.series).toMatchObject({ length: 1, phase: 'done', wins: [1, 0] });

			// Both ready — the Rematch gesture — converts the series AT ONCE, and
			// spends both Readys.
			await setReady(h, 'alice');
			const bothReady = await setReady(h, 'bob');
			expect(players(bothReady.body).map((p) => p.ready)).toEqual([false, false]);
			expect(h.lobby.room(ROOM)?.tables[0]?.series).toEqual({
				length: 3,
				wins: [1, 0],
				games: [{ matchId: game1.body.matchId, winner: 0 }],
				phase: 'sideboarding',
			});

			// The deck gate runs during this step: the SAME deck is accepted; a
			// DIFFERENT one is refused.
			const different = await putDeck(h, 'alice', deckBody(SECOND_DECK));
			expect(different.status).toBe(409);
			expect(different.body.error).toContain('sideboard');
			expect((await putDeck(h, 'alice', deckBody(UG_POLYMORPH))).status).toBe(200);
			expect((await putDeck(h, 'bob', deckBody(SECOND_DECK))).status).toBe(200);
			await setReady(h, 'alice');
			await setReady(h, 'bob');

			const game2 = await startAnother(h, 'alice');
			expect(game2.status).toBe(201);
			expect(game2.body.matchId).not.toBe(game1.body.matchId);
			// Alice (seat 0) won game 1, so Bob (seat 1) chooses play or draw.
			expect(h.specs.at(-1)).toMatchObject({ chooser: 1 });
			expect(h.lobby.room(ROOM)?.tables[0]?.series).toMatchObject({ length: 3, wins: [1, 0], phase: 'playing' });
		});

		it('against the AI: the one player’s Ready on a finished Bo1 converts it too', async () => {
			const h = await boot();
			h.lobby.open(ROOM, [{ id: ALICE, name: 'user-alice' }]);
			expect((await putDeck(h, 'alice', deckBody(UG_POLYMORPH))).status).toBe(200);
			expect((await start(h, { room: ROOM, bot: true }, '/api/play/matches', 'application/json', edgeHeaders('alice'))).status).toBe(201);
			(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: 'user-alice' });
			await view(h, 'alice');
			expect(h.lobby.room(ROOM)?.tables[0]?.series).toMatchObject({ length: 1, phase: 'done' });
			const ready = await setReady(h, 'alice');
			expect(players(ready.body).map((p) => p.ready)).toEqual([false]);
			expect(h.lobby.room(ROOM)?.tables[0]?.series).toMatchObject({ length: 3, wins: [1, 0], phase: 'sideboarding' });
		});

		/**
		 * The operator, 2026-10-21: "if rematch is clicked, yes the bot keeps the
		 * same deck. if we go back to room then it picks a new deck". Every game
		 * of the Bo3 a Rematch converts into is the same series, so the same bot
		 * deck; a start from a `done` series is a new one, and draws again.
		 * `Math.random` is pinned so a re-draw cannot land on the same deck by luck.
		 */
		it('against the AI in Classic: a Rematch keeps the bot’s deck, for the whole Bo3 and after it; any other start of a new series draws a new one', async () => {
			const h = await boot();
			h.lobby.open(ROOM, [{ id: ALICE, name: 'user-alice' }]);
			expect((await putDeck(h, 'alice', deckBody(UG_POLYMORPH))).status).toBe(200);
			const startBot = async (extra: Record<string, unknown> = {}) => {
				const before = h.hosts.length;
				const pending = call(h, 'POST', '/api/play/matches', { room: ROOM, bot: true, ...extra }, edgeHeaders('alice'));
				await untilHost(h, before + 1, pending);
				if (h.hosts.length > before) (h.hosts.at(-1) as ReplayHost).push(...OPENING);
				return pending;
			};
			const botDeck = () => h.specs.at(-1)!.seats[1]!.deck;
			const gameOver = async (winner: string | null) => {
				(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner });
				await view(h, 'alice');
			};
			const random = vi.spyOn(Math, 'random').mockReturnValue(0);
			try {
				expect((await startBot()).status).toBe(201);
				const first = botDeck();
				await gameOver('user-alice');
				random.mockReturnValue(0.999);
				// Rematch: the one Ready converts the Bo1, the sideboard step's Ready starts game 2.
				await setReady(h, 'alice');
				expect(h.lobby.room(ROOM)?.tables[0]?.series).toMatchObject({ length: 3, phase: 'sideboarding' });
				// The sideboard step resubmits the 75 before its Ready.
				expect((await putDeck(h, 'alice', deckBody(UG_POLYMORPH))).status).toBe(200);
				await setReady(h, 'alice');
				expect((await startBot()).status).toBe(201);
				expect(botDeck(), 'game 2 of the Bo3 the Rematch made').toBe(first);
				await gameOver(null);
				await setReady(h, 'alice');
				expect((await startBot()).status).toBe(201);
				expect(botDeck(), 'game 3').toBe(first);
				await gameOver('user-alice');
				expect(h.lobby.room(ROOM)?.tables[0]?.series).toMatchObject({ phase: 'done' });
				// Rematch on the decided Bo3's result screen: a new series, the same bot deck.
				expect((await call(h, 'POST', '/api/play/matches', { room: ROOM, bot: true, rematch: 'yes' }, edgeHeaders('alice'))).status).toBe(400);
				expect((await startBot({ rematch: true })).status).toBe(201);
				expect(h.lobby.room(ROOM)?.tables[0]?.series).toMatchObject({ length: 1, games: [] });
				expect(botDeck(), 'a Rematch after a decided Bo3').toBe(first);
				await gameOver('user-alice');
				// Back to room, then a new match: a new series, and a new bot deck.
				expect((await startBot()).status).toBe(201);
				expect(h.lobby.room(ROOM)?.tables[0]?.series).toMatchObject({ length: 1, games: [] });
				expect(botDeck()).not.toBe(first);
			} finally {
				random.mockRestore();
			}
		});

		/**
		 * Full Forge run 39086503872: a client-side "clear my stale ready" on
		 * the sideboard step raced a Ready that had already landed, and game 2
		 * started 409 "not ready yet". The step's own ready flags are the
		 * server's to reset: the agreement that begins sideboarding spends both
		 * Readys, so nothing stale can start the next game, and only a fresh
		 * Ready from each seat does.
		 */
		it('the Rematch agreement that begins sideboarding spends both Readys — no start until both ready again', async () => {
			const h = await boot();
			openRoom(h);
			await bothLoaded(h);
			await setReady(h, 'alice');
			await setReady(h, 'bob');
			const game1 = await startRoom(h, 'alice');
			expect(game1.status).toBe(201);
			(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: 'user-bob' });
			await view(h, 'alice');
			expect(h.lobby.room(ROOM)?.tables[0]?.series.phase).toBe('done');

			const first = await setReady(h, 'alice');
			expect(players(first.body).map((p) => p.ready), 'one press is not an agreement').toEqual([true, false]);
			const agreed = await setReady(h, 'bob');
			expect(agreed.status).toBe(200);
			expect(h.lobby.room(ROOM)?.tables[0]?.series.phase).toBe('sideboarding');
			expect(players(agreed.body).map((p) => p.ready), "the agreeing press's own answer").toEqual([false, false]);
			expect((agreed.body.room as { phase: string }).phase, 'and the table read says where the series is').toBe('sideboarding');
			expect(players((await view(h, 'alice')).body).map((p) => p.ready), 'every read after it').toEqual([false, false]);

			const refused = await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('alice'));
			expect(refused.status).toBe(409);
			await setReady(h, 'alice');
			expect((await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('alice'))).status, 'one fresh Ready is not both').toBe(409);
			await setReady(h, 'bob');
			expect((await startAnother(h, 'alice')).status).toBe(201);
		});

		/**
		 * MTG's rule, the operator's ruling: sideboarding lasts for one match.
		 * Once a series is `done`, each seat goes back to the deck it registered
		 * when the series began — a library deck as that library deck, name and
		 * all — not the sideboarded 75 it played the last game with.
		 */
		describe("the room's chess clock", () => {
			it('starts no clock in a casual room, and the whole 20 minutes a seat once the leader turns it on', async () => {
				const h = await boot();
				openRoom(h);
				await bothLoaded(h);
				await setReady(h, 'alice');
				await setReady(h, 'bob');
				expect((await startRoom(h, 'alice')).status).toBe(201);
				expect(h.specs.at(-1)).not.toHaveProperty('clockMs');

				const on = await boot();
				openRoom(on).settings.clock = 'on';
				await bothLoaded(on);
				await setReady(on, 'alice');
				await setReady(on, 'bob');
				expect((await startRoom(on, 'alice')).status).toBe(201);
				expect(on.specs.at(-1)?.clockMs).toEqual([MATCH_CLOCK_MS, MATCH_CLOCK_MS]);
			});

			it("carries what a game's clock left into the series' next game: one pool, and the break costs nobody", async () => {
				const h = await boot();
				openRoom(h).settings.clock = 'on';
				await bothLoaded(h);
				await setReady(h, 'alice');
				await setReady(h, 'bob');
				const started = await startRoom(h, 'alice');
				expect(started.status).toBe(201);
				const match = h.matches.get(started.body.matchId as string)!;
				match.clockLeft = () => [700_000, 900_000];
				(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: 'user-alice' });
				await view(h, 'alice');
				// The Rematch makes the Bo1 a Bo3 and goes to sideboarding.
				await setReady(h, 'alice');
				await setReady(h, 'bob');
				await setReady(h, 'alice');
				await setReady(h, 'bob');
				expect((await startAnother(h, 'alice')).status).toBe(201);
				expect(h.specs.at(-1)?.clockMs).toEqual([700_000, 900_000]);
			});
		});

		describe('a finished series puts each seat back on its registered deck', () => {
			/** The game on the newest host ends, `winner` taking it; a read records it. */
			async function finish(h: Harness, winner: 'alice' | 'bob'): Promise<void> {
				(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: `user-${winner}` });
				await view(h, 'alice');
			}
			/** Alice's sideboarded 75: the same cards, but sent as `.dck` text rather than her library id. */
			const sideboarded = () => ({ deck: { dck: library.deck(UG_POLYMORPH)!.text } });
			const aliceDeck = (h: Harness) => (h.lobby.playerState(ROOM, ALICE) as { deck: { choice: { deck: unknown } } }).deck.choice.deck;

			it('after a Bo3 a Rematch made, decided 2-0 with a sideboarded game 2, alice holds her library deck again, by name, and nobody is ready', async () => {
				const h = await boot();
				openRoom(h);
				await bothLoaded(h);
				const registeredName = myDeck((await view(h, 'alice')).body)?.name;
				await setReady(h, 'alice');
				await setReady(h, 'bob');
				expect((await startRoom(h, 'alice')).status).toBe(201);
				await finish(h, 'alice');
				await setReady(h, 'alice');
				await setReady(h, 'bob');
				expect(h.lobby.room(ROOM)?.tables[0]?.series.phase).toBe('sideboarding');
				expect((await putDeck(h, 'alice', sideboarded())).status).toBe(200);
				expect(aliceDeck(h), 'the sideboarded load').toEqual({ dck: expect.any(String) });
				await setReady(h, 'alice');
				await setReady(h, 'bob');
				expect((await startAnother(h, 'alice')).status).toBe(201);
				expect(aliceDeck(h), 'game 2 holds the sideboarded load').toEqual({ dck: expect.any(String) });
				await finish(h, 'alice');

				expect(h.lobby.room(ROOM)?.tables[0]?.series).toMatchObject({ phase: 'done', wins: [2, 0] });
				expect(aliceDeck(h)).toEqual({ library: UG_POLYMORPH });
				const rows = players((await view(h, 'alice')).body);
				expect(rows[0]).toMatchObject({ deck: { name: registeredName, legal: true }, ready: false });
				expect(rows[1]).toMatchObject({ ready: false });
			});

			it('a series ended off the board (the table card’s Abandon or Drop match) puts a sideboarded seat back on its registered deck too', async () => {
				const h = await boot();
				openRoom(h);
				await bothLoaded(h);
				await setReady(h, 'alice');
				await setReady(h, 'bob');
				expect((await startRoom(h, 'alice')).status).toBe(201);
				await finish(h, 'alice');
				await setReady(h, 'alice');
				await setReady(h, 'bob');
				expect(h.lobby.room(ROOM)?.tables[0]?.series.phase).toBe('sideboarding');
				expect((await putDeck(h, 'alice', sideboarded())).status).toBe(200);
				expect(aliceDeck(h), 'the sideboarded load').toEqual({ dck: expect.any(String) });

				h.tables.seriesEnded(ROOM, h.lobby.room(ROOM)!.tables[0]!.id);
				expect(aliceDeck(h)).toEqual({ library: UG_POLYMORPH });
			});

			it('a row persisted with the registered deck as text alone: the series still finishes, and the seat keeps what it holds', async () => {
				const h = await boot();
				openRoom(h);
				await bothLoaded(h);
				await setReady(h, 'alice');
				await setReady(h, 'bob');
				expect((await startRoom(h, 'alice')).status).toBe(201);
				const aliceState = h.lobby.playerState(ROOM, ALICE) as Record<string, unknown>;
				h.lobby.setPlayerState(ROOM, ALICE, { ...aliceState, seriesDeck: library.deck(UG_POLYMORPH)!.text });
				await finish(h, 'bob');

				expect(h.lobby.room(ROOM)?.tables[0]?.series.phase).toBe('done');
				expect(aliceDeck(h)).toEqual({ library: UG_POLYMORPH });
				const read = await view(h, 'alice');
				expect(read.status).toBe(200);
				expect(players(read.body).map((p) => p.ready)).toEqual([false, false]);
			});
		});

		it('a finished Bo3’s Rematch is a new Bo1 series, its first game with no chooser (a stale games.at(-1) would rig it to the old loser)', async () => {
			const h = await boot();
			openRoom(h);
			await bothLoaded(h);
			await setReady(h, 'alice');
			await setReady(h, 'bob');
			expect((await startRoom(h, 'alice')).status).toBe(201);
			(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: 'user-bob' });
			await view(h, 'alice');
			await setReady(h, 'alice');
			await setReady(h, 'bob');
			await setReady(h, 'alice');
			await setReady(h, 'bob');
			expect((await startAnother(h, 'alice')).status).toBe(201);
			(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: 'user-bob' });
			await view(h, 'alice');
			expect(h.lobby.room(ROOM)?.tables[0]?.series).toMatchObject({ length: 3, phase: 'done', wins: [0, 2] });

			// Both ready: a finished Bo3 is not converted again.
			await setReady(h, 'alice');
			await setReady(h, 'bob');
			expect(h.lobby.room(ROOM)?.tables[0]?.series.phase).toBe('done');
			const next = await startAnother(h, 'alice');
			expect(next.status).toBe(201);
			expect(h.specs.at(-1), 'a brand new series: no stale chooser from the old series it replaces').not.toHaveProperty('chooser');
			expect(h.lobby.room(ROOM)?.tables[0]?.series).toMatchObject({ length: 1, wins: [0, 0], games: [] });
		});

		it('a seat holds its series deck until it loads another — what keeps a finished Bo1 open to a Rematch', () => {
			const deck = { choice: { deck: { library: UG_POLYMORPH } }, verdict: { legal: true }, text: 'A' };
			const row = { v: 1, deck, seriesDeck: deck };
			expect(routesMod.holdsSeriesDeck(row)).toBe(true);
			expect(routesMod.holdsSeriesDeck({ ...row, seriesDeck: 'A' }), 'a registered deck persisted as text alone').toBe(true);
			expect(routesMod.holdsSeriesDeck({ ...row, deck: { ...deck, text: 'B' } }), 'another deck').toBe(false);
			expect(routesMod.holdsSeriesDeck({ ...row, deck: null }), 'no deck').toBe(false);
			expect(routesMod.holdsSeriesDeck({ ...row, seriesDeck: null }), 'no series registered').toBe(false);
			expect(routesMod.holdsSeriesDeck(undefined), 'a hold dropped by a format or mode change').toBe(false);
		});
	});
});

/* ── a room on a DRAFTED pool: the two halves finally meet (wave 26 §F) ── */

/**
 * A drafted deck against a FRIEND, at the pod's own table (wave 26 §F, played
 * since wave 72 §P at a `draft` room's tables — a constructed room is never on
 * a pod, operator 2026-10-20).
 *
 * A `{ kind: 'draft' }` rule resolves ONE PERSON's pool, so a start route that
 * re-checks both decks in the REQUESTER's context measures the other player's
 * deck against the requester's 45 and reads every card of it as undrafted.
 *
 * The fix is that the room owns the POD and each player owns their own 45:
 * `routes.ts` re-checks each stored deck in `contextFor(thatPlayer.member.id)`,
 * and a room member's id is the participant id the pod seated them with.
 *
 * Two pools that share no card, so "checked against the wrong player's pool" is
 * not a subtle difference — it is every card in the deck. The disjointness is
 * asserted rather than assumed, because the cube being singleton is what makes
 * it true.
 */
describe('a pod table plays each drafter’s own pool', () => {
	const MEMBERS = [
		{ id: ALICE, name: 'user-alice' },
		{ id: BOB, name: 'user-bob' },
	];
	// One door, one id (wave 23): the pod IS the room, so its tables play `draft:<room id>`.
	const POD = 'amber-lantern-k7q4';
	const ROOM = POD;

	interface Pod {
		alice: DraftCard[];
		bob: DraftCard[];
	}

	/** One row of the table view. Its own copy: the describe above owns its own. */
	interface Row {
		seat: number;
		you: boolean;
		ready: boolean;
		/** On your own row only. */
		deck?: { legal: boolean; rulesName: string; issueCount: number } | null;
	}
	const players = (body: Record<string, unknown>): Row[] => body.players as Row[];
	const myDeck = (body: Record<string, unknown>) => players(body).find((p) => p.you)?.deck;

	/**
	 * One pod, both members seated, each holding 45 cards the other does not.
	 */
	function pod(h: Harness, draftId = POD): Pod {
		const room = h.rooms.open(draftId);
		const seatA = joinDraftRoom(room, `sock-a-${draftId}`, ALICE, 'friend').seat;
		const seatB = joinDraftRoom(room, `sock-b-${draftId}`, BOB, 'friend').seat;
		if (seatA === null || seatB === null) throw new Error('both drafters must be seated');
		const state = stateOf(room);
		const cards = state.queues.flat(2);
		const alice = cards.slice(0, 45);
		const bob = cards.slice(45, 90);
		state.pools[seatA] = alice;
		state.pools[seatB] = bob;
		// The property every assertion below rests on. A cube is singleton, so the
		// two halves of its packs name no card in common — said out loud, because a
		// cube that ever stopped being singleton would make these tests pass for
		// the wrong reason.
		const names = new Set(alice.map((c) => c.name));
		expect(bob.filter((c) => names.has(c.name))).toEqual([]);
		return { alice, bob };
	}

	/** A 40-card maindeck out of one person's own 45. The browser's own writer. */
	function built(pool: readonly DraftCard[], draftId = POD): string {
		let deck = deckFromPool(draftId, pool);
		for (const card of pool.slice(0, 40)) {
			const entry = deck.sideboard.find((e) => e.card.name === card.name && e.card.set === (card.setCode || null));
			if (entry !== undefined) deck = moveToMain(deck, entry.card, 1);
		}
		return dckTextOf(deck);
	}

	/** The pod's own room, in its rounds. Its stored `format` is an unrelated era, as a real draft room's is. */
	const openRoom = (h: Harness, id = ROOM, members: FakeRoom['members'] = [...MEMBERS]) => {
		const room = h.lobby.open(id, members, 'draft', POWER_2010);
		room.pod = { phase: 'rounds' };
		return room;
	};
	const putDeck = (h: Harness, user: string, dck: string, id = ROOM) =>
		call(h, 'PUT', `/api/tables/rooms/${id}/deck`, { deck: { dck } }, edgeHeaders(user));
	const setReady = (h: Harness, user: string) =>
		call(h, 'POST', `/api/tables/rooms/${ROOM}/ready`, { ready: true }, edgeHeaders(user));

	/**
	 * THE test. Two people, one pod, one room, two decks from two different 45s,
	 * and a real match.
	 *
	 * The per-caller resolution is what this asserts, and it asserts it where it
	 * is load-bearing: the start is pressed by ALICE, so a start route that used
	 * the requester's context would check bob's deck against alice's pool. Every
	 * card of it would come back `plays 1x X but drafted 0` and the answer would
	 * be a 422 instead of a 201.
	 */
	it('starts a human match with each seat checked against its OWN drafted pool', async () => {
		const h = await boot();
		const pools = pod(h);
		openRoom(h);

		const mine = await putDeck(h, 'alice', built(pools.alice));
		expect(mine.status).toBe(200);
		const theirs = await putDeck(h, 'bob', built(pools.bob));
		expect(theirs.status).toBe(200);
		// Each verdict is taken in that player's OWN pool, and each says so in the
		// first person to its own owner.
		expect(myDeck(mine.body)).toMatchObject({ legal: true, rulesName: `your pool from ${POD}` });
		expect(myDeck(theirs.body)).toMatchObject({ legal: true, rulesName: `your pool from ${POD}` });
		// And the room says what pool it is on, without the client having to know
		// how a drafted pool id is spelled.
		expect(mine.body.room).toMatchObject({ format: draftPoolId(POD), draftId: POD });

		expect((await setReady(h, 'alice')).status).toBe(200);
		expect((await setReady(h, 'bob')).status).toBe(200);

		const res = await start(h, { room: ROOM }, '/api/play/matches', 'application/json', edgeHeaders('alice'));
		expect(res.status).toBe(201);
		const matchId = res.body.matchId as string;

		// Forge is launched with both drafted decks, each the text its own owner's
		// pool checked, byte for byte — and the seats are bound to their owners.
		expect(h.specs).toHaveLength(1);
		expect(h.specs[0]?.seats.map((s) => s.deck)).toEqual([built(pools.alice), built(pools.bob)]);
		expect(h.matches.get(matchId)?.seatOf(ALICE)).toBe(0);
		expect(h.matches.get(matchId)?.seatOf(BOB)).toBe(1);
	});

	/**
	 * A save stores an unfinished build (`drafts.ts`), so the table is the
	 * only place a short one is stopped: it loads, reads illegal, cannot be
	 * readied, and the start is refused with nothing launched.
	 */
	it('will not ready or start a drafted build under forty', async () => {
		const h = await boot();
		const pools = pod(h);
		openRoom(h);
		let deck = deckFromPool(POD, pools.alice);
		for (const card of pools.alice.slice(0, 24)) {
			const entry = deck.sideboard.find((e) => e.card.name === card.name && e.card.set === (card.setCode || null));
			if (entry !== undefined) deck = moveToMain(deck, entry.card, 1);
		}
		const short = dckTextOf(deck);

		const loaded = await putDeck(h, 'alice', short);
		expect(loaded.status).toBe(200);
		expect(myDeck(loaded.body)).toMatchObject({ legal: false, issueCount: 1 });
		const refused = await setReady(h, 'alice');
		expect(refused.status).toBe(422);
		expect(refused.body.error).toContain('maindeck has 24 cards, needs at least 40');

		await putDeck(h, 'bob', built(pools.bob));
		expect((await setReady(h, 'bob')).status).toBe(200);
		const res = await start(h, { room: ROOM }, '/api/play/matches', 'application/json', edgeHeaders('bob'));
		expect(res).toMatchObject({ status: 409, body: { error: 'user-alice is not ready yet' } });
		expect(h.specs).toEqual([]);
	});

	/**
	 * One drafter against Forge's AI, from a drafted room: the AI plays a deck
	 * built from the pool of the bot that drafted across the table from her —
	 * a drafted pool offers no library deck to fall back on.
	 */
	it("starts a drafted room against the AI with the deck of the bot across the table", async () => {
		const h = await boot();
		const pools = pod(h);
		const room = h.rooms.find(POD)!;
		const state = stateOf(room);
		const across = (state.table.seats.findIndex((s) => s.occupant?.kind === 'human' && s.occupant.participantId === ALICE) + 4) % 8;
		expect(isBotSeat(state, across)).toBe(true);
		state.pools[across] = state.queues.flat(2).slice(90, 135);
		openRoom(h);
		expect((await putDeck(h, 'alice', built(pools.alice))).status).toBe(200);

		const res = await start(h, { room: ROOM, bot: true }, '/api/play/matches', 'application/json', edgeHeaders('alice'));
		expect(res.status).toBe(201);
		expect(h.specs[0]?.seats.map((s) => s.deck)).toEqual([built(pools.alice), botDeckText(state.pools[across]!, 'Bot draft')]);
		expect(botPoolAcross(room, ALICE)).toEqual(state.pools[across]);
	});

	/** The Decks page reads a drafted deck's W–L by `draft:<podId>` (`http/decks.ts`). */
	it('reports a drafted deck under its pod, so its record follows it', async () => {
		const h = await boot();
		const pools = pod(h);
		const state = stateOf(h.rooms.find(POD)!);
		const across = (state.table.seats.findIndex((s) => s.occupant?.kind === 'human' && s.occupant.participantId === ALICE) + 4) % 8;
		state.pools[across] = state.queues.flat(2).slice(90, 135);
		openRoom(h);
		expect((await putDeck(h, 'alice', built(pools.alice))).status).toBe(200);
		const res = await start(h, { room: ROOM, bot: true }, '/api/play/matches', 'application/json', edgeHeaders('alice'));
		expect(res.status).toBe(201);
		const match = h.matches.get(res.body.matchId as string)!;
		(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: match.spec.seats[0].name });

		await vi.waitFor(() => expect(h.reports).toHaveLength(1));
		expect(h.reports[0]!.seats.map((s) => [s.kind, s.attrs?.deckId])).toEqual([
			['user', `draft:${POD}`],
			['bot', undefined],
		]);
	});

	it('reports no drafted game the server ended before Forge called it', async () => {
		const h = await boot();
		const pools = pod(h);
		const state = stateOf(h.rooms.find(POD)!);
		const across = (state.table.seats.findIndex((s) => s.occupant?.kind === 'human' && s.occupant.participantId === ALICE) + 4) % 8;
		state.pools[across] = state.queues.flat(2).slice(90, 135);
		openRoom(h);
		expect((await putDeck(h, 'alice', built(pools.alice))).status).toBe(200);
		const res = await start(h, { room: ROOM, bot: true }, '/api/play/matches', 'application/json', edgeHeaders('alice'));
		expect(res.status).toBe(201);
		const match = h.matches.get(res.body.matchId as string)!;
		match.stop();
		(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: match.spec.seats[0].name });
		await new Promise((r) => setTimeout(r, 50));
		expect(h.reports).toEqual([]);
		expect(h.lobby.room(ROOM)?.tables.flatMap((t) => t.series.games)).toEqual([]);
	});

	it('refuses a drafted room against the AI while no bot has drafted anything', async () => {
		const h = await boot();
		const pools = pod(h);
		openRoom(h);
		expect((await putDeck(h, 'alice', built(pools.alice))).status).toBe(200);
		const res = await start(h, { room: ROOM, bot: true }, '/api/play/matches', 'application/json', edgeHeaders('alice'));
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/AI has nothing to play/);
	});

	/**
	 * The same table, started by the OTHER player. Both directions, because "the
	 * room's drafted pool resolves to the leader's" and "…to the requester's" are
	 * two different wrong answers and only one of them is caught by starting as
	 * the leader. Alice is the leader here (`fakeLobby` makes the first member
	 * one), so bob pressing start is the case where the leader is neither the
	 * requester nor the owner of the seat being checked.
	 */
	it('starts the same table when the player who is NOT the leader presses start', async () => {
		const h = await boot();
		const pools = pod(h);
		const room = openRoom(h);
		expect(room.leader).toBe(ALICE);
		await putDeck(h, 'alice', built(pools.alice));
		await putDeck(h, 'bob', built(pools.bob));
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		const res = await start(h, { room: ROOM }, '/api/play/matches', 'application/json', edgeHeaders('bob'));
		expect(res.status).toBe(201);
		expect(h.specs[0]?.seats.map((s) => s.deck)).toEqual([built(pools.alice), built(pools.bob)]);
	});

	/**
	 * A player cannot load a deck from somebody else's drafted pool.
	 *
	 * Bob sends ALICE's deck — the exact text she loaded, which the server has
	 * just accepted from her — and it is refused for him, by name, because the
	 * pool his deck is checked against is HIS. There is no field in the body that
	 * could say otherwise: the pod comes from the room and the person comes from
	 * the edge headers.
	 *
	 * And the refusal is his own to read: alice's row shows him a count and the
	 * room's pool in the third person, never a card from her 45.
	 */
	it('refuses a deck built from the other player’s pool, and names the card to its owner only', async () => {
		const h = await boot();
		const pools = pod(h);
		openRoom(h);
		expect((await putDeck(h, 'alice', built(pools.alice))).status).toBe(200);

		const stolen = await putDeck(h, 'bob', built(pools.alice));
		expect(stolen.status).toBe(200);
		// Every card of it, because the two pools share none.
		expect(players(stolen.body)[1]).toMatchObject({ you: true, deck: { legal: false, issueCount: 45 } });
		// An illegal deck cannot be readied, so it can never reach a start — and
		// the refusal names the card, to HIM: it is his deck, and the cards in it
		// are the ones he sent.
		const refused = await setReady(h, 'bob');
		expect(refused.status).toBe(422);
		expect(refused.body.error).toContain(pools.alice[0]?.name);
		expect((await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('bob'))).status).toBe(409);
		expect(h.specs).toEqual([]);

		// What ALICE is told about bob's row: that he is not ready, and nothing of
		// his deck. (Her own row echoes her own choice back to her, which is what
		// restores her picker; the rule is about somebody ELSE's row.)
		const seen = await call(h, 'GET', `/api/tables/rooms/${ROOM}`, undefined, edgeHeaders('alice'));
		expect(players(seen.body)[1]).toEqual({ seat: 1, name: expect.any(String), you: false, ready: false });
	});

	/**
	 * The start refusal names the PLAYER and the pool, and never a card.
	 *
	 * Reached by swapping the two 45s in the pod under two loaded, readied decks —
	 * a state no real pod reaches, which is the point. The start does not trust
	 * the stored verdicts; it re-checks, once per player, in that player's own
	 * context, so after the swap each player's deck is made entirely of cards the
	 * other one now holds. Bob presses start, and what comes back names alice and
	 * the pool with not one of her cards in it — which is the whole privacy rule,
	 * and a drafted pool IS the hidden information.
	 */
	it('refuses a start naming the player and the pool, never a card', async () => {
		const h = await boot();
		const pools = pod(h);
		openRoom(h);
		await putDeck(h, 'alice', built(pools.alice));
		await putDeck(h, 'bob', built(pools.bob));
		await setReady(h, 'alice');
		await setReady(h, 'bob');

		const state = stateOf(h.rooms.find(POD)!);
		const seatA = state.pools.indexOf(pools.alice);
		const seatB = state.pools.indexOf(pools.bob);
		state.pools[seatA] = pools.bob;
		state.pools[seatB] = pools.alice;

		const refused = await call(h, 'POST', '/api/play/matches', { room: ROOM }, edgeHeaders('bob'));
		expect(refused.status).toBe(422);
		expect(refused.body.error).toBe(`user-alice's deck is not legal in their own pool from ${POD}`);
		for (const card of pools.alice.slice(0, 5)) {
			expect(JSON.stringify(refused.body)).not.toContain(card.name);
		}
		expect(refused.body.verdict).toBeUndefined();
		expect(refused.body.issues).toBeUndefined();
		expect(h.specs).toEqual([]);

		// Each 45 back with the drafter who built from it: the same two holds start.
		state.pools[seatA] = pools.alice;
		state.pools[seatB] = pools.bob;
		expect((await start(h, { room: ROOM }, '/api/play/matches', 'application/json', edgeHeaders('bob'))).status).toBe(201);
	});

	/** A member of the room who never drafted is told so, in the first person. */
	it('tells a member with no seat in the pod that they have none', async () => {
		const h = await boot();
		const pools = pod(h);
		openRoom(h, ROOM, [...MEMBERS, { id: CAROL, name: 'user-carol' }]);
		const res = await putDeck(h, 'carol', built(pools.alice));
		expect(res).toMatchObject({ status: 400, body: { error: `you have no seat in draft ${JSON.stringify(POD)}` } });
	});

	/**
	 * A pod this server does not have is a 409 about the ROOM, the same shape a
	 * missing frozen pool gets.
	 */
	it('answers 409 for a room whose pod this server does not have', async () => {
		const h = await boot();
		const pools = pod(h);
		// A real drafted deck, and a draft room in its rounds whose pod was never opened.
		openRoom(h, 'r-no-such-pod');
		expect(await putDeck(h, 'alice', built(pools.alice), 'r-no-such-pod')).toMatchObject({
			status: 409,
			body: { error: 'this room\'s draft "r-no-such-pod" is not one this server has' },
		});
		expect(h.specs).toEqual([]);
	});

	/**
	 * The operator, 2026-10-20: a drafted deck is picked on Free pick → My decks, never by
	 * putting a room on its pod — so the catalog offers no pod, even to someone who drafted.
	 */
	it('offers no pod as a pool, even to a drafter', async () => {
		const h = await boot();
		pod(h);
		const seen = await call(h, 'GET', '/api/tables/formats', undefined, edgeHeaders('alice'));
		const formats = seen.body.formats as { id: string; source: string }[];
		expect(formats.filter((f) => f.source === 'draft' || f.id.startsWith('draft:'))).toEqual([]);
		expect(formats.at(-1)?.id).toBe(library.formats.at(-1)?.id);
	});

	/**
	 * Wave 71 §D bullet 3's own carve-out: "Basics are free when the room's
	 * pool is `draft:*`." A drafted pool's deck editor already treats basics
	 * as free and unlimited at build time; `sideboardIssue` (`routes.ts`)
	 * excludes them from the multiset comparison for exactly the same reason,
	 * so adding or removing them during `sideboarding` is never a refusal —
	 * but swapping in a card that was never drafted (not a basic) still is.
	 */
	it('sideboarding on a drafted pool: adding or removing basics is accepted; a non-basic never drafted is refused', async () => {
		const h = await boot();
		const pools = pod(h);
		openRoom(h);
		const baseline = built(pools.alice);
		await putDeck(h, 'alice', baseline);
		await putDeck(h, 'bob', built(pools.bob));
		await setReady(h, 'alice');
		await setReady(h, 'bob');

		// As if game 1 of the series just ended: `sideboarding`, with alice's
		// baseline the deck she just played.
		h.lobby.room(ROOM)!.tables[0]!.series.phase = 'sideboarding';
		const aliceState = h.lobby.playerState(ROOM, ALICE) as Record<string, unknown>;
		h.lobby.setPlayerState(ROOM, ALICE, { ...aliceState, seriesDeck: baseline });

		// Basics added to the maindeck: accepted.
		const withBasics = baseline.replace('[Main]\n', '[Main]\n4 Plains\n');
		expect((await putDeck(h, 'alice', withBasics)).status).toBe(200);
		// And removed again (back to the baseline, with no basics at all): still accepted.
		expect((await putDeck(h, 'alice', baseline)).status).toBe(200);

		// A card from BOB's half of the pod — by the cube's singleton property
		// (asserted in `pod()`), one alice never drafted — swapped in for a main
		// card: refused, because it is not a basic and changes the pool.
		let deck = deckFromPool(POD, pools.alice);
		for (const card of pools.alice.slice(0, 40)) {
			const entry = deck.sideboard.find((e) => e.card.name === card.name && e.card.set === (card.setCode || null));
			if (entry !== undefined) deck = moveToMain(deck, entry.card, 1);
		}
		const foreignEntry = deckFromPool(POD, [pools.bob[0]!]).sideboard[0]!;
		deck = { ...deck, main: [...deck.main.slice(1), foreignEntry] };
		const refused = await putDeck(h, 'alice', dckTextOf(deck));
		expect(refused.status).toBe(409);
		expect(refused.body.error).toContain('sideboard');
	});

	/* ── wave 72 §P: a draft room's own POD table ──────────────────────── */

	const PODTABLE = 'r-pod-table';

	/**
	 * The REAL bug this proves fixed: before `effectivePoolOf`, every table
	 * route read `room.format` straight — correct for a constructed room, but
	 * a `draft` room's `format` is whatever random era it opened on and was
	 * never pointed at its own pod (no table route ever reached one before
	 * this wave). A pod's own table plays the pod everyone there drafted,
	 * `room.id` IS that pod's id, and `room.format` here is deliberately an
	 * UNRELATED frozen era — if any route still read it raw, the deck check,
	 * the start, or the spec Forge gets would all be wrong.
	 */
	it("plays the room's OWN pod on its table, never room.format, once the pod is in `rounds`", async () => {
		const h = await boot();
		// The pod's draft id IS the room id (wave 23's "one door, one id") —
		// `effectivePoolOf` relies on exactly this, so the fixture has to too.
		const pools = pod(h, PODTABLE);
		h.lobby.open(PODTABLE, [...MEMBERS], 'draft', POWER_2010);
		const room = h.lobby.room(PODTABLE)!;
		room.pod = { phase: 'rounds' };

		const putPodDeck = (user: string, dck: string) =>
			call(h, 'PUT', `/api/tables/rooms/${PODTABLE}/deck`, { deck: { dck } }, edgeHeaders(user));
		const setPodReady = (user: string) =>
			call(h, 'POST', `/api/tables/rooms/${PODTABLE}/ready`, { ready: true }, edgeHeaders(user));

		const mine = await putPodDeck('alice', built(pools.alice, PODTABLE));
		expect(mine.status).toBe(200);
		// The table's own pool is the POD (= the room's own id), not the room's
		// unrelated `format`.
		expect(mine.body.room).toMatchObject({ format: draftPoolId(PODTABLE), draftId: PODTABLE });
		expect(myDeck(mine.body)).toMatchObject({ legal: true, rulesName: `your pool from ${PODTABLE}` });
		const theirs = await putPodDeck('bob', built(pools.bob, PODTABLE));
		expect(theirs.status).toBe(200);

		expect((await setPodReady('alice')).status).toBe(200);
		expect((await setPodReady('bob')).status).toBe(200);

		const res = await start(h, { room: PODTABLE }, '/api/play/matches', 'application/json', edgeHeaders('alice'));
		expect(res.status).toBe(201);
		// Forge is launched against the POD, with both drafted decks.
		expect(h.specs.at(-1)?.format).toBe(draftPoolId(PODTABLE));
		expect(h.specs.at(-1)?.seats.map((s) => s.deck)).toEqual([built(pools.alice, PODTABLE), built(pools.bob, PODTABLE)]);

		// Reverted (read `room.format` instead of `effectivePoolOf(room)` in
		// `tablePoolOf`/`unknownPool`): the PUT above 409s ("this room's format
		// ... is not one this server has" — `${POWER_2010}` names no pod) and
		// nothing past it runs. 1 failed. Restored: passes, 201. 1 passed.
	});

	it('starts no new series at a pod table whose series is over — the pod, not a Rematch, decides the next game', async () => {
		const h = await boot();
		h.lobby.open(PODTABLE, [...MEMBERS], 'draft', POWER_2010);
		const room = h.lobby.room(PODTABLE)!;
		room.pod = { phase: 'done' };
		room.tables[0]!.series.phase = 'done';
		for (const body of [{ room: PODTABLE }, { room: PODTABLE, bot: true }]) {
			const res = await start(h, body, '/api/play/matches', 'application/json', edgeHeaders('alice'));
			expect(res.status).toBe(409);
			expect(res.body.error).toBe('this series is over — the standings are in the room');
		}
		expect(h.specs).toHaveLength(0);
	});

	it('refuses a table WRITE the same as before while the pod has no tables yet', async () => {
		const h = await boot();
		h.lobby.open(PODTABLE, [...MEMBERS], 'draft', POWER_2010);
		const room = h.lobby.room(PODTABLE)!;
		// `done` keeps its tables, for their history; a finished series there starts nothing (below).
		for (const phase of ['lobby', 'drafting', 'building'] as const) {
			room.pod = { phase };
			const res = await call(h, 'PUT', `/api/tables/rooms/${PODTABLE}/deck`, { deck: { dck: 'anything' } }, edgeHeaders('alice'));
			expect(res.status).toBe(409);
			expect(res.body.error).toContain('not constructed-1v1 or a pod at its tables');
		}
	});
});

/**
 * All Random (ruling 3 and 4): the server deals both seats two different decks
 * from one random era of the room's pool, and the table goes straight into the
 * match with no picking and no reveal. A Rematch plays the same two decks.
 */
describe('an All Random table', () => {
	const ROOM = 'r-random';
	const room = (h: Harness, members: FakeRoom['members'], pool: 'full' | 'standard' | 'modern' | 'legacy' = 'modern', lock = false) =>
		Object.assign(h.lobby.open(ROOM, members), { mode: 'random' as const, modeOptions: lock ? { pool, lock } : { pool } });
	const sit = (h: Harness, user: string) => call(h, 'POST', `/api/tables/rooms/${ROOM}/sit`, {}, edgeHeaders(user));
	const setReady = (h: Harness, user: string) => call(h, 'POST', `/api/tables/rooms/${ROOM}/ready`, { ready: true }, edgeHeaders(user));
	const myDeck = (body: Record<string, unknown>) => (body.players as { you: boolean; deck?: { name: string } | null }[]).find((p) => p.you)?.deck;
	const libraryIdOf = (text: string | null | undefined) => library.decks.find((d) => d.text === text)?.id;
	async function startNext(h: Harness, body: Record<string, unknown>, user = 'alice') {
		const before = h.hosts.length;
		const pending = call(h, 'POST', '/api/play/matches', body, edgeHeaders(user));
		await untilHost(h, before + 1, pending);
		if (h.hosts.length > before) (h.hosts.at(-1) as ReplayHost).push(...OPENING);
		return pending;
	}
	/** The two decks a spec dealt, as library ids, and the era they share. */
	function dealt(spec: MatchSpec | undefined): { ids: string[]; eras: string[] } {
		const ids = (spec?.seats ?? []).map((s) => libraryIdOf(s.deck) ?? '?');
		return { ids, eras: ids.map((id) => library.deck(id)?.era ?? '?') };
	}

	it('deals two seated players two different decks of one Modern era once both are ready, and starts with them', async () => {
		const h = await boot();
		room(h, [
			{ id: ALICE, name: 'user-alice' },
			{ id: BOB, name: 'user-bob' },
		]);
		expect((await sit(h, 'alice')).status).toBe(200);
		expect((await sit(h, 'bob')).status).toBe(200);
		const first = await setReady(h, 'alice');
		expect(first.status, 'a seat readies with no deck: the server deals').toBe(200);
		expect(myDeck(first.body), 'nothing is dealt until both are ready').toBeNull();
		const second = await setReady(h, 'bob');
		expect(second.status).toBe(200);
		// The operator, 2026-10-22: "we should not display the name of the chosen deck until after the game has concluded".
		expect(myDeck(second.body), 'dealt, and not named before it is played').toBeNull();

		expect((await startNext(h, { room: ROOM })).status).toBe(201);
		const during = await call(h, 'GET', `/api/tables/rooms/${ROOM}`, undefined, edgeHeaders('bob'));
		expect(myDeck(during.body as Record<string, unknown>), 'not named while the game runs').toBeNull();
		(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: 'user-bob' });
		await call(h, 'GET', `/api/tables/rooms/${ROOM}`, undefined, edgeHeaders('alice'));
		const after = await call(h, 'GET', `/api/tables/rooms/${ROOM}`, undefined, edgeHeaders('bob'));
		expect(myDeck(after.body as Record<string, unknown>)?.name, 'named back in the room after the game').toEqual(expect.any(String));
		const { ids, eras } = dealt(h.specs[0]);
		expect(ids).not.toContain('?');
		expect(ids[0]).not.toBe(ids[1]);
		expect(eras[0]).toBe(eras[1]);
		expect(library.format(eras[0]!)?.family).toBe('modern');
		expect(h.specs[0]?.format, "the match is dealt in the decks' own era").toBe(eras[0]);
	});

	it('refuses a picked deck: the server deals', async () => {
		const h = await boot();
		room(h, [{ id: ALICE, name: 'user-alice' }]);
		const res = await call(h, 'PUT', `/api/tables/rooms/${ROOM}/deck`, { deck: { library: UG_POLYMORPH } }, edgeHeaders('alice'));
		expect(res.status).toBe(409);
	});

	// The operator, 2026-10-22: "i notice it doesn't pick a new deck when a new game starts. i would not expect it to lock the deck by default".
	it('deals a new series fresh unless the room locks its decks: a start from the room after a finished game deals again, and the new deal is unnamed', async () => {
		const h = await boot();
		room(h, [{ id: ALICE, name: 'user-alice' }], 'legacy');
		expect((await sit(h, 'alice')).status).toBe(200);
		expect((await startNext(h, { room: ROOM, bot: true })).status).toBe(201);
		(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: 'user-alice' });
		const back = await call(h, 'GET', `/api/tables/rooms/${ROOM}`, undefined, edgeHeaders('alice'));
		const played = myDeck(back.body as Record<string, unknown>)?.name;
		expect(played, 'game 1’s deck, named after it').toEqual(expect.any(String));
		expect((await startNext(h, { room: ROOM, bot: true })).status).toBe(201);
		expect(h.specs).toHaveLength(2);
		const during = await call(h, 'GET', `/api/tables/rooms/${ROOM}`, undefined, edgeHeaders('alice'));
		expect(myDeck(during.body as Record<string, unknown>), 'game 2 was dealt again: unnamed until it is over').toBeNull();
	});

	// The operator, 2026-10-23: "if rematch is clicked we go to sideboarding then the next game with the same deck.
	// re-randomize should only be considered when back in the lobby and a game is not inprogres anymore".
	it('against the AI, a Rematch sideboards and plays the same two decks, with the decks not locked', async () => {
		const h = await boot();
		room(h, [{ id: ALICE, name: 'user-alice' }], 'legacy');
		expect((await sit(h, 'alice')).status).toBe(200);
		expect((await startNext(h, { room: ROOM, bot: true })).status).toBe(201);
		const game1 = dealt(h.specs[0]).ids;
		(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: 'user-alice' });
		await call(h, 'GET', `/api/tables/rooms/${ROOM}`, undefined, edgeHeaders('alice'));
		// The result screen's Rematch: a Ready converts the Bo1, then the sideboard step's Ready starts the next game.
		await setReady(h, 'alice');
		expect(h.lobby.room(ROOM)?.tables[0]?.series).toMatchObject({ length: 3, phase: 'sideboarding' });
		await setReady(h, 'alice');
		expect((await startNext(h, { room: ROOM, bot: true })).status).toBe(201);
		expect(dealt(h.specs[1]).ids, 'game 2 of the series keeps both decks').toEqual(game1);
	});

	it('between two players, a Rematch keeps both decks through the Bo3, and the room deals again once it is over', async () => {
		const h = await boot();
		room(h, [
			{ id: ALICE, name: 'user-alice' },
			{ id: BOB, name: 'user-bob' },
		]);
		await sit(h, 'alice');
		await sit(h, 'bob');
		const bothReady = async () => {
			await setReady(h, 'alice');
			await setReady(h, 'bob');
		};
		await bothReady();
		expect((await startNext(h, { room: ROOM })).status).toBe(201);
		const game1 = dealt(h.specs[0]).ids;
		(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: 'user-bob' });
		await call(h, 'GET', `/api/tables/rooms/${ROOM}`, undefined, edgeHeaders('alice'));
		await bothReady();
		expect(h.lobby.room(ROOM)?.tables[0]?.series).toMatchObject({ length: 3, wins: [0, 1], phase: 'sideboarding' });
		await bothReady();
		expect((await startNext(h, { room: ROOM })).status).toBe(201);
		expect(dealt(h.specs[1]).ids, 'game 2 keeps both decks').toEqual(game1);
		(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: 'user-alice' });
		await call(h, 'GET', `/api/tables/rooms/${ROOM}`, undefined, edgeHeaders('alice'));
		expect(h.lobby.room(ROOM)?.tables[0]?.series).toMatchObject({ wins: [1, 1], phase: 'sideboarding' });
		await bothReady();
		expect((await startNext(h, { room: ROOM })).status).toBe(201);
		expect(dealt(h.specs[2]).ids, 'game 3 keeps both decks').toEqual(game1);
		(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: 'user-bob' });
		await call(h, 'GET', `/api/tables/rooms/${ROOM}`, undefined, edgeHeaders('alice'));
		expect(h.lobby.room(ROOM)?.tables[0]?.series).toMatchObject({ wins: [1, 2], phase: 'done' });
		// The series is over: the next Ready in the room starts a new one, and deals it.
		await bothReady();
		const next = await call(h, 'GET', `/api/tables/rooms/${ROOM}`, undefined, edgeHeaders('alice'));
		expect(myDeck(next.body as Record<string, unknown>), 'a new deal, unnamed until it is played').toBeNull();
	});

	// The operator, 2026-10-23: "if rematch is clicked we go to sideboarding then the next game with the same deck".
	it('a Rematch of a decided Bo3 keeps both decks into the next series: the press says it is a Rematch', async () => {
		const h = await boot();
		room(h, [
			{ id: ALICE, name: 'user-alice' },
			{ id: BOB, name: 'user-bob' },
		]);
		await sit(h, 'alice');
		await sit(h, 'bob');
		const bothReady = async (body: Record<string, unknown> = {}) => {
			for (const user of ['alice', 'bob']) await call(h, 'POST', `/api/tables/rooms/${ROOM}/ready`, { ready: true, ...body }, edgeHeaders(user));
		};
		const game = async (winner: string) => {
			expect((await startNext(h, { room: ROOM })).status).toBe(201);
			(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner });
			await call(h, 'GET', `/api/tables/rooms/${ROOM}`, undefined, edgeHeaders('alice'));
		};
		await bothReady();
		await game('user-bob');
		const game1 = dealt(h.specs[0]).ids;
		await bothReady({ rematch: true });
		await bothReady();
		await game('user-bob');
		expect(h.lobby.room(ROOM)?.tables[0]?.series).toMatchObject({ wins: [0, 2], phase: 'done' });
		await bothReady({ rematch: true });
		expect((await startNext(h, { room: ROOM })).status).toBe(201);
		expect(dealt(h.specs[2]).ids, 'the Rematch plays the same two decks').toEqual(game1);
	});

	it('against the AI, a Rematch of a decided Bo3 keeps both decks', async () => {
		const h = await boot();
		room(h, [{ id: ALICE, name: 'user-alice' }], 'legacy');
		expect((await sit(h, 'alice')).status).toBe(200);
		const lose = async (body: Record<string, unknown>) => {
			expect((await startNext(h, { room: ROOM, bot: true, ...body })).status).toBe(201);
			(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: h.specs.at(-1)!.seats[1]!.name });
			await call(h, 'GET', `/api/tables/rooms/${ROOM}`, undefined, edgeHeaders('alice'));
		};
		await lose({});
		const game1 = dealt(h.specs[0]).ids;
		await call(h, 'POST', `/api/tables/rooms/${ROOM}/ready`, { ready: true, rematch: true }, edgeHeaders('alice'));
		await setReady(h, 'alice');
		await lose({});
		expect(h.lobby.room(ROOM)?.tables[0]?.series).toMatchObject({ length: 3, phase: 'done' });
		await call(h, 'POST', `/api/tables/rooms/${ROOM}/ready`, { ready: true, rematch: true }, edgeHeaders('alice'));
		await lose({ rematch: true });
		expect(dealt(h.specs[2]).ids, 'the Rematch plays the same two decks').toEqual(game1);
	});

	it('against the AI with the decks locked: two different decks of one era, and a Rematch plays the same two', async () => {
		const h = await boot();
		room(h, [{ id: ALICE, name: 'user-alice' }], 'legacy', true);
		expect((await sit(h, 'alice')).status).toBe(200);
		expect((await startNext(h, { room: ROOM, bot: true })).status).toBe(201);
		const game1 = dealt(h.specs[0]);
		expect(game1.ids).not.toContain('?');
		expect(game1.ids[0]).not.toBe(game1.ids[1]);
		expect(game1.eras[0]).toBe(game1.eras[1]);
		expect(library.format(game1.eras[0]!)?.family).toBe('legacy');
		expect(h.specs[0]?.format).toBe(game1.eras[0]);

		(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: 'user-alice' });
		await call(h, 'GET', `/api/tables/rooms/${ROOM}`, undefined, edgeHeaders('alice'));
		expect((await startNext(h, { room: ROOM, bot: true })).status).toBe(201);
		expect(dealt(h.specs[1]).ids, 'the Rematch keeps both decks').toEqual(game1.ids);
	});

	it('a Rematch between two players with the decks locked converts the Bo1 and keeps both decks', async () => {
		const h = await boot();
		room(
			h,
			[
				{ id: ALICE, name: 'user-alice' },
				{ id: BOB, name: 'user-bob' },
			],
			'full',
			true,
		);
		await sit(h, 'alice');
		await sit(h, 'bob');
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		expect((await startNext(h, { room: ROOM })).status).toBe(201);
		const game1 = dealt(h.specs[0]).ids;
		(h.hosts.at(-1) as ReplayHost).push({ t: 'gameover', winner: 'user-bob' });
		await call(h, 'GET', `/api/tables/rooms/${ROOM}`, undefined, edgeHeaders('alice'));
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		expect(h.lobby.room(ROOM)?.tables[0]?.series).toMatchObject({ length: 3, wins: [0, 1], phase: 'sideboarding' });
		await setReady(h, 'alice');
		await setReady(h, 'bob');
		expect((await startNext(h, { room: ROOM })).status).toBe(201);
		expect(dealt(h.specs[1]).ids).toEqual(game1);
	});
});

/**
 * A Gauntlet's games are dealt to its table the way an All Random table's are:
 * the two chosen decks held in the seats, checked in the Gauntlet's own era
 * (the table's pool, never the room's), the AI's beside its human's.
 */
describe('a Gauntlet table', () => {
	const ROOM = 'r-gauntlet';

	/** A Gauntlet against the AI at its first choice, the AI's choice made, built with the state machine itself. */
	function atChoice(): GauntletState {
		const eras = gauntletEras(library.formats, library.decks).filter((e) => e.family === 'modern');
		const drawn = drawGauntlet(newGauntlet(), {
			players: [
				{ memberId: ALICE, name: 'user-alice' },
				{ memberId: null, name: 'Sage' },
			],
			eras,
			options: {},
			random: () => 0.3,
			now: 0,
		});
		if (!drawn.ok) throw new Error(drawn.reason);
		let g = startBanpick(drawn.state);
		const stub = (id: string) => ({ id, name: id, archetype: id, pilot: '', colors: [], main: [], sideboard: [] });
		while (g.phase === 'banpick') {
			const step = viewOfGauntlet(g, null, [false, false], stub).step!;
			const out = act(g, step.seat, step.act, g.decks.find((_, i) => g.marks[i] === null)!);
			if (!out.ok) throw new Error(out.reason);
			g = out.state;
		}
		const aiPick = g.decks.find((_, i) => g.marks[i]?.act === 'pick' && g.marks[i]?.by === 1)!;
		const chose = choose(g, 1, aiPick);
		if (!chose.ok) throw new Error(chose.reason);
		return chose.state;
	}

	it("deals the chosen decks in the Gauntlet's era at the table, leaves the room's pool alone, and the AI plays its own choice", async () => {
		const h = await boot();
		const room = Object.assign(h.lobby.open(ROOM, [{ id: ALICE, name: 'user-alice' }]), { mode: 'gauntlet' as const, modeOptions: { family: 'modern' as const } });
		expect((await call(h, 'POST', `/api/tables/rooms/${ROOM}/sit`, {}, edgeHeaders('alice'))).status).toBe(200);
		const g = atChoice();
		h.lobby.setGauntlet!(ROOM, g);
		const mine = g.decks.find((_, i) => g.marks[i]?.act === 'pick' && g.marks[i]?.by === 0)!;
		const aiDeck = g.choices[1]!;

		const picked = await call(h, 'PUT', `/api/tables/rooms/${ROOM}/deck`, { deck: { library: mine } }, edgeHeaders('alice'));
		expect(picked.status, 'a Gauntlet deals its decks').toBe(409);
		const chosen = await call(h, 'POST', `/api/tables/rooms/${ROOM}/gauntlet/choose`, { deck: mine }, edgeHeaders('alice'));
		expect(chosen.status).toBe(200);
		expect(chosen.body.phase).toBe('playing');

		const pending = call(h, 'POST', '/api/play/matches', { room: ROOM, bot: true }, edgeHeaders('alice'));
		await untilHost(h, 1, pending);
		(h.hosts.at(-1) as ReplayHost | undefined)?.push(...OPENING);
		expect((await pending).status).toBe(201);
		const spec = h.specs[0]!;
		expect(spec.seats.map((s) => s.deck)).toEqual([library.deck(mine)!.text, library.deck(aiDeck)!.text]);
		expect(spec.format, "the match plays the Gauntlet's era").toBe(g.era!.id);
		expect(room.format, "the room's own pool is untouched").toBe(POWER_2010);
	});

	/**
	 * The operator, 2026-10-28 (overturning 2026-10-26's "Gauntlet flips a coin for every game"): "follow
	 * the normal Bo3 rules for winner/loser and choosing" — the loser of a Gauntlet game chooses play or
	 * draw for the next, as in any Bo3. Production `r-ae1712d0df3d`: alice lost game 1 to the AI and game 2
	 * flipped a coin.
	 */
	it('asks the previous game’s loser play-or-draw, as any Bo3 does', async () => {
		const h = await boot();
		const room = Object.assign(h.lobby.open(ROOM, [{ id: ALICE, name: 'user-alice' }]), { mode: 'gauntlet' as const, modeOptions: { family: 'modern' as const } });
		expect((await call(h, 'POST', `/api/tables/rooms/${ROOM}/sit`, {}, edgeHeaders('alice'))).status).toBe(200);
		const g = atChoice();
		h.lobby.setGauntlet!(ROOM, g);
		const mine = g.decks.find((_, i) => g.marks[i]?.act === 'pick' && g.marks[i]?.by === 0)!;
		const chosen = await call(h, 'POST', `/api/tables/rooms/${ROOM}/gauntlet/choose`, { deck: mine }, edgeHeaders('alice'));
		expect(chosen.status).toBe(200);
		expect(chosen.body.phase, 'the deal landed: this is a real game to start, deck and all').toBe('playing');

		// A previous game's own record — exactly the shape `recordGameResult`
		// leaves on `table.series` once Bo3-sized `between` machinery records a
		// game (never `seating`/`done`, so `newSeries` reads false): the AI (seat
		// 1) won it.
		room.tables[0]!.series = { ...room.tables[0]!.series, phase: 'between', games: [{ matchId: 'm-gauntlet-game1', winner: 1 }] };

		const pending = call(h, 'POST', '/api/play/matches', { room: ROOM, bot: true }, edgeHeaders('alice'));
		await untilHost(h, 1, pending);
		(h.hosts.at(-1) as ReplayHost | undefined)?.push(...OPENING);
		expect((await pending).status).toBe(201);
		expect(h.specs[0]!.chooser, 'alice lost game 1, so she chooses').toBe(0);
	});

	/** Ruling 13.4: a drawn Gauntlet holds the table until it is decided, and then the room is free again. */
	it('locks the table from the draw until the Gauntlet is decided; then the seat stands, and a Ready draws a new Gauntlet', async () => {
		const h = await boot();
		const room = Object.assign(h.lobby.open(ROOM, [{ id: ALICE, name: 'user-alice' }]), { mode: 'gauntlet' as const, modeOptions: { family: 'modern' as const } });
		expect((await call(h, 'POST', `/api/tables/rooms/${ROOM}/sit`, {}, edgeHeaders('alice'))).status).toBe(200);
		const g = atChoice();
		h.lobby.setGauntlet!(ROOM, g);
		const locked = async () => ((await call(h, 'GET', `/api/tables/rooms/${ROOM}`, undefined, edgeHeaders('alice'))).body.room as { locked: boolean }).locked;
		const stand = () => call(h, 'POST', `/api/tables/rooms/${ROOM}/stand`, {}, edgeHeaders('alice'));

		expect(await locked(), 'a drawn Gauntlet locks the table').toBe(true);
		expect(await stand()).toMatchObject({ status: 409 });

		const mine = g.decks.find((_, i) => g.marks[i]?.act === 'pick' && g.marks[i]?.by === 0)!;
		const playing = choose(g, 0, mine);
		if (!playing.ok) throw new Error(playing.reason);
		const done = gameOver(playing.state, { seriesOver: true, winner: 1 });
		if (!done.ok) throw new Error(done.reason);
		h.lobby.setGauntlet!(ROOM, done.state);
		room.tables[0]!.series = { ...room.tables[0]!.series, phase: 'done' };

		expect(await locked(), 'a decided Gauntlet leaves the table unlocked').toBe(false);
		const again = await call(h, 'POST', `/api/tables/rooms/${ROOM}/gauntlet/ready`, { ready: true, ai: true }, edgeHeaders('alice'));
		expect(again.status, JSON.stringify(again.body)).toBe(200);
		expect(again.body.phase, 'a Ready after the result draws a new Gauntlet').toBe('reveal');
		expect(again.body.games).toEqual([]);

		h.lobby.setGauntlet!(ROOM, done.state);
		const stood = await stand();
		expect(stood.status, JSON.stringify(stood.body)).toBe(200);
		expect((await call(h, 'GET', `/api/tables/rooms/${ROOM}`, undefined, edgeHeaders('alice'))).body.players).toEqual([]);
	});
});


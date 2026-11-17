/**
 * The lobby core with no Magic in it: the toy game (`play/fixtures/toy-game/`) registers a room type of
 * its own, with its own `game` blob, and a room of it is made, joined, seated, readied, watched, left,
 * saved, restored on a fresh lobby and swept through the platform alone. Nothing here imports a game's
 * lobby; the ratchet keeps it that way (`scripts/layers/`).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FileRoomStore } from '@wolffm/rooms-server/store';

import { WIN_SCORE } from '../play/fixtures/toy-game/rules.ts';
import { RoomLobby, type PlatformRoomView, type RoomCreateInput, type RoomTypeHooks } from './lobby.ts';
import { NO_BUSY_HOOK } from './room-list.ts';

const TOY = 'toy';

/** The toy's own part of a room: the score a match plays to, and how many matches the room has played. */
interface ToyRoomGame {
	target: number;
	played: number;
}

type ToyInput = RoomCreateInput & { target?: number };

function isToyGame(v: unknown): v is ToyRoomGame {
	return typeof v === 'object' && v !== null && typeof (v as ToyRoomGame).target === 'number' && typeof (v as ToyRoomGame).played === 'number';
}

/** Two seats, a Ready that only a seated member gives, and its own blob on disk. */
const TOY_ROOM: RoomTypeHooks<ToyRoomGame, ToyInput> = {
	newGame: (input) => ({ seats: [null, null], game: { target: input.target ?? WIN_SCORE, played: 0 } }),
	encode: (room) => ({ ...room.game }),
	decode(app) {
		if (!isToyGame(app.game)) throw new Error('app.game is invalid');
		if (!Array.isArray(app.seats) || app.seats.length !== 2) throw new Error('app.seats is invalid');
		return { seats: [...(app.seats as (string | null)[])], game: { ...app.game } };
	},
	restore: (app) => ({ dropHolds: false, game: () => ({ ...(app.game as ToyRoomGame) }) }),
	view: (room) => ({ game: { ...room.game } }),
	busy: NO_BUSY_HOOK,
	liveMatches: () => [],
	ready: (room, memberId, ready) => (ready && !room.seats.includes(memberId) ? 'keep' : undefined),
	usesSeats: () => true,
	seatsFixed: () => false,
	seatCeiling: () => 2,
	growSeats: () => {},
	trimSeats: () => {},
};

type ToyView = PlatformRoomView & { game: ToyRoomGame };

/** Same toy, but up to four seats — big enough to prove the leader's atomic seat ops (wave 119 §S). */
const TOY4 = 'toy4';
const TOY4_ROOM: RoomTypeHooks<ToyRoomGame, ToyInput> = {
	...TOY_ROOM,
	seatCeiling: () => 4,
	growSeats(room, seat) {
		while (room.seats.length <= seat) room.seats = [...room.seats, null];
	},
	trimSeats(room) {
		while (room.seats.length > 2 && room.seats.at(-1) === null) room.seats = room.seats.slice(0, -1);
	},
	// The default `memberSeats` reads any non-member string (the AI marker, a closed seat's) as
	// open, which is right for a room that never shows them apart — this one wants its view to
	// carry the markers verbatim, the way a real caller who needs to tell "AI"/"closed" from
	// "open" in the generic view (not a game-specific field, as Magic's `podAi` does) would.
	seatsView: (room) => [...room.seats],
};

/**
 * A room type whose own game seats are never used (`usesSeats: () => false`, same as a classic 1v1
 * room's) — its two players sit at ONE table of its own, `game.table`, auto-seated there on arrival.
 * Stands in for a real classic room's `RoomTable` (`games/magic/server/src/room/lobby.ts`'s
 * `extraSeatTarget`) so the leader's remove and lower-capacity are proved against the FALLBACK path
 * generically, with no Magic in this file (wave 120 §S2).
 */
const TOY_TABLE = 'toy-table';
interface ToyTableGame extends ToyRoomGame {
	table: (string | null)[];
}
function isToyTableGame(v: unknown): v is ToyTableGame {
	return isToyGame(v) && Array.isArray((v as ToyTableGame).table);
}
const TOY_TABLE_ROOM: RoomTypeHooks<ToyTableGame, ToyInput> = {
	newGame: (input) => ({ seats: [], game: { target: input.target ?? WIN_SCORE, played: 0, table: [null, null] } }),
	encode: (room) => ({ ...room.game, table: [...room.game.table] }),
	decode(app) {
		if (!isToyTableGame(app.game)) throw new Error('app.game is invalid');
		return { seats: [], game: { ...app.game, table: [...app.game.table] } };
	},
	restore: (app) => ({ dropHolds: false, game: () => ({ ...(app.game as ToyTableGame), table: [...(app.game as ToyTableGame).table] }) }),
	view: (room) => ({ game: { ...room.game, table: [...room.game.table] } }),
	busy: NO_BUSY_HOOK,
	liveMatches: () => [],
	// Nobody waits unseated: the table's own two players ARE the room's players (default `playersOf` would read `room.seats`, always empty for this type).
	players: (room) => room.game.table.filter((s): s is string => s !== null),
	autoSeat: (room, memberId) => {
		const open = room.game.table.indexOf(null);
		if (open === -1) return false;
		room.game.table = room.game.table.map((s, i) => (i === open ? memberId : s));
		return true;
	},
	usesSeats: () => false,
	seatsFixed: () => false,
	seatCeiling: () => 0,
	growSeats: () => {},
	trimSeats: () => {},
	extraSeatTarget: (room) => ({
		read: () => [...room.game.table],
		write: (seats) => {
			room.game.table = seats;
		},
		// Stands in for a classic 1v1 room's own table: no AI-occupies-a-seat idea at all.
		supportsBot: false,
	}),
};

const ALICE = { id: 'fk:aaaaaaaaaaaaaaaa', name: 'alice', userId: 'uid-alice' };
const BOB = { id: 'fk:bbbbbbbbbbbbbbbb', name: 'bob', userId: 'uid-bob' };
const CAROL = { id: 'fk:cccccccccccccccc', name: 'carol', userId: 'uid-carol' };
const DAVE = { id: 'fk:dddddddddddddddd', name: 'dave', userId: 'uid-dave' };

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function openToyLobby(dir: string, now: () => number, log: (e: Record<string, unknown>) => void = () => {}): Promise<RoomLobby<ToyView, ToyInput>> {
	const lobby = new RoomLobby<ToyView, ToyInput>({
		store: new FileRoomStore(dir),
		now,
		log,
		typeOf: (gameType) => {
			if (gameType === TOY) return TOY_ROOM as unknown as RoomTypeHooks<unknown, ToyInput>;
			if (gameType === TOY4) return TOY4_ROOM as unknown as RoomTypeHooks<unknown, ToyInput>;
			if (gameType === TOY_TABLE) return TOY_TABLE_ROOM as unknown as RoomTypeHooks<unknown, ToyInput>;
			return undefined;
		},
		watchpartyRoom: { name: 'Toy table', gameType: TOY },
	});
	await lobby.open();
	return lobby;
}

describe('a room of a game the platform alone hosts', () => {
	it('is made, seated, readied, watched, handed on, restored and swept with no game lobby behind it', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'cardtable-toy-lobby-'));
		dirs.push(dir);
		let clock = 1_800_000_000_000;
		const now = (): number => clock;
		const lobby = await openToyLobby(dir, now);

		// 1. Made with its own blob; two members take the two seats (the creator on create, Bob on
		// joining), both ready; Carol arrives to a full room and watches, and her Ready is the toy's to refuse.
		const made = lobby.create(ALICE, { name: 'Toy night', gameType: TOY, target: 5 });
		if (!made.ok) throw new Error(made.reason);
		const id = made.room.id;
		expect(made.room.game).toEqual({ target: 5, played: 0 });
		clock += 1_000;
		expect(lobby.join(id, BOB)).toMatchObject({ ok: true, alreadyMember: false });
		clock += 1_000;
		expect(lobby.join(id, CAROL).ok).toBe(true);
		expect(lobby.get(id)?.seats).toEqual([ALICE.id, BOB.id]);
		expect(lobby.gameSeatOf(id, BOB.id)).toBe(1);
		expect(lobby.gameSeatOf(id, CAROL.id)).toBeNull();
		expect(lobby.sitSeat(id, CAROL.id)).toEqual({ ok: false, reason: 'pod-full' });
		expect(lobby.setReady(id, ALICE.id, true)).toBe(true);
		expect(lobby.setReady(id, BOB.id, true)).toBe(true);
		expect(lobby.setReady(id, CAROL.id, true)).toBe(true);
		expect(lobby.get(id)?.members.map((m) => [m.id, m.ready])).toEqual([
			[ALICE.id, true],
			[BOB.id, true],
			[CAROL.id, false],
		]);

		// 2. The leader leaves: leadership passes to the earliest joiner still here (ruling 6), Bob, not
		// Carol, and her seat reads as nobody's.
		const left = lobby.leave(id, ALICE.id);
		expect(left.ok && left.room.leader).toBe(BOB.id);
		expect(lobby.get(id)?.seats).toEqual([null, BOB.id]);
		expect(lobby.gameSeatOf(id, ALICE.id)).toBeNull();

		// 3. Saved on every change: a fresh lobby over the same directory reads back the same room,
		// its blob, seats, leader and Readys, but no names (R12).
		const before = lobby.get(id)!;
		const log: Record<string, unknown>[] = [];
		const restored = await openToyLobby(dir, now, (e) => log.push(e));
		expect(log.filter((e) => e.event === 'room-quarantined')).toEqual([]);
		const after = restored.get(id)!;
		expect({ ...after, members: after.members.map(({ name: _name, ...m }) => m) }).toEqual({ ...before, members: before.members.map(({ name: _name, ...m }) => m) });
		expect(after.game).toEqual({ target: 5, played: 0 });
		expect(restored.isMember(id, ALICE.id)).toBe(false);

		// 4. Swept once it has sat past its idle window, from memory and from disk.
		expect(restored.sweep(60_000)).toEqual([]);
		clock += 2 * 60_000;
		expect(restored.sweep(60_000)).toEqual([id]);
		expect(restored.get(id)).toBeUndefined();
		await restored.removed();
		expect(await new FileRoomStore(dir).list()).toEqual([]);
	});

	it('quarantines a stored room whose blob its type cannot read, and keeps the rest', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'cardtable-toy-lobby-'));
		dirs.push(dir);
		const lobby = await openToyLobby(dir, () => 1_800_000_000_000);
		const good = lobby.create(ALICE, { name: 'Good', gameType: TOY });
		const bad = lobby.create(BOB, { name: 'Bad', gameType: TOY });
		if (!good.ok || !bad.ok) throw new Error('not made');
		const store = new FileRoomStore(dir);
		const snapshot = (await store.load(bad.room.id))!;
		store.saveSync({ ...snapshot, app: { ...(snapshot.app as object), game: { target: 'five' } } });
		const log: Record<string, unknown>[] = [];
		const reopened = await openToyLobby(dir, () => 1_800_000_000_000, (e) => log.push(e));
		expect(reopened.list().map((r) => r.id)).toEqual([good.room.id]);
		expect(log.filter((e) => e.event === 'room-quarantined').map((e) => [e.roomId, e.reason])).toEqual([[bad.room.id, `codec: snapshot for room ${bad.room.id} is unreadable (codec): app codec threw: Error: app.game is invalid`]]);
	});

});

/**
 * The leader's three atomic seat ops (wave 119 §S): each evicts an occupant to the spectator row in
 * the SAME call, which `sitSeat`/`aiSeat`/`closeSeat` cannot do (each of those refuses an occupied
 * seat). Built on cardtable's own `GameSeats`, isolated here so a later swap to
 * `@wolffm/rooms-protocol`'s own equivalents (once published) is this file's tests to re-point, not
 * a redesign of the callers (`http/room-core.ts`'s HTTP routes, `room/lobby.ts`'s doc comment).
 */
describe("the leader's atomic seat ops: nobody is ever seatless and not a member (2026-11-02)", () => {
	async function fourSeatRoom(): Promise<{ lobby: RoomLobby<ToyView, ToyInput>; id: string }> {
		const dir = await mkdtemp(join(tmpdir(), 'cardtable-toy4-lobby-'));
		dirs.push(dir);
		const lobby = await openToyLobby(dir, () => 1_800_000_000_000);
		const made = lobby.create(ALICE, { name: 'Four seats', gameType: TOY4 });
		if (!made.ok) throw new Error('not made');
		const id = made.room.id;
		lobby.join(id, BOB);
		lobby.join(id, CAROL);
		lobby.join(id, DAVE);
		lobby.sitSeat(id, BOB.id);
		lobby.sitSeat(id, CAROL.id);
		lobby.sitSeat(id, DAVE.id);
		expect(lobby.get(id)?.seats).toEqual([ALICE.id, BOB.id, CAROL.id, DAVE.id]);
		return { lobby, id };
	}

	it('roleOf: a seated member plays, an unseated one watches, an outsider is neither', async () => {
		const { lobby, id } = await fourSeatRoom();
		expect(lobby.roleOf(id, ALICE.id)).toBe('player');
		lobby.standSeat(id, ALICE.id);
		expect(lobby.roleOf(id, ALICE.id)).toBe('spectator');
		expect(lobby.roleOf(id, 'fk:nobody0000000000')).toBeUndefined();
		expect(lobby.roleOf('r-nosuchroom00', ALICE.id)).toBeUndefined();
	});

	it('subPlaceOf: a room type with no idea of a sub-place answers false for every key, and for no such room', async () => {
		const { lobby, id } = await fourSeatRoom();
		expect(lobby.subPlaceOf(id, 'anything')).toBe(false);
		expect(lobby.subPlaceOf('r-nosuchroom00', 'anything')).toBe(false);
	});

	it("removeFromSeat: the leader evicts a seated member to the spectator row; they stay a member; idempotent; refused for a non-leader or a non-member target", async () => {
		const { lobby, id } = await fourSeatRoom();
		expect(lobby.removeFromSeat(id, ALICE.id, BOB.id)).toMatchObject({ ok: true });
		expect(lobby.roleOf(id, BOB.id)).toBe('spectator');
		expect(lobby.isMember(id, BOB.id)).toBe(true);
		expect(lobby.get(id)?.seats).toEqual([ALICE.id, null, CAROL.id, DAVE.id]);
		// Idempotent: Bob already holds no seat.
		expect(lobby.removeFromSeat(id, ALICE.id, BOB.id)).toMatchObject({ ok: true });
		// Only the leader may do this.
		expect(lobby.removeFromSeat(id, CAROL.id, DAVE.id)).toEqual({ ok: false, reason: 'not-leader' });
		expect(lobby.get(id)?.seats).toEqual([ALICE.id, null, CAROL.id, DAVE.id]);
		// The target must be a member.
		expect(lobby.removeFromSeat(id, ALICE.id, 'fk:nobody0000000000')).toEqual({ ok: false, reason: 'target-not-member' });
	});

	it('lowerSeatCapacity: the leader closes seats from the top, evicting occupants first; never below MIN_OPEN_SEATS; idempotent once met', async () => {
		const { lobby, id } = await fourSeatRoom();
		const result = lobby.lowerSeatCapacity(id, ALICE.id, 2);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error('unreachable');
		// Highest seat (Dave) evicted first, then Carol.
		expect(result.evicted).toEqual([DAVE.id, CAROL.id]);
		expect(lobby.get(id)?.seats).toEqual([ALICE.id, BOB.id, 'closed', 'closed']);
		expect(lobby.roleOf(id, DAVE.id)).toBe('spectator');
		expect(lobby.roleOf(id, CAROL.id)).toBe('spectator');
		expect(lobby.isMember(id, DAVE.id)).toBe(true);
		// Already met: a no-op, nothing further evicted.
		expect(lobby.lowerSeatCapacity(id, ALICE.id, 2)).toEqual({ ok: true, room: lobby.get(id), evicted: [] });
		// Never below MIN_OPEN_SEATS (2).
		expect(lobby.lowerSeatCapacity(id, ALICE.id, 1)).toEqual({ ok: false, reason: 'too-few' });
		// Only the leader.
		const { lobby: lobby2, id: id2 } = await fourSeatRoom();
		expect(lobby2.lowerSeatCapacity(id2, BOB.id, 2)).toEqual({ ok: false, reason: 'not-leader' });
	});

	it("botReplacesHuman: the leader puts the AI in a seat, evicting its human occupant first; idempotent once the AI holds it; bad-seat out of range", async () => {
		const { lobby, id } = await fourSeatRoom();
		const result = lobby.botReplacesHuman(id, ALICE.id, 2);
		expect(result).toMatchObject({ ok: true, evicted: CAROL.id });
		expect(lobby.get(id)?.seats).toEqual([ALICE.id, BOB.id, 'ai', DAVE.id]);
		expect(lobby.roleOf(id, CAROL.id)).toBe('spectator');
		expect(lobby.isMember(id, CAROL.id)).toBe(true);
		// Idempotent: the AI already holds seat 2.
		expect(lobby.botReplacesHuman(id, ALICE.id, 2)).toEqual({ ok: true, room: lobby.get(id), evicted: null });
		// Out of range.
		expect(lobby.botReplacesHuman(id, ALICE.id, 99)).toEqual({ ok: false, reason: 'bad-seat' });
		// Only the leader.
		expect(lobby.botReplacesHuman(id, DAVE.id, 1)).toEqual({ ok: false, reason: 'not-leader' });
	});
});

/**
 * Wave 120 §S2: a room type that does not `usesSeats` (same as a classic 1v1 room's) may still name
 * a DIFFERENT seat lineup for the leader's three atomic ops (`extraSeatTarget`) — proved here with
 * no Magic at all, against the toy's own "one table" (`TOY_TABLE_ROOM`), whose target declines a bot
 * (`supportsBot: false`) the same way a 1v1 room's own table does.
 */
describe("the leader's three atomic ops reach a room type's OWN seat lineup when it does not usesSeats (wave 120 §S2)", () => {
	async function tableRoom(): Promise<{ lobby: RoomLobby<ToyView, ToyInput>; id: string }> {
		const dir = await mkdtemp(join(tmpdir(), 'cardtable-toytable-lobby-'));
		dirs.push(dir);
		const lobby = await openToyLobby(dir, () => 1_800_000_000_000);
		const made = lobby.create(ALICE, { name: 'One table', gameType: TOY_TABLE });
		if (!made.ok) throw new Error('not made');
		const id = made.room.id;
		lobby.join(id, BOB);
		expect((lobby.get(id) as unknown as { game: ToyTableGame }).game.table).toEqual([ALICE.id, BOB.id]);
		expect(lobby.get(id)?.seats, 'this type never populates room.seats at all').toEqual([]);
		return { lobby, id };
	}

	it("removeFromSeat evicts to the type's own table, never room.seats", async () => {
		const { lobby, id } = await tableRoom();
		expect(lobby.removeFromSeat(id, ALICE.id, BOB.id)).toMatchObject({ ok: true });
		expect((lobby.get(id) as unknown as { game: ToyTableGame }).game.table).toEqual([ALICE.id, null]);
		expect(lobby.roleOf(id, BOB.id)).toBe('spectator');
		expect(lobby.isMember(id, BOB.id)).toBe(true);
		// Idempotent: Bob already holds no seat there.
		expect(lobby.removeFromSeat(id, ALICE.id, BOB.id)).toMatchObject({ ok: true });
		// Only the leader.
		expect(lobby.removeFromSeat(id, BOB.id, ALICE.id)).toEqual({ ok: false, reason: 'not-leader' });
	});

	it('lowerSeatCapacity reaches it too — a no-op at the floor, refused below it, same as every other room', async () => {
		const { lobby, id } = await tableRoom();
		expect(lobby.lowerSeatCapacity(id, ALICE.id, 2)).toMatchObject({ ok: true, evicted: [] });
		expect((lobby.get(id) as unknown as { game: ToyTableGame }).game.table).toEqual([ALICE.id, BOB.id]);
		expect(lobby.lowerSeatCapacity(id, ALICE.id, 1)).toEqual({ ok: false, reason: 'too-few' });
	});

	it("botReplacesHuman reaches the fallback too, but refuses truthfully — the type's own target has no AI-seat idea of its own (never the plain not-draft, which would say this room does not seat through game seats at all)", async () => {
		const { lobby, id } = await tableRoom();
		expect(lobby.botReplacesHuman(id, ALICE.id, 0)).toEqual({ ok: false, reason: 'no-bot-seat' });
	});

	it('sitSeat/standSeat/aiSeat/closeSeat stay gated on usesSeats exactly as before — extraSeatTarget never widens them', async () => {
		const { lobby, id } = await tableRoom();
		expect(lobby.sitSeat(id, ALICE.id)).toEqual({ ok: false, reason: 'not-draft' });
		expect(lobby.standSeat(id, ALICE.id)).toEqual({ ok: false, reason: 'not-draft' });
		expect(lobby.aiSeat(id, ALICE.id, 0, true)).toEqual({ ok: false, reason: 'not-draft' });
		expect(lobby.closeSeat(id, ALICE.id, 0, true)).toEqual({ ok: false, reason: 'not-draft' });
	});
});

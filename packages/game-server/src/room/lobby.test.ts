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

const ALICE = { id: 'fk:aaaaaaaaaaaaaaaa', name: 'alice', userId: 'uid-alice' };
const BOB = { id: 'fk:bbbbbbbbbbbbbbbb', name: 'bob', userId: 'uid-bob' };
const CAROL = { id: 'fk:cccccccccccccccc', name: 'carol', userId: 'uid-carol' };

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function openToyLobby(dir: string, now: () => number, log: (e: Record<string, unknown>) => void = () => {}): Promise<RoomLobby<ToyView, ToyInput>> {
	const lobby = new RoomLobby<ToyView, ToyInput>({
		store: new FileRoomStore(dir),
		now,
		log,
		typeOf: (gameType) => (gameType === TOY ? (TOY_ROOM as unknown as RoomTypeHooks<unknown, ToyInput>) : undefined),
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

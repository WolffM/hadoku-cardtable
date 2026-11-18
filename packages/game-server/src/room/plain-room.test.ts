/**
 * `plainRoomType` — the room type of a game that keeps nothing of its own (bomberman) — and the
 * AI faces every room draws (`ai-faces.ts`): a real `RoomLobby` over a real store, no game behind it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FileRoomStore } from '@wolffm/rooms-server/store';
import { AVATAR_POOL } from '@wolffm/rooms-protocol';

import { personaOf, seatPersonas } from './ai-faces.ts';
import { RoomLobby, plainRoomType, type PlainRoomSize, type PlainRoomView, type PlatformRoomView, type RoomCreateInput, type RoomTypeHooks } from './lobby.ts';
import { AI_SEAT, CLOSED_SEAT } from './record.ts';

const PLAIN = 'plain';
type View = PlatformRoomView & PlainRoomView;

const ALICE = { id: 'fk:aaaaaaaaaaaaaaaa', name: 'alice', userId: 'uid-alice' };
const BOB = { id: 'fk:bbbbbbbbbbbbbbbb', name: 'bob', userId: 'uid-bob' };

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function roomOf(size: PlainRoomSize): Promise<{ lobby: RoomLobby<View, RoomCreateInput>; id: string }> {
	const dir = await mkdtemp(join(tmpdir(), 'game-server-plain-'));
	dirs.push(dir);
	const type = plainRoomType<RoomCreateInput>(size) as unknown as RoomTypeHooks<unknown, RoomCreateInput>;
	const lobby = new RoomLobby<View, RoomCreateInput>({
		store: new FileRoomStore(dir),
		now: () => 1_800_000_000_000,
		log: () => {},
		typeOf: (t) => (t === PLAIN ? type : undefined),
		watchpartyRoom: { name: 'Plain', gameType: PLAIN },
	});
	await lobby.open();
	const made = lobby.create(ALICE, { name: 'Plain night', gameType: PLAIN });
	if (!made.ok) throw new Error(made.reason);
	return { lobby, id: made.room.id };
}

const seatsOf = (lobby: RoomLobby<View, RoomCreateInput>, id: string): (string | null)[] => lobby.get(id)!.seats;

describe('plainRoomType', () => {
	it('keepOneOpen: a room whose every seat is taken grows one open seat, up to max', async () => {
		const { lobby, id } = await roomOf({ seats: 2, max: 3, markedSeats: true, keepOneOpen: true });
		// Alice sat on create; Bob takes the last open seat on joining, so a third opens.
		expect(seatsOf(lobby, id)).toEqual([ALICE.id, null]);
		lobby.join(id, BOB);
		expect(seatsOf(lobby, id)).toEqual([ALICE.id, BOB.id, null]);
		// The AI fills it: the room is at max, so nothing more opens.
		expect(lobby.aiSeat(id, ALICE.id, 2, true).ok).toBe(true);
		expect(seatsOf(lobby, id)).toEqual([ALICE.id, BOB.id, AI_SEAT]);
		// A seat given back trims to one open seat, never below the opening size.
		expect(lobby.aiSeat(id, ALICE.id, 2, false).ok).toBe(true);
		expect(seatsOf(lobby, id)).toEqual([ALICE.id, BOB.id, null]);
	});

	it('keepOneOpen never reopens a seat the leader closed', async () => {
		const { lobby, id } = await roomOf({ seats: 3, max: 6, markedSeats: true, keepOneOpen: true });
		expect(lobby.closeSeat(id, ALICE.id, 2, true).ok).toBe(true);
		lobby.join(id, BOB);
		// Every open seat taken, one closed: the room does not grow past the leader's choice.
		expect(seatsOf(lobby, id)).toEqual([ALICE.id, BOB.id, CLOSED_SEAT]);
	});

	it('without keepOneOpen a full room stays full', async () => {
		const { lobby, id } = await roomOf({ seats: 2, max: 3 });
		lobby.join(id, BOB);
		expect(seatsOf(lobby, id)).toEqual([ALICE.id, BOB.id]);
	});

	it('a member who leaves gives their seat up — no ghost holder', async () => {
		const { lobby, id } = await roomOf({ seats: 2, max: 4, markedSeats: true, keepOneOpen: true });
		lobby.join(id, BOB);
		expect(seatsOf(lobby, id)).toEqual([ALICE.id, BOB.id, null]);
		expect(lobby.leave(id, BOB.id).ok).toBe(true);
		expect(seatsOf(lobby, id)).toEqual([ALICE.id, null]);
	});

	it('markedSeats: the view tells a bot and a closed seat from an open one; aiSeats names the bot', async () => {
		const { lobby, id } = await roomOf({ seats: 4, max: 4, markedSeats: true });
		lobby.aiSeat(id, ALICE.id, 1, true);
		lobby.closeSeat(id, ALICE.id, 3, true);
		const view = lobby.get(id)!;
		expect(view.seats).toEqual([ALICE.id, AI_SEAT, null, CLOSED_SEAT]);
		expect(view.aiSeats[0]).toBeNull();
		expect(view.aiSeats[1]).toEqual(personaOf(view.aiSeats[1]!.avatarId));
		expect(AVATAR_POOL).toContain(view.aiSeats[1]!.avatarId);
		expect([view.aiSeats[2], view.aiSeats[3]]).toEqual([null, null]);
	});

	it('without markedSeats the view reads bot and closed seats as nobody’s, as before', async () => {
		const { lobby, id } = await roomOf({ seats: 3, max: 3 });
		lobby.aiSeat(id, ALICE.id, 1, true);
		expect(lobby.get(id)!.seats).toEqual([ALICE.id, null, null]);
	});
});

describe('seatPersonas', () => {
	const room = (seats: (string | null)[], faces: (string | undefined)[] = [], id = 'r-faces') => ({
		id,
		seats,
		members: faces.map((avatarId, i) => ({ id: `m${i}`, avatarId })),
	});
	const faces = (r: ReturnType<typeof room>) => seatPersonas(r, AI_SEAT).map((p) => p?.avatarId ?? null);

	it('every bot a different face, none a member wears, each named after its character', () => {
		const r = room(['m0', AI_SEAT, AI_SEAT, AI_SEAT, null], ['knight']);
		const drawn = seatPersonas(r, AI_SEAT);
		const ids = drawn.flatMap((p) => (p === null ? [] : [p.avatarId]));
		expect(ids).toHaveLength(3);
		expect(new Set(ids).size).toBe(3);
		expect(ids).not.toContain('knight');
		for (const p of drawn) if (p !== null) expect(p.name).toBe(p.avatarId.charAt(0).toUpperCase() + p.avatarId.slice(1));
	});

	it('is random across rooms, not the pool in order', () => {
		const firsts = new Set(Array.from({ length: 12 }, (_, i) => faces(room([AI_SEAT], [], `r-${i}`))[0]));
		expect(firsts.size).toBeGreaterThan(3);
	});

	it('a bot keeps its face when people come and go, and redraws only when someone puts it on', () => {
		const before = faces(room([AI_SEAT, AI_SEAT, null]));
		const other = AVATAR_POOL.find((a) => !before.includes(a))!;
		expect(faces(room([AI_SEAT, AI_SEAT, null], [other]))).toEqual(before);
		const after = faces(room([AI_SEAT, AI_SEAT, null], [before[0]!]));
		expect(after[0]).not.toBe(before[0]);
		expect(after[0]).not.toBe(after[1]);
	});

	it('past the pool, faces repeat rather than fail', () => {
		const r = room(Array.from({ length: AVATAR_POOL.length + 2 }, () => AI_SEAT));
		expect(faces(r).every((f) => f !== null && (AVATAR_POOL as readonly string[]).includes(f))).toBe(true);
	});
});

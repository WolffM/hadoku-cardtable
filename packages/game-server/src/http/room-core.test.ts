/**
 * The leader's three atomic seat-op routes (wave 119 §S: remove a seated member, lower seat
 * capacity, replace a human with the AI), through a REAL express app and a real `RoomLobby` on a
 * toy room type — no Magic import, same discipline as `room/lobby.test.ts`'s own toy fixture, so
 * this proves the GENERIC route wiring (status codes, leader-only, rate limit) rather than
 * anything Magic-specific. Magic's own `http/rooms.ts`/`rooms.test.ts` (not this lane's) cover the
 * same routes mounted for real pods.
 */
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FileRoomStore } from '@wolffm/rooms-server/store';

import { NO_BUSY_HOOK } from '../room/room-list.ts';
import type { PlatformRoomView, RoomCreateInput, RoomTypeHooks } from '../room/lobby.ts';
import type { RoomCoreWire } from './room-core.ts';

const EDGE_SECRET = 'test-edge-auth-secret';

/*
 * `config.ts`/`kernel.ts` read `EDGE_AUTH_SECRET` once, at import time — so `room-core.ts` (which
 * imports `edge-auth.ts`) and `room/lobby.ts` must be imported AFTER it is set, same discipline as
 * `room/serve.test.ts`. A static top-level import of either would load `edge-auth.ts` at file-parse
 * time, before this file's own `beforeAll` runs.
 */
let edgeMod: typeof import('../edge-auth.ts');
let identityMod: typeof import('../room/identity.ts');
let lobbyMod: typeof import('../room/lobby.ts');
let roomCoreMod: typeof import('./room-core.ts');

beforeAll(async () => {
	process.env.EDGE_AUTH_SECRET = EDGE_SECRET;
	delete process.env.CARDTABLE_INSECURE_NO_EDGE_AUTH;
	vi.resetModules();
	edgeMod = await import('../edge-auth.ts');
	identityMod = await import('../room/identity.ts');
	lobbyMod = await import('../room/lobby.ts');
	roomCoreMod = await import('./room-core.ts');
});

function edgeHeaders(userKey: string, tier = 'friend'): Record<string, string> {
	return { 'x-edge-auth': EDGE_SECRET, 'x-hadoku-tier': tier, 'x-user-id': `user-${userKey}`, 'x-user-key': `friend-key-${userKey}` };
}

function participantIdFor(userKey: string): string {
	return identityMod.identityFromHeaders(edgeHeaders(userKey) as unknown as Parameters<typeof identityMod.identityFromHeaders>[0], 'unused');
}

/** A toy room type with four seats, big enough to prove the leader's seat ops. */
const TOY = 'toy';
interface ToyGame {
	played: number;
}
type ToyView = PlatformRoomView & { game: ToyGame };
const TOY_ROOM: RoomTypeHooks<ToyGame, RoomCreateInput> = {
	newGame: () => ({ seats: [null, null], game: { played: 0 } }),
	encode: (room) => ({ ...room.game }),
	decode: (app) => ({ seats: Array.isArray(app.seats) ? [...(app.seats as (string | null)[])] : [null, null], game: { played: 0 } }),
	restore: () => ({ dropHolds: false, game: () => ({ played: 0 }) }),
	view: (room) => ({ game: { ...room.game } }),
	// The generic default `memberSeats` reads `AI_SEAT`/`CLOSED_SEAT` as open; this fixture wants
	// its view to carry them verbatim, same reasoning as `room/lobby.test.ts`'s own TOY4 fixture.
	seatsView: (room) => [...room.seats],
	busy: NO_BUSY_HOOK,
	liveMatches: () => [],
	usesSeats: () => true,
	seatsFixed: () => false,
	seatCeiling: () => 4,
	growSeats(room, seat) {
		while (room.seats.length <= seat) room.seats = [...room.seats, null];
	},
	trimSeats(room) {
		while (room.seats.length > 2 && room.seats.at(-1) === null) room.seats = room.seats.slice(0, -1);
	},
};

/** The same toy, as a game type whose every room is friends-only (`GameTypeSpec.minTier`). */
const TOY_FRIENDS = 'toy-friends';
const TOY_FRIENDS_ROOM: RoomTypeHooks<ToyGame, RoomCreateInput> = { ...TOY_ROOM, minTier: 'friend' };

function body<T>(check: (v: unknown) => v is T): RoomCoreWire<T, never>['createRoomBody'] {
	return { safeParse: (v) => (check(v) ? { success: true, data: v } : { success: false, error: { issues: [{ code: 'invalid_type', path: [], message: 'bad body' }] } }) };
}
const EMPTY_BODY = body((v): v is object => typeof v === 'object' && v !== null);
const CREATE_BODY = body((v): v is { name: string; gameType: string } => typeof v === 'object' && v !== null && typeof (v as { name?: unknown }).name === 'string' && typeof (v as { gameType?: unknown }).gameType === 'string');
const JOIN_BODY = body((v): v is { password?: string } => typeof v === 'object' && v !== null);
const READY_BODY = body((v): v is { ready: boolean } => typeof v === 'object' && v !== null && typeof (v as { ready?: unknown }).ready === 'boolean');
const WATCHPARTY_BODY = body((v): v is { room: string } => typeof v === 'object' && v !== null && typeof (v as { room?: unknown }).room === 'string');

const ROOM_ID_RE = /^(r|wp)-[0-9a-z]+$/;

/** The real `RoomLobby<ToyView, RoomCreateInput>`, loaded only after `EDGE_AUTH_SECRET` is set. */
type ToyLobby = import('../room/lobby.ts').RoomLobby<ToyView, RoomCreateInput>;

/**
 * `LobbyCore` (room-core.ts's own interface) also wants `roomOfMatch`/`setGameType` — Magic's own
 * additions, not the generic `RoomLobby`'s. Neither route under test here touches them; this
 * wraps the real lobby's own methods (so `h.lobby` in a test is still the full `RoomLobby`) with
 * the narrowest stand-in for the two `attachRoomCore` structurally needs but never calls here.
 */
function asLobbyCore(lobby: ToyLobby): import('./room-core.ts').LobbyCore<ToyView, RoomCreateInput> {
	return {
		get: lobby.get.bind(lobby),
		offered: lobby.offered.bind(lobby),
		isMember: lobby.isMember.bind(lobby),
		leaveDrops: lobby.leaveDrops.bind(lobby),
		create: lobby.create.bind(lobby),
		minTierOf: lobby.minTierOf.bind(lobby),
		join: lobby.join.bind(lobby),
		setReady: lobby.setReady.bind(lobby),
		touch: lobby.touch.bind(lobby),
		leave: lobby.leave.bind(lobby),
		close: lobby.close.bind(lobby),
		bindWatchparty: lobby.bindWatchparty.bind(lobby),
		roomOfMatch: () => undefined,
		setGameType: () => ({ ok: false, reason: 'not-supported' }),
		removeFromSeat: lobby.removeFromSeat.bind(lobby),
		lowerSeatCapacity: lobby.lowerSeatCapacity.bind(lobby),
		botReplacesHuman: lobby.botReplacesHuman.bind(lobby),
		passLeader: lobby.passLeader.bind(lobby),
	};
}

interface Harness {
	port: number;
	lobby: ToyLobby;
	close: () => Promise<void>;
}

const dirs: string[] = [];
let http: HttpServer | undefined;

async function boot(opts: { seatRoutes?: boolean; away?: (memberId: string) => number | null | undefined; here?: (roomId: string) => ReadonlySet<string> } = {}): Promise<Harness> {
	const dir = await mkdtemp(join(tmpdir(), 'w119s-room-core-test-'));
	dirs.push(dir);
	const lobby = new lobbyMod.RoomLobby<ToyView, RoomCreateInput>({
		store: new FileRoomStore(dir),
		now: () => Date.now(),
		log: () => undefined,
		typeOf: (t) => (t === TOY ? (TOY_ROOM as unknown as RoomTypeHooks<unknown, RoomCreateInput>) : t === TOY_FRIENDS ? (TOY_FRIENDS_ROOM as unknown as RoomTypeHooks<unknown, RoomCreateInput>) : undefined),
		watchpartyRoom: { name: 'wp', gameType: TOY },
	});
	await lobby.open();

	const app = express();
	app.use(edgeMod.edgeProvenance);
	app.use(edgeMod.requireMinTier);
	const api = express.Router();
	api.use(express.json());
	roomCoreMod.attachRoomCore(api, {
		lobby: asLobbyCore(lobby),
		...(opts.seatRoutes === true ? { seatRoutes: lobby } : {}),
		...(opts.away === undefined ? {} : { away: opts.away }),
		...(opts.here === undefined ? {} : { here: opts.here }),
		wire: {
			roomIdRe: ROOM_ID_RE,
			createRoomBody: CREATE_BODY,
			joinRoomBody: JOIN_BODY,
			readyBody: READY_BODY,
			emptyBody: EMPTY_BODY,
			watchpartyBindBody: WATCHPARTY_BODY,
			patchRoomBody: EMPTY_BODY as unknown as RoomCoreWire<never, never>['patchRoomBody'],
		},
	});
	app.use('/api', api);
	http = createServer(app);
	await new Promise<void>((done) => http!.listen(0, '127.0.0.1', done));
	return {
		port: (http.address() as AddressInfo).port,
		lobby,
		close: () => new Promise<void>((done) => http!.close(() => done())),
	};
}

async function get(h: Harness, path: string, headers: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await fetch(`http://127.0.0.1:${h.port}/api/rooms${path}`, { headers });
	return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function post(h: Harness, path: string, headers: Record<string, string>, bodyJson: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await fetch(`http://127.0.0.1:${h.port}/api/rooms${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(bodyJson) });
	return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

afterEach(async () => {
	await http?.close();
	http = undefined;
});
afterAll(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('the leader’s seat-op routes', () => {
	/** Alice (seat 0) leads; Bob sits explicitly at seat 3, so the room grows to four seats with two held in the middle open — the shape the capacity op has to evict past, not just truncate. */
	async function fourSeatRoom(h: Harness): Promise<{ id: string; alice: string; bob: string }> {
		const alice = participantIdFor('alice');
		const bob = participantIdFor('bob');
		const made = h.lobby.create({ id: alice, name: 'alice', userId: 'u-alice' }, { name: 'room', gameType: TOY });
		if (!made.ok) throw new Error('not made');
		h.lobby.join(made.room.id, { id: bob, name: 'bob', userId: 'u-bob' });
		// `sitSeat` only ever grows the room one seat past its current length, so Bob (auto-seated
		// at 1 on joining) walks forward a seat at a time to reach 3, growing the room with him.
		expect(h.lobby.sitSeat(made.room.id, bob, 2)).toMatchObject({ ok: true });
		expect(h.lobby.sitSeat(made.room.id, bob, 3)).toMatchObject({ ok: true });
		expect(h.lobby.get(made.room.id)?.seats).toEqual([alice, null, null, bob]);
		return { id: made.room.id, alice, bob };
	}

	it('POST /:id/seats/remove: the leader evicts a seated member; a non-leader is refused 403', async () => {
		const h = await boot();
		try {
			const { id, bob } = await fourSeatRoom(h);
			const refused = await post(h, `/${id}/seats/remove`, edgeHeaders('bob'), { memberId: bob });
			expect(refused.status).toBe(403);
			const ok = await post(h, `/${id}/seats/remove`, edgeHeaders('alice'), { memberId: bob });
			expect(ok.status).toBe(200);
			// `trimSeats` drops the now-trailing-null seats back to the room's floor of two.
			expect(ok.json.seats).toEqual([h.lobby.get(id)?.members[0]?.id, null]);
			expect(h.lobby.roleOf(id, bob)).toBe('spectator');
			expect(h.lobby.isMember(id, bob)).toBe(true);
		} finally {
			await h.close();
		}
	});

	it('POST /:id/seats/capacity: the leader shrinks the room, evicting from the top; never below two seats', async () => {
		const h = await boot();
		try {
			const { id, alice, bob } = await fourSeatRoom(h);
			const lowered = await post(h, `/${id}/seats/capacity`, edgeHeaders('alice'), { count: 2 });
			expect(lowered.status).toBe(200);
			expect(lowered.json.evicted).toEqual([bob]);
			expect(h.lobby.roleOf(id, bob)).toBe('spectator');
			const tooFew = await post(h, `/${id}/seats/capacity`, edgeHeaders('alice'), { count: 1 });
			expect(tooFew.status).toBe(400);
			void alice;
		} finally {
			await h.close();
		}
	});

	it('POST /:id/seats/bot: the leader replaces a seated human with the AI', async () => {
		const h = await boot();
		try {
			const { id, bob } = await fourSeatRoom(h);
			const result = await post(h, `/${id}/seats/bot`, edgeHeaders('alice'), { seat: 3 });
			expect(result.status).toBe(200);
			expect(result.json.evicted).toBe(bob);
			expect(result.json.seats).toEqual([h.lobby.get(id)?.members[0]?.id, null, null, 'ai']);
			expect(h.lobby.roleOf(id, bob)).toBe('spectator');
		} finally {
			await h.close();
		}
	});

	it('POST /:id/leader: the leader hands the room to another member, who can then act as leader; a non-leader is refused 403', async () => {
		const h = await boot();
		try {
			const { id, alice, bob } = await fourSeatRoom(h);
			expect((await post(h, `/${id}/leader`, edgeHeaders('bob'), { memberId: bob })).status).toBe(403);
			expect((await post(h, `/${id}/leader`, edgeHeaders('alice'), { memberId: 'fk:0000000000000000' })).status).toBe(404);
			const passed = await post(h, `/${id}/leader`, edgeHeaders('alice'), { memberId: bob });
			expect(passed.status).toBe(200);
			expect(h.lobby.get(id)?.leader).toBe(bob);
			expect((await post(h, `/${id}/seats/remove`, edgeHeaders('alice'), { memberId: bob })).status).toBe(403);
			expect((await post(h, `/${id}/seats/remove`, edgeHeaders('bob'), { memberId: alice })).status).toBe(200);
		} finally {
			await h.close();
		}
	});

	it('is rate-limited per caller', async () => {
		const h = await boot();
		try {
			const { id, bob } = await fourSeatRoom(h);
			let last: { status: number } = { status: 200 };
			for (let i = 0; i < 11; i++) last = await post(h, `/${id}/seats/remove`, edgeHeaders('alice'), { memberId: bob });
			expect(last.status).toBe(429);
		} finally {
			await h.close();
		}
	});
});

describe('who is away', () => {
	it('the room body names each member with no screen open and when they were last seen; one here is not named', async () => {
		const alice = participantIdFor('alice');
		const bob = participantIdFor('bob');
		const carol = participantIdFor('carol');
		const seen: Record<string, number | null | undefined> = { [alice]: undefined, [bob]: Date.UTC(2026, 10, 19, 1), [carol]: null };
		const h = await boot({ away: (id) => seen[id] });
		try {
			const made = h.lobby.create({ id: alice, name: 'alice', userId: 'u-alice' }, { name: 'room', gameType: TOY });
			if (!made.ok) throw new Error('not made');
			h.lobby.join(made.room.id, { id: bob, name: 'bob', userId: 'u-bob' });
			h.lobby.join(made.room.id, { id: carol, name: 'carol', userId: 'u-carol' });
			const res = await fetch(`http://127.0.0.1:${h.port}/api/rooms/${made.room.id}`, { headers: edgeHeaders('alice') });
			expect(((await res.json()) as { away: unknown }).away).toEqual({ [bob]: '2026-11-19T01:00:00.000Z', [carol]: null });
		} finally {
			await h.close();
		}
	});
});

describe('who is in the room now', () => {
	it('the room body lists the members connected to the room, in the room’s order; a connection that is no member’s is not listed', async () => {
		const [alice, bob, carol] = [participantIdFor('alice'), participantIdFor('bob'), participantIdFor('carol')];
		const h = await boot({ here: () => new Set([carol, alice, participantIdFor('passer-by')]) });
		try {
			const made = h.lobby.create({ id: alice, name: 'alice', userId: 'u-alice' }, { name: 'room', gameType: TOY });
			if (!made.ok) throw new Error('not made');
			h.lobby.join(made.room.id, { id: bob, name: 'bob', userId: 'u-bob' });
			h.lobby.join(made.room.id, { id: carol, name: 'carol', userId: 'u-carol' });
			const res = await fetch(`http://127.0.0.1:${h.port}/api/rooms/${made.room.id}`, { headers: edgeHeaders('alice') });
			expect(((await res.json()) as { here: unknown }).here).toEqual([alice, carol]);
		} finally {
			await h.close();
		}
	});

	it('a room watchparty draws carries no `here`: its roster is watchparty’s, and this server cannot say', async () => {
		const h = await boot({ here: () => new Set() });
		try {
			const bound = h.lobby.bindWatchparty({ id: participantIdFor('alice'), name: 'alice', userId: 'u-alice' }, 'some-watchparty-room');
			if (!bound.ok) throw new Error('not bound');
			const res = await fetch(`http://127.0.0.1:${h.port}/api/rooms/${bound.room.id}`, { headers: edgeHeaders('alice') });
			expect(res.status).toBe(200);
			expect((await res.json()) as object).not.toHaveProperty('here');
		} finally {
			await h.close();
		}
	});
});

describe('the opt-in seat routes (`seatRoutes`)', () => {
	it('are absent unless a lobby is handed in', async () => {
		const h = await boot();
		try {
			const made = h.lobby.create({ id: participantIdFor('alice'), name: 'alice', userId: 'u-alice' }, { name: 'room', gameType: TOY });
			if (!made.ok) throw new Error('not made');
			const res = await fetch(`http://127.0.0.1:${h.port}/api/rooms/${made.room.id}/seats/stand`, { method: 'POST', headers: { ...edgeHeaders('alice'), 'content-type': 'application/json' }, body: '{}' });
			expect(res.status).toBe(404);
		} finally {
			await h.close();
		}
	});

	it('sit, stand, close/open and bot-off, each answering the room; the leader’s two refused to anyone else', async () => {
		const h = await boot({ seatRoutes: true });
		try {
			const alice = participantIdFor('alice');
			const bob = participantIdFor('bob');
			const made = h.lobby.create({ id: alice, name: 'alice', userId: 'u-alice' }, { name: 'room', gameType: TOY });
			if (!made.ok) throw new Error('not made');
			const id = made.room.id;
			h.lobby.join(id, { id: bob, name: 'bob', userId: 'u-bob' });
			expect(h.lobby.get(id)?.seats).toEqual([alice, bob]);

			const stood = await post(h, `/${id}/seats/stand`, edgeHeaders('bob'), {});
			expect(stood.status).toBe(200);
			expect(stood.json.seats).toEqual([alice, null]);
			const sat = await post(h, `/${id}/seats/sit`, edgeHeaders('bob'), { seat: 1 });
			expect(sat.json.seats).toEqual([alice, bob]);
			expect((await post(h, `/${id}/seats/sit`, edgeHeaders('bob'), { seat: -1 })).status).toBe(400);

			// Sitting one past the last grows the room; the leader closes that seat and opens it again.
			await post(h, `/${id}/seats/sit`, edgeHeaders('bob'), { seat: 2 });
			expect((await post(h, `/${id}/seats/close`, edgeHeaders('bob'), { seat: 1, closed: true })).status).toBe(403);
			const closed = await post(h, `/${id}/seats/close`, edgeHeaders('alice'), { seat: 1, closed: true });
			expect(closed.json.seats).toEqual([alice, 'closed', bob]);
			const opened = await post(h, `/${id}/seats/close`, edgeHeaders('alice'), { seat: 1, closed: false });
			expect(opened.json.seats).toEqual([alice, null, bob]);

			// The AI in (room-core's `seats/bot`) and back out.
			await post(h, `/${id}/seats/bot`, edgeHeaders('alice'), { seat: 1 });
			expect(h.lobby.get(id)?.seats).toEqual([alice, 'ai', bob]);
			expect((await post(h, `/${id}/seats/bot-off`, edgeHeaders('bob'), { seat: 1 })).status).toBe(403);
			const off = await post(h, `/${id}/seats/bot-off`, edgeHeaders('alice'), { seat: 1 });
			expect(off.status).toBe(200);
			expect(off.json.seats).toEqual([alice, null, bob]);
		} finally {
			await h.close();
		}
	});
});

describe('a friends-only room (`minTier`)', () => {
	const listed = async (h: Harness, headers: Record<string, string>): Promise<string[]> => ((await get(h, '/', headers)).json.rooms as { id: string }[]).map((r) => r.id);

	it('is made only by a caller the edge names friend or above — a member is refused, though cardtable otherwise treats a member as a friend', async () => {
		const h = await boot();
		try {
			const refused = await post(h, '/', edgeHeaders('mia', 'member'), { name: 'friends', gameType: TOY, minTier: 'friend' });
			expect(refused.status).toBe(403);
			expect(h.lobby.offered()).toEqual([]);
			const made = await post(h, '/', edgeHeaders('fred'), { name: 'friends', gameType: TOY, minTier: 'friend' });
			expect(made.status).toBe(201);
			expect(made.json.minTier).toBe('friend');
			const open = await post(h, '/', edgeHeaders('mia', 'member'), { name: 'open', gameType: TOY });
			expect(open.status).toBe(201);
			expect(open.json).not.toHaveProperty('minTier');
		} finally {
			await h.close();
		}
	});

	it('does not exist below friend: not listed, 404 to read or join; a friend and an admin see it and join', async () => {
		const h = await boot();
		try {
			const made = await post(h, '/', edgeHeaders('fred'), { name: 'friends', gameType: TOY, minTier: 'friend' });
			const id = made.json.id as string;
			// The app's own floor here is friend, which a member passes (`tierOf` promotes them); the room's does not.
			const mia = edgeHeaders('mia', 'member');
			expect(await listed(h, mia)).toEqual([]);
			expect((await get(h, `/${id}`, mia)).status).toBe(404);
			expect((await post(h, `/${id}/join`, mia, {})).status).toBe(404);
			expect(h.lobby.isMember(id, participantIdFor('mia'))).toBe(false);
			expect(await listed(h, edgeHeaders('fran'))).toEqual([id]);
			expect((await post(h, `/${id}/join`, edgeHeaders('fran'), {})).status).toBe(200);
			expect((await post(h, `/${id}/join`, edgeHeaders('ada', 'admin'), {})).status).toBe(200);
		} finally {
			await h.close();
		}
	});

	it("a game type's own floor makes every room of it friends-only, whatever the body says", async () => {
		const h = await boot();
		try {
			expect((await post(h, '/', edgeHeaders('mia', 'member'), { name: 'x', gameType: TOY_FRIENDS })).status).toBe(403);
			const made = await post(h, '/', edgeHeaders('fred'), { name: 'x', gameType: TOY_FRIENDS });
			expect(made.status).toBe(201);
			expect(made.json.minTier).toBe('friend');
			expect(await listed(h, edgeHeaders('mia', 'member'))).toEqual([]);
		} finally {
			await h.close();
		}
	});

	it('keeps its floor across a restart', async () => {
		const h = await boot();
		try {
			const made = await post(h, '/', edgeHeaders('fred'), { name: 'friends', gameType: TOY, minTier: 'friend' });
			const id = made.json.id as string;
			const again = new lobbyMod.RoomLobby<ToyView, RoomCreateInput>({
				store: new FileRoomStore(dirs.at(-1)!),
				now: () => Date.now(),
				log: () => undefined,
				typeOf: (t) => (t === TOY ? (TOY_ROOM as unknown as RoomTypeHooks<unknown, RoomCreateInput>) : undefined),
				watchpartyRoom: { name: 'wp', gameType: TOY },
			});
			await again.open();
			expect(again.get(id)?.minTier).toBe('friend');
		} finally {
			await h.close();
		}
	});
});

/**
 * `/api/rooms`'s GENERIC surface: list, create, join, ready, leave, close, an
 * admin's testing-room reset, the watchparty bind, "the room that started this
 * match", and the `{ gameType }` arm of `PATCH /:id`. `rooms.ts` stays Magic:
 * formats, pods, drafts, tournaments, and the `{ format }`/`{ settings }`/
 * `{ mode }` arms of the same PATCH, mounted on this file's OWN router after it.
 *
 * This file imports no `Lobby`, no `RoomView`, no `@hadoku/shared` (the ratchet
 * resolves `@hadoku/shared` as one package, magic even through `/platform`) —
 * every real Magic type is a type PARAMETER instead (`V`, `C`, `P`, `G` below),
 * and `rooms.ts` passes the real `Lobby`/schemas in structurally. `LobbyCore`'s
 * methods use method syntax on purpose, for TypeScript's bivariant parameter
 * checking — it's what lets the real, narrower-typed `Lobby` satisfy this
 * interface with no cast.
 *
 * ## The PATCH seam
 *
 * ONE registration of `PATCH /:id` (the frozen `route-table.json` admits each
 * method+path once): this file parses the body with `deps.wire.patchRoomBody`
 * and answers `{ gameType }` itself; anything else goes to `opts.onPatch`, a
 * hook `rooms.ts` passes in — never a second route, never `res.locals`.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { MultiRateLimiter, type RateLimitConfig } from '@wolffm/rooms-server';
import { isDurableParticipantId } from '@wolffm/rooms-protocol';
import { isAdmin } from '../edge-auth.js';
import { bodyErrors, callerOf, parseBody, perCallerLimit, type BodySchema } from './request.js';
import { watchpartyRoomId } from '../room/watchparty-link.js';
import { jsonLogger } from '../log.js';

/** Who is asking — exactly what `callerOf` returns, never a redeclared shape. */
type CallerLike = ReturnType<typeof callerOf>;

/** The minimal room shape every route here touches; the real `RoomView` satisfies it and rides through untouched as `V`. */
export interface RoomViewCore {
	id: string;
	leader: string;
	members: readonly { id: string; ready: boolean }[];
	testing?: boolean;
}

/** The slice of `room/lobby.ts`'s `Lobby` this file calls, typed against `V` and `C` alone — never the real types. */
export interface LobbyCore<V extends RoomViewCore, C> {
	get(roomId: string): V | undefined;
	offered(): V[];
	isMember(roomId: string, callerId: string): boolean;
	create(caller: CallerLike, body: C): { ok: true; room: V } | { ok: false };
	join(roomId: string, caller: CallerLike, password?: string): { ok: true; room: V } | { ok: false; reason: 'no-match' | 'not-durable' };
	setReady(roomId: string, callerId: string, ready: boolean): boolean;
	touch(roomId: string, callerId: string): void;
	leave(roomId: string, callerId: string): { ok: true; room: V; forfeited?: { tableId: string; matchIds: readonly string[] } } | { ok: false };
	close(roomId: string, callerId: string): { ok: true; matches: readonly string[] } | { ok: false; reason: string };
	bindWatchparty(caller: CallerLike, watchpartyRoom: string): { ok: true; room: V } | { ok: false };
	roomOfMatch(matchId: string): V | undefined;
	setGameType(roomId: string, callerId: string, gameType: string): { ok: true; room: V } | { ok: false; reason: string };
}

/** The request-body schemas and the room-id shape, injected rather than imported: the real values live in a Magic-resolved package. */
export interface RoomCoreWire<C, P extends object> {
	roomIdRe: RegExp;
	createRoomBody: BodySchema<C>;
	joinRoomBody: BodySchema<{ password?: string }>;
	readyBody: BodySchema<{ ready: boolean }>;
	emptyBody: BodySchema<unknown>;
	watchpartyBindBody: BodySchema<{ room: string }>;
	patchRoomBody: BodySchema<P>;
}

/** The single answer for "no such room" and "wrong password". Byte-identical by construction. */
export const NO_MATCH = { error: 'no room with that id and password' } as const;

/** Join attempts per caller: a burst of 10, then one more every 30 s. Only NON-member attempts spend a token. */
export const JOIN_RATE_LIMIT: RateLimitConfig = {
	capacity: 10,
	refillAmount: 1,
	refillIntervalMs: 30_000,
};

/** Rooms made per caller: a burst of 10, then one a minute. `rooms.ts`'s own `/challenge` shares this SAME limiter instance. */
export const ROOM_CREATE_RATE_LIMIT: RateLimitConfig = {
	capacity: 10,
	refillAmount: 1,
	refillIntervalMs: 60_000,
};

export interface RoomCoreDeps<V extends RoomViewCore, C, P extends object, G = never> {
	lobby: LobbyCore<V, C>;
	wire: RoomCoreWire<C, P>;
	/** Structured log lines. Never carries a password, hash or salt. */
	log?: (entry: Record<string, unknown>) => void;
	closed?: (roomId: string, matches: readonly string[]) => void;
	/** A tournament entrant's drop (`Lobby.leave`): their match's games to end and its seats' decks to restore. */
	forfeited?: (roomId: string, tableId: string, loser: string, matches: readonly string[]) => void;
	/** "Reset = Close": runs AFTER `closed`, same as `index.ts`'s own `seedTestingRooms` boot call. */
	reseedTesting?: () => void;
	arrived?: (roomId: string, caller: CallerLike) => void;
	/** Each table's game, by table id (`play/table-game.ts`). A hook: this file never inspects `G`'s shape. */
	tableGames?(room: V): Record<string, G>;
	featured?(caller: string): { matchId: string; roomId: string } | null;
	joinRateLimit?: RateLimitConfig;
	createRateLimit?: RateLimitConfig | null;
	now?: () => number;
}

/** The room, as this caller is told it: `V` untouched plus their own row. */
export type RoomBody<V extends RoomViewCore, G = never> = V & {
	you: { id: string; leader: boolean; ready: boolean };
	tableGames?: Record<string, G>;
};

export function badRequest(res: Response, error: string): void {
	res.status(400).json({ error });
}

export function noMatch(res: Response): void {
	res.status(404).json(NO_MATCH);
}

export function notDurable(res: Response, verb = 'create or join'): void {
	res.status(403).json({ error: `the edge did not name you, so you cannot ${verb} a room` });
}

/** The PATCH seam's own narrowing: `P` is otherwise opaque (`{ gameType?: unknown }` trips TS's "weak type" check). */
function hasGameType(v: object): v is { gameType: string } {
	return 'gameType' in v && typeof (v as { gameType?: unknown }).gameType === 'string';
}

/** A testing room, to a non-admin, is as if it did not exist — shared by this file's router and `rooms.ts`'s. */
export function hideTestingRoomsParam<V extends RoomViewCore>(lobby: Pick<LobbyCore<V, never>, 'get'>): (req: Request, res: Response, next: NextFunction, id: string) => void {
	return (req, res, next, id) => {
		const room = lobby.get(id);
		if (room !== undefined && room.testing && !isAdmin(req)) return noMatch(res);
		next();
	};
}

export interface RoomCoreHandle<V extends RoomViewCore, G = never> {
	router: Router;
	roomBody(room: V, callerId: string): RoomBody<V, G>;
	/** The SAME per-caller limiter `POST /` spends from — `rooms.ts`'s `/challenge` too, never a second budget. */
	createLimit(req: Request, res: Response): boolean;
}

export function attachRoomCore<V extends RoomViewCore, C, P extends object, G = never>(
	api: Router,
	deps: RoomCoreDeps<V, C, P, G>,
	opts: {
		beforeWildcard?(router: Router): void;
		/** `{ format }`/`{ settings }`/`{ mode }` (Magic's three other PATCH variants) — method syntax for bivariance, like `LobbyCore`. */
		onPatch?(req: Request, res: Response, body: P, caller: CallerLike, roomId: string): void;
	} = {},
): RoomCoreHandle<V, G> {
	const { lobby, wire } = deps;
	const log = deps.log ?? jsonLogger('cardtable-rooms');
	const now = deps.now ?? Date.now;
	const joinLimiter = new MultiRateLimiter<string>(deps.joinRateLimit ?? JOIN_RATE_LIMIT);

	const roomBody = (room: V, callerId: string): RoomBody<V, G> => {
		const mine = room.members.find((m) => m.id === callerId);
		const games = deps.tableGames?.(room);
		return { ...room, you: { id: callerId, leader: room.leader === callerId, ready: mine?.ready === true }, ...(games === undefined ? {} : { tableGames: games }) };
	};

	const rooms = Router();

	rooms.param('id', hideTestingRoomsParam(lobby));

	rooms.get('/', (req: Request, res: Response) => {
		const me = callerOf(req).id;
		const admin = isAdmin(req);
		// A testing room is never offered to a non-admin.
		const offered = lobby.offered().filter((room) => admin || !room.testing);
		const pick = deps.featured?.(me) ?? null;
		const featured = pick !== null && offered.some((room) => room.id === pick.roomId) ? pick : null;
		res.json({ rooms: offered.map((room) => roomBody(room, me)), featured });
	});

	const createLimit = perCallerLimit(deps.createRateLimit === undefined ? ROOM_CREATE_RATE_LIMIT : deps.createRateLimit, 'too many new rooms; wait a little and try again', {
		act: 'room-create',
		now,
		onRefused: () => log({ event: 'room-create-refused', reason: 'rate-limited' }),
	});
	rooms.post('/', (req: Request, res: Response) => {
		const body = parseBody(wire.createRoomBody, req, res);
		if (body === null || !createLimit(req, res)) return;
		const caller = callerOf(req);
		const result = lobby.create(caller, body);
		if (!result.ok) return notDurable(res);
		deps.arrived?.(result.room.id, caller);
		res.status(201).json(roomBody(result.room, caller.id));
	});

	// The embed's front door: the room bound to the watchparty room whose game slot this is.
	rooms.post('/watchparty', (req: Request, res: Response) => {
		const body = parseBody(wire.watchpartyBindBody, req, res);
		if (body === null) return;
		const caller = callerOf(req);
		if (!lobby.isMember(watchpartyRoomId(body.room), caller.id) && !joinLimiter.allow(caller.id, 1, now())) {
			log({ event: 'room-join-refused', reason: 'rate-limited' });
			res.setHeader('Retry-After', String(Math.ceil((deps.joinRateLimit ?? JOIN_RATE_LIMIT).refillIntervalMs / 1000)));
			return res.status(429).json({ error: 'too many join attempts; wait a little and try again' });
		}
		const result = lobby.bindWatchparty(caller, body.room);
		if (!result.ok) return notDurable(res);
		deps.arrived?.(result.room.id, caller);
		res.json(roomBody(result.room, caller.id));
	});

	// The room a match was started from, for its own members only.
	rooms.get('/of-match/:matchId', (req: Request, res: Response) => {
		const matchId = String(req.params.matchId);
		const room = wire.roomIdRe.test(matchId) ? lobby.roomOfMatch(matchId) : undefined;
		const me = callerOf(req).id;
		if (room === undefined || !lobby.isMember(room.id, me)) return noMatch(res);
		res.json(roomBody(room, me));
	});

	// `rooms.ts`'s own exact-path GET routes (`/challenges`) MUST register here,
	// BEFORE `GET /:id` below — a bare `:id` wildcard matches any one segment,
	// "challenges" included, and Express tries routes in registration order.
	opts.beforeWildcard?.(rooms);

	rooms.get('/:id', (req: Request, res: Response) => {
		const id = String(req.params.id);
		const room = wire.roomIdRe.test(id) ? lobby.get(id) : undefined;
		if (room === undefined) return noMatch(res);
		const me = callerOf(req).id;
		lobby.touch(id, me);
		res.json(roomBody(room, me));
	});

	rooms.post('/:id/join', (req: Request, res: Response) => {
		const body = parseBody(wire.joinRoomBody, req, res);
		if (body === null) return;
		const caller = callerOf(req);
		const id = String(req.params.id);
		// A member re-entering needs no password and spends no token.
		if (wire.roomIdRe.test(id) && lobby.isMember(id, caller.id)) {
			const again = lobby.join(id, caller);
			if (again.ok) {
				deps.arrived?.(id, caller);
				return res.json(roomBody(again.room, caller.id));
			}
		}
		if (!joinLimiter.allow(caller.id, 1, now())) {
			log({ event: 'room-join-refused', reason: 'rate-limited' });
			res.setHeader('Retry-After', String(Math.ceil((deps.joinRateLimit ?? JOIN_RATE_LIMIT).refillIntervalMs / 1000)));
			return res.status(429).json({ error: 'too many join attempts; wait a little and try again' });
		}
		if (!wire.roomIdRe.test(id)) return noMatch(res);
		const result = lobby.join(id, caller, body.password);
		if (!result.ok) {
			if (result.reason === 'not-durable') return notDurable(res);
			log({ event: 'room-join-refused', reason: 'no-match' });
			return noMatch(res);
		}
		deps.arrived?.(id, caller);
		res.json(roomBody(result.room, caller.id));
	});

	rooms.post('/:id/ready', (req: Request, res: Response) => {
		const body = parseBody(wire.readyBody, req, res);
		if (body === null) return;
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return notDurable(res, 'take part in');
		const id = String(req.params.id);
		if (!wire.roomIdRe.test(id) || !lobby.setReady(id, caller.id, body.ready)) return noMatch(res);
		const room = lobby.get(id);
		if (room === undefined) return noMatch(res);
		res.json(roomBody(room, caller.id));
	});

	// A member steps out of their own room. A tournament entrant mid-round is a drop (`forfeited`).
	rooms.post('/:id/leave', (req: Request, res: Response) => {
		if (parseBody(wire.emptyBody, req, res) === null) return;
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return notDurable(res, 'leave');
		const id = String(req.params.id);
		if (!wire.roomIdRe.test(id)) return noMatch(res);
		const result = lobby.leave(id, caller.id);
		if (!result.ok) return noMatch(res);
		if (result.forfeited !== undefined) deps.forfeited?.(id, result.forfeited.tableId, caller.id, result.forfeited.matchIds);
		res.json(roomBody(result.room, caller.id));
	});

	// The owner ends the room for everyone.
	rooms.post('/:id/close', (req: Request, res: Response) => {
		if (parseBody(wire.emptyBody, req, res) === null) return;
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return notDurable(res, 'close');
		const id = String(req.params.id);
		if (!wire.roomIdRe.test(id) || !lobby.isMember(id, caller.id)) return noMatch(res);
		const wasTesting = lobby.get(id)?.testing === true;
		const result = lobby.close(id, caller.id);
		if (!result.ok) {
			if (result.reason === 'no-room') return noMatch(res);
			return res.status(403).json({ error: 'only the room owner can close it' });
		}
		deps.closed?.(id, result.matches);
		if (wasTesting) deps.reseedTesting?.();
		res.json({ ok: true });
	});

	// An admin resets a testing room from the list without joining it.
	rooms.post('/:id/reset', (req: Request, res: Response) => {
		if (parseBody(wire.emptyBody, req, res) === null) return;
		const caller = callerOf(req);
		const id = String(req.params.id);
		if (!wire.roomIdRe.test(id) || !isAdmin(req) || lobby.get(id)?.testing !== true) return noMatch(res);
		const result = lobby.close(id, caller.id);
		if (!result.ok) return noMatch(res);
		deps.closed?.(id, result.matches);
		deps.reseedTesting?.();
		res.json({ ok: true });
	});

	/**
	 * `{ gameType }` is this file's own: the game-type registry is platform.
	 * Everything else `P` can be (Magic's `{ format }`/`{ settings }`/`{ mode }`)
	 * goes to `opts.onPatch`. ONE registration either way — `route-table.json`
	 * admits `PATCH /:id` once.
	 */
	rooms.patch('/:id', (req: Request, res: Response, next: NextFunction) => {
		const v = parseBody(wire.patchRoomBody, req, res);
		if (v === null) return;
		const id = String(req.params.id);
		if (!wire.roomIdRe.test(id)) return noMatch(res);
		if (!hasGameType(v)) {
			if (opts.onPatch === undefined) return next();
			opts.onPatch(req, res, v, callerOf(req), id);
			return;
		}
		const me = callerOf(req).id;
		const result = lobby.setGameType(id, me, v.gameType);
		if (!result.ok) {
			if (result.reason === 'no-room') return noMatch(res);
			if (result.reason === 'draft-started') return res.status(409).json({ error: 'this room is drafting; the game type cannot change now' });
			if (result.reason === 'mode-locked') {
				return res.status(409).json({ error: 'a game is under way or a seated player is ready; the game type cannot change now', reason: result.reason });
			}
			return res.status(403).json({ error: 'only the room leader can change the game type' });
		}
		res.json(roomBody(result.room, me));
	});

	api.use('/rooms', rooms);

	return { router: rooms, roomBody, createLimit };
}

export { bodyErrors };

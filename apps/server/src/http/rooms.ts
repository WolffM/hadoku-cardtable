/**
 * `/api/rooms` — the room list, create, join, and the leader's game-type switch.
 *
 * Mounted on the `api` router AFTER `requireMinTier`, so every caller here is
 * already friend tier. Every friend sees every room (the operator's rule); a
 * room password is privacy between friends, not authentication — see
 * `room/lobby.ts`'s header.
 *
 *   GET   /api/rooms            → 200 { rooms: RoomView[] }
 *   POST  /api/rooms            { name, gameType?, password? }  → 201 RoomView
 *   GET   /api/rooms/:id        → 200 RoomView | 404
 *   POST  /api/rooms/:id/join   { password? }                   → 200 RoomView | 404 | 429
 *   PATCH /api/rooms/:id        { gameType }                    → 200 RoomView | 403 | 404
 *
 * ## A wrong password and a missing room are the same answer
 *
 * Both are `404` with the byte-identical `NO_MATCH` body, as is a room id that is
 * not even well-formed. A 404-vs-403 split would tell an enumerator which ids
 * exist. (The list shows every room to every friend anyway — this is about not
 * building an oracle, not about hiding the list.)
 *
 * ## Ephemeral callers can look but not create or join
 *
 * A caller the edge did not name gets an `eph:` identity minted per request, so
 * they could never be recognised as the same member twice. `create` and `join`
 * answer 403 for them; list and get are open. Behind the edge every friend has a
 * friend key, so this is a dev/direct-hit case, not a production one.
 *
 * ## Nothing here logs a request body
 *
 * The body may carry a password. The only log lines are the lobby's structured
 * events and this file's refusals, all of which are built from ids and enums.
 * A malformed JSON body is caught here too: `JSON.parse`'s message QUOTES the
 * input, and Express's default error handler would print it to stderr.
 */

import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { MultiRateLimiter, type RateLimitConfig } from '@wolffm/rooms-server';
import { userIdOf } from '../edge-auth.js';
import { identityFromHeaders } from '../room/identity.js';
import {
	DEFAULT_GAME_TYPE,
	GAME_TYPES,
	ROOM_ID_RE,
	type Caller,
	type GameType,
	type Lobby,
} from '../room/lobby.js';

/** The single answer for "no such room" and "wrong password". Byte-identical by construction. */
export const NO_MATCH = { error: 'no room with that id and password' } as const;

/**
 * Join attempts per caller: a burst of 10, then one more every 30 s (120 an
 * hour). A friend mistyping a password a few times never notices; a script
 * guessing even a four-letter lowercase password (≈457k candidates) needs
 * over five months. Only NON-member attempts spend a token — a member
 * re-entering their own room (every page load) needs no password and costs
 * nothing.
 */
export const JOIN_RATE_LIMIT: RateLimitConfig = {
	capacity: 10,
	refillAmount: 1,
	refillIntervalMs: 30_000,
};

const NAME_MAX = 60;
const PASSWORD_MAX = 200;

export interface RoomsDeps {
	lobby: Lobby;
	/** Structured log lines. Never carries a password, hash or salt. */
	log?: (entry: Record<string, unknown>) => void;
	/** Overrides `JOIN_RATE_LIMIT`. */
	joinRateLimit?: RateLimitConfig;
	/** Injected for tests; the limiter's clock. */
	now?: () => number;
}

function callerOf(req: Request): Caller {
	return { id: identityFromHeaders(req.headers, `http-${randomUUID()}`), name: userIdOf(req) };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function asObject(body: unknown): Record<string, unknown> | null {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
	return body as Record<string, unknown>;
}

function unknownKeys(body: Record<string, unknown>, allowed: readonly string[]): string[] {
	return Object.keys(body).filter((k) => !allowed.includes(k));
}

function parseGameType(v: unknown): Parsed<GameType> {
	if (typeof v === 'string' && (GAME_TYPES as readonly string[]).includes(v)) {
		return { ok: true, value: v as GameType };
	}
	return { ok: false, error: `gameType must be one of: ${GAME_TYPES.join(', ')}` };
}

/**
 * `undefined`, `null` and `""` all mean "no password" — a blank form field is
 * an open room, not an error. Anything else must be a string of 1–200 chars.
 * The error messages never echo the value.
 */
function parsePassword(v: unknown): Parsed<string | undefined> {
	if (v === undefined || v === null || v === '') return { ok: true, value: undefined };
	if (typeof v !== 'string') return { ok: false, error: 'password must be a string' };
	if (v.length > PASSWORD_MAX) {
		return { ok: false, error: `password must be at most ${PASSWORD_MAX} characters` };
	}
	return { ok: true, value: v };
}

function parseCreate(
	body: unknown,
): Parsed<{ name: string; gameType: GameType; password: string | undefined }> {
	const o = asObject(body);
	if (o === null) return { ok: false, error: 'body must be a JSON object' };
	const extra = unknownKeys(o, ['name', 'gameType', 'password']);
	if (extra.length > 0) return { ok: false, error: `unknown field(s): ${extra.join(', ')}` };
	if (typeof o.name !== 'string') return { ok: false, error: 'name must be a string' };
	const name = o.name.trim();
	if (name.length === 0 || name.length > NAME_MAX) {
		return { ok: false, error: `name must be 1–${NAME_MAX} characters` };
	}
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(name)) {
		return { ok: false, error: 'name must not contain control characters' };
	}
	const gameType = o.gameType === undefined ? ({ ok: true, value: DEFAULT_GAME_TYPE } as const) : parseGameType(o.gameType);
	if (!gameType.ok) return gameType;
	const password = parsePassword(o.password);
	if (!password.ok) return password;
	return { ok: true, value: { name, gameType: gameType.value, password: password.value } };
}

function parseJoin(body: unknown): Parsed<{ password: string | undefined }> {
	// A join with no body at all is a join with no password.
	if (body === undefined) return { ok: true, value: { password: undefined } };
	const o = asObject(body);
	if (o === null) return { ok: false, error: 'body must be a JSON object' };
	const extra = unknownKeys(o, ['password']);
	if (extra.length > 0) return { ok: false, error: `unknown field(s): ${extra.join(', ')}` };
	const password = parsePassword(o.password);
	if (!password.ok) return password;
	return { ok: true, value: { password: password.value } };
}

function parsePatch(body: unknown): Parsed<{ gameType: GameType }> {
	const o = asObject(body);
	if (o === null) return { ok: false, error: 'body must be a JSON object' };
	const extra = unknownKeys(o, ['gameType']);
	if (extra.length > 0) return { ok: false, error: `unknown field(s): ${extra.join(', ')}` };
	const gameType = parseGameType(o.gameType);
	if (!gameType.ok) return gameType;
	return { ok: true, value: { gameType: gameType.value } };
}

function badRequest(res: Response, error: string): void {
	res.status(400).json({ error });
}

function noMatch(res: Response): void {
	res.status(404).json(NO_MATCH);
}

function notDurable(res: Response): void {
	res.status(403).json({ error: 'the edge did not name you, so you cannot create or join a room' });
}

export function attachRooms(api: Router, deps: RoomsDeps): void {
	const { lobby } = deps;
	const log =
		deps.log ??
		((entry: Record<string, unknown>) =>
			console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'cardtable-rooms', ...entry })));
	const now = deps.now ?? Date.now;
	const joinLimiter = new MultiRateLimiter<string>(deps.joinRateLimit ?? JOIN_RATE_LIMIT);

	const rooms = Router();

	rooms.get('/', (_req: Request, res: Response) => {
		res.json({ rooms: lobby.list() });
	});

	rooms.post('/', (req: Request, res: Response) => {
		const parsed = parseCreate(req.body);
		if (!parsed.ok) return badRequest(res, parsed.error);
		const result = lobby.create(callerOf(req), parsed.value);
		if (!result.ok) return notDurable(res);
		res.status(201).json(result.room);
	});

	rooms.get('/:id', (req: Request, res: Response) => {
		const id = String(req.params.id);
		const room = ROOM_ID_RE.test(id) ? lobby.get(id) : undefined;
		if (room === undefined) return noMatch(res);
		res.json(room);
	});

	rooms.post('/:id/join', (req: Request, res: Response) => {
		const parsed = parseJoin(req.body);
		if (!parsed.ok) return badRequest(res, parsed.error);
		const caller = callerOf(req);
		const id = String(req.params.id);
		// A member re-entering needs no password and spends no token.
		if (ROOM_ID_RE.test(id) && lobby.isMember(id, caller.id)) {
			const again = lobby.join(id, caller);
			if (again.ok) return res.json(again.room);
		}
		// Spent BEFORE the room is looked up, so a 429 says nothing about whether
		// the room exists either.
		if (!joinLimiter.allow(caller.id, 1, now())) {
			log({ event: 'room-join-refused', reason: 'rate-limited' });
			res.setHeader('Retry-After', String(Math.ceil((deps.joinRateLimit ?? JOIN_RATE_LIMIT).refillIntervalMs / 1000)));
			return res.status(429).json({ error: 'too many join attempts; wait a little and try again' });
		}
		if (!ROOM_ID_RE.test(id)) return noMatch(res);
		const result = lobby.join(id, caller, parsed.value.password);
		if (!result.ok) {
			if (result.reason === 'not-durable') return notDurable(res);
			log({ event: 'room-join-refused', reason: 'no-match' });
			return noMatch(res);
		}
		res.json(result.room);
	});

	rooms.patch('/:id', (req: Request, res: Response) => {
		const parsed = parsePatch(req.body);
		if (!parsed.ok) return badRequest(res, parsed.error);
		const id = String(req.params.id);
		if (!ROOM_ID_RE.test(id)) return noMatch(res);
		const result = lobby.setGameType(id, callerOf(req).id, parsed.value.gameType);
		if (!result.ok) {
			if (result.reason === 'no-room') return noMatch(res);
			return res.status(403).json({ error: 'only the room leader can change the game type' });
		}
		res.json(result.room);
	});

	api.use('/rooms', rooms);

	// Errors on /rooms — chiefly `express.json()`'s parse failure, raised on the
	// api router BEFORE `rooms` runs. Answered here without the message (it
	// quotes the body, which may hold a password) and logged by name only.
	api.use('/rooms', (err: unknown, _req: Request, res: Response, next: NextFunction) => {
		if (res.headersSent) return next(err);
		const e = err as { type?: unknown; status?: unknown; name?: unknown };
		if (e.type === 'entity.parse.failed') {
			return badRequest(res, 'body is not valid JSON');
		}
		if (typeof e.status === 'number' && e.status >= 400 && e.status < 500) {
			return badRequest(res, 'the request body could not be read');
		}
		log({ event: 'rooms-error', name: typeof e.name === 'string' ? e.name : 'unknown' });
		res.status(500).json({ error: 'internal error' });
	});
}

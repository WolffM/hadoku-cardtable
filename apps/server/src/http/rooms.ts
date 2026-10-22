/**
 * `/api/rooms` — the room list, create, join, and the leader's game-type switch.
 *
 * Mounted on the `api` router AFTER `requireMinTier`, so every caller here is
 * already friend tier. Every friend sees every room (the operator's rule); a
 * room password is privacy between friends, not authentication — see
 * `room/lobby.ts`'s header.
 *
 *   GET   /api/rooms            → 200 { rooms: RoomView[] }
 *   POST  /api/rooms            { name, gameType?, clientMode?, password?, mode?, modeOptions? } → 201 RoomView
 *   GET   /api/rooms/:id        → 200 RoomView | 404
 *   GET   /api/rooms/of-match/:matchId → 200 RoomView (the room that started it, members only) | 404
 *   POST  /api/rooms/:id/join   { password? }                   → 200 RoomView | 404 | 429
 *   POST  /api/rooms/:id/ready  { ready }                       → 200 RoomView | 400 | 403 | 404
 *   POST  /api/rooms/:id/leave  {} or no body                   → 200 RoomView | 403 | 404
 *   POST  /api/rooms/:id/identity { avatarId }                 → 200 RoomView | 400 | 403 | 404
 *   POST  /api/rooms/:id/start  {} or no body                   → 200 RoomView | 403 | 404 | 409
 *   PATCH /api/rooms/:id        { gameType } | { format } | { settings } | { mode, modeOptions? } → 200 RoomView | 403 | 404 | 409
 *   POST  /api/rooms/:id/pod/sit    {} or { seat }               → 200 RoomView | 404 | 409 (wave 72 §P, lobby phase only)
 *   POST  /api/rooms/:id/pod/stand  {} or no body                → 200 RoomView | 404 | 409 (wave 72 §P, lobby phase only)
 *   POST  /api/rooms/:id/pod/play   {} or no body                → 200 RoomView | 403 | 404 | 409 (done building; the last drafter's press deals round 1)
 *   PUT   /api/rooms/:id/pod/plan   { plan }                      → 200 RoomView | 400 | 403 | 404 | 409 { verdict } (wave 73 §A, leader only, lobby phase only)
 *
 * `format` is a frozen era's id or Free pick — never `draft:<podId>`. A drafted
 * deck is played on Free pick ("My decks"); a pod's own tables play its pool by
 * being a `draft` room (`http/routes.ts`'s `effectivePoolOf`), not by a format.
 *
 * Every body that carries a room is `RoomView` plus a caller-scoped
 * `you: { leader, ready }` — see "`you` is the caller's own row" below.
 *
 * ## `ready` and `start` are the room's own, not the table's
 *
 * `/api/tables/rooms/:id/ready` (`http/routes.ts`) is the CONSTRUCTED table's
 * ready: it means "my deck is loaded and legal" and is refused without a deck.
 * This one is the ROOM's, it needs no deck, and it is what a draft starts on.
 * A draft room never touches the tables API at all.
 *
 * `start` may be called by any member, not only the leader — like constructed,
 * where either browser asks and the server answers one start to both — and it is
 * idempotent, so two browsers racing is one draft. A PATCH of the game type is
 * refused with 409 once a draft is running: the pod is dealt against this room's
 * id and is already being played.
 *
 * ## `you` is the caller's own row, and the only caller-scoped thing here
 *
 * `RoomView.leader` is a hashed ParticipantId and `RoomMember.id` is another
 * one; nothing told a client WHICH of them was theirs, so the room screen could
 * not tell that it was the leader and could not tell whether the ready flag it
 * was drawing was its own. `RoomView` cannot answer that — it has no caller — so
 * the answer is added here, where the request is: `you.leader` and `you.ready`,
 * derived from `identityFromHeaders` exactly as every other route derives the
 * caller. A non-member gets `{ leader: false, ready: false }`, which is the
 * truth for them, and the list carries one `you` per room for the same reason.
 *
 * ## The PATCH takes one field at a time
 *
 * `{ gameType }`, `{ format }` and `{ settings }` are separate lobby mutations
 * with separate refusals, so a body carrying both is a 400 rather than a write that
 * half-lands. That is the same discipline as the allow-list itself: this file
 * refuses what it will not honour whole (see `clientMode` below).
 *
 * ## `clientMode` is a create-only field
 *
 * A room's client mode decides what the server provisions for it, so it is
 * chosen once and never changed. POST takes it (defaulting to `builtin`); every
 * other route refuses it, because each one allow-lists its own body keys and
 * `clientMode` is on none of those lists — so a PATCH carrying it is a 400
 * `unknown field(s): clientMode`, not an accepted-and-ignored write. If an
 * update path is ever wanted it has to be added deliberately; it cannot arrive
 * by a field quietly passing through.
 *
 * ## A wrong password and a missing room are the same answer
 *
 * Both are `404` with the byte-identical `NO_MATCH` body, as is a room id that is
 * not even well-formed, and so is a caller who is not a member of the room they
 * are trying to ready up in. A 404-vs-403 split would tell an enumerator which
 * ids exist. (The list shows every room to every friend anyway — this is about not
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
import { isDurableParticipantId } from '@wolffm/rooms-protocol';
import { userNameOf } from '../edge-auth.js';
import { identityFromHeaders } from '../room/identity.js';
import {
	CONSTRUCTED_MODES,
	DEFAULT_GAME_TYPE,
	GAME_TYPES,
	POD_SEATS,
	RoomModeSchema,
	SetDraftPlanBodySchema,
	type DraftPlan,
	type GameType,
	type PoolVerdict,
	type RoomMode,
} from '@hadoku/shared';
import {
	AVATAR_ID_MAX,
	CLIENT_MODES,
	DEFAULT_CLIENT_MODE,
	DEFAULT_ROOM_SETTINGS,
	DRAFT_POOL_PREFIX,
	POD_MIN_OPEN,
	ROOM_ID_RE,
	watchpartyRoomId,
	type Caller,
	type ClientMode,
	type FormatId,
	type Lobby,
	type RoomSettings,
	type RoomView,
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
	/** A room its owner closed: stop the matches it was playing and drop its draft if unfinished. */
	closed?: (roomId: string, matches: readonly string[]) => void;
	/** Overrides `JOIN_RATE_LIMIT`. */
	joinRateLimit?: RateLimitConfig;
	/** Injected for tests; the limiter's clock. */
	now?: () => number;
	/**
	 * The verdict for a plan (`room/plan.ts`'s `checkPlan`, bound to the
	 * server's cube lookup and Forge checker) — `PUT …/pod/plan` runs this
	 * BEFORE calling `lobby.setPodPlan`, since computing it is the one thing in
	 * this request that needs async I/O. `index.ts` wires the real deps (the
	 * interim shortlist `CubeLookup` and a `null` `ForgeChecker` for steps 1-5;
	 * C's `createCubeStore` and D's `createForgePools` at step 6).
	 */
	checkPlan: (plan: DraftPlan) => Promise<PoolVerdict>;
}

function callerOf(req: Request): Caller {
	// The DISPLAY NAME, not the id. This was `userIdOf(req)` — an opaque
	// registry identifier — so every room roster read like
	// "2a25151a-5ec8-…". The name arrives edge-injected beside the id
	// (`X-User-Name`); a key that was never named falls back to a word rather
	// than an identifier, because a roster is for humans.
	return { id: identityFromHeaders(req.headers, `http-${randomUUID()}`), name: userNameOf(req) ?? 'friend' };
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

/** Same shape as `parseGameType`: an unknown value is a stated refusal, never a silent default. */
function parseClientMode(v: unknown): Parsed<ClientMode> {
	if (typeof v === 'string' && (CLIENT_MODES as readonly string[]).includes(v)) {
		return { ok: true, value: v as ClientMode };
	}
	return { ok: false, error: `clientMode must be one of: ${CLIENT_MODES.join(', ')}` };
}

/**
 * A constructed room's mode with its options (`RoomModeSchema`): Classic and
 * Gauntlet may leave `modeOptions` out, All Random may not. Options that belong
 * to another mode are refused, never dropped.
 */
function parseMode(mode: unknown, modeOptions: unknown): Parsed<RoomMode> {
	if (!(CONSTRUCTED_MODES as readonly unknown[]).includes(mode)) {
		return { ok: false, error: `mode must be one of: ${CONSTRUCTED_MODES.join(', ')}` };
	}
	const parsed = RoomModeSchema.safeParse(modeOptions === undefined ? { mode } : { mode, modeOptions });
	return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: `modeOptions are not ${String(mode)}'s options` };
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
): Parsed<{ name: string; gameType: GameType; clientMode: ClientMode; password: string | undefined; mode: RoomMode | undefined }> {
	const o = asObject(body);
	if (o === null) return { ok: false, error: 'body must be a JSON object' };
	const extra = unknownKeys(o, ['name', 'gameType', 'clientMode', 'password', 'mode', 'modeOptions']);
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
	const clientMode =
		o.clientMode === undefined ? ({ ok: true, value: DEFAULT_CLIENT_MODE } as const) : parseClientMode(o.clientMode);
	if (!clientMode.ok) return clientMode;
	const password = parsePassword(o.password);
	if (!password.ok) return password;
	let mode: RoomMode | undefined;
	if (o.mode !== undefined || o.modeOptions !== undefined) {
		if (gameType.value !== 'constructed-1v1') return { ok: false, error: 'only a constructed room has a mode' };
		const parsed = parseMode(o.mode, o.modeOptions);
		if (!parsed.ok) return parsed;
		mode = parsed.value;
	}
	return {
		ok: true,
		value: { name, gameType: gameType.value, clientMode: clientMode.value, password: password.value, mode },
	};
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

/** Same allow-list discipline as the others: `{ ready: boolean }` and nothing else. */
/** Watchparty's room id is opaque to us; this only bounds what is hashed. */
const WATCHPARTY_ROOM_MAX = 200;

function parseWatchpartyBind(body: unknown): Parsed<{ room: string }> {
	const o = asObject(body);
	if (o === null) return { ok: false, error: 'body must be a JSON object' };
	const extra = unknownKeys(o, ['room']);
	if (extra.length > 0) return { ok: false, error: `unknown field(s): ${extra.join(', ')}` };
	if (typeof o.room !== 'string' || o.room.length === 0 || o.room.length > WATCHPARTY_ROOM_MAX) {
		return { ok: false, error: `room must be 1–${WATCHPARTY_ROOM_MAX} characters` };
	}
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(o.room)) return { ok: false, error: 'room must not contain control characters' };
	return { ok: true, value: { room: o.room } };
}

function parseReady(body: unknown): Parsed<{ ready: boolean }> {
	const o = asObject(body);
	if (o === null) return { ok: false, error: 'body must be a JSON object' };
	const extra = unknownKeys(o, ['ready']);
	if (extra.length > 0) return { ok: false, error: `unknown field(s): ${extra.join(', ')}` };
	if (typeof o.ready !== 'boolean') return { ok: false, error: 'ready must be a boolean' };
	return { ok: true, value: { ready: o.ready } };
}

/**
 * `{ avatarId }`, where the field is REQUIRED and may be null.
 *
 * The three states of `avatarId?: string | null` mean three different things and
 * only two of them are a request: a string is "this is my character", `null` is
 * "I have none any more". ABSENT is neither, so it is a 400 rather than a
 * no-op write — the same discipline as `parseReady`, which will not accept a
 * body that forgot to say which way. A body that means nothing must not be
 * answerable with a 200 that changed nothing.
 *
 * `''` is refused rather than folded into `null`, because an empty string on
 * this route is a client bug and telling it so is cheaper than it finding out
 * from a face that will not draw. The lobby folds it anyway (`avatarIdOf`), so
 * the two layers cannot disagree about what is stored — only about whether the
 * caller is told.
 */
function parseAvatar(body: unknown): Parsed<{ avatarId: string | null }> {
	const o = asObject(body);
	if (o === null) return { ok: false, error: 'body must be a JSON object' };
	const extra = unknownKeys(o, ['avatarId']);
	if (extra.length > 0) return { ok: false, error: `unknown field(s): ${extra.join(', ')}` };
	if (o.avatarId === null) return { ok: true, value: { avatarId: null } };
	if (typeof o.avatarId !== 'string') return { ok: false, error: 'avatarId must be a string or null' };
	const id = o.avatarId.trim();
	if (id === '' || id.length > AVATAR_ID_MAX) {
		return { ok: false, error: `avatarId must be 1\u2013${AVATAR_ID_MAX} characters, or null to clear it` };
	}
	return { ok: true, value: { avatarId: id } };
}

/** A start carries nothing. No body at all is the same as `{}`. */
function parseStart(body: unknown): Parsed<Record<string, never>> {
	if (body === undefined) return { ok: true, value: {} };
	const o = asObject(body);
	if (o === null) return { ok: false, error: 'body must be a JSON object' };
	const extra = unknownKeys(o, []);
	if (extra.length > 0) return { ok: false, error: `unknown field(s): ${extra.join(', ')}` };
	return { ok: true, value: {} };
}

/**
 * `{}` or `{ seat }` — wave 72 §P's `POST …/pod/sit`. `seat` absent takes the
 * first free one; given, it must be an integer `0..POD_SEATS - 1` — the
 * lobby's own range, restated here only to answer a malformed value with a
 * stated 400 rather than `lobby.sitPod`'s bare `bad-seat`.
 */
function parseSit(body: unknown): Parsed<{ seat: number | undefined }> {
	if (body === undefined) return { ok: true, value: { seat: undefined } };
	const o = asObject(body);
	if (o === null) return { ok: false, error: 'body must be a JSON object' };
	const extra = unknownKeys(o, ['seat']);
	if (extra.length > 0) return { ok: false, error: `unknown field(s): ${extra.join(', ')}` };
	if (o.seat === undefined) return { ok: true, value: { seat: undefined } };
	if (typeof o.seat !== 'number' || !Number.isInteger(o.seat) || o.seat < 0 || o.seat >= POD_SEATS) {
		return { ok: false, error: `seat must be an integer 0..${POD_SEATS - 1}` };
	}
	return { ok: true, value: { seat: o.seat } };
}

/**
 * A format id is any non-blank string; whether it names a pool THIS server has
 * is the tables layer's answer (`http/routes.ts`'s `unknownPool`, a 409 about
 * the room rather than a 400 about the body).
 *
 * A drafted pool is refused at the door (operator, 2026-10-20). Putting a room
 * on `draft:<podId>` tied its table to that pod's socket, which answers nobody
 * once the pod's room has closed — so nobody's deck ever loaded. A drafted deck
 * is played on Free pick, from "My decks", as its saved `.dck`.
 */
function parseFormat(v: unknown): Parsed<FormatId> {
	if (typeof v !== 'string' || v.trim() === '') return { ok: false, error: 'format must be a format id' };
	if (v.startsWith(DRAFT_POOL_PREFIX)) {
		return { ok: false, error: 'format must be a format id: a drafted deck is played on Free pick' };
	}
	return { ok: true, value: v };
}

/**
 * Some of the room's settings, every one a boolean. An empty object is
 * refused: a PATCH that changes nothing is a client that meant something else.
 */
function parseSettings(v: unknown): Parsed<Partial<RoomSettings>> {
	const o = asObject(v);
	if (o === null) return { ok: false, error: 'settings must be an object' };
	const extra = unknownKeys(o, Object.keys(DEFAULT_ROOM_SETTINGS));
	if (extra.length > 0) return { ok: false, error: `unknown setting(s): ${extra.join(', ')}` };
	if (Object.keys(o).length === 0) return { ok: false, error: 'settings names no setting' };
	const bad = Object.keys(o).find((k) => typeof o[k] !== 'boolean');
	if (bad !== undefined) return { ok: false, error: `settings.${bad} must be a boolean` };
	return { ok: true, value: o as Partial<RoomSettings> };
}

/** One field, one mutation. `{ gameType }`, `{ format }`, `{ settings }` or `{ mode }` (with its options) — exactly one. */
type PatchBody = { gameType: GameType } | { format: FormatId } | { settings: Partial<RoomSettings> } | { mode: RoomMode };

function parsePatch(body: unknown): Parsed<PatchBody> {
	const o = asObject(body);
	if (o === null) return { ok: false, error: 'body must be a JSON object' };
	// The allow-list is the refusal: `clientMode` is not on it, so a PATCH
	// carrying it is a 400 rather than a write nobody notices. See the header.
	const extra = unknownKeys(o, ['gameType', 'format', 'settings', 'mode', 'modeOptions']);
	if (extra.length > 0) return { ok: false, error: `unknown field(s): ${extra.join(', ')}` };
	// Two fields is refused rather than applied in some order: each has its own
	// refusal, and a body whose halves disagree must not half-land. `modeOptions`
	// is not a field of its own: it rides with `mode`.
	const modeField = o.mode !== undefined || o.modeOptions !== undefined ? true : undefined;
	if ([o.gameType, o.format, o.settings, modeField].filter((v) => v !== undefined).length > 1) {
		return { ok: false, error: 'patch one field at a time: gameType, format, settings or mode' };
	}
	if (modeField) {
		const mode = parseMode(o.mode, o.modeOptions);
		return mode.ok ? { ok: true, value: { mode: mode.value } } : mode;
	}
	if (o.settings !== undefined) {
		const settings = parseSettings(o.settings);
		return settings.ok ? { ok: true, value: { settings: settings.value } } : settings;
	}
	if (o.format !== undefined) {
		const format = parseFormat(o.format);
		return format.ok ? { ok: true, value: { format: format.value } } : format;
	}
	const gameType = parseGameType(o.gameType);
	if (!gameType.ok) return gameType;
	return { ok: true, value: { gameType: gameType.value } };
}

/**
 * The room, as this caller is told it: the public `RoomView` plus their own row.
 *
 * `you.leader` is the flag the room screen could not compute for itself, and
 * `you.ready` is the ROOM's ready flag for this caller — the one wave 23's room
 * screen had to guess at after a reload, which is why a reload while ready
 * relabelled the button and could not stand down in one click.
 */
export interface RoomBody extends RoomView {
	/** `id` is the caller's own member id — the one the room's tables and pod name them by, whatever the session's whoami says. */
	you: { id: string; leader: boolean; ready: boolean };
}

function roomBody(room: RoomView, callerId: string): RoomBody {
	const mine = room.members.find((m) => m.id === callerId);
	return { ...room, you: { id: callerId, leader: room.leader === callerId, ready: mine?.ready === true } };
}

function badRequest(res: Response, error: string): void {
	res.status(400).json({ error });
}

function noMatch(res: Response): void {
	res.status(404).json(NO_MATCH);
}

/**
 * The verb is the caller's, because the sentence is read by a person. Create and
 * join keep the wording they have always had; `ready` and `start` are not
 * creating anything, so they say what they actually are.
 */
function notDurable(res: Response, verb = 'create or join'): void {
	res.status(403).json({ error: `the edge did not name you, so you cannot ${verb} a room` });
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

	rooms.get('/', (req: Request, res: Response) => {
		// One `you` per room: the front page says which rooms you lead and which
		// you have already readied in, without a second request per room.
		const me = callerOf(req).id;
		// `offered`, not `list`: a room nobody has touched for
		// `ROOM_STALE_MS` is a dead table and is not advertised (wave 31).
		res.json({ rooms: lobby.offered().map((room) => roomBody(room, me)) });
	});

	rooms.post('/', (req: Request, res: Response) => {
		const parsed = parseCreate(req.body);
		if (!parsed.ok) return badRequest(res, parsed.error);
		const caller = callerOf(req);
		const result = lobby.create(caller, parsed.value);
		if (!result.ok) return notDurable(res);
		res.status(201).json(roomBody(result.room, caller.id));
	});

	// The embed's front door (D21): the cardtable room bound to the watchparty
	// room whose game slot this is, made on first use. Joining it spends a join
	// token exactly as `/:id/join` does for a newcomer, so binding is no cheaper
	// a way to probe or flood than joining is. The watchparty name is never
	// logged (see `watchpartyRoomId`).
	rooms.post('/watchparty', (req: Request, res: Response) => {
		const parsed = parseWatchpartyBind(req.body);
		if (!parsed.ok) return badRequest(res, parsed.error);
		const caller = callerOf(req);
		if (!lobby.isMember(watchpartyRoomId(parsed.value.room), caller.id) && !joinLimiter.allow(caller.id, 1, now())) {
			log({ event: 'room-join-refused', reason: 'rate-limited' });
			res.setHeader('Retry-After', String(Math.ceil((deps.joinRateLimit ?? JOIN_RATE_LIMIT).refillIntervalMs / 1000)));
			return res.status(429).json({ error: 'too many join attempts; wait a little and try again' });
		}
		const result = lobby.bindWatchparty(caller, parsed.value.room);
		if (!result.ok) return notDurable(res);
		res.json(roomBody(result.room, caller.id));
	});

	// The room a match was started from, for its own members: a match screen's
	// route carries only the match, and its result screen readies at the room's
	// table for a Rematch. A finished or restarted-over match still answers
	// (`Lobby.roomOfMatch`). Anyone else is the same 404 as a room that is not there.
	rooms.get('/of-match/:matchId', (req: Request, res: Response) => {
		const matchId = String(req.params.matchId);
		const room = ROOM_ID_RE.test(matchId) ? lobby.roomOfMatch(matchId) : undefined;
		const me = callerOf(req).id;
		if (room === undefined || !lobby.isMember(room.id, me)) return noMatch(res);
		res.json(roomBody(room, me));
	});

	rooms.get('/:id', (req: Request, res: Response) => {
		const id = String(req.params.id);
		const room = ROOM_ID_RE.test(id) ? lobby.get(id) : undefined;
		if (room === undefined) return noMatch(res);
		const me = callerOf(req).id;
		// The room screen reads this; a member's read (or open watch, `room/feed.ts`) keeps a room offered.
		lobby.touch(id, me);
		res.json(roomBody(room, me));
	});

	rooms.post('/:id/join', (req: Request, res: Response) => {
		const parsed = parseJoin(req.body);
		if (!parsed.ok) return badRequest(res, parsed.error);
		const caller = callerOf(req);
		const id = String(req.params.id);
		// A member re-entering needs no password and spends no token.
		if (ROOM_ID_RE.test(id) && lobby.isMember(id, caller.id)) {
			const again = lobby.join(id, caller);
			if (again.ok) return res.json(roomBody(again.room, caller.id));
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
		res.json(roomBody(result.room, caller.id));
	});

	rooms.post('/:id/ready', (req: Request, res: Response) => {
		const parsed = parseReady(req.body);
		if (!parsed.ok) return badRequest(res, parsed.error);
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return notDurable(res, 'take part in');
		const id = String(req.params.id);
		// A non-member is the same 404 as a room that does not exist. There is no
		// join-by-readying: entering a room is what makes someone a member.
		if (!ROOM_ID_RE.test(id) || !lobby.setReady(id, caller.id, parsed.value.ready)) return noMatch(res);
		const room = lobby.get(id);
		if (room === undefined) return noMatch(res);
		res.json(roomBody(room, caller.id));
	});

	/**
	 * A member steps out of their own room (R16). No body: `parseStart`'s shape
	 * is reused because the refusal for an unexpected field is identical and a
	 * second function would say the same thing twice.
	 *
	 * If the leader leaves, leadership passes to whoever remaining joined
	 * earliest — `lobby.leave`'s own ruling, not this file's. A non-member and
	 * a room that does not exist are the server's usual single 404, same as
	 * `ready` and `start`: there is no sentence someone who was never in a room
	 * needs that differs from "no such room".
	 *
	 * This is the "Main menu" half of the result screen's two buttons (L's
	 * seam): leave, then navigate to the lobby list. "Rematch" does not call
	 * this at all — it stays a member and readies at the room's table
	 * (`POST /api/tables/rooms/:id/ready`).
	 */
	rooms.post('/:id/leave', (req: Request, res: Response) => {
		const parsed = parseStart(req.body);
		if (!parsed.ok) return badRequest(res, parsed.error);
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return notDurable(res, 'leave');
		const id = String(req.params.id);
		if (!ROOM_ID_RE.test(id)) return noMatch(res);
		const result = lobby.leave(id, caller.id);
		if (!result.ok) return noMatch(res);
		res.json(roomBody(result.room, caller.id));
	});

	/**
	 * The owner ends the room for everyone (the operator, 2026-10-19: *"lobby
	 * owner needs to be able to 'close' a tournament"*). A non-member gets the
	 * usual 404; a member who is not the owner, a 403.
	 */
	rooms.post('/:id/close', (req: Request, res: Response) => {
		const o = asObject(req.body ?? {});
		if (o === null) return badRequest(res, 'body must be a JSON object');
		const extra = unknownKeys(o, []);
		if (extra.length > 0) return badRequest(res, `unknown field(s): ${extra.join(', ')}`);
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return notDurable(res, 'close');
		const id = String(req.params.id);
		if (!ROOM_ID_RE.test(id) || !lobby.isMember(id, caller.id)) return noMatch(res);
		const result = lobby.close(id, caller.id);
		if (!result.ok) {
			if (result.reason === 'no-room') return noMatch(res);
			return res.status(403).json({ error: 'only the room owner can close it' });
		}
		deps.closed?.(id, result.matches);
		res.json({ ok: true });
	});

	/**
	 * The caller's own avatar in this room — the last hop of the operator's
	 * *"you're still not pulling in the watchparty selected avatars"*.
	 *
	 * ## Why this one identity field is ACCEPTED and not derived
	 *
	 * `name` arrives edge-injected (`X-User-Name`) and the participant id is
	 * hashed from the edge's headers, so neither is ever read off a body — see
	 * `room/identity.ts`, "Derived, never accepted". There is no `X-User-Avatar`
	 * and there is no reason for the edge to invent one: the avatar is a choice
	 * the viewer makes inside WATCHPARTY's chrome, saved in watchparty's own prefs
	 * row, and the edge has never seen it.
	 *
	 * So it comes from the browser, and the thing that makes that safe is that
	 * the ROW it lands on is not negotiable: `callerOf(req)` is the derived
	 * ParticipantId, and `setAvatar` will only touch that member. A body cannot
	 * name somebody else, and the worst a caller can do is draw the wrong face on
	 * their own seat. That is a cosmetic property of a person, not a credential.
	 *
	 * ## One door, not three
	 *
	 * Create and join do NOT take the field. A room a friend has been in all
	 * evening needs its avatar updated without re-creating or re-joining, so the
	 * update path has to exist anyway — and two doors onto one value is how the
	 * two come to disagree. `Caller` therefore stays exactly what it was, which
	 * keeps `callerOf`'s header-only reading intact.
	 *
	 * A non-member, and a room that does not exist, are the same 404 as
	 * everywhere else in this file. A browser asserting its avatar against a
	 * MATCH id gets that 404 and is right to ignore it — see the client.
	 */
	rooms.post('/:id/identity', (req: Request, res: Response) => {
		const parsed = parseAvatar(req.body);
		if (!parsed.ok) return badRequest(res, parsed.error);
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return notDurable(res, 'take part in');
		// The match route has no room id of its own: the client names the MATCH it is
		// on. Match ids are not `r-` ids but do fit `ROOM_ID_RE`'s alphabet, so a match
		// lookup goes FIRST and the name is used as a room id only when it is no
		// match. This was a 404 for both players at every match start.
		const named = String(req.params.id);
		const id = lobby.roomOfMatch(named)?.id ?? named;
		if (!ROOM_ID_RE.test(id) || !lobby.setAvatar(id, caller.id, parsed.value.avatarId)) return noMatch(res);
		const room = lobby.get(id);
		if (room === undefined) return noMatch(res);
		res.json(roomBody(room, caller.id));
	});

	rooms.post('/:id/start', (req: Request, res: Response) => {
		const parsed = parseStart(req.body);
		if (!parsed.ok) return badRequest(res, parsed.error);
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return notDurable(res, 'take part in');
		const id = String(req.params.id);
		if (!ROOM_ID_RE.test(id)) return noMatch(res);
		const result = lobby.startDraft(id, caller.id);
		if (!result.ok) {
			// `not-member` is deliberately the same answer as `no-room`.
			if (result.reason === 'no-room' || result.reason === 'not-member') return noMatch(res);
			// A sentence, because the room screen shows it to whoever clicked.
			return res.status(409).json({
				error:
					result.reason === 'not-draft'
						? 'this room is not playing a draft'
						: 'every seat needs a player or the AI, and every player ready, before the draft starts',
			});
		}
		res.json(roomBody(result.room, caller.id));
	});

	/**
	 * Take a pod seat (wave 72 §P), lobby phase only. `seat` absent takes the
	 * first free one. Leader and non-leader alike — the pod lobby reuses the
	 * 1v1 table's own seat UI, and sitting is not a leader act there either.
	 */
	rooms.post('/:id/pod/sit', (req: Request, res: Response) => {
		const parsed = parseSit(req.body);
		if (!parsed.ok) return badRequest(res, parsed.error);
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return notDurable(res, 'take part in');
		const id = String(req.params.id);
		if (!ROOM_ID_RE.test(id)) return noMatch(res);
		const result = lobby.sitPod(id, caller.id, parsed.value.seat);
		if (!result.ok) {
			if (result.reason === 'no-room' || result.reason === 'not-member') return noMatch(res);
			const error =
				result.reason === 'not-draft'
					? 'this room does not have a pod'
					: result.reason === 'not-lobby'
						? 'the pod has already started — seats are fixed'
						: result.reason === 'bad-seat'
							? `seat must be an integer 0..${POD_SEATS - 1}`
							: result.reason === 'seat-taken'
								? 'that seat is already taken'
								: 'the pod is full';
			return res.status(409).json({ error });
		}
		res.json(roomBody(result.room, caller.id));
	});

	/** Give up a pod seat, lobby phase only. Idempotent: not seated answers `ok` and changes nothing. */
	rooms.post('/:id/pod/stand', (req: Request, res: Response) => {
		const parsed = parseStart(req.body);
		if (!parsed.ok) return badRequest(res, parsed.error);
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return notDurable(res, 'take part in');
		const id = String(req.params.id);
		if (!ROOM_ID_RE.test(id)) return noMatch(res);
		const result = lobby.standPod(id, caller.id);
		if (!result.ok) {
			if (result.reason === 'no-room' || result.reason === 'not-member') return noMatch(res);
			return res.status(409).json({
				error: result.reason === 'not-draft' ? 'this room does not have a pod' : 'the pod has already started — seats are fixed',
			});
		}
		res.json(roomBody(result.room, caller.id));
	});

	/**
	 * The AI button on an open pod seat (`{ seat, on: true }`), or taking it
	 * back out (`on: false`), lobby phase only, any member. The draft deals
	 * only once no seat is open (`room/lobby.ts`'s `startDraft`).
	 */
	rooms.post('/:id/pod/ai', (req: Request, res: Response) => {
		const o = asObject(req.body);
		if (o === null) return badRequest(res, 'body must be a JSON object');
		const extra = unknownKeys(o, ['seat', 'on']);
		if (extra.length > 0) return badRequest(res, `unknown field(s): ${extra.join(', ')}`);
		if (typeof o.seat !== 'number' || !Number.isInteger(o.seat) || o.seat < 0 || o.seat >= POD_SEATS) {
			return badRequest(res, `seat must be an integer 0..${POD_SEATS - 1}`);
		}
		if (typeof o.on !== 'boolean') return badRequest(res, 'on must be true or false');
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return notDurable(res, 'take part in');
		const id = String(req.params.id);
		if (!ROOM_ID_RE.test(id)) return noMatch(res);
		const result = lobby.aiPod(id, caller.id, o.seat, o.on);
		if (!result.ok) {
			if (result.reason === 'no-room' || result.reason === 'not-member') return noMatch(res);
			const error =
				result.reason === 'not-draft'
					? 'this room does not have a pod'
					: result.reason === 'not-lobby'
						? 'the pod has already started — seats are fixed'
						: 'that seat is already taken';
			return res.status(409).json({ error });
		}
		res.json(roomBody(result.room, caller.id));
	});

	/** Close an empty pod seat, or open a closed one: the owner's, before the draft (`Lobby.closePod`). */
	rooms.post('/:id/pod/close', (req: Request, res: Response) => {
		const o = asObject(req.body);
		if (o === null) return badRequest(res, 'body must be a JSON object');
		const extra = unknownKeys(o, ['seat', 'closed']);
		if (extra.length > 0) return badRequest(res, `unknown field(s): ${extra.join(', ')}`);
		if (typeof o.seat !== 'number' || !Number.isInteger(o.seat) || o.seat < 0 || o.seat >= POD_SEATS) {
			return badRequest(res, `seat must be an integer 0..${POD_SEATS - 1}`);
		}
		if (typeof o.closed !== 'boolean') return badRequest(res, 'closed must be true or false');
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return notDurable(res, 'take part in');
		const id = String(req.params.id);
		if (!ROOM_ID_RE.test(id)) return noMatch(res);
		const result = lobby.closePod(id, caller.id, o.seat, o.closed);
		if (!result.ok) {
			if (result.reason === 'no-room' || result.reason === 'not-member') return noMatch(res);
			if (result.reason === 'not-leader') return res.status(403).json({ error: 'only the room owner closes seats' });
			const error =
				result.reason === 'not-draft'
					? 'this room does not have a pod'
					: result.reason === 'not-lobby'
						? 'the pod has already started — seats are fixed'
						: result.reason === 'too-few'
							? `a pod keeps at least ${POD_MIN_OPEN} seats`
							: 'that seat is taken';
			return res.status(409).json({ error });
		}
		res.json(roomBody(result.room, caller.id));
	});

	/**
	 * Done building — the deck editor's Play. Refused until the caller's deck
	 * is saved and legal; the last drafter's press deals round 1
	 * (`room/lobby.ts`'s `playPod`).
	 */
	rooms.post('/:id/pod/play', (req: Request, res: Response) => {
		const parsed = parseStart(req.body);
		if (!parsed.ok) return badRequest(res, parsed.error);
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return notDurable(res, 'take part in');
		const id = String(req.params.id);
		if (!ROOM_ID_RE.test(id)) return noMatch(res);
		const result = lobby.playPod(id, caller.id);
		if (!result.ok) {
			if (result.reason === 'no-room') return noMatch(res);
			if (result.reason === 'not-drafter') return res.status(403).json({ error: 'you did not draft in this pod' });
			return res.status(409).json({ error: 'your deck is not saved and legal yet' });
		}
		res.json(roomBody(result.room, caller.id));
	});

	/**
	 * The leader's pool choice (wave 73 §A), lobby phase only — the wire
	 * contract's own words: "it runs the verdict first. Refused: 409 {
	 * verdict }, and the plan is unchanged. Accepted: 200, and the plan is
	 * broadcast on the room like any pod change." `kind: 'set'` is refused at
	 * 400 this wave (sets are wave 74); everything else goes to `checkPlan`
	 * BEFORE `lobby.setPodPlan` ever sees it, since that is this request's one
	 * piece of async I/O (`room/plan.ts`'s `checkSource`/`checkPlan`).
	 */
	rooms.put('/:id/pod/plan', async (req: Request, res: Response) => {
		const parsed = SetDraftPlanBodySchema.safeParse(req.body);
		if (!parsed.success) return badRequest(res, 'body is { plan: { rounds: [source, source, source] } }');
		if (parsed.data.plan.rounds.some((r) => r.kind === 'set')) return badRequest(res, 'set sources are not supported yet');
		const caller = callerOf(req);
		if (!isDurableParticipantId(caller.id)) return notDurable(res, 'take part in');
		const id = String(req.params.id);
		if (!ROOM_ID_RE.test(id)) return noMatch(res);

		const verdict = await deps.checkPlan(parsed.data.plan);
		const result = lobby.setPodPlan(id, caller.id, parsed.data.plan, verdict);
		if (!result.ok) {
			if (result.reason === 'no-room' || result.reason === 'not-member') return noMatch(res);
			if (result.reason === 'not-leader') return res.status(403).json({ error: 'only the room owner sets the draft pool' });
			if (result.reason === 'refused') return res.status(409).json({ verdict: result.verdict });
			return res.status(409).json({
				error: result.reason === 'not-draft' ? 'this room does not have a pod' : 'the pod has already started — the pool is fixed',
			});
		}
		res.json(roomBody(result.room, caller.id));
	});

	rooms.patch('/:id', (req: Request, res: Response) => {
		const parsed = parsePatch(req.body);
		if (!parsed.ok) return badRequest(res, parsed.error);
		const id = String(req.params.id);
		if (!ROOM_ID_RE.test(id)) return noMatch(res);
		const me = callerOf(req).id;
		// Two settings, one leader, one refusal shape. The noun in each sentence is
		// the setting the caller asked for, because the room screen shows it.
		const v = parsed.value;
		const what = 'format' in v ? 'format' : 'settings' in v ? 'settings' : 'mode' in v ? 'mode' : 'game type';
		const result =
			'format' in v
				? lobby.setFormat(id, me, v.format)
				: 'settings' in v
					? lobby.setSettings(id, me, v.settings)
					: 'mode' in v
						? lobby.setMode(id, me, v.mode)
						: lobby.setGameType(id, me, v.gameType);
		if (!result.ok) {
			if (result.reason === 'no-room') return noMatch(res);
			if (result.reason === 'draft-started') {
				return res.status(409).json({ error: `this room is drafting; the ${what} cannot change now` });
			}
			if (result.reason === 'not-constructed') {
				return res.status(409).json({ error: 'only a constructed room has a mode', reason: result.reason });
			}
			if (result.reason === 'mode-locked') {
				return res.status(409).json({ error: 'a seated player is ready; the mode cannot change now', reason: result.reason });
			}
			return res.status(403).json({ error: `only the room leader can change the ${what}` });
		}
		res.json(roomBody(result.room, me));
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

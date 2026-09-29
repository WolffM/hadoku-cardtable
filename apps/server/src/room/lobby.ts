/**
 * The lobby — which rooms exist, who is in them, and what they are playing.
 *
 * The operator's rule is "every friend sees every room, and should be able to
 * enter any room unless the room is password protected". Watchparty keeps
 * `cardtable-*` rooms out of ITS lobby on purpose, so the list is ours; their
 * chrome gives chat and roster INSIDE a room, and this file says which rooms
 * there are.
 *
 * ## Persistence: write-through, through `@hadoku/room-store`
 *
 * This repo redeploys on every push to `main`, so an in-memory room list would
 * evaporate several times a day — taking passwords and deck choices with it.
 * Every mutation writes that room's snapshot synchronously (`FileRoomStore`'s
 * atomic temp-file-and-rename) before the call returns, so there is no debounce
 * window for a deploy to fall into and no flush-on-SIGTERM to get right. The
 * write rate is a handful of clicks per game; a debounce would buy nothing.
 *
 * Rooms are stored in room-store's own snapshot format (`STORE_VERSION`), and
 * read back through its `decodeSnapshot`, so an unreadable or future-format
 * record is QUARANTINED (moved aside intact) rather than half-applied or
 * silently dropped. `RoomPersistence` is not used: it exists to restore live
 * socket rooms (`CoreRoomState`) and its debounce is the thing we do not want.
 *
 * The snapshot's `members` are the room's members, and each member's `app` blob
 * carries two things: the room's own readiness flag (`ready`, what a draft
 * starts on) and the constructed table's per-player state blob (deck choice and
 * its own ready flag, written by `http/routes.ts`) — which is exactly what that
 * field is for. The room-level `app` blob carries name, leader, game type,
 * client mode, format, match id and `draftStartedAt`, plus the password's salt
 * and scrypt hash. A room written before `clientMode` existed has no such key
 * and reads back `builtin`; one written before `ready`/`draftStartedAt` existed
 * reads back `false` and `null`; one written before `format` existed reads back
 * on the newest frozen pool.
 *
 * ## The password is privacy between friends, not authentication
 *
 * Everything here is already behind the friend gate at the edge. A room
 * password keeps a sibling out of your game; it is not a security boundary and
 * nothing here should be read as one. It is still handled with care, because a
 * friend may reuse a password they use elsewhere:
 *
 *   - Never stored in plaintext: scrypt with a per-room random salt.
 *   - Never logged, at any level, in any error — and neither is its hash or
 *     salt. The salt and hash live in a private map, not on the room record, so
 *     dumping a record cannot print them.
 *   - Compared with `timingSafeEqual`.
 *
 * ## Only durable callers may create or join
 *
 * A member is identified by `identityFromHeaders` (`fk:`/`dev:`/`eph:`). An
 * ephemeral id is a per-request random value here — it could never be matched
 * on a second request, and room-store drops non-durable members from every
 * snapshot anyway. So `create`/`join` refuse an ephemeral caller (the HTTP layer
 * answers 403). Behind the edge every friend-tier caller carries a friend key,
 * so in production this never bites; it exists so the answer is a clear refusal
 * rather than a member who silently vanishes on the next restart.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	FileRoomStore,
	STORE_VERSION,
	SnapshotUnreadableError,
	decodeSnapshot,
	type AppCodec,
	type RoomCodec,
	type RoomSnapshot,
	type SerializedMember,
} from '@hadoku/room-store';
import { createSeatTable, isDurableParticipantId } from '@wolffm/rooms-protocol';
// A data loader, not a route: `http/library.ts` is what reads `decks/pools`, and
// the newest frozen pool is a room's default format. Importing it here rather
// than restating the pool-file convention keeps one reader for that fact; it
// pulls in no HTTP and closes no cycle (`library.ts` imports only `node:fs`,
// `node:path` and `@hadoku/deck`).
import { loadTablesLibrary } from '../http/library.js';

export type GameType = 'constructed-1v1' | 'draft';
/**
 * Every game type a room may be set to.
 *
 * A `draft` room is a room like any other: it has members, a leader and a
 * readiness flag per member, and `startDraft` is what turns it into a live pod
 * (wave 23). Nothing is dealt before that call — see `room/socket.ts`.
 */
export const GAME_TYPES: readonly GameType[] = ['constructed-1v1', 'draft'];
export const DEFAULT_GAME_TYPE: GameType = 'constructed-1v1';

/**
 * Which client the room's players sit in front of: our own React table
 * (`builtin`), or Forge's full client streamed from a per-seat container
 * (`streamed`).
 *
 * **Chosen at create and never again.** The mode decides what the server
 * provisions for a room, so there is no update path for it — `http/rooms.ts`'s
 * PATCH refuses the field outright rather than accepting and ignoring it, and
 * `setGameType` (the only mutator of the room's own shape) does not touch it.
 */
export type ClientMode = 'builtin' | 'streamed';
/** Every client mode a room may be created with. */
export const CLIENT_MODES: readonly ClientMode[] = ['builtin', 'streamed'];
export const DEFAULT_CLIENT_MODE: ClientMode = 'builtin';

/** What `roomKeyFor` in the UI accepts, and every id this file mints. */
export const ROOM_ID_RE = /^[a-z0-9-]{1,40}$/;

/* ── the room's format ───────────────────────────────────────────────────── */

/**
 * The pool a room's table plays in. Two kinds, one string:
 *
 *   `2011-07-01`              a frozen Standard era — a `TableFormat.id` from
 *                             `http/library.ts`, which is the pool's date
 *   `draft:amber-lantern-k7q4` a DRAFTED pool — the pod every player at this
 *                             table drafted from (`draftPoolId`)
 *
 * **Why one string rather than a tagged union.** The id travels through the
 * room snapshot on disk, through `RoomView.format`, through `PATCH
 * /api/rooms/:id`, and through the browser's `RoomView` — four codecs, none of
 * which has to learn a second shape while the id stays a string. The
 * discrimination is `draftIdOfPool`, in one place, and every reader that only
 * wants "which pool is this room on" keeps working unchanged.
 *
 * **A drafted pool is one id and TWO pools.** The era arm resolves to one
 * frozen list for everybody; the draft arm resolves PER CALLER to the cards
 * that caller drafted (`http/routes.ts`'s `draftPoolForMember`, over
 * `viewForParticipant`). That is the whole point — two players at one table
 * drafted from one pod and hold two different 45-card pools — and it is why a
 * drafted pool id names the POD and never a pool of cards.
 *
 * **It belongs to the ROOM, not to a seat.** Before wave 25 each player sent
 * their own `rules` with their own deck (`http/routes.ts`, `PUT …/deck`) and the
 * start route only ever checked a deck against the rule its own owner had
 * named, so two people could load decks legal in two different Standard pools
 * and the match started anyway. One pool per table is not a new mode; it is the
 * property the table never had. The leader sets it (`setFormat`), exactly as the
 * leader sets the game type.
 *
 * Whether the id names a pool THIS server has is not decided here: the lobby
 * stores a room's choice and `http/routes.ts` — which holds the library — is
 * what refuses a table whose pool it cannot load.
 */
export type FormatId = string;

/**
 * What a room's format says when this server has no frozen pool at all.
 *
 * Not a date, deliberately: a made-up date would read like a pool and would be
 * silently wrong. This id resolves to nothing, so the table routes answer "this
 * room's format is not one this server has" rather than checking a deck against
 * a pool nobody froze. It is unreachable wherever `decks/pools` is present,
 * which is every checkout and the deploy tree.
 */
export const NO_FORMAT: FormatId = 'unavailable';

/**
 * What makes a room's pool a DRAFTED pool rather than a frozen era.
 *
 * A colon, because a frozen era id is a date and `ROOM_ID_RE` allows no colon —
 * so no pod id and no era id can ever be mistaken for the other, and the
 * discrimination needs no version field.
 */
export const DRAFT_POOL_PREFIX = 'draft:';

/** A pod's id as a room's pool id. The one place this string is built. */
export function draftPoolId(draftId: string): FormatId {
	return `${DRAFT_POOL_PREFIX}${draftId}`;
}

/**
 * The pod behind a drafted pool id, or null when the id is a frozen era.
 *
 * The one place the string is taken apart, and it VALIDATES: a pod id is a room
 * id (wave 23 — one door, one id, so `draftRooms.find` is keyed by the room's
 * own id), so anything `ROOM_ID_RE` refuses is not a pod and is reported as no
 * pod at all rather than passed on to be looked up. Without that, a stored
 * `draft:../../etc` would reach the registry as a key.
 */
export function draftIdOfPool(pool: FormatId): string | null {
	if (!pool.startsWith(DRAFT_POOL_PREFIX)) return null;
	const draftId = pool.slice(DRAFT_POOL_PREFIX.length);
	return ROOM_ID_RE.test(draftId) ? draftId : null;
}

/**
 * The repo root, found by walking up from this module to the first ancestor that
 * holds `decks/pools`.
 *
 * NOT `dirname(dirname(import.meta.url))`. That expression is right for
 * `src/index.ts` and `dist/index.js` — each exactly one directory below the
 * package root — and wrong for this file, which sits two directories down in
 * `src` and is bundled INTO `dist/index.js` (`esbuild --bundle`, see
 * `package.json`). The two layouts differ by a level, so a fixed number of
 * `..`s cannot be right for both; the search is what makes one function right
 * for dev, for the bundle and for the deploy tree.
 */
function repoRootWithPools(from: string): string | null {
	let dir = dirname(fileURLToPath(from));
	for (let up = 0; up < 8; up++) {
		if (existsSync(join(dir, 'decks', 'pools'))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** Resolved at most once per process: it reads the pool fixtures off disk. */
let newestFrozen: FormatId | null = null;

/**
 * The NEWEST frozen pool, which is what a new room starts on.
 *
 * `library.formats` is "in date order, oldest first" (`http/library.ts`), so the
 * newest is the LAST element — `formats[0]` is 2011-02-13 and every room used to
 * start there. Lazy and memoised, because a lobby that never mints a room and
 * restores no pre-format record should not read `decks/pools` at all.
 */
export function newestFormat(): FormatId {
	if (newestFrozen !== null) return newestFrozen;
	const root = repoRootWithPools(import.meta.url);
	const formats = root === null ? [] : loadTablesLibrary(root).formats;
	newestFrozen = formats.at(-1)?.id ?? NO_FORMAT;
	return newestFrozen;
}

/**
 * Watchparty's own bound on the value (`sprite: z.string().min(1).max(32)` in
 * `@wolffm/watchparty-ui@0.39.8`'s bundled `room-chrome.js`). Restated here
 * rather than guessed at, because this is the layer that persists it.
 */
export const AVATAR_ID_MAX = 32;

/**
 * The one reading of an avatar id, in every direction.
 *
 * `@wolffm/rooms-protocol` types it `avatarId?: string | null` (`RosterIdentity`,
 * `LocalIdentity`), so THREE states arrive — absent, explicitly null, a string —
 * and exactly TWO ever leave this file: a non-blank string, or absent. `null`,
 * `''`, whitespace, an over-long value and anything that is not a string all
 * collapse to absent, because to whoever is drawing a face they all mean the
 * same thing (draw the fallback) and a third state on the wire is a third branch
 * in every consumer for no new fact.
 *
 * An EMPTY STRING reaching a client is the specific bug this function exists to
 * stop. It survives a `!== undefined` check and then resolves to a sprite URL
 * ending `square_.png`, which is a 404 drawn as a broken image rather than the
 * fallback the absence would have produced.
 */
function avatarIdOf(v: unknown): string | undefined {
	if (typeof v !== 'string') return undefined;
	const trimmed = v.trim();
	return trimmed === '' || trimmed.length > AVATAR_ID_MAX ? undefined : trimmed;
}

export interface RoomMember {
	/** A ParticipantId from `identityFromHeaders`. */
	id: string;
	/** `userIdOf(req)` — the same string `/api/whoami` returns as `userId`. */
	name: string;
	/**
	 * The character this member picked in watchparty's room, when they have one.
	 *
	 * **Absent or a non-blank string, never `null` and never `''`** — see
	 * `avatarIdOf`. The value is watchparty's `sprite` id (`sage`, `herald`,
	 * `cleric`, `knight`, `mage`, `brawler`, `wanderer`, `rogue` in 0.39.8), and
	 * it is deliberately NOT validated against that list: a ninth character they
	 * add must reach the client, not be dropped here. Resolving it to something
	 * drawable is the UI's job (`apps/ui/src/room/avatar.ts`), because the URL is
	 * derived from the page's own origin and this file has no origin.
	 */
	avatarId?: string;
	joinedAt: string;
	/**
	 * The ROOM's readiness, which is what a draft starts on.
	 *
	 * Not the constructed table's ready flag: that one lives in the player-state
	 * blob beside the deck choice (`http/routes.ts`), because it means "my deck
	 * is loaded and legal" and is refused without one. This one means "I am
	 * ready for this room to begin" and needs no deck. A room switching game
	 * type clears it — see `setGameType`.
	 */
	ready: boolean;
}

/** The PUBLIC shape. Every response body that carries a room uses exactly this. */
export interface RoomView {
	id: string;
	name: string;
	creator: string;
	leader: string;
	gameType: GameType;
	/**
	 * The room's pool, and the rules BOTH seats' decks are checked against.
	 *
	 * Always a concrete id, in every body that carries a room: a new room starts
	 * on the newest frozen pool and a room stored before this field existed reads
	 * back on it too, so no client ever has to guess what a room is playing. Only
	 * the leader changes it (`setFormat`).
	 */
	format: FormatId;
	/** Fixed at create. Every client sees it before joining, from `list()` as well as `get()`. */
	clientMode: ClientMode;
	/** Whether a password is set — never the password, never any hash of it. */
	locked: boolean;
	members: RoomMember[];
	matchId: string | null;
	/**
	 * ISO string once the draft has been dealt; null in the lobby phase.
	 *
	 * Never restored across a restart, for the same reason `matchId` is not: the
	 * draft itself is in this process's memory (`room/draftRooms.ts` keeps no
	 * disk state), so a room that came back claiming to be mid-draft would show
	 * an empty table. A restart puts the room back in its lobby with its ready
	 * flags intact instead, and the UI says so in words.
	 */
	draftStartedAt: string | null;
	createdAt: string;
}

/** Who is asking. `id` from `identityFromHeaders`, `name` from `userIdOf`. */
export interface Caller {
	id: string;
	name: string;
}

export interface CreateRoomInput {
	name: string;
	gameType: GameType;
	/** The one place this is ever set. Required here; the HTTP layer defaults a missing field. */
	clientMode: ClientMode;
	/** Absent or empty: an open room. */
	password?: string;
}

export type CreateResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'not-durable' };

/**
 * `no-match` covers BOTH "no such room" and "wrong password", on purpose: the
 * HTTP layer must not be able to tell them apart, so this layer does not either.
 */
export type JoinResult =
	| { ok: true; room: RoomView; alreadyMember: boolean }
	| { ok: false; reason: 'no-match' | 'not-durable' };

export type SetGameTypeResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'no-room' | 'not-leader' | 'draft-started' };

/** Deliberately the same three refusals as `SetGameTypeResult`: one leader, one shape. */
export type SetFormatResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'no-room' | 'not-leader' | 'draft-started' };

export type StartDraftResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'no-room' | 'not-member' | 'not-draft' | 'not-ready' };

/**
 * How long a room may sit untouched before the lobby forgets it.
 *
 * Rooms used to be permanent: `create` had no opposite, and neither `leave`
 * nor any expiry existed, so every room ever made stayed on the front page for
 * ever. The operator found a four-day-old room still advertising a match whose
 * JVM died in the first nightly restart after it.
 *
 * Twelve hours, because the only clock a lobby room has is its own mutations —
 * joining, choosing a deck, readying up. Nobody sits in a room for half a day
 * without touching any of that, and anything shorter risks reaping a room out
 * from under people who are mid-conversation in the chat panel, which this
 * server cannot see.
 */
export const ROOM_IDLE_MS = 12 * 60 * 60_000;

export interface Lobby {
	list(): RoomView[];
	get(roomId: string): RoomView | undefined;
	/** Whether `memberId` is a member of `roomId`. False when there is no such room. */
	isMember(roomId: string, memberId: string): boolean;
	/** Per-member opaque state owned by lane C (deck choice, ready). Not part of RoomView. undefined when unset / no room / not a member. */
	playerState(roomId: string, memberId: string): unknown;
	/** false when there is no such room or memberId is not a member. Persisted. */
	setPlayerState(roomId: string, memberId: string, state: unknown): boolean;
	/** false when there is no such room or the caller is not a member. Persisted. */
	setReady(roomId: string, memberId: string, ready: boolean): boolean;
	/**
	 * The member's OWN avatar, and nobody else's.
	 *
	 * `memberId` is always a derived ParticipantId (`identityFromHeaders`), so a
	 * browser cannot name a row that is not its own however it spells the body —
	 * which is what makes accepting this value from a client safe. It is a
	 * cosmetic property of a person, not a credential, and it is the one identity
	 * field the edge does not inject: there is no `X-User-Avatar`, so the only
	 * place it can come from is the viewer's own watchparty prefs.
	 *
	 * Three states in, two states stored. A non-blank string sets it; `null`
	 * clears it; `''`, whitespace, an over-long value and a non-string all read
	 * as `null` (`avatarIdOf`). `false` only when there is no such room or
	 * `memberId` is not a member. Persisted, and only written when the value
	 * actually changed.
	 */
	setAvatar(roomId: string, memberId: string, avatarId: string | null): boolean;
	/**
	 * Deal the room's draft: the point at which a draft room stops being a lobby.
	 *
	 * Requires the room to exist, the caller to be a member, the game type to be
	 * `draft`, and EVERY member to be ready (with at least one member). Any
	 * member may call it — like constructed, where either browser may ask and
	 * the server answers one start to both — so it is idempotent: a room whose
	 * draft has already started answers `ok` with its view and changes nothing.
	 *
	 * It does not build the draft. It records that the room started one; the
	 * socket refuses to open a pod for a room where this is null, and the engine
	 * deals the pod on the first `join` after it (`room/socket.ts`). That is why
	 * bots exist only from the instant the draft is dealt: nothing counts seats
	 * at this call, `createDraft` fills all eight with bots and each human who
	 * connects evicts one.
	 */
	startDraft(roomId: string, callerId: string): StartDraftResult;
	/** false when there is no such room. Persisted. */
	setMatch(roomId: string, matchId: string | null): boolean;
	create(caller: Caller, input: CreateRoomInput): CreateResult;
	/** Idempotent for an existing member, who needs no password again. */
	join(roomId: string, caller: Caller, password?: string): JoinResult;
	/**
	 * Leader only. Changes the game type and NOTHING else — a room's `clientMode`
	 * is immutable. Every member's `ready` is cleared: readiness is readiness for
	 * a particular game, so changing the game invalidates it. Refused with
	 * `draft-started` while a draft is running.
	 */
	setGameType(roomId: string, callerId: string, gameType: GameType): SetGameTypeResult;
	/**
	 * Leader only. Changes the pool both seats' decks are checked against.
	 *
	 * A change DROPS every member's readiness and every member's table state —
	 * the deck choice, the verdict and the `.dck` text `http/routes.ts` holds in
	 * the per-member blob. A verdict is a verdict in one pool: what somebody
	 * readied with is not what this table is now, for the same reason loading a
	 * new deck un-readies you. The blob stays opaque to this file — it is
	 * dropped whole, not edited, because every part of it was produced under the
	 * pool that just went away.
	 *
	 * Refused with `draft-started` while a draft is running, like `setGameType`:
	 * the lobby is not the place to half-change a room a pod is being played in.
	 */
	setFormat(roomId: string, callerId: string, format: FormatId): SetFormatResult;
	/**
	 * Forget every room untouched for longer than `idleMs`, on disk as well as
	 * in memory. Returns the ids dropped, for the caller's log.
	 *
	 * A room whose draft has STARTED is never dropped: a pod runs for the better
	 * part of an hour without anybody touching the lobby, and reaping it would
	 * take the draft with it. That cannot make a room immortal, because
	 * `draftStartedAt` is not restored — the next restart puts the room back in
	 * its lobby, and it ages out from there.
	 */
	sweep(idleMs?: number): string[];
}

/** Structured, and never carries a password, hash or salt. */
export type LobbyLog = (entry: Record<string, unknown>) => void;

export interface OpenLobbyOptions {
	/** Where room snapshots live. Created if missing. Never tmpfs in production. */
	dir: string;
	log?: LobbyLog;
	/** Injected for tests. */
	now?: () => number;
	/**
	 * The pool a room starts on, and what a record written before the field reads
	 * back as. Defaults to `newestFormat()` — the newest frozen pool, read off
	 * disk. A caller that already holds a `TablesLibrary` may pass
	 * `library.formats.at(-1)?.id` instead and save the second read.
	 */
	defaultFormat?: FormatId;
}

// ── the password ─────────────────────────────────────────────────────────────

/**
 * scrypt at node's defaults (N=2^14, r=8, p=1): tens of milliseconds, paid once
 * at create and once per join attempt by a non-member, and join attempts are
 * rate-limited per caller in `http/rooms.ts`. Sync, because the lobby is a
 * synchronous in-memory structure and a friend group creates rooms by hand.
 */
const SALT_BYTES = 16;
const KEY_BYTES = 32;

interface Secret {
	salt: string;
	hash: string;
}

function hashPassword(password: string, salt: Buffer): Buffer {
	return scryptSync(password.normalize('NFC'), salt, KEY_BYTES);
}

function makeSecret(password: string): Secret {
	const salt = randomBytes(SALT_BYTES);
	return { salt: salt.toString('hex'), hash: hashPassword(password, salt).toString('hex') };
}

function passwordMatches(secret: Secret, password: string): boolean {
	const expected = Buffer.from(secret.hash, 'hex');
	const got = hashPassword(password, Buffer.from(secret.salt, 'hex'));
	return got.length === expected.length && timingSafeEqual(got, expected);
}

// ── the stored record ────────────────────────────────────────────────────────

interface MemberRecord {
	id: string;
	name: string;
	joinedAt: number;
	state: unknown;
	ready: boolean;
	/** Normalised by `avatarIdOf` on the way in, so this is never `''` and never `null`. */
	avatarId?: string;
}

interface RoomRecord {
	id: string;
	name: string;
	creator: string;
	leader: string;
	gameType: GameType;
	format: FormatId;
	clientMode: ClientMode;
	matchId: string | null;
	/** ms since epoch once the draft was dealt; null in the lobby phase. */
	draftStartedAt: number | null;
	createdAt: number;
	/** Last mutation, in ms. What `sweep` ages a room out on. */
	updatedAt: number;
	members: MemberRecord[];
}

/** The room-level `app` blob on disk. The secret is here and ONLY here on disk. */
interface StoredApp {
	name: string;
	creator: string;
	leader: string;
	gameType: GameType;
	/**
	 * Null ONLY on the way out of `deserialize`, and only for a record written
	 * before the field existed: `openLobby` turns that into the default. Never
	 * null on the way in — `#persist` always writes the room's concrete id — so a
	 * record that stores an explicit `null` is a record this build did not write
	 * and does not understand, and the codec quarantines it like any other.
	 */
	format: FormatId | null;
	clientMode: ClientMode;
	matchId: string | null;
	/**
	 * Written, and deliberately read back as null (see `openLobby`). It is here
	 * so a snapshot on disk says whether that room was mid-draft when the
	 * process died — the log line of the last write — and so the codec refuses a
	 * record whose value is not a number rather than silently ignoring it.
	 */
	draftStartedAt: number | null;
	secret: Secret | null;
}

/**
 * Not bumped for `clientMode`, not bumped for `ready`/`draftStartedAt`, and not
 * bumped for `format`. Each is additive and is read with a default — `builtin`,
 * `false`, `null`, the newest frozen pool — so a record written before it
 * existed decodes without a migration, and a bump would imply one that does not
 * exist. `deserialize` gets the stored version anyway if a real migration ever
 * needs it.
 */
const APP_VERSION = 1;

/** Any non-blank string. Whether it names a pool THIS server has is not this file's question. */
function isFormatId(v: unknown): v is FormatId {
	return typeof v === 'string' && v.trim() !== '';
}

function isGameType(v: unknown): v is GameType {
	return typeof v === 'string' && (GAME_TYPES as readonly string[]).includes(v);
}

function isClientMode(v: unknown): v is ClientMode {
	return typeof v === 'string' && (CLIENT_MODES as readonly string[]).includes(v);
}

function isSecret(v: unknown): v is Secret {
	if (typeof v !== 'object' || v === null) return false;
	const s = v as Record<string, unknown>;
	return typeof s.salt === 'string' && typeof s.hash === 'string';
}

/**
 * The room-level codec. Its errors name the FIELD, never a value — the message
 * reaches the quarantine reason and the log, and a value here could be the hash.
 */
const appCodec: AppCodec<StoredApp> = {
	version: APP_VERSION,
	serialize: (value) => structuredClone(value),
	deserialize(raw) {
		if (typeof raw !== 'object' || raw === null) throw new Error('app is not an object');
		const a = raw as Record<string, unknown>;
		if (typeof a.name !== 'string') throw new Error('app.name is not a string');
		if (typeof a.creator !== 'string') throw new Error('app.creator is not a string');
		if (typeof a.leader !== 'string') throw new Error('app.leader is not a string');
		if (!isGameType(a.gameType)) throw new Error('app.gameType is not a known game type');
		// Written before wave 18: absent means `builtin`, which is what those rooms
		// are. A field that is PRESENT and unknown is not defaulted away — that is
		// a record this build does not understand, so it quarantines like any other.
		if (a.clientMode !== undefined && !isClientMode(a.clientMode)) {
			throw new Error('app.clientMode is not a known client mode');
		}
		// Absent is a room written before wave 25, which starts on the newest
		// frozen pool (`openLobby`). Present and not a format id is a record this
		// build does not understand — including an explicit `null`, which this
		// build never writes.
		if (a.format !== undefined && !isFormatId(a.format)) throw new Error('app.format is not a format id');
		if (a.matchId !== null && typeof a.matchId !== 'string') throw new Error('app.matchId is invalid');
		// Absent is a room written before wave 23, which is every room that
		// existed then and no room that was mid-draft. Present and not a number
		// is a record this build does not understand.
		if (a.draftStartedAt !== undefined && a.draftStartedAt !== null && typeof a.draftStartedAt !== 'number') {
			throw new Error('app.draftStartedAt is not a number');
		}
		if (a.secret !== null && !isSecret(a.secret)) throw new Error('app.secret is invalid');
		return {
			name: a.name,
			creator: a.creator,
			leader: a.leader,
			gameType: a.gameType,
			format: a.format === undefined ? null : (a.format as FormatId),
			clientMode: a.clientMode === undefined ? DEFAULT_CLIENT_MODE : a.clientMode,
			matchId: a.matchId as string | null,
			draftStartedAt: a.draftStartedAt === undefined ? null : (a.draftStartedAt as number | null),
			secret: a.secret === null ? null : { salt: (a.secret as Secret).salt, hash: (a.secret as Secret).hash },
		};
	},
};

const codec: RoomCodec<StoredApp, unknown> = { app: appCodec };

function viewOf(room: RoomRecord, locked: boolean): RoomView {
	return {
		id: room.id,
		name: room.name,
		creator: room.creator,
		leader: room.leader,
		gameType: room.gameType,
		format: room.format,
		clientMode: room.clientMode,
		locked,
		members: room.members.map((m) => ({
			id: m.id,
			name: m.name,
			joinedAt: new Date(m.joinedAt).toISOString(),
			ready: m.ready,
			// Spread, not `avatarId: m.avatarId`. The key is ABSENT for a member
			// who has no avatar rather than present-and-undefined, so an
			// in-process reader and a JSON reader see the same two states —
			// `JSON.stringify` drops an undefined value and would otherwise be
			// the only thing making them agree.
			...(m.avatarId === undefined ? {} : { avatarId: m.avatarId }),
		})),
		matchId: room.matchId,
		draftStartedAt: room.draftStartedAt === null ? null : new Date(room.draftStartedAt).toISOString(),
		createdAt: new Date(room.createdAt).toISOString(),
	};
}

/**
 * `r-` plus 12 hex characters. The prefix means a room id can never equal a
 * draft id or a match id; 48 random bits make a collision a non-event at this
 * scale, and `create` re-rolls on one anyway.
 */
function mintRoomId(): string {
	return `r-${randomBytes(6).toString('hex')}`;
}

function unboxState(app: unknown): unknown {
	if (typeof app !== 'object' || app === null || !('state' in app)) return undefined;
	return (app as { state: unknown }).state;
}

/** Anything but a stored `true` is not ready — including a member blob from before the field. */
function unboxReady(app: unknown): boolean {
	if (typeof app !== 'object' || app === null) return false;
	return (app as { ready?: unknown }).ready === true;
}

// ── the lobby ────────────────────────────────────────────────────────────────

class FileLobby implements Lobby {
	#store: FileRoomStore;
	#now: () => number;
	#log: LobbyLog;
	#rooms = new Map<string, RoomRecord>();
	/**
	 * The newest `createdAt` minted or restored so far.
	 *
	 * Two rooms created in the same millisecond used to tie, and the list's
	 * tie-break is the room id — which is random, so the front page's order
	 * flipped between two rooms made in one click. A created room's stamp is
	 * therefore forced at least 1 ms past the last one: the list is creation
	 * order, deterministically, and it stays that way across a restart because
	 * the stamp is what is persisted.
	 */
	#lastCreatedAt = 0;
	/** Kept apart from the records so no dump of a record can carry them. */
	#secrets = new Map<string, Secret>();

	/** The pool a room minted here starts on. Resolved by `openLobby`, never read off a room. */
	#defaultFormat: FormatId;

	constructor(store: FileRoomStore, now: () => number, log: LobbyLog, defaultFormat: FormatId) {
		this.#store = store;
		this.#now = now;
		this.#log = log;
		this.#defaultFormat = defaultFormat;
	}

	/** Boot only: install a room decoded from disk. */
	restore(room: RoomRecord, secret: Secret | null): void {
		this.#rooms.set(room.id, room);
		this.#lastCreatedAt = Math.max(this.#lastCreatedAt, room.createdAt);
		if (secret !== null) this.#secrets.set(room.id, secret);
	}

	#view(room: RoomRecord): RoomView {
		return viewOf(room, this.#secrets.has(room.id));
	}

	#persist(room: RoomRecord): void {
		const now = this.#now();
		room.updatedAt = now;
		const members: SerializedMember[] = room.members.map((m) => {
			const member: SerializedMember = {
				participantId: m.id,
				joinedAt: m.joinedAt,
				lastSeen: m.joinedAt,
				name: m.name,
				// Boxed, so a state of `null` survives a restart as `null`, and
				// `ready` rides the same blob — it is per-member state like the
				// deck choice. A member with neither still writes `null`, which
				// is byte-for-byte what a pre-wave-23 room wrote.
				app:
					m.state === undefined && !m.ready
						? null
						: { state: structuredClone(m.state), ready: m.ready },
			};
			// Room-store's own field (`SerializedMember.avatarId`), not the
			// per-member `app` blob: the avatar is a fleet-wide identity property
			// `@wolffm/rooms-protocol` already names, so it belongs beside `name`
			// rather than inside our opaque blob. Written only when there is one,
			// so a member with no avatar produces the bytes a pre-wave-28 room
			// wrote, byte for byte.
			if (m.avatarId !== undefined) member.avatarId = m.avatarId;
			return member;
		});
		const app: StoredApp = {
			name: room.name,
			creator: room.creator,
			leader: room.leader,
			gameType: room.gameType,
			format: room.format,
			clientMode: room.clientMode,
			matchId: room.matchId,
			draftStartedAt: room.draftStartedAt,
			secret: this.#secrets.get(room.id) ?? null,
		};
		const snapshot: RoomSnapshot = {
			storeVersion: STORE_VERSION,
			roomId: room.id,
			roomKey: room.id,
			lastEventSeq: 0,
			createdAt: room.createdAt,
			updatedAt: now,
			members,
			usedAvatars: [],
			clientNames: {},
			seats: createSeatTable(null),
			app: appCodec.serialize(app),
			appVersion: APP_VERSION,
		};
		this.#store.saveSync(snapshot);
	}

	list(): RoomView[] {
		return [...this.#rooms.values()]
			.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
			.map((r) => this.#view(r));
	}

	get(roomId: string): RoomView | undefined {
		const room = this.#rooms.get(roomId);
		return room === undefined ? undefined : this.#view(room);
	}

	isMember(roomId: string, memberId: string): boolean {
		return this.#rooms.get(roomId)?.members.some((m) => m.id === memberId) ?? false;
	}

	playerState(roomId: string, memberId: string): unknown {
		const member = this.#rooms.get(roomId)?.members.find((m) => m.id === memberId);
		return member?.state === undefined ? undefined : structuredClone(member.state);
	}

	setPlayerState(roomId: string, memberId: string, state: unknown): boolean {
		const room = this.#rooms.get(roomId);
		const member = room?.members.find((m) => m.id === memberId);
		if (room === undefined || member === undefined) return false;
		member.state = state === undefined ? undefined : structuredClone(state);
		this.#persist(room);
		return true;
	}

	setMatch(roomId: string, matchId: string | null): boolean {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return false;
		room.matchId = matchId;
		this.#persist(room);
		return true;
	}

	create(caller: Caller, input: CreateRoomInput): CreateResult {
		if (!isDurableParticipantId(caller.id)) return { ok: false, reason: 'not-durable' };
		let id = mintRoomId();
		while (this.#rooms.has(id)) id = mintRoomId();
		const now = Math.max(this.#now(), this.#lastCreatedAt + 1);
		this.#lastCreatedAt = now;
		const room: RoomRecord = {
			id,
			name: input.name,
			creator: caller.id,
			leader: caller.id,
			gameType: input.gameType,
			// The NEWEST frozen pool, not `formats[0]`. There is no field for it in
			// `CreateRoomInput` on purpose: a room is created on the current pool and
			// the leader moves it from there, so one setting has one mutator.
			format: this.#defaultFormat,
			clientMode: input.clientMode,
			matchId: null,
			draftStartedAt: null,
			createdAt: now,
			updatedAt: now,
			members: [{ id: caller.id, name: caller.name, joinedAt: now, state: undefined, ready: false }],
		};
		this.#rooms.set(id, room);
		if (input.password !== undefined && input.password !== '') {
			this.#secrets.set(id, makeSecret(input.password));
		}
		this.#persist(room);
		this.#log({
			event: 'room-created',
			roomId: id,
			gameType: room.gameType,
			format: room.format,
			clientMode: room.clientMode,
			locked: this.#secrets.has(id),
		});
		return { ok: true, room: this.#view(room) };
	}

	join(roomId: string, caller: Caller, password?: string): JoinResult {
		if (!isDurableParticipantId(caller.id)) return { ok: false, reason: 'not-durable' };
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-match' };
		if (room.members.some((m) => m.id === caller.id)) {
			return { ok: true, room: this.#view(room), alreadyMember: true };
		}
		const secret = this.#secrets.get(roomId);
		if (secret !== undefined && !passwordMatches(secret, password ?? '')) {
			return { ok: false, reason: 'no-match' };
		}
		room.members.push({ id: caller.id, name: caller.name, joinedAt: this.#now(), state: undefined, ready: false });
		this.#persist(room);
		this.#log({ event: 'room-joined', roomId, members: room.members.length });
		return { ok: true, room: this.#view(room), alreadyMember: false };
	}

	setReady(roomId: string, memberId: string, ready: boolean): boolean {
		const room = this.#rooms.get(roomId);
		const member = room?.members.find((m) => m.id === memberId);
		if (room === undefined || member === undefined) return false;
		member.ready = ready;
		this.#persist(room);
		this.#log({ event: 'room-ready', roomId, ready });
		return true;
	}

	setAvatar(roomId: string, memberId: string, avatarId: string | null): boolean {
		const room = this.#rooms.get(roomId);
		const member = room?.members.find((m) => m.id === memberId);
		if (room === undefined || member === undefined) return false;
		const next = avatarIdOf(avatarId);
		// Idempotent, and it does not WRITE when nothing changed. The browser
		// asserts its avatar on every page load (`apps/ui/src/room/RoomShell.tsx`),
		// which for a room somebody leaves open all evening would otherwise be a
		// snapshot write per reload for a value that never moved. `true` either
		// way: the caller asked for a state and the room is in it.
		if (next === member.avatarId) return true;
		if (next === undefined) delete member.avatarId;
		else member.avatarId = next;
		this.#persist(room);
		// The id itself, not the member's: which character somebody picked is not
		// a secret, and a log line that could not name it could not be read.
		this.#log({ event: 'room-avatar', roomId, avatarId: next ?? null });
		return true;
	}

	startDraft(roomId: string, callerId: string): StartDraftResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (!room.members.some((m) => m.id === callerId)) return { ok: false, reason: 'not-member' };
		// Idempotent, and checked BEFORE readiness: the two browsers both ask, and
		// the second one arrives after the first member's flags may already have
		// been cleared by a leave. A room that has started has started.
		if (room.draftStartedAt !== null) return { ok: true, room: this.#view(room) };
		if (room.gameType !== 'draft') return { ok: false, reason: 'not-draft' };
		// "Everyone" is every member of the room, and there must be at least one.
		// One member who readies alone drafts against seven bots — that is what
		// the pod did before it was a room, and it is kept.
		if (room.members.length === 0 || room.members.some((m) => !m.ready)) {
			return { ok: false, reason: 'not-ready' };
		}
		room.draftStartedAt = this.#now();
		this.#persist(room);
		this.#log({ event: 'room-draft-started', roomId, members: room.members.length });
		return { ok: true, room: this.#view(room) };
	}

	setGameType(roomId: string, callerId: string, gameType: GameType): SetGameTypeResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (room.leader !== callerId) return { ok: false, reason: 'not-leader' };
		// The draft is dealt against this room's id and is already being played.
		// Switching the game under it would leave a live pod in a room that says
		// it is playing constructed, and nothing would ever close the pod.
		if (room.draftStartedAt !== null) return { ok: false, reason: 'draft-started' };
		room.gameType = gameType;
		// Readiness is readiness for a particular game: a member who readied for
		// a draft has not agreed to a constructed match. Cleared for everyone,
		// including the leader making the change.
		for (const member of room.members) member.ready = false;
		this.#persist(room);
		this.#log({ event: 'room-game-type', roomId, gameType });
		return { ok: true, room: this.#view(room) };
	}

	setFormat(roomId: string, callerId: string, format: FormatId): SetFormatResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (room.leader !== callerId) return { ok: false, reason: 'not-leader' };
		if (room.draftStartedAt !== null) return { ok: false, reason: 'draft-started' };
		// Setting the pool a room is already on changes nothing and clears nothing:
		// a leader clicking the option that is already selected must not un-ready
		// the table under everybody.
		if (room.format === format) return { ok: true, room: this.#view(room) };
		room.format = format;
		// BOTH readiness flags, and the deck hold with them. The room's `ready` is
		// readiness for this table; the table's own ready flag and the deck verdict
		// live inside the per-member blob `http/routes.ts` owns, and every part of
		// that blob — the choice, the verdict, the checked `.dck` — was produced
		// against the pool that just went away. So the blob is dropped whole rather
		// than edited: this file does not read its shape, and a verdict from another
		// pool is not a verdict here.
		for (const member of room.members) {
			member.ready = false;
			member.state = undefined;
		}
		this.#persist(room);
		this.#log({ event: 'room-format', roomId, format });
		return { ok: true, room: this.#view(room) };
	}

	sweep(idleMs: number = ROOM_IDLE_MS): string[] {
		const cutoff = this.#now() - idleMs;
		const dropped: string[] = [];
		for (const [id, room] of this.#rooms) {
			if (room.updatedAt > cutoff) continue;
			// A pod in progress. Nobody touches the lobby for the forty minutes a
			// draft takes, and the room is the pod's container — reaping it would
			// end the game. `draftStartedAt` dies with the process, so this cannot
			// keep a room alive past the next restart.
			if (room.draftStartedAt !== null) continue;
			this.#rooms.delete(id);
			this.#secrets.delete(id);
			dropped.push(id);
			// The room is gone from the list the moment it leaves the map; the
			// disk write is best-effort and logged, because a store that cannot
			// delete must not resurrect the room on the next boot silently.
			void this.#store.remove(id).catch((err: unknown) => {
				this.#log({ event: 'room-forget-failed', roomId: id, err: String(err) });
			});
			this.#log({ event: 'room-forgotten', roomId: id, idleMs });
		}
		return dropped;
	}
}

/**
 * Open the lobby over `dir`, restoring every room a previous process wrote.
 *
 * Async because room-store's read path is (`list`/`load`/`quarantine`); every
 * operation on the returned lobby is synchronous. A record this build cannot
 * read is quarantined and logged by room id and reason — the reason names what
 * was wrong, never the bytes, since the bytes could include a password hash.
 */
export async function openLobby(opts: OpenLobbyOptions): Promise<Lobby> {
	const store = new FileRoomStore(opts.dir);
	const now = opts.now ?? Date.now;
	const log = opts.log ?? (() => {});
	const defaultFormat = opts.defaultFormat ?? newestFormat();
	const lobby = new FileLobby(store, now, log, defaultFormat);

	for (const roomId of await store.list()) {
		const quarantine = async (reason: string): Promise<void> => {
			await store.quarantine(roomId, reason);
			log({ event: 'room-quarantined', roomId, reason });
		};
		let snapshot: RoomSnapshot | null;
		try {
			snapshot = await store.load(roomId);
		} catch (err) {
			// JSON.parse's message quotes the input, so it is NOT passed on.
			if (err instanceof SyntaxError) {
				await quarantine('malformed: not JSON');
				continue;
			}
			throw err;
		}
		if (snapshot === null) continue;
		try {
			if (!ROOM_ID_RE.test(roomId)) throw new SnapshotUnreadableError('malformed', roomId, 'room id');
			const decoded = decodeSnapshot(snapshot, codec, {
				roomId,
				restoreId: `boot-${now()}`,
				restoredAt: now(),
			});
			const app = decoded.app;
			const members: MemberRecord[] = decoded.members.map((m) => {
				// Re-normalised on the way in rather than trusted. `decodeSnapshot`
				// already drops a non-string, but a record written by a build with a
				// looser rule could carry `''` — the one value `avatarIdOf` exists to
				// keep off the wire. Absent when there is none, so a restored room and
				// a fresh one present the same two states.
				const avatarId = avatarIdOf(m.avatarId);
				return {
					id: m.participantId,
					name: m.name ?? 'anon',
					joinedAt: m.joinedAt,
					state: unboxState(m.app),
					// Kept across the restart, unlike the draft itself: the room comes
					// back in its lobby phase with everybody still ready, which is one
					// click from starting again rather than four.
					ready: unboxReady(m.app),
					...(avatarId === undefined ? {} : { avatarId }),
				};
			});
			lobby.restore(
				{
					id: roomId,
					name: app.name,
					creator: app.creator,
					leader: app.leader,
					gameType: app.gameType,
					// **Restored, unlike the match and the draft.** A room that came
					// back on a different pool from the one its players loaded their
					// decks against is exactly the bug this field exists to prevent:
					// the decks are restored too (the per-member blob), so the pool
					// they were checked in has to come back with them.
					format: app.format ?? defaultFormat,
					clientMode: app.clientMode,
					// **Never restored.** A match is a child JVM this process
					// owns; nothing survives a restart, and this repo restarts on
					// every deploy and again at 08:00 UTC. A room that kept its
					// `matchId` advertised "playing" for ever, pointing at a game
					// that died days earlier — which is what the operator found.
					matchId: null,
					// **Never restored either, and for the same reason.** A draft
					// lives in `room/draftRooms.ts`'s in-memory registry, which
					// this process did not inherit — `open` would deal a brand new
					// draft over the top of whatever was played. So a restart puts
					// the room back in its lobby phase; the UI says a draft does
					// not survive a restart rather than showing an empty table.
					draftStartedAt: null,
					createdAt: decoded.createdAt,
					// The raw snapshot's clock: when this room was last touched
					// by the process that wrote it. `decoded` does not carry it.
					updatedAt: snapshot.updatedAt,
					members,
				},
				app.secret,
			);
		} catch (err) {
			if (err instanceof SnapshotUnreadableError) {
				await quarantine(`${err.reason}: ${err.message}`);
				continue;
			}
			throw err;
		}
	}
	log({ event: 'lobby-open', rooms: lobby.list().length, defaultFormat });
	return lobby;
}

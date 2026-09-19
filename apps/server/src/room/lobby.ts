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
 * is lane C's per-player state (deck choice, ready) — which is exactly what that
 * field is for. The room-level `app` blob carries name, leader, game type and
 * match id, plus the password's salt and scrypt hash.
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

export type GameType = 'constructed-1v1' | 'draft';
/** Every game type a room may be set to. `draft` is accepted as a value; nothing builds it yet. */
export const GAME_TYPES: readonly GameType[] = ['constructed-1v1', 'draft'];
export const DEFAULT_GAME_TYPE: GameType = 'constructed-1v1';

/** What `roomKeyFor` in the UI accepts, and every id this file mints. */
export const ROOM_ID_RE = /^[a-z0-9-]{1,40}$/;

export interface RoomMember {
	/** A ParticipantId from `identityFromHeaders`. */
	id: string;
	/** `userIdOf(req)` — the same string `/api/whoami` returns as `userId`. */
	name: string;
	joinedAt: string;
}

/** The PUBLIC shape. Every response body that carries a room uses exactly this. */
export interface RoomView {
	id: string;
	name: string;
	creator: string;
	leader: string;
	gameType: GameType;
	/** Whether a password is set — never the password, never any hash of it. */
	locked: boolean;
	members: RoomMember[];
	matchId: string | null;
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
	| { ok: false; reason: 'no-room' | 'not-leader' };

export interface Lobby {
	list(): RoomView[];
	get(roomId: string): RoomView | undefined;
	/** Whether `memberId` is a member of `roomId`. False when there is no such room. */
	isMember(roomId: string, memberId: string): boolean;
	/** Per-member opaque state owned by lane C (deck choice, ready). Not part of RoomView. undefined when unset / no room / not a member. */
	playerState(roomId: string, memberId: string): unknown;
	/** false when there is no such room or memberId is not a member. Persisted. */
	setPlayerState(roomId: string, memberId: string, state: unknown): boolean;
	/** false when there is no such room. Persisted. */
	setMatch(roomId: string, matchId: string | null): boolean;
	create(caller: Caller, input: CreateRoomInput): CreateResult;
	/** Idempotent for an existing member, who needs no password again. */
	join(roomId: string, caller: Caller, password?: string): JoinResult;
	/** Leader only. */
	setGameType(roomId: string, callerId: string, gameType: GameType): SetGameTypeResult;
}

/** Structured, and never carries a password, hash or salt. */
export type LobbyLog = (entry: Record<string, unknown>) => void;

export interface OpenLobbyOptions {
	/** Where room snapshots live. Created if missing. Never tmpfs in production. */
	dir: string;
	log?: LobbyLog;
	/** Injected for tests. */
	now?: () => number;
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
}

interface RoomRecord {
	id: string;
	name: string;
	creator: string;
	leader: string;
	gameType: GameType;
	matchId: string | null;
	createdAt: number;
	members: MemberRecord[];
}

/** The room-level `app` blob on disk. The secret is here and ONLY here on disk. */
interface StoredApp {
	name: string;
	creator: string;
	leader: string;
	gameType: GameType;
	matchId: string | null;
	secret: Secret | null;
}

const APP_VERSION = 1;

function isGameType(v: unknown): v is GameType {
	return typeof v === 'string' && (GAME_TYPES as readonly string[]).includes(v);
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
		if (a.matchId !== null && typeof a.matchId !== 'string') throw new Error('app.matchId is invalid');
		if (a.secret !== null && !isSecret(a.secret)) throw new Error('app.secret is invalid');
		return {
			name: a.name,
			creator: a.creator,
			leader: a.leader,
			gameType: a.gameType,
			matchId: a.matchId as string | null,
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
		locked,
		members: room.members.map((m) => ({
			id: m.id,
			name: m.name,
			joinedAt: new Date(m.joinedAt).toISOString(),
		})),
		matchId: room.matchId,
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

	constructor(store: FileRoomStore, now: () => number, log: LobbyLog) {
		this.#store = store;
		this.#now = now;
		this.#log = log;
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
		const members: SerializedMember[] = room.members.map((m) => {
			const member: SerializedMember = {
				participantId: m.id,
				joinedAt: m.joinedAt,
				lastSeen: m.joinedAt,
				name: m.name,
				// Boxed, so a state of `null` survives a restart as `null`.
				app: m.state === undefined ? null : { state: structuredClone(m.state) },
			};
			return member;
		});
		const app: StoredApp = {
			name: room.name,
			creator: room.creator,
			leader: room.leader,
			gameType: room.gameType,
			matchId: room.matchId,
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
			matchId: null,
			createdAt: now,
			members: [{ id: caller.id, name: caller.name, joinedAt: now, state: undefined }],
		};
		this.#rooms.set(id, room);
		if (input.password !== undefined && input.password !== '') {
			this.#secrets.set(id, makeSecret(input.password));
		}
		this.#persist(room);
		this.#log({ event: 'room-created', roomId: id, gameType: room.gameType, locked: this.#secrets.has(id) });
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
		room.members.push({ id: caller.id, name: caller.name, joinedAt: this.#now(), state: undefined });
		this.#persist(room);
		this.#log({ event: 'room-joined', roomId, members: room.members.length });
		return { ok: true, room: this.#view(room), alreadyMember: false };
	}

	setGameType(roomId: string, callerId: string, gameType: GameType): SetGameTypeResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (room.leader !== callerId) return { ok: false, reason: 'not-leader' };
		room.gameType = gameType;
		this.#persist(room);
		this.#log({ event: 'room-game-type', roomId, gameType });
		return { ok: true, room: this.#view(room) };
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
	const lobby = new FileLobby(store, now, log);

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
			const members: MemberRecord[] = decoded.members.map((m) => ({
				id: m.participantId,
				name: m.name ?? 'anon',
				joinedAt: m.joinedAt,
				state: unboxState(m.app),
			}));
			lobby.restore(
				{
					id: roomId,
					name: app.name,
					creator: app.creator,
					leader: app.leader,
					gameType: app.gameType,
					matchId: app.matchId,
					createdAt: decoded.createdAt,
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
	log({ event: 'lobby-open', rooms: lobby.list().length });
	return lobby;
}

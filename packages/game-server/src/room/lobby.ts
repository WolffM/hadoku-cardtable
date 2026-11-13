/**
 * The lobby core: which rooms exist, who is in them, who leads them and holds which seat, kept on
 * disk, for any game type. A game type plugs in through `RoomTypeHooks` (its own part of the record,
 * its seat rules, its view, what leaving or a Ready costs it); this file never names a game's field.
 * Magic's lobby (`games/magic/server/src/room/lobby.ts`) is this core with Magic's hooks, and a game
 * with nothing of its own to keep (bomberman) plays on `plainRoomType`.
 *
 * ## Persistence: write-through, through `@wolffm/rooms-server/store`
 *
 * A deploy restarts the server several times a day, so every mutation writes that room's snapshot
 * synchronously (`FileRoomStore`'s atomic temp-file-and-rename) before the call returns: no debounce
 * window for a deploy to fall into, no flush-on-SIGTERM to get right. Rooms are stored in the store's
 * own snapshot format (`STORE_VERSION`) and read back through `decodeSnapshot`, so an unreadable or
 * future-format record is QUARANTINED (moved aside intact), never half-applied or silently dropped.
 *
 * The snapshot's `members` are the room's members; each member's `app` blob carries their Ready and
 * their per-room state. The room-level `app` blob (`StoredRoomApp`) carries name, creator, leader,
 * game type, the game seats, the game's own part (`RoomTypeHooks.encode`), and the password's salt
 * and scrypt hash.
 *
 * ## The password is privacy between friends, not authentication
 *
 * Everything here is behind the member gate at the edge. A room password keeps a sibling out of your
 * game; it is not a security boundary. It is still handled with care, because a person may reuse a
 * password they use elsewhere: scrypt with a per-room salt, never logged (nor its hash or salt), kept
 * in a private map rather than on the record so dumping a record cannot print it, and compared with
 * `timingSafeEqual` (`provisioning.ts`).
 *
 * ## Only durable callers may create or join
 *
 * An ephemeral participant id is a per-request random value: it could never be matched on a second
 * request, and the store drops non-durable members from every snapshot. So `create`/`join` refuse an
 * ephemeral caller (the HTTP layer answers 403) rather than seat a member who vanishes on restart.
 */

import {
	FileRoomStore,
	STORE_VERSION,
	SnapshotUnreadableError,
	decodeSnapshot,
	type AppCodec,
	type RoomCodec,
	type RoomSnapshot,
	type SerializedMember,
} from '@wolffm/rooms-server/store';
import { createSeatTable, isDurableParticipantId } from '@wolffm/rooms-protocol';
import { addMember, createMembershipLedger, setReady as ledgerSetReady } from '@wolffm/rooms-server';
import { seatsOpenAt } from '@hadoku/platform-wire/events';
import { sameLook, type Look } from '@hadoku/platform-wire/look';
import { ROOM_ID_RE } from '@hadoku/platform-wire/room-feed';

import { replaceIds } from '../erase/anonymise.ts';
import { avatarIdOf } from './avatar.ts';
import type { Caller } from './caller.ts';
import { ROOM_STALE_MS, UNNAMED } from './constants.ts';
import { addRoomMember, isMemberReady, isRoomMember, passwordAdmits, removeRoomMember, setMemberReady } from './membership.ts';
import { makeSecret, mintRoomId, type Secret } from './provisioning.ts';
import { AI_SEAT, CLOSED_SEAT, leaveGameSeat, memberSeats, setGameSeat, takeGameSeat, type GameSeats, type PlatformMember, type PlatformRoomRecord } from './record.ts';
import { isOfferedRoom, isSweepableRoom, NO_BUSY_HOOK, sortRoomsByCreation, type RoomBusyHook } from './room-list.ts';
import { watchpartyRoomId } from './watchparty-link.ts';

/** A member as the lobby keeps one: the platform's record plus what a view shows of them. */
export interface LobbyMember extends PlatformMember {
	/** In memory only, from the member's own requests (`rename`): a saved room keeps no names (R12). Restored `UNNAMED`. */
	name: string;
	/** In memory only: their account's character, absent until it has been read. */
	avatarId?: string;
	/** In memory only: their account's picture and cosmetics, as prefs-api answered (`setLook`). */
	look?: Look;
}

export type LobbyRoom<G = unknown> = PlatformRoomRecord<G, LobbyMember>;

/** What every room is created with, whatever it plays. A game type's own input adds to it. */
export interface RoomCreateInput {
	name: string;
	gameType: string;
	/** Absent or empty: an open room. */
	password?: string;
	/** A seeded, admin-only room, never set by a client body: never swept (`room-list.ts`). */
	testing?: boolean;
	/** When the room's event starts, in ms (`events.ts`). Set by the events route, never by a client body. */
	scheduledFor?: number;
}

/** A member as every room's view names them. */
export interface LobbyMemberView {
	id: string;
	name: string;
	joinedAt: string;
	ready: boolean;
	avatarId?: string;
	look?: Look;
}

/** A room's view as every game's room has it (`@hadoku/shared`'s `roomBaseFields`); the game type's part is spread over it. */
export interface PlatformRoomView {
	id: string;
	name: string;
	creator: string;
	leader: string;
	gameType: string;
	/** Whether a password is set: never the password, never any hash of it. */
	locked: boolean;
	members: LobbyMemberView[];
	/** Who holds each game seat, by seat number; a member in none is watching. */
	seats: (string | null)[];
	createdAt: string;
	testing: boolean;
	scheduledFor: string | null;
}

/** The room-level `app` blob as the store keeps it: the platform's fields, the game seats, and the game's own part under `game`. */
export interface StoredRoomApp {
	name: string;
	creator: string;
	leader: string;
	gameType: string;
	/** Absent for a room written before testing rooms existed: an ordinary one. */
	testing?: boolean;
	/** Absent for a room no event made. */
	scheduledFor?: number;
	secret: Secret | null;
	seats: GameSeats;
	/** The game type's part as it stores it (`RoomTypeHooks.encode`/`decode`). */
	game: unknown;
}

/** Structured, and never carries a password, hash or salt. */
export type LobbyLog = (entry: Record<string, unknown>) => void;

/**
 * Everything a game type tells the lobby about its rooms. Every hook is called only for a room of
 * the type it was registered for, so `G` is that room's own part.
 */
export interface RoomTypeHooks<G, I extends RoomCreateInput = RoomCreateInput> {
	/** A new room's game seats and its game part's defaults. */
	newGame(input: I, id: string): { seats: GameSeats; game: G };
	/** The game part as stored. */
	encode(room: LobbyRoom<G>): unknown;
	/** The stored `app` as written: anything the type writes beside it (a copy an older build reads). Default: as it is. */
	writes?(app: StoredRoomApp): object;
	/**
	 * The stored `app` read back: its game seats and its game part, as stored. Throws to quarantine the room;
	 * the message names the field, never a value. `version` is the app blob's own (`ROOM_APP_VERSION` or older).
	 */
	decode(app: Record<string, unknown>, version: number, ctx: { roomId: string }): { seats: GameSeats; game: unknown };
	/**
	 * The decoded game part made a record's. `dropHolds`: every member comes back with no state and not
	 * ready (the room is restored as a change to what it plays would leave it). `game` is given the members.
	 */
	restore(app: StoredRoomApp, roomId: string): { dropHolds: boolean; game: (members: readonly LobbyMember[]) => G };
	/** A restored room is installed (boot only). */
	restored?(room: LobbyRoom<G>): void;
	/** A created room is installed and saved; what the creation log line says of it. */
	created?(room: LobbyRoom<G>): Record<string, unknown>;
	/** Before every save. */
	beforePersist?(room: LobbyRoom<G>): void;
	/** The game type's part of the room's view, spread over the platform's. */
	view(room: LobbyRoom<G>): object;
	/** The game seats as the view and the relay see them (`PlatformRoomView.seats`). Default: `memberSeats`. */
	seatsView?(room: LobbyRoom<G>): GameSeats;
	/** The members who play, in seat order. Default: the members who hold a game seat. */
	players?(room: LobbyRoom<G>): string[];
	/**
	 * Seat a member who just arrived (only when nobody already in the room waits unseated). `'game-seat'`:
	 * the first open game seat, the platform's own. `true`/`false`: the type seated them itself, or nowhere.
	 */
	autoSeat?(room: LobbyRoom<G>, memberId: string): boolean | 'game-seat';
	/** The busy rules the room list and the sweep read (`room-list.ts`). */
	busy: RoomBusyHook<LobbyRoom<G>>;
	/** The matches the room's games are playing now, which a close lets go of. */
	liveMatches(room: LobbyRoom<G>): string[];
	/** A member is leaving and still in the room: what it costs their game (a match it forfeits). */
	leaving?(room: LobbyRoom<G>, memberId: string): Pick<LeaveOk<never>, 'forfeited'> | void;
	/** A Ready: `'keep'` refuses the change quietly (the room's positions are fixed). Called before it is saved. */
	ready?(room: LobbyRoom<G>, memberId: string, ready: boolean): 'keep' | void;
	/** After a saved change to who sits or who is ready (a tournament's field filling, say). */
	seatsChanged?(room: LobbyRoom<G>): void;
	/** Whether the room seats through its game seats (`sitSeat` and the rest). */
	usesSeats(room: LobbyRoom<G>): boolean;
	/** Whether nobody may sit, stand, seat an AI or close a seat now (the game started, say). */
	seatsFixed(room: LobbyRoom<G>): boolean;
	/** Whether the AI and closed seats are the event's, not anybody's to change. */
	fieldFixed?(room: LobbyRoom<G>): boolean;
	/** The most game seats the room grows to. */
	seatCeiling(room: LobbyRoom<G>): number;
	/** The game seats grown to hold `seat`. */
	growSeats(room: LobbyRoom<G>, seat: number): void;
	/** Open seats past the room's own size taken away from the end. */
	trimSeats(room: LobbyRoom<G>): void;
	/** An AI took `seat` (`on`) or left it; the seat is already marked. */
	aiSeated?(room: LobbyRoom<G>, seat: number, on: boolean): void;
	/** Every member id `ids` names, in the game part, before the record's ids are replaced (account erase). */
	anonymise?(room: LobbyRoom<G>, ids: ReadonlySet<string>): void;
	/** The room is about to be forgotten (a close or the sweep): keep what it played, settle what it owes. */
	ending?(room: LobbyRoom<G>, why: 'close' | 'sweep' | 'forget'): void;
	/** A relay room's match seat count: set for a type whose room IS its match (`onRelayRoomOpened`). */
	relaySeats?: number;
}

/** The fewest seats a room is left with when its seats are closed: one player and one more. */
export const MIN_OPEN_SEATS = 2;

export type CreateResult<V> = { ok: true; room: V } | { ok: false; reason: 'not-durable' };

/** `no-match` covers BOTH "no such room" and "wrong password", on purpose: the HTTP layer must not be able to tell them apart. */
export type JoinResult<V> = { ok: true; room: V; alreadyMember: boolean } | { ok: false; reason: 'no-match' | 'not-durable' };

interface LeaveOk<V> {
	ok: true;
	room: V;
	/** A match this leave forfeited, its games for the caller to end. */
	forfeited?: { tableId: string; matchIds: string[] };
}
export type LeaveResult<V> = LeaveOk<V> | { ok: false; reason: 'no-room' | 'not-member' };

export type CloseRoomResult = { ok: true; matches: string[] } | { ok: false; reason: 'no-room' | 'not-leader' };

export type SitSeatResult<V> =
	| { ok: true; room: V }
	| { ok: false; reason: 'no-room' | 'not-member' | 'not-draft' | 'not-lobby' | 'not-open' | 'bad-seat' | 'seat-taken' | 'pod-full' | 'historical' };

export type CloseSeatResult<V> =
	| { ok: true; room: V }
	| { ok: false; reason: 'no-room' | 'not-member' | 'not-leader' | 'not-draft' | 'not-lobby' | 'bad-seat' | 'seat-taken' | 'too-few' | 'historical' };

export type StandSeatResult<V> = { ok: true; room: V } | { ok: false; reason: 'no-room' | 'not-member' | 'not-draft' | 'not-lobby' };

export interface AvatarChange {
	roomId: string;
	memberId: string;
	/** The new, normalised value; null when it was cleared. */
	avatarId: string | null;
}

/** The room-level app blob's version. Additive fields never bump it: each reads with a default. */
export const ROOM_APP_VERSION = 2;

export interface LobbyCoreOptions<I extends RoomCreateInput> {
	store: FileRoomStore;
	now: () => number;
	log: LobbyLog;
	/** The hooks for a room of `gameType`, or undefined for a type this server does not host (its rooms quarantine). */
	typeOf: (gameType: string) => RoomTypeHooks<unknown, I> | undefined;
	/** What a room bound to a watchparty room is made as (`bindWatchparty`). */
	watchpartyRoom: I;
}

/** The generic half of a room's view. */
function platformView(room: LobbyRoom, locked: boolean, seats: GameSeats): PlatformRoomView {
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
			ready: isMemberReady(room, m.id),
			// Spread, not `avatarId: m.avatarId`: the key is ABSENT for a member with none, so an
			// in-process reader and a JSON reader see the same two states.
			...(m.avatarId === undefined ? {} : { avatarId: m.avatarId }),
			...(m.look === undefined ? {} : { look: m.look }),
		})),
		seats,
		createdAt: new Date(room.createdAt).toISOString(),
		testing: room.testing,
		scheduledFor: room.scheduledFor === undefined ? null : new Date(room.scheduledFor).toISOString(),
	};
}

function isSecret(v: unknown): v is Secret {
	return typeof v === 'object' && v !== null && typeof (v as Secret).salt === 'string' && typeof (v as Secret).hash === 'string';
}

/**
 * The room-level codec: the platform's fields here, the game seats and game part through the room's
 * type. Its errors name the FIELD, never a value: the message reaches the quarantine reason and the
 * log, and a value here could be the hash.
 */
export function roomAppCodec(typeOf: (gameType: string) => Pick<RoomTypeHooks<unknown>, 'decode' | 'writes'> | undefined): RoomCodec<StoredRoomApp, unknown> {
	const app: AppCodec<StoredRoomApp> = {
		version: ROOM_APP_VERSION,
		serialize: (value) => structuredClone(typeOf(value.gameType)?.writes?.(value) ?? value),
		deserialize(raw, version, ctx) {
			if (typeof raw !== 'object' || raw === null) throw new Error('app is not an object');
			if (version < 1 || version > ROOM_APP_VERSION) throw new Error('app version is not one this build reads');
			const a = raw as Record<string, unknown>;
			if (typeof a.name !== 'string') throw new Error('app.name is not a string');
			if (typeof a.creator !== 'string') throw new Error('app.creator is not a string');
			if (typeof a.leader !== 'string') throw new Error('app.leader is not a string');
			const hooks = typeof a.gameType === 'string' ? typeOf(a.gameType) : undefined;
			if (hooks === undefined) throw new Error('app.gameType is not a known game type');
			if (a.testing !== undefined && typeof a.testing !== 'boolean') throw new Error('app.testing is invalid');
			if (a.scheduledFor !== undefined && typeof a.scheduledFor !== 'number') throw new Error('app.scheduledFor is invalid');
			if (a.secret !== null && !isSecret(a.secret)) throw new Error('app.secret is invalid');
			const { seats, game } = hooks.decode(a, version, { roomId: ctx.roomId });
			return {
				name: a.name,
				creator: a.creator,
				leader: a.leader,
				gameType: a.gameType as string,
				testing: a.testing === true,
				...(a.scheduledFor === undefined ? {} : { scheduledFor: a.scheduledFor as number }),
				secret: a.secret === null ? null : { salt: (a.secret as Secret).salt, hash: (a.secret as Secret).hash },
				seats,
				game,
			};
		},
	};
	return { app };
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

/**
 * The lobby core. `V` is the view a room of the hosting game reads as (the platform's fields and
 * the type's part); `I` the create input. A game's lobby extends it with its own operations, which
 * reach the rooms through the protected members below.
 */
export class RoomLobby<V extends PlatformRoomView, I extends RoomCreateInput> {
	protected readonly store: FileRoomStore;
	protected readonly now: () => number;
	protected readonly log: LobbyLog;
	readonly #typeOf: (gameType: string) => RoomTypeHooks<unknown, I> | undefined;
	readonly #watchpartyRoom: I;
	readonly #codec: RoomCodec<StoredRoomApp, unknown>;
	readonly #rooms = new Map<string, LobbyRoom>();
	/** Kept apart from the records so no dump of a record can carry them. */
	readonly #secrets = new Map<string, Secret>();
	/** In memory only: a read is not a mutation and must not write a file. */
	readonly #touchedAt = new Map<string, number>();
	/** Room files still being deleted (`#forget`): `removed` waits for them. */
	readonly #removing = new Set<Promise<void>>();
	readonly #avatarListeners = new Set<(change: AvatarChange) => void>();
	readonly #changeListeners = new Set<(roomId: string) => void>();
	/**
	 * The newest `createdAt` minted or restored so far. A created room's stamp is forced at least 1 ms
	 * past the last one, so the list is creation order deterministically (the tie-break is the random
	 * room id), across a restart too, because the stamp is what is persisted.
	 */
	#lastCreatedAt = 0;
	#relayRoomOpened: (roomId: string, seatCount: number, gameType: string) => void = () => {};

	constructor(opts: LobbyCoreOptions<I>) {
		this.store = opts.store;
		this.now = opts.now;
		this.log = opts.log;
		this.#typeOf = opts.typeOf;
		this.#watchpartyRoom = opts.watchpartyRoom;
		this.#codec = roomAppCodec(opts.typeOf);
	}

	/** `room`'s own hooks. A room is only ever installed with a type that has them (`openRoomStore`, `#insert`). */
	protected hooksOf(room: LobbyRoom): RoomTypeHooks<unknown, I> {
		return this.#typeOf(room.gameType)!;
	}

	/** The room by id, of whatever type. */
	protected room(roomId: string): LobbyRoom | undefined {
		return this.#rooms.get(roomId);
	}

	protected rooms(): IterableIterator<LobbyRoom> {
		return this.#rooms.values();
	}

	/** Boot only: install a room decoded from disk. */
	protected install(room: LobbyRoom, secret: Secret | null): void {
		this.#rooms.set(room.id, room);
		this.#lastCreatedAt = Math.max(this.#lastCreatedAt, room.createdAt);
		if (secret !== null) this.#secrets.set(room.id, secret);
		this.hooksOf(room).restored?.(room);
	}

	protected view(room: LobbyRoom): V {
		const hooks = this.hooksOf(room);
		const seats = hooks.seatsView?.(room) ?? memberSeats(room);
		return { ...platformView(room, this.#secrets.has(room.id), seats), ...hooks.view(room) } as V;
	}

	/** Save `room` and tell every `onChange` listener. Every mutation ends here. */
	protected persist(room: LobbyRoom): void {
		const hooks = this.hooksOf(room);
		hooks.beforePersist?.(room);
		const now = this.now();
		room.updatedAt = now;
		const members: SerializedMember[] = room.members.map((m) => {
			// No name and no avatar id (R12): a member is saved as who they are, not as what they
			// were called. Both come back from their next request (`rename`, the avatar assert).
			const ready = isMemberReady(room, m.id);
			return {
				participantId: m.id,
				...(m.userId === null ? {} : { accountId: m.userId }),
				joinedAt: m.joinedAt,
				lastSeen: m.joinedAt,
				// Boxed, so a state of `null` survives a restart as `null`, and `ready` rides the same
				// blob. A member with neither writes `null`.
				app: m.state === undefined && !ready ? null : { state: structuredClone(m.state), ready },
			};
		});
		const app: StoredRoomApp = {
			name: room.name,
			creator: room.creator,
			leader: room.leader,
			gameType: room.gameType,
			testing: room.testing,
			...(room.scheduledFor === undefined ? {} : { scheduledFor: room.scheduledFor }),
			secret: this.#secrets.get(room.id) ?? null,
			seats: [...room.seats],
			game: hooks.encode(room),
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
			seats: createSeatTable(null),
			app: this.#codec.app.serialize(app),
			appVersion: ROOM_APP_VERSION,
		};
		this.store.saveSync(snapshot);
		this.changed(room.id);
	}

	/** Tell every `onChange` listener `roomId` reads differently now, with nothing written. */
	protected changed(roomId: string): void {
		for (const listener of [...this.#changeListeners]) {
			try {
				listener(roomId);
			} catch (err) {
				// A broken subscriber must not undo a change that is already stored.
				this.log({ event: 'room-change-listener-failed', roomId, error: (err as Error).message });
			}
		}
	}

	/**
	 * Be told every time a room is written, created or forgotten. Every mutation goes through one
	 * persist, so this is every change a read could see and nothing else: a read (`touch`, `get`,
	 * `list`) never fires it. Returns the unsubscribe.
	 */
	onChange(listener: (roomId: string) => void): () => void {
		this.#changeListeners.add(listener);
		return () => {
			this.#changeListeners.delete(listener);
		};
	}

	/**
	 * Told once, at boot, how a room whose type is its own match (`RoomTypeHooks.relaySeats`) opens
	 * that match: called the moment such a room is created, and at once for every such room already
	 * open (rooms restored from disk, which no match outlived). Unset, such a room has no match behind it.
	 */
	onRelayRoomOpened(hook: (roomId: string, seatCount: number, gameType: string) => void): void {
		this.#relayRoomOpened = hook;
		for (const room of this.#rooms.values()) this.#openRelayMatch(room);
	}

	#openRelayMatch(room: LobbyRoom): void {
		const seats = this.hooksOf(room).relaySeats;
		if (seats !== undefined) this.#relayRoomOpened(room.id, seats, room.gameType);
	}

	list(): V[] {
		return sortRoomsByCreation([...this.#rooms.values()]).map((r) => this.view(r));
	}

	/**
	 * The rooms the front page offers: `list()` minus the rooms nobody has touched for `staleMs`. A
	 * room with a game in progress is always offered. Same order as `list()`.
	 */
	offered(staleMs: number = ROOM_STALE_MS): V[] {
		const now = this.now();
		return sortRoomsByCreation(
			[...this.#rooms.values()].filter((r) => isOfferedRoom(r, this.hooksOf(r).busy, now, staleMs, this.#touchedAt.get(r.id))),
		).map((r) => this.view(r));
	}

	/** Record that `memberId` has `roomId` open now. A non-member or unknown room is ignored. */
	touch(roomId: string, memberId: string): void {
		if (this.isMember(roomId, memberId)) this.#touchedAt.set(roomId, this.now());
	}

	get(roomId: string): V | undefined {
		const room = this.#rooms.get(roomId);
		return room === undefined ? undefined : this.view(room);
	}

	/** Whether `memberId` is a member of `roomId`. False when there is no such room. */
	isMember(roomId: string, memberId: string): boolean {
		const room = this.#rooms.get(roomId);
		return room !== undefined && isRoomMember(room, memberId);
	}

	/** Per-member opaque state owned by the game's routes (the deck a seat holds). Not part of the view. undefined when unset / no room / not a member. */
	playerState(roomId: string, memberId: string): unknown {
		const member = this.#rooms.get(roomId)?.members.find((m) => m.id === memberId);
		return member?.state === undefined ? undefined : structuredClone(member.state);
	}

	/** false when there is no such room or memberId is not a member. Persisted. */
	setPlayerState(roomId: string, memberId: string, state: unknown): boolean {
		const room = this.#rooms.get(roomId);
		const member = room?.members.find((m) => m.id === memberId);
		if (room === undefined || member === undefined) return false;
		member.state = state === undefined ? undefined : structuredClone(state);
		this.persist(room);
		return true;
	}

	/** The members who play, in seat order. */
	protected playersOf(room: LobbyRoom): string[] {
		return this.hooksOf(room).players?.(room) ?? memberSeats(room).filter((s): s is string => s !== null);
	}

	/**
	 * Everyone in a room is a player or a spectator, whatever the room plays (the operator,
	 * 2026-11-02). A newcomer takes the first open seat, only on entering, never on a member's return
	 * (someone who chose to watch stays watching), and never ahead of a member already in the room
	 * without a seat: at a party the watcher who waited takes the loser's seat, not the loser coming
	 * back in (`e2e/turnover.spec.ts`). Nothing moves while the room's seats are shut for its event.
	 */
	#autoSeat(room: LobbyRoom, memberId: string): void {
		if (this.seatsShut(room) !== null) return;
		const players = this.playersOf(room);
		if (room.members.some((m) => m.id !== memberId && !players.includes(m.id))) return;
		const how = this.hooksOf(room).autoSeat?.(room, memberId) ?? 'game-seat';
		if (how !== 'game-seat') return;
		const open = room.seats.indexOf(null);
		if (open === -1) return;
		setGameSeat(room, open, memberId);
		this.log({ event: 'seat-auto', roomId: room.id, seat: open, memberId });
	}

	/** `seatsShutUntil`, for a room in hand. */
	protected seatsShut(room: LobbyRoom): number | null {
		if (room.scheduledFor === undefined) return null;
		const opens = seatsOpenAt(room.scheduledFor);
		return this.now() < opens ? opens : null;
	}

	/**
	 * When a room made for an event opens its seats (`seatsOpenAt`), while they are still shut by the
	 * lobby's clock: until then nobody sits, is seated on joining or on Ready, and nothing deals.
	 * Null once they are open, for a room no event made, and for no such room.
	 */
	seatsShutUntil(roomId: string): number | null {
		const room = this.#rooms.get(roomId);
		return room === undefined ? null : this.seatsShut(room);
	}

	/**
	 * The seat this member holds in the room's game (the view's `seats`), or null: watching, not a
	 * member, or no such room. What a relay match seats a socket by, so the relay and every screen
	 * name the same seat holders.
	 */
	gameSeatOf(roomId: string, memberId: string): number | null {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return null;
		const seat = (this.hooksOf(room).seatsView?.(room) ?? memberSeats(room)).indexOf(memberId);
		return seat === -1 ? null : seat;
	}

	/**
	 * A member steps out. Removed from `members`; their state and Ready go with their row. If they
	 * led the room, leadership passes to whichever remaining member joined EARLIEST (R16). What it
	 * costs their game is the type's (`RoomTypeHooks.leaving`). A room left by its last member is not
	 * deleted here (the idle sweep owns deletion) but leaves `offered()` the instant it empties.
	 * `no-room` and `not-member` are both answered the same 404 by the HTTP layer.
	 */
	leave(roomId: string, memberId: string): LeaveResult<V> {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (!isRoomMember(room, memberId)) return { ok: false, reason: 'not-member' };
		const cost = this.hooksOf(room).leaving?.(room, memberId) ?? {};
		// R16: leadership (whoever remains joined earliest) passes on here if `memberId` held it.
		removeRoomMember(room, memberId);
		this.persist(room);
		this.log({ event: 'room-left', roomId, members: room.members.length, newLeader: room.leader });
		return { ok: true, room: this.view(room), ...cost };
	}

	create(caller: Caller, input: I): CreateResult<V> {
		if (!isDurableParticipantId(caller.id)) return { ok: false, reason: 'not-durable' };
		let id = mintRoomId();
		while (this.#rooms.has(id)) id = mintRoomId();
		return { ok: true, room: this.#insert(id, caller, input) };
	}

	/**
	 * The room a watchparty room's game slot binds to (D21): `wp-` plus a digest of the watchparty
	 * room, so everyone in that room arrives at the same table without anyone passing an id around.
	 * Made on first use with the caller as its creator and leader, joined after that.
	 */
	bindWatchparty(caller: Caller, watchpartyRoom: string): JoinResult<V> {
		if (!isDurableParticipantId(caller.id)) return { ok: false, reason: 'not-durable' };
		const id = watchpartyRoomId(watchpartyRoom);
		if (this.#rooms.has(id)) return this.join(id, caller);
		return { ok: true, room: this.#insert(id, caller, this.#watchpartyRoom), alreadyMember: false };
	}

	#insert(id: string, caller: Caller, input: I): V {
		const hooks = this.#typeOf(input.gameType);
		if (hooks === undefined) throw new Error(`no room type ${input.gameType}`);
		const now = Math.max(this.now(), this.#lastCreatedAt + 1);
		this.#lastCreatedAt = now;
		const ledger = createMembershipLedger();
		addMember(ledger, caller.id, now);
		const room: LobbyRoom = {
			id,
			name: input.name,
			creator: caller.id,
			leader: caller.id,
			gameType: input.gameType,
			testing: input.testing === true,
			...(input.scheduledFor === undefined ? {} : { scheduledFor: input.scheduledFor }),
			...hooks.newGame(input, id),
			createdAt: now,
			updatedAt: now,
			members: [{ id: caller.id, userId: caller.userId, name: caller.name, joinedAt: now, state: undefined }],
			ledger,
		};
		this.#rooms.set(id, room);
		this.#openRelayMatch(room);
		this.#autoSeat(room, caller.id);
		if (input.password !== undefined && input.password !== '') this.#secrets.set(id, makeSecret(input.password));
		this.persist(room);
		const said = hooks.created?.(room) ?? {};
		this.log({ event: 'room-created', roomId: id, gameType: room.gameType, ...said, locked: this.#secrets.has(id) });
		return this.view(room);
	}

	/** Idempotent for an existing member, who needs no password again. */
	join(roomId: string, caller: Caller, password?: string): JoinResult<V> {
		if (!isDurableParticipantId(caller.id)) return { ok: false, reason: 'not-durable' };
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-match' };
		if (isRoomMember(room, caller.id)) return { ok: true, room: this.view(room), alreadyMember: true };
		if (!passwordAdmits(this.#secrets.get(roomId), password)) return { ok: false, reason: 'no-match' };
		const now = this.now();
		// An empty ledger's first member becomes its leader (an emptied room's new arrival leads it).
		addRoomMember(room, { id: caller.id, userId: caller.userId, name: caller.name, joinedAt: now, state: undefined }, now);
		this.#autoSeat(room, caller.id);
		this.persist(room);
		this.log({ event: 'room-joined', roomId, members: room.members.length });
		return { ok: true, room: this.view(room), alreadyMember: false };
	}

	/**
	 * Call `caller.id` by `caller.name` in every room they are a member of. The name was copied once, at
	 * join, so a key renamed in the registry kept its first name in every room it had joined
	 * (2026-10-26). Writes only the rooms whose copy moved.
	 */
	rename(caller: Pick<Caller, 'id' | 'name'>): void {
		for (const room of this.#rooms.values()) {
			const member = room.members.find((m) => m.id === caller.id);
			if (member === undefined || member.name === caller.name) continue;
			member.name = caller.name;
			this.persist(room);
		}
	}

	/** false when there is no such room or the caller is not a member. Persisted. */
	setReady(roomId: string, memberId: string, ready: boolean): boolean {
		const room = this.#rooms.get(roomId);
		if (room === undefined || !isRoomMember(room, memberId)) return false;
		const hooks = this.hooksOf(room);
		if (hooks.ready?.(room, memberId, ready) === 'keep') return true;
		setMemberReady(room, memberId, ready);
		this.persist(room);
		this.log({ event: 'room-ready', roomId, ready });
		hooks.seatsChanged?.(room);
		return true;
	}

	/**
	 * The member's OWN avatar, and nobody else's: `memberId` is always a derived participant id, so a
	 * browser cannot name a row that is not its own. Three states in, two stored: a non-blank string
	 * sets it; `null`, `''`, whitespace, an over-long value and a non-string clear it (`avatarIdOf`).
	 * `false` only when there is no such room or member. Written only when it changed.
	 */
	setAvatar(roomId: string, memberId: string, avatarId: string | null): boolean {
		const room = this.#rooms.get(roomId);
		const member = room?.members.find((m) => m.id === memberId);
		if (room === undefined || member === undefined) return false;
		const next = avatarIdOf(avatarId);
		// Idempotent, and no write when nothing changed: a member's account is written onto the room
		// on every arrival and every change to it. `true` either way: the room is in the asked state.
		if (next === member.avatarId) return true;
		if (next === undefined) delete member.avatarId;
		else member.avatarId = next;
		this.persist(room);
		this.#announceAvatar(roomId, member.id, member.avatarId ?? null);
		return true;
	}

	/** Each member's registry userId, for looking up how they look. Never part of a view. */
	usersOf(roomId: string): { memberId: string; userId: string }[] {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return [];
		return room.members.flatMap((m) => (m.userId === null ? [] : [{ memberId: m.id, userId: m.userId }]));
	}

	/**
	 * A member's avatar picture and cosmetics, as prefs-api answered for them. In memory only: looked
	 * up again after a restart. A real change is announced as an avatar change, so a running match
	 * re-sends its seats, and to `onChange` with nothing written. `false` only when there is no such room or member.
	 */
	setLook(roomId: string, memberId: string, look: Look | undefined): boolean {
		const room = this.#rooms.get(roomId);
		const member = room?.members.find((m) => m.id === memberId);
		if (room === undefined || member === undefined) return false;
		if (sameLook(member.look, look)) return true;
		if (look === undefined) delete member.look;
		else member.look = look;
		this.log({ event: 'room-look', roomId, picture: look?.picture !== undefined, worn: Object.keys(look?.cosmetics ?? {}).length });
		this.#announceAvatar(roomId, memberId, member.avatarId ?? null);
		this.changed(roomId);
		return true;
	}

	#announceAvatar(roomId: string, memberId: string, avatarId: string | null): void {
		// The id itself, not the member's: which character somebody picked is not a secret.
		this.log({ event: 'room-avatar', roomId, avatarId });
		for (const listener of [...this.#avatarListeners]) {
			try {
				listener({ roomId, memberId, avatarId });
			} catch (err) {
				this.log({ event: 'room-avatar-listener-failed', roomId, error: (err as Error).message });
			}
		}
	}

	/** Be told when a member's avatar actually CHANGES (never on an idempotent re-assert). Returns the unsubscribe. */
	onAvatarChange(listener: (change: AvatarChange) => void): () => void {
		this.#avatarListeners.add(listener);
		return () => {
			this.#avatarListeners.delete(listener);
		};
	}

	/** The room by id when it seats through its game seats, with the refusal every seat op shares otherwise. */
	#seatRoom(roomId: string, memberId: string): { room: LobbyRoom; hooks: RoomTypeHooks<unknown, I> } | { refused: 'no-room' | 'not-member' | 'not-draft' | 'not-lobby' } {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { refused: 'no-room' };
		if (!isRoomMember(room, memberId)) return { refused: 'not-member' };
		const hooks = this.hooksOf(room);
		// `not-draft`, the wire's name for a room that does not seat through its game seats.
		if (!hooks.usesSeats(room)) return { refused: 'not-draft' };
		if (hooks.seatsFixed(room)) return { refused: 'not-lobby' };
		return { room, hooks };
	}

	/** Whether `seat` is one a seat op may act on: one the room has, or the one past the last (which grows it), never past its ceiling. */
	#inReach(room: LobbyRoom, hooks: RoomTypeHooks<unknown, I>, seat: number): boolean {
		return Number.isInteger(seat) && seat >= 0 && seat < hooks.seatCeiling(room) && seat <= room.seats.length;
	}

	/**
	 * Take a game seat. `seat` absent takes the first open one (their own counts as open), growing the
	 * room by one past the last when none is; given, it must be open and in reach. Moves the caller from
	 * any seat they held.
	 */
	sitSeat(roomId: string, memberId: string, seat?: number): SitSeatResult<V> {
		const found = this.#seatRoom(roomId, memberId);
		if ('refused' in found) return { ok: false, reason: found.refused };
		const { room, hooks } = found;
		if (this.seatsShut(room) !== null) return { ok: false, reason: 'not-open' };
		if (seat !== undefined && !this.#inReach(room, hooks, seat)) return { ok: false, reason: 'bad-seat' };
		const already = room.seats.indexOf(memberId);
		let target = seat;
		if (target === undefined) {
			const open = room.seats.findIndex((id, i) => id === null || i === already);
			target = open === -1 ? room.seats.length : open;
			if (target >= hooks.seatCeiling(room)) return { ok: false, reason: 'pod-full' };
		} else if (target !== already && (room.seats[target] ?? null) !== null) {
			return { ok: false, reason: 'seat-taken' };
		}
		hooks.growSeats(room, target);
		takeGameSeat(room, memberId, target);
		hooks.trimSeats(room);
		this.persist(room);
		this.log({ event: 'pod-sit', roomId, memberId, seat: target });
		hooks.seatsChanged?.(room);
		return { ok: true, room: this.view(room) };
	}

	/** Give up a game seat. Idempotent: not seated is not a failure. */
	standSeat(roomId: string, memberId: string): StandSeatResult<V> {
		const found = this.#seatRoom(roomId, memberId);
		if ('refused' in found) return { ok: false, reason: found.refused };
		const { room, hooks } = found;
		if (!leaveGameSeat(room, memberId)) return { ok: true, room: this.view(room) };
		hooks.trimSeats(room);
		this.persist(room);
		this.log({ event: 'pod-stand', roomId, memberId });
		hooks.seatsChanged?.(room);
		return { ok: true, room: this.view(room) };
	}

	/** Put the AI in an open seat (`on`), or take it out. Any member. */
	aiSeat(roomId: string, memberId: string, seat: number, on: boolean): SitSeatResult<V> {
		const found = this.#seatRoom(roomId, memberId);
		if ('refused' in found) return { ok: false, reason: found.refused };
		const { room, hooks } = found;
		if (hooks.fieldFixed?.(room) === true) return { ok: false, reason: 'historical' };
		if (on && this.seatsShut(room) !== null) return { ok: false, reason: 'not-open' };
		if (!this.#inReach(room, hooks, seat) || (!on && seat >= room.seats.length)) return { ok: false, reason: 'bad-seat' };
		const now = room.seats[seat] ?? null;
		if (on ? now === AI_SEAT : now === null) return { ok: true, room: this.view(room) };
		if (now !== (on ? null : AI_SEAT)) return { ok: false, reason: 'seat-taken' };
		hooks.growSeats(room, seat);
		setGameSeat(room, seat, on ? AI_SEAT : null);
		hooks.aiSeated?.(room, seat, on);
		hooks.trimSeats(room);
		this.persist(room);
		this.log({ event: on ? 'pod-ai-sit' : 'pod-ai-stand', roomId, memberId, seat });
		hooks.seatsChanged?.(room);
		return { ok: true, room: this.view(room) };
	}

	/** Close an empty seat, or open a closed one: the leader's; never fewer than `MIN_OPEN_SEATS` open. */
	closeSeat(roomId: string, memberId: string, seat: number, closed: boolean): CloseSeatResult<V> {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (!isRoomMember(room, memberId)) return { ok: false, reason: 'not-member' };
		if (room.leader !== memberId) return { ok: false, reason: 'not-leader' };
		const found = this.#seatRoom(roomId, memberId);
		if ('refused' in found) return { ok: false, reason: found.refused };
		const { hooks } = found;
		if (hooks.fieldFixed?.(room) === true) return { ok: false, reason: 'historical' };
		if (!this.#inReach(room, hooks, seat) || seat >= room.seats.length) return { ok: false, reason: 'bad-seat' };
		const now = room.seats[seat] ?? null;
		if (closed ? now === CLOSED_SEAT : now === null) return { ok: true, room: this.view(room) };
		if (now !== (closed ? null : CLOSED_SEAT)) return { ok: false, reason: 'seat-taken' };
		const size = (): number => room.seats.filter((s) => s !== CLOSED_SEAT).length;
		if (closed && size() <= MIN_OPEN_SEATS) return { ok: false, reason: 'too-few' };
		setGameSeat(room, seat, closed ? CLOSED_SEAT : null);
		hooks.trimSeats(room);
		this.persist(room);
		this.log({ event: closed ? 'pod-seat-closed' : 'pod-seat-opened', roomId, memberId, seat, size: size() });
		return { ok: true, room: this.view(room) };
	}

	/**
	 * Forget every room untouched for longer than `idleMs` (or its type's own idle window), on disk as
	 * well as in memory. Never a room with a live game, never one its type spares. Returns the ids dropped.
	 */
	sweep(idleMs?: number): string[] {
		const dropped: string[] = [];
		const now = this.now();
		for (const [id, room] of this.#rooms) {
			const busy = this.hooksOf(room).busy;
			if (!isSweepableRoom(room, busy, now, idleMs)) continue;
			this.hooksOf(room).ending?.(room, 'sweep');
			this.#forget(id);
			dropped.push(id);
			this.log({ event: 'room-forgotten', roomId: id, idleMs: idleMs ?? busy.defaultIdleMs(room) });
		}
		return dropped;
	}

	/** Resolves once every room forgotten so far is gone from disk too (a failed delete is logged as `room-forget-failed`). */
	async removed(): Promise<void> {
		await Promise.all([...this.#removing]);
	}

	/**
	 * Account erase: every room that still names one of `ids` names `to` instead, and is saved. Answers
	 * how many rooms changed. The person leaves first (`leave`), so leadership has passed on.
	 */
	anonymise(ids: ReadonlySet<string>, to: string): number {
		let changed = 0;
		for (const room of this.#rooms.values()) {
			this.hooksOf(room).anonymise?.(room, ids);
			if (replaceIds(room, ids, to) === 0) continue;
			changed++;
			this.persist(room);
		}
		return changed;
	}

	/** Move the start of the event a room was made for, and its seats' opening with it. False when there is no such room. */
	reschedule(roomId: string, at: number): boolean {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return false;
		room.scheduledFor = at;
		this.persist(room);
		return true;
	}

	/**
	 * The owner ends the room for everyone: it is forgotten, as the sweep forgets one, and its type keeps
	 * what it played first. Answers the matches it was playing, for the caller to stop. Any admin in a
	 * testing room may close it: the HTTP layer has already checked admin and membership.
	 */
	close(roomId: string, callerId: string): CloseRoomResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (room.leader !== callerId && !room.testing) return { ok: false, reason: 'not-leader' };
		const hooks = this.hooksOf(room);
		hooks.ending?.(room, 'close');
		const matches = hooks.liveMatches(room);
		this.#forget(roomId);
		this.log({ event: 'room-closed', roomId, matches: matches.length });
		return { ok: true, matches };
	}

	/** Gone from the list the moment it leaves the map, and from disk best-effort. */
	#forget(id: string): void {
		const room = this.#rooms.get(id);
		if (room !== undefined) this.hooksOf(room).ending?.(room, 'forget');
		this.#rooms.delete(id);
		this.#secrets.delete(id);
		this.#touchedAt.delete(id);
		// Logged, because a store that cannot delete must not resurrect the room on the next boot silently.
		const removing = this.store.remove(id).catch((err: unknown) => {
			this.log({ event: 'room-forget-failed', roomId: id, err: String(err) });
		});
		this.#removing.add(removing);
		void removing.finally(() => this.#removing.delete(removing));
		this.changed(id);
	}

	/**
	 * Read every room file back, through `typeOf`: once, before the lobby is used. A record that cannot
	 * be read is quarantined and logged by room id and reason; the reason names what was wrong, never
	 * the bytes, which could include a password hash. Answers how many rooms are open.
	 */
	async open(): Promise<number> {
		const store = this.store;
		const codec = this.#codec;
		for (const roomId of await store.list()) {
			const quarantine = async (reason: string): Promise<void> => {
				await store.quarantine(roomId, reason);
				this.log({ event: 'room-quarantined', roomId, reason });
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
				const decoded = decodeSnapshot(snapshot, codec, { roomId, restoreId: `boot-${this.now()}`, restoredAt: this.now() });
				const app = decoded.app;
				const { dropHolds, game } = this.#typeOf(app.gameType)!.restore(app, roomId);
				const members: LobbyMember[] = [];
				// Rebuilt, not persisted; `leaderId` is set explicitly below, from disk.
				const ledger = createMembershipLedger();
				for (const m of decoded.members) {
					// Nothing names or dresses a member on disk (R12): they are `UNNAMED` and wear no
					// character until their account is read again. Ready is kept across the restart.
					addMember(ledger, m.participantId, m.joinedAt);
					if (!dropHolds && unboxReady(m.app)) ledgerSetReady(ledger, m.participantId, true);
					members.push({ id: m.participantId, userId: m.accountId ?? null, name: UNNAMED, joinedAt: m.joinedAt, state: dropHolds ? undefined : unboxState(m.app) });
				}
				ledger.leaderId = app.leader;
				this.install(
					{
						id: roomId,
						name: app.name,
						creator: app.creator,
						leader: app.leader,
						gameType: app.gameType,
						testing: app.testing === true,
						...(app.scheduledFor === undefined ? {} : { scheduledFor: app.scheduledFor }),
						seats: app.seats,
						game: game(members),
						createdAt: decoded.createdAt,
						// The raw snapshot's clock: when this room was last touched by the process that wrote it.
						updatedAt: snapshot.updatedAt,
						members,
						ledger,
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
		return this.#rooms.size;
	}
}

/** A stored seat list: every seat a holder's id, a marker, or open. */
function isStoredSeats(v: unknown): v is GameSeats {
	return Array.isArray(v) && v.every((s) => s === null || typeof s === 'string');
}

/**
 * The room type of a game that keeps nothing of its own in the room (bomberman): no game part, its
 * players in the platform's game seats, opened with `seats` of them and growing to `max`, an AI or a
 * closed seat in any open one. `relaySeats` when the room is its own relay match.
 */
export function plainRoomType<I extends RoomCreateInput>(size: { seats: number; max: number; relaySeats?: number }): RoomTypeHooks<Record<string, never>, I> {
	const open = (): GameSeats => new Array<string | null>(size.seats).fill(null);
	return {
		newGame: () => ({ seats: open(), game: {} }),
		encode: () => ({}),
		decode(app) {
			if (app.seats !== undefined && !isStoredSeats(app.seats)) throw new Error('app.seats is invalid');
			return { seats: app.seats === undefined ? open() : [...app.seats], game: {} };
		},
		restore: () => ({ dropHolds: false, game: () => ({}) }),
		view: () => ({}),
		busy: NO_BUSY_HOOK,
		liveMatches: () => [],
		usesSeats: () => true,
		seatsFixed: () => false,
		seatCeiling: () => size.max,
		growSeats(room, seat) {
			while (room.seats.length <= seat) room.seats = [...room.seats, null];
		},
		trimSeats(room) {
			while (room.seats.length > size.seats && room.seats.at(-1) === null) room.seats = room.seats.slice(0, -1);
		},
		...(size.relaySeats === undefined ? {} : { relaySeats: size.relaySeats }),
	};
}

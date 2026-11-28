/**
 * The lobby core: which rooms exist, who is in them, who leads them and holds which seat, kept on
 * disk, for any game type. A game type plugs in through `RoomTypeHooks` (its own part of the record,
 * its seat rules, its view, what leaving or a Ready costs it); this file never names a game's field.
 * Magic's lobby (`games/magic/server/src/room/lobby.ts`) is this core with Magic's hooks, and a game
 * with nothing of its own to keep (bomberman) plays on `plainRoomType`.
 *
 * ## Persistence: write-through, through `@wolffm/rooms-server/store`
 *
 * A deploy restarts the server several times a day, so every mutation queues that room's snapshot
 * before the call returns (`FileRoomStore`'s atomic temp-file-fsync-rename, which production's
 * `OffLoopRoomStore` runs off the event loop: a stalled disk must never stop the server). No
 * debounce: the write starts at once, and the kernel's shutdown drain awaits it (`flushed`). Rooms are stored in the store's
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
import { OffLoopRoomStore } from './off-loop-store.js';
import { createSeatTable, isDurableParticipantId } from '@wolffm/rooms-protocol';
import { addMember, createMembershipLedger, setReady as ledgerSetReady } from '@wolffm/rooms-server';
import { seatsOpenAt } from '@hadoku/platform-wire/events';
import { sameLook, type Look } from '@hadoku/platform-wire/look';
import { ROOM_ID_RE } from '@hadoku/platform-wire/room-feed';
import type { AnyRoomSettings } from '@hadoku/platform-wire/room-settings';

import { moveIds, namesAny, replaceIds, type IdMove } from '../erase/anonymise.ts';
import { seatPersonas, type AiPersona } from './ai-faces.ts';
import { avatarIdOf } from './avatar.ts';
import type { Caller } from './caller.ts';
import { ROOM_STALE_MS, UNNAMED } from './constants.ts';
import { addRoomMember, isMemberReady, isRoomMember, passRoomLeader, passwordAdmits, removeRoomMember, setMemberReady } from './membership.ts';
import { makeSecret, mintRoomId, type Secret } from './provisioning.ts';
import { AI_SEAT, CLOSED_SEAT, leaveGameSeat, memberSeats, setGameSeat, takeGameSeat, type GameSeats, type PlatformMember, type PlatformRoomRecord } from './record.ts';
import { isOfferedRoom, isSweepableRoom, NO_BUSY_HOOK, sortRoomsByCreation, type RoomBusyHook } from './room-list.ts';
import { lowerCapacity, replaceWithBot } from './seat-table-adapter.ts';
import { stricterTier } from './tier-floor.ts';
import { watchpartyRoomId } from './watchparty-link.ts';

/** A member as the lobby keeps one: the platform's record plus what a view shows of them. */
/**
 * A testing room's stand-in: a `dev:` identity no browser presents, which holds a seeded place until
 * the first person to join takes it over whole (`RoomLobby.join`).
 */
export const TESTING_STAND_IN_ID = 'dev:testing-stand-in';

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
	/** The room's own tier floor (`tier-floor.ts`): Create room's friends-only switch. The game type's own floor, if stricter, wins. */
	minTier?: string;
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
	/** The room's own tier floor (`tier-floor.ts`); absent for a room anyone at the app's floor may see. */
	minTier?: string;
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
	/** Absent for a room with no floor of its own. */
	minTier?: string;
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
	/**
	 * The leader's three atomic ops' fallback seat lineup for a room this type says does NOT
	 * `usesSeats` — wave 120 §S2: a 1v1 room's one `RoomTable` IS its seats, so the leader's
	 * remove, lower-capacity AND bot-replace reach it too, through the same table `gameSeatsOf`'s
	 * own non-pod branch already reads, rather than the room's own (unused, always-empty)
	 * `room.seats`. Undefined declines: the plain `not-draft` every other seat op already answers.
	 * `botReplacesHuman` still checks the target's own `supportsBot` before it does anything with
	 * it — a 1v1 room's table is not offered an AI seat (see `GenericSeatTarget.supportsBot`'s own
	 * header), but the route now answers that truthfully (`'no-bot-seat'`), never the `not-draft`
	 * that would wrongly say this room does not seat through game seats at all. Not consulted for
	 * `sitSeat`/`standSeat`/`aiSeat`/`closeSeat`, which stay gated on `usesSeats` exactly as before.
	 */
	extraSeatTarget?(room: LobbyRoom<G>): GenericSeatTarget | undefined;
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
	/** A testing room's stand-in gave `to` its place (`#handOver`): the record already names `to`; what the game keeps outside it follows. */
	handedOver?(room: LobbyRoom<G>, from: string, to: string): void;
	/** The room is about to be forgotten (a close or the sweep): keep what it played, settle what it owes. */
	ending?(room: LobbyRoom<G>, why: 'close' | 'sweep' | 'forget'): void;
	/** A relay room's match seat count: set for a type whose room IS its match (`onRelayRoomOpened`). */
	relaySeats?: number;
	/** Every room of this type has at least this tier floor (`tier-floor.ts`), whatever its creator chose. */
	minTier?: string;
	/**
	 * Whether `rest` names a sub-place inside this room that the type keeps track of beyond its game
	 * seats (a table id, a match this room remembers) — `room/serve.ts`'s `placeOfKey`, matching a
	 * stale table-keyed room-socket join back to its room. Default: never (a type with no such idea,
	 * `plainRoomType`'s).
	 */
	subPlaceOf?(room: LobbyRoom<G>, rest: string): boolean;
	/** The room's settings, which its leader changes (`RoomLobby.setSettings`). Absent: the type has none. */
	settings?: RoomTypeSettings<G>;
}

/**
 * Where a room type keeps its settings and when they are locked. The fields themselves are the
 * game's declaration (`@hadoku/platform-wire/room-settings`); the type only says where they live
 * in its game part (it stores them, and its view shows them) and answers each lock by name.
 */
export interface RoomTypeSettings<G> {
	spec: AnyRoomSettings;
	read(room: LobbyRoom<G>): Record<string, unknown>;
	/** Called only with a change that passed every lock, before the room is saved. */
	write(room: LobbyRoom<G>, next: Record<string, unknown>): void;
	/** Why the fields under `lock` cannot change now (the refusal's reason), or null when they can. */
	locked(room: LobbyRoom<G>, lock: string): string | null;
}

/**
 * `setSettings`' answer. `no-settings`: the room's type declares none. Any other refusal is a lock's
 * reason, as the type's `locked` named it (`match-live` for the kit's `LIVE` lock).
 */
export type SetSettingsResult<V> = { ok: true; room: V } | { ok: false; reason: string };

/** The reason a relay room refuses a `LIVE` setting while its match is live or counting down. */
export const MATCH_LIVE = 'match-live';

/**
 * A generic seat lineup the leader's atomic ops can read and write — `room.seats` itself (every
 * room type that `usesSeats`), or, via `RoomTypeHooks.extraSeatTarget`, wherever ELSE a type that
 * does NOT keeps its seating (wave 120 §S2: a 1v1 room's one `RoomTable`).
 */
export interface GenericSeatTarget {
	read(): GameSeats;
	write(seats: GameSeats): void;
	/**
	 * Whether this lineup has an AI-occupies-a-seat idea at all — `botReplacesHuman`'s own gate,
	 * checked before it ever picks a seat. `room.seats` always does (`AI_SEAT`). A 1v1 room's one
	 * table does not (wave 120 §S2): `false` here is what lets that route answer a truthful,
	 * specific refusal (`'no-bot-seat'`) instead of the plain `not-draft` a room that does not seat
	 * through game seats AT ALL answers — a 1v1 room now does, for the other two ops.
	 */
	supportsBot: boolean;
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

/** `aiSeat`'s answer: a seat's answer, or `not-leader` — only the room's leader seats or unseats the AI. */
export type AiSeatResult<V> = SitSeatResult<V> | { ok: false; reason: 'not-leader' };

export type CloseSeatResult<V> =
	| { ok: true; room: V }
	| { ok: false; reason: 'no-room' | 'not-member' | 'not-leader' | 'not-draft' | 'not-lobby' | 'bad-seat' | 'seat-taken' | 'too-few' | 'historical' };

export type StandSeatResult<V> = { ok: true; room: V } | { ok: false; reason: 'no-room' | 'not-member' | 'not-draft' | 'not-lobby' };

/**
 * The three atomic seat ops every member-is-a-player-or-a-spectator room needs and `sitSeat`/
 * `aiSeat`/`closeSeat` do not give it, because each of those refuses an occupied seat
 * (`docs/planning/wave119-2026-11-16.md` §S; the survey's §7 names the same gap in
 * `@wolffm/rooms-protocol` and bomberman, unbuilt everywhere alike). Each evicts its occupant to
 * the spectator row FIRST, in the same call, so there is never a tick with a stale seat and a
 * fresh one both claiming the member. Leader-only; each is the leader's own kick/shrink/replace,
 * never a member acting on themselves. Built against cardtable's own `GameSeats`, not
 * `@wolffm/rooms-protocol`'s `SeatTable` — see `removeFromSeat`'s own doc for why.
 */
export type PassLeaderResult<V> =
	| { ok: true; room: V }
	| { ok: false; reason: 'no-room' | 'not-member' | 'not-leader' | 'target-not-member' };

export type RemoveFromSeatResult<V> =
	| { ok: true; room: V }
	| { ok: false; reason: 'no-room' | 'not-member' | 'not-leader' | 'target-not-member' | 'not-draft' | 'not-lobby' };

export type LowerSeatCapacityResult<V> =
	| { ok: true; room: V; evicted: readonly string[] }
	| { ok: false; reason: 'no-room' | 'not-member' | 'not-leader' | 'not-draft' | 'not-lobby' | 'historical' | 'too-few' };

export type BotReplacesHumanResult<V> =
	| { ok: true; room: V; evicted: string | null }
	| { ok: false; reason: 'no-room' | 'not-member' | 'not-leader' | 'not-draft' | 'not-lobby' | 'historical' | 'bad-seat' | 'no-bot-seat' };

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
		// Spread: the key is ABSENT for a room with no floor, as `avatarId` is for a member with no character.
		...(room.minTier === undefined ? {} : { minTier: room.minTier }),
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
			if (a.minTier !== undefined && typeof a.minTier !== 'string') throw new Error('app.minTier is invalid');
			if (a.secret !== null && !isSecret(a.secret)) throw new Error('app.secret is invalid');
			const { seats, game } = hooks.decode(a, version, { roomId: ctx.roomId });
			return {
				name: a.name,
				creator: a.creator,
				leader: a.leader,
				gameType: a.gameType as string,
				testing: a.testing === true,
				...(a.scheduledFor === undefined ? {} : { scheduledFor: a.scheduledFor as number }),
				...(a.minTier === undefined ? {} : { minTier: a.minTier as string }),
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
			...(room.minTier === undefined ? {} : { minTier: room.minTier }),
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

	/**
	 * Everyone in a room is a player or a spectator, never neither (the operator, 2026-11-02):
	 * `'player'` iff `memberId` holds a game seat, `'spectator'` iff they are a member who holds
	 * none. Derived from the seats every time, never stored, so there is no third value to desync
	 * into. Undefined for a non-member or no such room — the question does not apply to them.
	 */
	roleOf(roomId: string, memberId: string): 'player' | 'spectator' | undefined {
		if (!this.isMember(roomId, memberId)) return undefined;
		return this.gameSeatOf(roomId, memberId) === null ? 'spectator' : 'player';
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
		const hooks = this.hooksOf(room);
		const how = hooks.autoSeat?.(room, memberId) ?? 'game-seat';
		if (how !== 'game-seat') return;
		// A member back in still holds the seat they left in: never a second one.
		if (room.seats.includes(memberId)) return;
		// None open: grow the room by one past the last, as a Sit press does (`sitSeat`), up to the type's ceiling.
		let open = room.seats.indexOf(null);
		if (open === -1) {
			if (room.seats.length >= hooks.seatCeiling(room)) return;
			open = room.seats.length;
			hooks.growSeats(room, open);
		}
		setGameSeat(room, open, memberId);
		// As every other seat op does: a type that keeps a seat open (`plainRoomType`'s `keepOneOpen`) grows here.
		hooks.trimSeats(room);
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
	/**
	 * Whether `rest` names a sub-place inside `roomId` that its type keeps track of beyond its game
	 * seats (a table id, a match this room remembers) — `room/serve.ts`'s `placeOfKey`, matching a
	 * stale table-keyed room-socket join back to its room. False for no such room, or for a type
	 * with no concept of one (`plainRoomType`'s).
	 */
	subPlaceOf(roomId: string, rest: string): boolean {
		const room = this.#rooms.get(roomId);
		return room !== undefined && (this.hooksOf(room).subPlaceOf?.(room, rest) ?? false);
	}

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

	/** The floor a room made from `input` would have: its own, or its game type's when that is stricter (`tier-floor.ts`). */
	minTierOf(input: Pick<I, 'gameType' | 'minTier'>): string | undefined {
		return stricterTier(input.minTier, this.#typeOf(input.gameType)?.minTier);
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
		const minTier = this.minTierOf(input);
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
			...(minTier === undefined ? {} : { minTier }),
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

	/**
	 * The leader changes some of the room's settings; the rest stay as they are. `patch` is already
	 * valid (`RoomSettingsSpec.parsePatch`). A field whose value does not move is no change; one that
	 * does is checked against its lock, and the first lock that holds refuses the whole patch.
	 */
	setSettings(roomId: string, callerId: string, patch: Record<string, unknown>): SetSettingsResult<V> {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		return this.changeSettings(room, callerId, patch);
	}

	/** `setSettings` on a room in hand. `write` stands in for the type's own (a game with more to move when a setting does). */
	protected changeSettings(room: LobbyRoom, callerId: string, patch: Record<string, unknown>, write?: (room: LobbyRoom, next: Record<string, unknown>) => void): SetSettingsResult<V> {
		const settings = this.hooksOf(room).settings;
		if (settings === undefined) return { ok: false, reason: 'no-settings' };
		if (room.leader !== callerId) return { ok: false, reason: 'not-leader' };
		const result = settings.spec.apply(settings.read(room), patch, (lock) => settings.locked(room, lock));
		if (!result.ok) return { ok: false, reason: result.reason };
		if (result.changed.length === 0) return { ok: true, room: this.view(room) };
		(write ?? settings.write)(room, result.next);
		this.persist(room);
		this.log({ event: 'room-settings', roomId: room.id, settings: result.next });
		return { ok: true, room: this.view(room) };
	}

	/** Idempotent for an existing member, who needs no password again. */
	join(roomId: string, caller: Caller, password?: string): JoinResult<V> {
		if (!isDurableParticipantId(caller.id)) return { ok: false, reason: 'not-durable' };
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-match' };
		if (isRoomMember(room, caller.id)) return { ok: true, room: this.view(room), alreadyMember: true };
		if (!passwordAdmits(this.#secrets.get(roomId), password)) return { ok: false, reason: 'no-match' };
		if (room.testing && isRoomMember(room, TESTING_STAND_IN_ID)) {
			this.#handOver(room, caller);
			return { ok: true, room: this.view(room), alreadyMember: false };
		}
		const now = this.now();
		// An empty ledger's first member becomes its leader (an emptied room's new arrival leads it).
		addRoomMember(room, { id: caller.id, userId: caller.userId, name: caller.name, joinedAt: now, state: undefined }, now);
		this.#autoSeat(room, caller.id);
		this.persist(room);
		this.log({ event: 'room-joined', roomId, members: room.members.length });
		return { ok: true, room: this.view(room), alreadyMember: false };
	}

	/**
	 * A testing room's stand-in gives the first person in its whole place: its seat, its deck, its
	 * series and its lead, the way an account erase hands a person's place to a tombstone
	 * (`anonymise`). So a seeded situation (a series between games, say) is one an admin plays from,
	 * not only watches.
	 */
	#handOver(room: LobbyRoom, caller: Caller): void {
		const ids = new Set([TESTING_STAND_IN_ID]);
		this.hooksOf(room).anonymise?.(room, ids);
		replaceIds(room, ids, caller.id);
		const member = room.members.find((m) => m.id === caller.id);
		if (member !== undefined) {
			member.userId = caller.userId;
			member.name = caller.name;
		}
		this.hooksOf(room).handedOver?.(room, TESTING_STAND_IN_ID, caller.id);
		this.persist(room);
		this.log({ event: 'room-handed-over', roomId: room.id });
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
	#seatRoom(roomId: string, memberId: string, override = false): { room: LobbyRoom; hooks: RoomTypeHooks<unknown, I> } | { refused: 'no-room' | 'not-member' | 'not-draft' | 'not-lobby' } {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { refused: 'no-room' };
		if (!override && !isRoomMember(room, memberId)) return { refused: 'not-member' };
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
	 * `removeFromSeat`/`lowerSeatCapacity`/`botReplacesHuman`'s own resolver (wave 120 §S2) — the
	 * same checks as `#seatRoom`, but a room that does NOT `usesSeats` gets one more chance:
	 * `hooks.extraSeatTarget`, a type's OWN seat lineup for just these three ops (a 1v1 room's one
	 * table). `generic` tells the caller whether `target` IS `room.seats` (so `trimSeats` applies)
	 * or the type's own stand-in (which trims nothing — a fixed-size table, never grown or shrunk
	 * this way). `room.seats` always `supportsBot` (its `AI_SEAT` marker); a type's own stand-in
	 * says for itself.
	 */
	#seatOpRoom(
		roomId: string,
		memberId: string,
		override = false,
	):
		| { room: LobbyRoom; hooks: RoomTypeHooks<unknown, I>; target: GenericSeatTarget; generic: boolean }
		| { refused: 'no-room' | 'not-member' | 'not-draft' | 'not-lobby' } {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { refused: 'no-room' };
		if (!override && !isRoomMember(room, memberId)) return { refused: 'not-member' };
		const hooks = this.hooksOf(room);
		if (hooks.usesSeats(room)) {
			if (hooks.seatsFixed(room)) return { refused: 'not-lobby' };
			return {
				room,
				hooks,
				generic: true,
				target: {
					read: () => room.seats,
					write: (seats) => {
						room.seats = seats;
					},
					supportsBot: true,
				},
			};
		}
		const target = hooks.extraSeatTarget?.(room);
		if (target === undefined) return { refused: 'not-draft' };
		return { room, hooks, generic: false, target };
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

	/** Put the AI in an open seat (`on`), or take it out. The leader's, or `override`'s (see `removeFromSeat`). */
	aiSeat(roomId: string, memberId: string, seat: number, on: boolean, override = false): AiSeatResult<V> {
		const found = this.#seatRoom(roomId, memberId, override);
		if ('refused' in found) return { ok: false, reason: found.refused };
		const { room, hooks } = found;
		if (!override && room.leader !== memberId) return { ok: false, reason: 'not-leader' };
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

	/** Close an empty seat, or open a closed one: the leader's, or `override`'s (see `removeFromSeat`); never fewer than `MIN_OPEN_SEATS` open. */
	closeSeat(roomId: string, memberId: string, seat: number, closed: boolean, override = false): CloseSeatResult<V> {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (!override && !isRoomMember(room, memberId)) return { ok: false, reason: 'not-member' };
		if (!override && room.leader !== memberId) return { ok: false, reason: 'not-leader' };
		const found = this.#seatRoom(roomId, memberId, override);
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
	 * The leader hands the room's leadership to `targetId`, another member, seated or watching.
	 * Passing it to yourself is answered `ok` and changes nothing.
	 */
	passLeader(roomId: string, memberId: string, targetId: string, override = false): PassLeaderResult<V> {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (!override && !isRoomMember(room, memberId)) return { ok: false, reason: 'not-member' };
		if (!override && room.leader !== memberId) return { ok: false, reason: 'not-leader' };
		if (targetId === memberId) return { ok: true, room: this.view(room) };
		if (!passRoomLeader(room, targetId)) return { ok: false, reason: 'target-not-member' };
		this.persist(room);
		this.log({ event: 'leader-passed', roomId, memberId, targetId });
		return { ok: true, room: this.view(room) };
	}

	/**
	 * The leader removes `targetId` from whatever game seat they hold, to the spectator row.
	 * Idempotent: a target who holds none is still answered `ok`. Never touches membership — they
	 * stay in the room, watching (this file's own "a player or a spectator, never neither",
	 * 2026-11-02). `targetId` need not be `memberId`; this is the leader acting on someone else,
	 * which is exactly what `standSeat` (self-service) cannot do. Resolved through `#seatOpRoom`
	 * (wave 120 §S2), not `#seatRoom`: a room that does not `usesSeats` gets one more chance at
	 * `hooks.extraSeatTarget` before the plain `not-draft` — a 1v1 room's one table, for instance.
	 * The library's own `removeFromSeat(table, participantId)` is `unseatParticipant(table,
	 * participantId, { hold: false })`, the same shape a plain null-out already was, so the target
	 * array is mutated directly here rather than through `seat-table-adapter.ts`.
	 * `override`: the caller acts with an operator's reach (a wife or admin tier, checked by the route),
	 * needing to be neither the leader nor a member.
	 */
	removeFromSeat(roomId: string, memberId: string, targetId: string, override = false): RemoveFromSeatResult<V> {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (!override && !isRoomMember(room, memberId)) return { ok: false, reason: 'not-member' };
		if (!override && room.leader !== memberId) return { ok: false, reason: 'not-leader' };
		if (!isRoomMember(room, targetId)) return { ok: false, reason: 'target-not-member' };
		const found = this.#seatOpRoom(roomId, memberId, override);
		if ('refused' in found) return { ok: false, reason: found.refused };
		const { room: r, hooks, target, generic } = found;
		const seats = target.read();
		const at = seats.indexOf(targetId);
		if (at === -1) return { ok: true, room: this.view(r) };
		target.write(seats.map((s, i) => (i === at ? null : s)));
		if (generic) hooks.trimSeats(r);
		this.persist(r);
		this.log({ event: 'seat-removed-by-leader', roomId, memberId, targetId });
		hooks.seatsChanged?.(r);
		return { ok: true, room: this.view(r) };
	}

	/**
	 * The leader closes seats from the TOP down until `count` are open, evicting any occupant
	 * first — a human to the spectator row, an AI simply removed — instead of `closeSeat`'s refusal
	 * on an occupied seat. Never below `MIN_OPEN_SEATS`. A `count` already met is a no-op. Answers
	 * the humans evicted, highest seat first. `AI_SEAT`/`CLOSED_SEAT` are not member ids, so the
	 * default `memberSeats` view reads them as open same as any other non-member string — a room
	 * type that wants its view to tell "AI"/"closed" from "open" gives itself its own `seatsView`
	 * (same as Magic's pod view carries AI through `podAi`, a field of its own, not this one's).
	 * Resolved through `#seatOpRoom` (wave 120 §S2): see `removeFromSeat`'s header.
	 */
	lowerSeatCapacity(roomId: string, memberId: string, count: number, override = false): LowerSeatCapacityResult<V> {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (!override && !isRoomMember(room, memberId)) return { ok: false, reason: 'not-member' };
		if (!override && room.leader !== memberId) return { ok: false, reason: 'not-leader' };
		const found = this.#seatOpRoom(roomId, memberId, override);
		if ('refused' in found) return { ok: false, reason: found.refused };
		const { room: r, hooks, target, generic } = found;
		if (hooks.fieldFixed?.(r) === true) return { ok: false, reason: 'historical' };
		if (!Number.isInteger(count) || count < MIN_OPEN_SEATS) return { ok: false, reason: 'too-few' };
		const before = target.read();
		const { seats, evicted } = lowerCapacity(before, count);
		if (evicted.length === 0 && seats.every((s, i) => s === before[i])) return { ok: true, room: this.view(r), evicted };
		target.write(seats);
		if (generic) hooks.trimSeats(r);
		this.persist(r);
		this.log({ event: 'seat-capacity-lowered', roomId, memberId, count, evicted: evicted.length });
		hooks.seatsChanged?.(r);
		return { ok: true, room: this.view(r), evicted };
	}

	/**
	 * The leader puts the AI in `seat`, evicting whoever holds it first — a human to the spectator
	 * row — instead of `aiSeat`'s refusal on an occupied seat. Already the AI's: a no-op. Resolved
	 * through `#seatOpRoom` (wave 120 §S2): see `removeFromSeat`'s header. A room whose target
	 * does not `supportsBot` (a 1v1 room's one table — no AI-occupies-a-seat idea of its own) is
	 * refused `'no-bot-seat'`, a truthful, specific reason — never the plain `not-draft`, which
	 * would wrongly say this room does not seat through game seats at all (it does, for the other
	 * two ops), and never an invented AI seat the table has nowhere to show.
	 * `override`: the caller acts with an operator's reach (a wife or admin tier, checked by the route),
	 * needing to be neither the leader nor a member.
	 */
	botReplacesHuman(roomId: string, memberId: string, seat: number, override = false): BotReplacesHumanResult<V> {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (!override && !isRoomMember(room, memberId)) return { ok: false, reason: 'not-member' };
		if (!override && room.leader !== memberId) return { ok: false, reason: 'not-leader' };
		const found = this.#seatOpRoom(roomId, memberId, override);
		if ('refused' in found) return { ok: false, reason: found.refused };
		const { room: r, hooks, target, generic } = found;
		if (hooks.fieldFixed?.(r) === true) return { ok: false, reason: 'historical' };
		if (!target.supportsBot) return { ok: false, reason: 'no-bot-seat' };
		if (!this.#inReach(r, hooks, seat) || seat >= r.seats.length) return { ok: false, reason: 'bad-seat' };
		const before = target.read();
		const { seats, evicted } = replaceWithBot(before, seat);
		if (evicted === null && seats[seat] === before[seat]) return { ok: true, room: this.view(r), evicted: null };
		target.write(seats);
		hooks.aiSeated?.(r, seat, true);
		if (generic) hooks.trimSeats(r);
		this.persist(r);
		this.log({ event: 'seat-bot-replaced-human', roomId, memberId, seat, evicted: evicted !== null });
		hooks.seatsChanged?.(r);
		return { ok: true, room: this.view(r), evicted };
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

	/** Resolves once every room written or forgotten so far is on disk (`OffLoopRoomStore`); at once for a store that writes in the call. */
	async flushed(): Promise<void> {
		await this.removed();
		if (this.store instanceof OffLoopRoomStore) await this.store.flushed();
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

	/**
	 * Account merge: every room that names the merged-away account names the kept one instead, by
	 * `moveIds` — so a room that already names the kept account is a conflict it wins, left for the
	 * erase sweep that follows (`erase/rooms.ts` has the person leave it first). Each room changed is
	 * saved. Answers how many changed.
	 */
	merge(move: IdMove): number {
		let changed = 0;
		for (const room of this.#rooms.values()) {
			if (moveIds(room, move) === 0) continue;
			changed++;
			this.persist(room);
		}
		return changed;
	}

	/** Does the room's record name any of `ids` anywhere (a member, a seat, a result)? False for no such room. */
	names(roomId: string, ids: ReadonlySet<string>): boolean {
		const room = this.#rooms.get(roomId);
		return room !== undefined && namesAny(room, ids);
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
		// What this process has already written to the directory is read back, not the bytes before it.
		await this.flushed();
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
						...(app.minTier === undefined ? {} : { minTier: app.minTier }),
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

/** How a plain room is sized, and which of the platform's seat behaviours it opts into. */
export interface PlainRoomSize {
	/** The seats a new room opens with; trimming never takes it below this. */
	seats: number;
	/** The most seats it grows to. */
	max: number;
	/** A relay room's match seat count: set when the room IS its relay match. */
	relaySeats?: number;
	/**
	 * Report seats as stored — `AI_SEAT` and `CLOSED_SEAT` included — rather than `memberSeats`'
	 * reading, which shows both as open. A game whose seat list draws bots and closed seats wants
	 * this; neither marker is ever a member id, so `gameSeatOf` still only matches a member's own seat.
	 */
	markedSeats?: boolean;
	/**
	 * Keep one seat open: whenever every seat is taken (no open and no closed one), add another,
	 * up to `max`. The room grows by itself; nobody presses a "+" to make room for the next player,
	 * and a seat the leader closed is never reopened by it.
	 */
	keepOneOpen?: boolean;
	/**
	 * The game's settings (`@hadoku/platform-wire/room-settings`): kept in the room's game part
	 * (`app.game.settings`), shown as the view's `settings`, changed by the leader. `locked` answers
	 * each of the fields' locks by name; absent, nothing is ever locked.
	 */
	settings?: { spec: AnyRoomSettings; locked?(room: LobbyRoom<PlainGame>, lock: string): string | null };
}

/** A plain room's game part: only its settings, when its game declares any. */
export interface PlainGame {
	settings?: Record<string, unknown>;
}

/** What a plain room's view adds to the platform's: the AI at each seat, `seatPersonas`'s draw, and its settings. */
export interface PlainRoomView {
	/** In seat order; null where no AI sits. */
	aiSeats: (AiPersona | null)[];
	/** Present when the game declares settings: every field, at its value now. */
	settings?: Record<string, unknown>;
}

/**
 * The room type of a game that keeps nothing of its own in the room (bomberman): no game part, its
 * players in the platform's game seats, opened with `seats` of them and growing to `max`, an AI or a
 * closed seat in any open one. `relaySeats` when the room is its own relay match.
 *
 * A member who leaves the room gives up their seat (`leaving`): `RoomLobby.leave` drops only the
 * membership, so without it the departed id stayed in the seat for good.
 */
export function plainRoomType<I extends RoomCreateInput>(size: PlainRoomSize): RoomTypeHooks<PlainGame, I> {
	const open = (): GameSeats => new Array<string | null>(size.seats).fill(null);
	const declared = size.settings;
	/** A room's settings as the game part holds them; a room made before its game declared any reads the defaults. */
	const settingsOf = (room: LobbyRoom<PlainGame>): Record<string, unknown> => room.game.settings ?? declared!.spec.defaults();
	const game = (settings: Record<string, unknown> | undefined): PlainGame => (settings === undefined ? {} : { settings });
	const full = (seats: GameSeats): boolean => !seats.some((s) => s === null || s === CLOSED_SEAT);
	const trim = (room: { seats: GameSeats }): void => {
		while (room.seats.length > size.seats && room.seats.at(-1) === null) room.seats = room.seats.slice(0, -1);
		if (size.keepOneOpen === true && room.seats.length < size.max && full(room.seats)) room.seats = [...room.seats, null];
	};
	return {
		newGame: () => ({ seats: open(), game: game(declared?.spec.defaults()) }),
		encode: (room) => game(room.game.settings),
		decode(app) {
			if (app.seats !== undefined && !isStoredSeats(app.seats)) throw new Error('app.seats is invalid');
			const raw = typeof app.game === 'object' && app.game !== null ? (app.game as { settings?: unknown }).settings : undefined;
			// A game that declares no settings ignores whatever a file holds; one that does refuses settings it never declared.
			const settings = declared === undefined ? undefined : declared.spec.readStored(raw);
			if (settings === null) throw new Error('app.game.settings is invalid');
			return { seats: app.seats === undefined ? open() : [...app.seats], game: game(settings) };
		},
		restore: (app) => ({ dropHolds: false, game: () => game((app.game as PlainGame).settings) }),
		view: (room): PlainRoomView => ({ aiSeats: seatPersonas(room, AI_SEAT), ...(declared === undefined ? {} : { settings: structuredClone(settingsOf(room)) }) }),
		busy: NO_BUSY_HOOK,
		liveMatches: () => [],
		usesSeats: () => true,
		seatsFixed: () => false,
		seatCeiling: () => size.max,
		growSeats(room, seat) {
			while (room.seats.length <= seat) room.seats = [...room.seats, null];
		},
		trimSeats: trim,
		leaving(room, memberId) {
			const seat = room.seats.indexOf(memberId);
			if (seat === -1) return;
			room.seats = room.seats.map((s, i) => (i === seat ? null : s));
			trim(room);
		},
		...(size.markedSeats === true ? { seatsView: (room: LobbyRoom<PlainGame>) => room.seats } : {}),
		...(declared === undefined
			? {}
			: {
					settings: {
						spec: declared.spec,
						read: settingsOf,
						write(room: LobbyRoom<PlainGame>, next: Record<string, unknown>) {
							room.game = { ...room.game, settings: next };
						},
						locked: (room: LobbyRoom<PlainGame>, lock: string) => declared.locked?.(room, lock) ?? null,
					},
				}),
		...(size.relaySeats === undefined ? {} : { relaySeats: size.relaySeats }),
	};
}

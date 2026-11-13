/**
 * The lobby — which rooms exist, who is in them, and what they are playing.
 *
 * The operator's rule is "every friend sees every room, and should be able to
 * enter any room unless the room is password protected". Watchparty keeps
 * `cardtable-*` rooms out of ITS lobby on purpose, so the list is ours; their
 * chrome gives chat and roster INSIDE a room, and this file says which rooms
 * there are.
 *
 * ## Persistence: write-through, through `@wolffm/rooms-server/store`
 *
 * This repo redeploys on every push to `main`, so an in-memory room list would
 * evaporate several times a day — taking passwords and deck choices with it.
 * Every mutation writes that room's snapshot synchronously (`FileRoomStore`'s
 * atomic temp-file-and-rename) before the call returns, so there is no debounce
 * window for a deploy to fall into and no flush-on-SIGTERM to get right. The
 * write rate is a handful of clicks per game; a debounce would buy nothing.
 *
 * Rooms are stored in the rooms-server store's own snapshot format (`STORE_VERSION`), and
 * read back through its `decodeSnapshot`, so an unreadable or future-format
 * record is QUARANTINED (moved aside intact) rather than half-applied or
 * silently dropped. `RoomPersistence` is not used: it exists to restore live
 * socket rooms (`CoreRoomState`) and its debounce is the thing we do not want.
 *
 * The snapshot's `members` are the room's members, and each member's `app` blob
 * carries two things: the room's own readiness flag (`ready`, what a draft
 * starts on) and the constructed table's per-player state blob (the deck the
 * seat holds, written by `http/routes.ts`) — which is exactly what that
 * field is for. The room-level `app` blob carries name, leader, game type,
 * client mode, format, tables (who sits at each and their Readys), match id and `draftStartedAt`, plus the password's salt
 * and scrypt hash. A room written before `clientMode` existed has no such key
 * and reads back `builtin`; one written before `ready`/`draftStartedAt` existed
 * reads back `false` and `null`; one written before `format` existed reads back
 * on the newest Standard era. A new room opens on a random era (`randomFormat`).
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
 * on a second request, and the store drops non-durable members from every
 * snapshot anyway. So `create`/`join` refuse an ephemeral caller (the HTTP layer
 * answers 403). Behind the edge every friend-tier caller carries a friend key,
 * so in production this never bites; it exists so the answer is a clear refusal
 * rather than a member who silently vanishes on the next restart.
 */

import { randomBytes } from 'node:crypto';
import {
	FileRoomStore,
	STORE_VERSION,
	SnapshotUnreadableError,
	decodeSnapshot,
	type RoomSnapshot,
	type SerializedMember,
} from '@wolffm/rooms-server/store';
import { createSeatTable, isDurableParticipantId } from '@wolffm/rooms-protocol';
import { addMember, clearReady, createMembershipLedger, setReady as ledgerSetReady } from '@wolffm/rooms-server';
import {
	DEFAULT_CLIENT_MODE,
	DEFAULT_GAME_TYPE,
	DEFAULT_ROOM_SETTINGS,
	DRAFT_POOL_PREFIX,
	GAME_TYPES,
	gameTypeSpec,
	isPodAi,
	newestStandardEra,
	POD_SEATS,
	ROOM_ID_RE,
	type ClientMode,
	type DraftPlan,
	type GameType,
	planDisplayName,
	type ModeOptions,
	type PoolSource,
	type PoolVerdict,
	type RoomLocks,
	type RoomMode,
	type RoomSettings,
	type RoomView as PublicRoomView,
	type Tournament,
	type RoomTable,
	type SeriesPhase,
	sameLook,
	seatsOpenAt,
	type Look,
} from '@hadoku/shared';
// `@hadoku/draft` depends on `@hadoku/shared`, never the reverse, so `pod.ts`
// (which `@hadoku/shared` holds) cannot import these — this file is the one
// place both sides meet (wave 72 §P).
import { pairRound, roundsFor, roundsOf, structureOk, type MatchResult, type PodPlayer, type PodStructure } from '@hadoku/draft';
import { DEFAULT_PLAN, type PodDeal } from './draftRooms.ts';
import { gauntletHoldsTable, type GauntletState } from './gauntlet.ts';
import { leaveSeat, readySeat, seatList, seatOrder, sitAt, type TableSeat } from '@hadoku/game-server/room/seats';
import { magicViewPart, type MagicViewPart } from './magic-view.ts';
import { convertToBo3, newSeries, recordGame, seriesFormatOf, seriesWinner, type SeriesRecord } from './series.ts';

// A type only: the catalog itself is loaded once, at boot, by `index.ts`
// (`http/library.ts`'s `loadTablesLibrary`) and handed in as `formats`.
import type { TableFormat } from '../http/library.js';
import { replaceIds } from '@hadoku/game-server/erase/anonymise';
import { makeSecret, mintRoomId, mintTableId, type Secret } from '@hadoku/game-server/room/provisioning';
import { ROOM_STALE_MS, UNNAMED } from '@hadoku/game-server/room/constants';
import type { Caller } from '@hadoku/game-server/room/caller';
import { avatarIdOf } from '@hadoku/game-server/room/avatar';
import { addRoomMember, isMemberReady, isRoomMember, passwordAdmits, removeRoomMember, setMemberReady } from '@hadoku/game-server/room/membership';
import { isOfferedRoom, isSweepableRoom, sortRoomsByCreation, type RoomBusyHook } from '@hadoku/game-server/room/room-list';
import { watchpartyRoomId } from '@hadoku/game-server/room/watchparty-link';
// Pods, tournaments, AI seats and their view (`PodView`) — split out, wave 99 §L.
import {
	aiEntrantSeat,
	copySplit,
	dealGate,
	draftEntrants,
	drawAvatar,
	entrantPersona,
	freeAiAvatar,
	grownSeats,
	heldSplit,
	initialPodSize,
	isAiEntrant,
	isTournamentRoom,
	memberDraftId,
	NO_GAME_HOOKS,
	personaOf,
	gameSeatsOf,
	playersOf,
	podDraftId,
	podEntrants,
	podOfDraftId,
	podPhaseOf,
	podPlayers,
	podSeatCeiling,
	podSize,
	podStandings,
	podTable,
	POD_AI,
	POD_CLOSED,
	POD_MIN_OPEN,
	roomAi,
	seatedHumans,
	seatHistoricalField,
	seatInReach,
	seatsFixed,
	seriesRoomOf,
	settledBotGame,
	splitIntoPods,
	tournamentId,
	trimmedSeats,
	usesPod,
	type BotDeckSource,
	type BotGameAsk,
	type GameHooks,
	type PodRecord,
	type SeriesEnd,
	type TournamentPairing,
} from './pods.ts';
// The saved-room codec — split out, wave 99 §L.
import {
	APP_VERSION,
	appCodec,
	roomCodec,
	SETTING_KEYS,
	type MemberRecord,
	type RoomRecord,
	type StoredApp,
	type StoredTable,
	type TableRecord,
} from './lobby-codec.ts';

/* ── the room's format ───────────────────────────────────────────────────── */

/**
 * The pool a room's table plays in. Two kinds, one string:
 *
 *   `2016-07-22`              a frozen Standard era — a `TableFormat.id` from
 *                             `http/library.ts`, which is the pool's date
 *   `draft:amber-lantern-k7q4` a DRAFTED pool — the pod every player at this
 *                             table drafted from (`draftPoolId`). Only a
 *                             `draft` room's tables play one, derived from the
 *                             room's id (`http/routes.ts`'s `effectivePoolOf`);
 *                             no room's stored format is ever one (2026-10-20)
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

/** A catalogued era, as far as picking a room's format needs one. */
export type CatalogFormat = Pick<TableFormat, 'id' | 'family'>;

/**
 * The newest Standard era (`newestStandardEra`). What a room written before `format` existed reads back as, and the fixed
 * default a server started with `CARDTABLE_NEW_ROOM_FORMAT=newest` opens every new
 * room on. `NO_FORMAT` when the catalog has no Standard era at all (an empty
 * library, or a catalog that is Modern/Legacy only).
 *
 * `formats` is the server's own library (`http/library.ts`'s
 * `TablesLibrary.formats`), or a fixture catalog in a test.
 */
export function newestFormat(formats: readonly CatalogFormat[]): FormatId {
	return newestStandardEra(formats) ?? NO_FORMAT;
}

/**
 * What a NEW room opens on (operator, 2026-10-16: *"when the room opens, pick a
 * random format from (standard/modern/legacy) and pick a random year to open
 * to on default"*): a family drawn uniformly from the families the catalog
 * holds any era of, then an era drawn uniformly from that family's. Two draws
 * rather than one over every era, so Standard's many years do not crowd out
 * Modern and Legacy.
 *
 * `random` answers in [0, 1), as `Math.random` does; tests inject one.
 * `NO_FORMAT` for an empty catalog.
 */
export function randomFormat(random: () => number, formats: readonly CatalogFormat[]): FormatId {
	const byFamily = new Map<string, FormatId[]>();
	for (const f of formats) {
		const eras = byFamily.get(f.family);
		if (eras === undefined) byFamily.set(f.family, [f.id]);
		else eras.push(f.id);
	}
	const families = [...byFamily.values()];
	if (families.length === 0) return NO_FORMAT;
	const eras = families[Math.floor(random() * families.length)]!;
	return eras[Math.floor(random() * eras.length)]!;
}

/**
 * A new member, wearing no character yet. Their character is their account's
 * (`people.ts`'s `applyPerson`, as they arrive): prefs-api answers one for
 * every account, drawing and keeping one for an account that never picked, so
 * a room hands nobody a character of its own.
 */
function newMember(caller: Caller, joinedAt: number): MemberRecord {
	return { id: caller.id, userId: caller.userId, name: caller.name, joinedAt, state: undefined };
}

/**
 * The PUBLIC shape. Every response body that carries a room uses exactly this:
 * `@hadoku/shared`'s `RoomView`, which the browser parses with, plus the part
 * the room's game type adds (`useGameView`). Magic's part (`magic-view.ts`) is
 * every optional key below; a room of a type with no part of its own has none
 * of them, so a reader here reaches Magic's fields only after asking
 * whether the room has them.
 */
export interface RoomView extends Omit<PublicRoomView, 'game'>, Partial<MagicViewPart> {
	/** This server hosts only Magic's game types: its codec quarantines a saved room of any other. */
	gameType: GameType;
}

/** A game type's own part of a room's view: every key it answers is spread over the room's platform view. */
export type GameViewPart = (room: RoomRecord, checks: GameHooks) => Partial<MagicViewPart>;

interface CreateRoomInput {
	name: string;
	gameType: GameType;
	/** The one place this is ever set. Required here; the HTTP layer defaults a missing field. */
	clientMode: ClientMode;
	/** Absent or empty: an open room. */
	password?: string;
	/** A constructed room's mode, chosen at create. Absent: the leader chooses it in the room. */
	mode?: RoomMode;
	/**
	 * A seeded, admin-only room (`room/testing-rooms.ts`), never set by
	 * `CreateRoomBodySchema` — there is no HTTP field for it, on purpose, same
	 * as `clientMode`'s own "the one place this is ever set" rule. Absent or
	 * `false` is every room a friend ever creates.
	 */
	testing?: boolean;
	/**
	 * A board-state testing room's own Forge puzzle `[state]` text
	 * (`room/testing-rooms.ts`), set the same way `testing` is: no field for it
	 * in `CreateRoomBodySchema`, so no CREATE body a client sends — admin or
	 * not — can ever set one. It DOES ride on `RoomView` (`viewOf`, below) once
	 * set, same as `testing` itself — harmless, since a non-admin cannot reach
	 * a testing room at all. `http/routes.ts`'s `startFromRoom` is what reads
	 * it back onto a match.
	 */
	scenario?: string;
	/**
	 * When the room's event starts, in ms (`room/events.ts`): a room made ahead of its event. Set
	 * by the events route, never by `CreateRoomBodySchema`. Until then it is neither stale nor idle.
	 */
	scheduledFor?: number;
	/**
	 * A historical-tournament replay room (`scripts/` driver or `room/testing-rooms.ts`-style
	 * seeding, never a client body — no field in `CreateRoomBodySchema`, the same rule as
	 * `testing`). Born locked: every room control (`roomLocks` answers `'historical'` for all
	 * five) and every setting is the event's own, not a leader's choice. The room's name is
	 * expected to name the event.
	 */
	historical?: boolean;
	/**
	 * A historical room's entrant deck assignments: entrant id (a member id or `ai:<seat>`)
	 * → library deck id. Read by `GameHooks.currentTournamentDeck` at the tournament lock,
	 * so an assigned entrant replays the deck the real player played instead of a drawn one.
	 * Set the same way `historical` is — never by a client body.
	 */
	aiDeckAssignments?: Record<string, string>;
	/**
	 * A historical room's own format (the event's era): because a historical room is
	 * born locked, `setFormat` would refuse the change the room needs to BE itself,
	 * so the event's format is an input instead. Ignored unless `historical` is true.
	 */
	historicalFormat?: string;
	/**
	 * A historical room's own settings, in full (the event's shape — tournament on,
	 * decks locked). Ignored unless `historical` is true; defaults to the same
	 * tournament shape the driver always sets, so the two can never half-disagree.
	 */
	historicalSettings?: RoomSettings;
	/** A historical room's tournament structure: `{ swiss, cut }` (`PodStructure`). Validated by `structureOk` at the lock. */
	historicalStructure?: PodStructure;
	/**
	 * A historical room's field size: the room is born with this many pod seats, an AI in
	 * every seat `aiDeckAssignments` names (`ai:<seat>`) and the rest open for people. The
	 * field is the event's, so no seat is ever filled, emptied or closed afterwards.
	 */
	historicalField?: number;
	/** A historical room's open seats → the list that seat's real player played: whoever sits there plays it (`#lockTournament`). */
	seatDecks?: Record<string, string>;
}

type CreateResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'not-durable' };

/**
 * `no-match` covers BOTH "no such room" and "wrong password", on purpose: the
 * HTTP layer must not be able to tell them apart, so this layer does not either.
 */
type JoinResult =
	| { ok: true; room: RoomView; alreadyMember: boolean }
	| { ok: false; reason: 'no-match' | 'not-durable' };

type SetGameTypeResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'no-room' | 'not-leader' | 'draft-started' | 'mode-locked' | 'historical' };

/** `setFormat`'s refusals, plus a draft room (which has no mode). */
type SetModeResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'no-room' | 'not-leader' | 'not-constructed' | 'draft-started' | 'mode-locked' | 'historical' };

/** Deliberately the same refusals as `SetGameTypeResult`: one leader, one shape. */
type SetFormatResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'no-room' | 'not-leader' | 'draft-started' | 'mode-locked' | 'historical' };


/** `SetFormatResult`'s three refusals (one leader, one shape). */
type SetSettingsResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'no-room' | 'not-leader' | 'draft-started' | 'mode-locked' | 'historical' };

type AddTableResult = | { ok: true; room: RoomView; table: RoomTable } | { ok: false; reason: 'no-room' | 'not-leader' };

type RemoveTableResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'no-room' | 'not-leader' | 'no-such-table' | 'first-table' | 'not-idle' };

/** A table's series resolved from its card: the game it let go of, if one was in play, for the caller to stop. */
type ResolveTableResult =
	| { ok: true; matchId: string | null }
	| { ok: false; reason: 'no-room' | 'no-such-table' | 'not-seated' | 'pod-table' | 'not-pod-table' | 'nothing-to-abandon' | 'nothing-to-drop' };

/** `Lobby.dqPlayer`: the games it let go of, for the caller to stop. */
type DqPlayerResult = { ok: true; tableId: string | null; matchIds: string[] } | { ok: false; reason: 'no-room' | 'not-leader' | 'no-pod' | 'not-entrant' | 'already-dropped' };

type ResetGameResult = { ok: true; matchId: string } | { ok: false; reason: 'no-room' | 'not-leader' | 'no-such-table' | 'no-game' };

/** `Lobby.resetRoom`: the tables it started over, and the games they were playing, for the caller to stop. */
type ResetRoomResult = { ok: true; tableIds: string[]; matchIds: string[] } | { ok: false; reason: 'no-room' | 'not-leader' | 'pod-under-way' };

type RecordGameResultResult =
	| { ok: true; room: RoomView; phase: SeriesPhase }
	| { ok: false; reason: 'no-room' | 'no-such-table' };

type StartDraftResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'no-room' | 'not-member' | 'not-draft' | 'not-ready' | 'plan-not-ready' | 'not-split' | 'not-leader' | 'not-open' };

type SplitPodResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'no-room' | 'not-member' | 'not-leader' | 'not-draft' | 'one-pod' | 'not-ready' | 'plan-not-ready' };


/**
 * `not-member` covers a room that does not exist too (same bucket `join` and
 * `setReady` already use): there is no sentence a caller who is not in a room
 * needs that is different from "no such room".
 */
type LeaveResult =
	/** `forfeited`: a pod entrant's match this leave forfeited (`#dropEntrant`), its games for the caller to end. */
	| { ok: true; room: RoomView; forfeited?: { tableId: string; matchIds: string[] } }
	| { ok: false; reason: 'no-room' | 'not-member' };

/* ── the pod (wave 72 §P) ─────────────────────────────────────────────────── */

type SitPodResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'no-room' | 'not-member' | 'not-draft' | 'not-lobby' | 'not-open' | 'bad-seat' | 'seat-taken' | 'pod-full' | 'historical' };

type ClosePodResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'no-room' | 'not-member' | 'not-leader' | 'not-draft' | 'not-lobby' | 'bad-seat' | 'seat-taken' | 'too-few' | 'historical' };

type StandPodResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'no-room' | 'not-member' | 'not-draft' | 'not-lobby' };

export type SetPodPlanResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'no-room' | 'not-member' | 'not-draft' | 'not-lobby' | 'not-leader' }
	| { ok: false; reason: 'refused'; verdict: PoolVerdict };

type CloseRoomResult =
	| { ok: true; matches: string[] }
	| { ok: false; reason: 'no-room' | 'not-leader' };

type PlayPodResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'no-room' | 'not-drafter' | 'not-built' };


/**
 * How long a tournament room (`usesPod`) may sit untouched before the lobby
 * forgets it; every other room has `CASUAL_ROOM_IDLE_MS`.
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
/** How long a started pod's room is spared the idle sweep: a day is a long tournament night. */
export const POD_SPARED_MS = 24 * 60 * 60_000;
/**
 * How long a room that is not a tournament (`usesPod`) may sit idle before the sweep forgets it.
 * The operator, 2026-10-29: *"non-tournament rooms should close after being idle for 8hrs. do not
 * close rooms that have a game in progress."* A tournament room keeps `ROOM_IDLE_MS`.
 */
export const CASUAL_ROOM_IDLE_MS = 8 * 60 * 60_000;
/**
 * How long a game may run, in any room, before the sweep calls it a draw (`boot.ts`'s `sweepRooms`).
 * The operator, 2026-10-29: *"games that are in-progress for >8hrs should be forced into a draw and
 * players sent back to the lobby"* — "every game", tournament or not.
 */
export const GAME_DRAWN_AFTER_MS = 8 * 60 * 60_000;


interface AvatarChange {
	roomId: string;
	memberId: string;
	/** The new, normalised value; null when it was cleared. */
	avatarId: string | null;
}

type AvatarChangeListener = (change: AvatarChange) => void;

/** A room was written, created or forgotten. The id only: what changed is the room's to say when it is read. */
type RoomChangeListener = (roomId: string) => void;

/** How many of a room's matches it remembers, newest last, for `roomOfMatch`. */
export const ROOM_MATCHES_KEPT = 8;

export interface Lobby {
	list(): RoomView[];
	/**
	 * The rooms the front page offers: `list()` minus the rooms nobody has touched
	 * for `staleMs` (`ROOM_STALE_MS`). A room with a match or a draft in
	 * progress is always offered. Same order as `list()`.
	 */
	offered(staleMs?: number): RoomView[];
	/** Record that `memberId` has `roomId` open now. A non-member or unknown room is ignored. */
	touch(roomId: string, memberId: string): void;
	/**
	 * The room that started `matchId`, or undefined. A match id is never a room id.
	 *
	 * Not only the room's CURRENT match: a finished match is let go of
	 * (`releaseMatch`) as soon as anybody reads the room, while its result screen
	 * still needs its room for a Rematch. So the room remembers its last
	 * `ROOM_MATCHES_KEPT` matches, on disk.
	 */
	roomOfMatch(matchId: string): RoomView | undefined;
	/**
	 * Whether `memberId` played `matchId` in a series that is not settled yet: one that may still go
	 * on, so that game's hands are still hidden from them. Its replay is the watcher channel's
	 * stream, every hand face up, and a player is never shown the watcher view of their own match.
	 */
	stillPlaying(matchId: string, memberId: string): boolean;
	get(roomId: string): RoomView | undefined;
	/** Whether `memberId` is a member of `roomId`. False when there is no such room. */
	isMember(roomId: string, memberId: string): boolean;
	/** Per-member opaque state owned by `http/routes.ts` (the deck a seat holds). Not part of RoomView. undefined when unset / no room / not a member. */
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
	 * Be told when a member's avatar actually CHANGES (never on an idempotent
	 * re-assert). This is how a match already running learns of it: the seat was
	 * told the avatar once, at the start, and the room is the only thing that
	 * hears the change. Returns the unsubscribe.
	 */
	onAvatarChange(listener: AvatarChangeListener): () => void;
	/**
	 * Each member's registry userId, for looking up how they look (`people.ts`).
	 * A member the edge named nobody has none and is left out. Never part of a
	 * view: a userId is not something one member is shown about another.
	 */
	usersOf(roomId: string): { memberId: string; userId: string }[];
	/**
	 * A member's avatar picture and cosmetics, as prefs-api answered for them.
	 * In memory only: it is the person's, looked up again after a restart, never
	 * a copy the room keeps. A real change is announced as an avatar change, so
	 * a running match re-sends its seats, and to `onChange` with nothing written.
	 * `false` only when there is no such room or member.
	 */
	setLook(roomId: string, memberId: string, look: Look | undefined): boolean;
	/**
	 * Be told every time a room is written, created or forgotten. Every mutation
	 * goes through one persist, so this is every change a read could see and
	 * nothing else: a read (`touch`, `get`, `list`) never fires it. The room feed
	 * pushes from here (`room/watching.ts`). Returns the unsubscribe.
	 */
	onChange(listener: RoomChangeListener): () => void;
	/**
	 * A pool source's display name changed outside any room (a set's name,
	 * known only once Forge answers after boot): every draft room's view —
	 * `PodView.roundNames` — reads differently now, so every one is named to
	 * `onChange` with nothing written.
	 */
	poolNamesChanged(): void;
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
	/**
	 * Split & randomize: the leader of a draft room of more than 8 seated drafters, every one ready and no
	 * seat open, splits them into random pods (`splitIntoPods`, a fresh seed, logged). From there every
	 * position is locked (`seatsFixed`: no sit, stand, AI or close, and Ready stays on) until the leader's
	 * own `startDraft` deals from the pods. Only a split drafter leaving the room voids it (`leave`). A second press while one
	 * stands changes nothing.
	 */
	splitPod(roomId: string, callerId: string): SplitPodResult;
	/** Who sits at `tableId`, in seat order, with each seat's Ready. Empty when there is no such room or table. */
	seats(roomId: string, tableId: string): TableSeat[];
	/**
	 * `memberId` takes `seat` at `tableId` — the first open one when `seat` is
	 * absent — giving up a seat held anywhere else in the room, this table's
	 * other seat included. True when they hold it afterwards (a seat already
	 * held is a no-op); false when there is no such room, table or member, or
	 * the seat is someone else's (both are, with no `seat`).
	 */
	sit(roomId: string, tableId: string, memberId: string, seat?: number): boolean;
	/** `memberId` gives their seat at `tableId` back, Ready and all. False when there is no such room or table. */
	stand(roomId: string, tableId: string, memberId: string): boolean;
	/**
	 * Give back every seat `memberId` holds whose table has no live match and
	 * no Gauntlet holding it (ruling 13: "nobody sits or stands" while one
	 * does) — called once their last connection has been gone for the
	 * seat-release window (`room/socket.ts`'s own timer owns "still
	 * disconnected"; this is only the action). Ruled 2026-10-26: 30 s,
	 * a reload inside it keeps the seat — that is `room/socket.ts` never
	 * calling this at all, not anything checked here. Returns each
	 * room/table it released, to log.
	 */
	releaseAbandonedSeats(memberId: string, mark?: number): { roomId: string; tableId: string }[];
	/**
	 * Where the count of seats taken stands now: what a disconnect notes, so the release it schedules
	 * passes it as `mark` and leaves alone every seat taken since — a seat taken in the window is held
	 * by someone acting now, over HTTP before their page's socket is up (the e2e run that sat in a
	 * room it had just made, 4 ms before an earlier window's release fired, 2026-11-05).
	 */
	seatMark(): number;
	/** A seated player's Ready. False when `memberId` holds no seat at `tableId`. */
	setSeatReady(roomId: string, tableId: string, memberId: string, ready: boolean): boolean;
	/**
	 * Start a table's next game: sets `matchId`, and advances the series.
	 *
	 * From `seating` or `done`, this is a NEW series, sized by the room's
	 * `seriesFormatOf` at this instant, with the table's seats as who played it.
	 * From `sideboarding` or `between`, this is the next game of the SAME
	 * series. From `playing` (a replacement match after the previous one simply
	 * vanished — `http/routes.ts`'s `liveMatchId`), nothing about the series
	 * changes either. Every case ends in `phase: 'playing'`. The start spends
	 * every seat's Ready, so nothing is left ready to start again when the match
	 * ends or a restart lets go of it. `false` when there is no such room or
	 * table, or the table already has a live match.
	 */
	setTableMatch(roomId: string, tableId: string, matchId: string): boolean;
	/**
	 * Let go of a match that is simply GONE — the registry has no record of it
	 * at all, so there is no outcome to record (`http/routes.ts`'s
	 * `liveMatchId`). Clears the table's `matchId` and un-readies only ITS OWN
	 * seated members (R16, scoped to the table — the room-wide version used to
	 * un-ready everybody). The series' phase is untouched: this is "the match
	 * vanished", not "the game ended". Idempotent; `false` only when there is
	 * no such room or table.
	 */
	releaseTableMatch(roomId: string, tableId: string): boolean;
	/**
	 * A table's match ACTUALLY ended — Forge reported `over` — so the series
	 * ledger advances (`series.ts`'s `recordGame`): `done` once a seat has the
	 * majority or every game is played, otherwise `sideboarding` (or `between`,
	 * for a series that does not sideboard) at once, no Rematch press needed.
	 * The table's `matchId` clears and only its own seated members are
	 * un-readied (R16, scoped). `false` only when there is no such room or table.
	 *
	 * A game lost on the chess clock is an ordinary lost game: the clock is a game's, not a series'
	 * (the operator, 2026-11-07), so the series goes on.
	 */
	recordGameResult(roomId: string, tableId: string, result: { matchId: string; winner: 0 | 1 | null }): RecordGameResultResult;
	/**
	 * Abandon (the table card, `docs/planning/table-card-plan.md`): a seated player of a constructed
	 * table ends its series with NO result — nothing reaches `onSeriesEnd`, so no stats — and the table
	 * starts a fresh series, its players still seated (AF344). A game in play is let go of (`matchId`
	 * cleared, returned for the caller to stop), so its end finds no table to record into. A pod's table
	 * is refused: a bracket needs a result (`dropTableMatch`).
	 */
	abandonTable(roomId: string, callerId: string, tableId: string): ResolveTableResult;
	/**
	 * Drop match: a player of a pod's (draft or tournament) current pairing forfeits it. The other side
	 * wins the series — its wins raised to the majority, the dropper's won games standing below it — and
	 * the result is recorded as any finished series is (`onSeriesEnd`, the pod's results), so the round
	 * advances once its last table is done. A game in play is let go of, as by `abandonTable`.
	 */
	dropTableMatch(roomId: string, callerId: string, tableId: string): ResolveTableResult;
	/**
	 * The leader disqualifies an entrant of a pod whose rounds are under way, seated or watching (the
	 * operator, 2026-10-30: *"the room leader is the admin"*). Their current match is forfeited as by
	 * `dropTableMatch`, every later pairing of theirs is a bye for its opponent (`#pairRound`), and the
	 * standings keep their record, marked (`PodView.dropped`).
	 */
	dqPlayer(roomId: string, leaderId: string, entrantId: string): DqPlayerResult;
	/**
	 * The leader restarts a table's game in play from scratch. Forge cannot rewind, so the game is let go
	 * of (returned for the caller to stop) without a result; the series stands at its score, still
	 * `playing`, and the table's next start is the same game again with the decks its seats hold.
	 */
	resetGame(roomId: string, leaderId: string, tableId: string): ResetGameResult;
	/**
	 * The leader cleans up the room without closing it (the operator, 2026-11-11: *"we shouldn't close
	 * it automatically but leader needs a way to clean up a room"*): every table starts over as a mode
	 * change starts it (`#interruptSeries` — what was played is recorded, the decks held are dropped,
	 * nobody is ready), the Gauntlets and locked decks go, and the games in play are let go of without
	 * a result, returned for the caller to stop. Who is here, who sits where, the settings and the
	 * link stay. A draft or tournament under way is refused: its rounds end with Close.
	 */
	resetRoom(roomId: string, leaderId: string): ResetRoomResult;
	/**
	 * Rematch: `http/routes.ts`'s `POST …/ready` calls this UNCONDITIONALLY
	 * every time a `ready: true` leaves every seat of a table ready, and the
	 * decision lives here. A finished Bo1 whose players are still at the table
	 * with the decks they played (`#rematchable`) converts in place
	 * (`series.ts`'s `convertToBo3`): Bo3, the game kept as game 1, `phase:
	 * 'sideboarding'`. Anything else — not `done`, a finished Bo3, a series
	 * already recorded — is a no-op, `false`, and the next start is a new series.
	 */
	beginSideboarding(roomId: string, tableId: string): boolean;
	/**
	 * Leader only. Appends an empty table — `seating`, no seats, no match —
	 * sized to the room's current `seriesFormatOf`. Answers the new
	 * `RoomTable` (`POST /api/tables/rooms/:roomId/tables`'s own body).
	 */
	addTable(roomId: string, callerId: string): AddTableResult;
	/**
	 * Leader only. Removes a table other than the first — the first is the
	 * room's permanent constructed-1v1 case and is never removable — and only
	 * one that is EMPTY (no seats held) and IDLE (no live match, and its series
	 * is `seating` or `done`, never mid-series).
	 */
	removeTable(roomId: string, callerId: string, tableId: string): RemoveTableResult;
	/**
	 * A member steps out. Removed from `members`; their deck hold and ready
	 * flag go with their row, exactly as `setFormat`'s reset drops one member's
	 * worth of state. If the member who leaves is the LEADER, leadership passes
	 * to whichever remaining member joined EARLIEST (operator ruling, R16) —
	 * not simply the next one in the array, which happens to be join order
	 * today but is restated by `joinedAt` so a future reordering cannot change
	 * who leads by accident.
	 *
	 * A series the member played and left undecided ends here, before they go
	 * (`#settleSeries`): one finished game a Bo1, 1-1 a drawn Bo3, the game in
	 * play discarded.
	 *
	 * A room left by its last member is not deleted here — the idle sweep still
	 * owns deletion — but is dropped from `offered()` the instant it empties,
	 * rather than waiting out `ROOM_STALE_MS` with nobody in it to see the
	 * delay.
	 *
	 * `no-room` and `not-member` are two reasons here (like `startDraft`'s);
	 * `http/rooms.ts` answers the SAME 404 for both, the same bucket `setReady`
	 * already falls into with its bare `false`.
	 */
	leave(roomId: string, memberId: string): LeaveResult;
	/**
	 * The owner ends the room for everyone: it is forgotten, as the sweep forgets
	 * one, and a pod that played a round is kept in the tournaments first. Answers
	 * the matches its tables were playing, for the caller to stop.
	 */
	close(roomId: string, callerId: string): CloseRoomResult;
	/**
	 * Account erase: every room that still names one of `ids` (a member who has left, in
	 * results, series, pod pairings, locked decks) names `to` instead, and is saved. Answers
	 * how many rooms changed. The person leaves first (`leave`), so leadership has passed on.
	 */
	anonymise(ids: ReadonlySet<string>, to: string): number;
	/** Resolves once every room forgotten so far is gone from disk too (a failed delete is logged as `room-forget-failed`). */
	removed(): Promise<void>;
	/** Move the start of the event a room was made for (`CreateRoomInput.scheduledFor`), and its seats' opening with it. False when there is no such room. */
	reschedule(roomId: string, at: number): boolean;
	/**
	 * When a room made for an event opens its seats (`seatsOpenAt`), while they are still shut by the
	 * lobby's clock: until then nobody sits, is seated on joining or on Ready, and nothing deals.
	 * Null once they are open, for a room no event made, and for no such room.
	 */
	seatsShutUntil(roomId: string): number | null;
	/**
	 * The seat this member holds in the room's game (`RoomView.seats`), or null: watching, not a
	 * member, or no such room. What a relay match seats a socket by (`plugins/relay.ts`), so the
	 * relay and every screen's `RoomView.seats` name the same seat holders.
	 */
	gameSeatOf(roomId: string, memberId: string): number | null;
	create(caller: Caller, input: CreateRoomInput): CreateResult;
	/**
	 * The room a watchparty room's game slot binds to (D21): `wp-` plus a digest
	 * of the watchparty room, so everyone in that room arrives at the same table
	 * without anyone passing an id around. Made on first use with the caller as
	 * its creator and leader, joined after that; open, builtin, constructed — the
	 * leader moves it from there exactly as in a room made from the list.
	 */
	bindWatchparty(caller: Caller, watchpartyRoom: string): JoinResult;
	/** Idempotent for an existing member, who needs no password again. */
	join(roomId: string, caller: Caller, password?: string): JoinResult;
	/**
	 * Call `caller.id` by `caller.name` in every room they are a member of. The
	 * name was copied once, at join, so a key renamed in the registry kept its
	 * first name in every room it had joined — a room list showing
	 * "spare-961b02" beside a leaderboard showing "kib" (2026-10-26). Writes
	 * only the rooms whose copy moved.
	 */
	rename(caller: Pick<Caller, 'id' | 'name'>): void;
	/**
	 * Leader only. Changes the game type — a room's `clientMode` is immutable.
	 * Every member's `ready` is cleared: readiness is readiness for a particular
	 * game, so changing the game invalidates it. A real change also puts the
	 * mode back to unchosen: a mode belongs to a constructed room. Refused with
	 * `draft-started` while a draft is running, and with `mode-locked` while the
	 * mode could not change either.
	 */
	setGameType(roomId: string, callerId: string, gameType: GameType): SetGameTypeResult;
	/**
	 * Leader only. Changes the pool both seats' decks are checked against.
	 *
	 * A change DROPS every member's readiness, every seat and every member's
	 * table state — the deck choice, the verdict and the `.dck` text
	 * `http/routes.ts` holds in the per-member blob. A verdict is a verdict in one pool: what somebody
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
	 * Leader only, constructed rooms only. Sets the room's mode and its options.
	 * A change drops every member's readiness and table state exactly as
	 * `setFormat` does; the same mode with the same options changes nothing.
	 * Refused with `mode-locked` while `modeLocked` says so.
	 */
	setMode(roomId: string, callerId: string, mode: RoomMode): SetModeResult;
	/**
	 * The leader changes some of the room's match settings; the rest stay as they
	 * are. Unlike the pool, a setting says nothing about anybody's deck, so it
	 * clears no readiness and no deck hold. Refused with `draft-started` like the
	 * pool.
	 */
	setSettings(roomId: string, callerId: string, settings: Partial<RoomSettings>): SetSettingsResult;
	/**
	 * Forget every room untouched for longer than `idleMs`, on disk as well as
	 * in memory. Returns the ids dropped, for the caller's log. Without `idleMs`,
	 * a tournament room (`usesPod`) idles `ROOM_IDLE_MS` and any other room
	 * `CASUAL_ROOM_IDLE_MS`.
	 *
	 * A room with a match on any of its tables is never dropped, whatever its
	 * idle age: a game in progress keeps its room. A room whose draft STARTED
	 * less than `POD_SPARED_MS` ago is not dropped either: a pod runs for hours
	 * without anybody touching the lobby, and reaping it would take the
	 * tournament with it. Older than that, it ages out like any room.
	 */
	sweep(idleMs?: number): string[];

	/* ── the pod (wave 72 §P) ───────────────────────────────────────────── */

	/**
	 * Wires `GameHooks` for `type` — see its own doc. Replays every bot game a
	 * restored room of `type` still owes (`#playPairedBots`), the moment it is
	 * wired. Called once per game type, from `http/routes.ts`'s
	 * `attachTables` — Magic's own two ids, `'constructed-1v1'` and
	 * `'draft'`, wired with the SAME hooks object.
	 */
	useGameType(type: string, hooks: GameHooks): void;
	/**
	 * Wires `type`'s own part of its rooms' views (`GameViewPart`), replacing any it had. Magic's
	 * own two types come wired with Magic's (`magic-view.ts`); a type nothing wires adds nothing,
	 * so its view is the platform's fields alone.
	 */
	useGameView(type: string, part: GameViewPart): void;
	/**
	 * Told once, at boot, the way a room creates a `RelayMatch` for a `runtime: 'relay'`
	 * game type — `hook(roomId, seatCount, gameType)`, called the moment such a room is created
	 * (`#insert`), and at once for every such room already open when the hook is wired (rooms
	 * restored from disk at boot, which no match outlived). `plugins/relay.ts` wires `hook` to
	 * `runtimes/relay-match.ts`'s shared registry; this file never imports that module itself,
	 * which would close an import cycle back to `match.ts`'s `HostedMatch` (`match.ts` → `match/forge-session.ts` → `names.ts` →
	 * `room/lobby.ts` → `runtimes/relay-match.ts` → `match.ts`). Unset (a unit suite, or before
	 * the plugin wires it): such a room is simply created with no relay match behind it — the same
	 * as any game type nothing has wired a runtime for.
	 */
	onRelayRoomOpened(hook: (roomId: string, seatCount: number, gameType: string) => void): void;
	/**
	 * How the pod's draft is dealt (`draftRooms.ts`'s pod lookup, wired the same
	 * way as `useGameType`), read off `podTable`: the seats not closed, each
	 * member who sat at the seat they chose, and the AI seats' names in seat
	 * order. No humans for a room nobody sat in — the draft then deals every
	 * seat to a bot, and the first members to connect evict one each.
	 */
	podDraft(roomId: string): PodDeal | null;
	/**
	 * The leader's pool choice (`PUT /api/rooms/:id/pod/plan`): leader only,
	 * `lobby` phase only, and only with an ALREADY-COMPUTED `verdict` — this
	 * method is synchronous and does no Forge/catalog I/O itself (that is the
	 * route's job, via `room/plan.ts`, before calling here). A refused verdict
	 * (`verdict.ok === false`) is reported back but never written: the room
	 * keeps its previous plan, per the wire contract's "Refused: 409 { verdict
	 * }, and the plan is unchanged."
	 */
	setPodPlan(roomId: string, memberId: string, plan: DraftPlan, verdict: PoolVerdict): SetPodPlanResult;

	/* ── the Gauntlet ───────────────────────────────────────────────────── */

	/**
	 * This table's stored Gauntlet, or null when it has none (or there is no
	 * such room/table) — one per TABLE, so a tournament round's several
	 * Gauntlet tables never share state. `tableId` defaults to `tables[0]`'s
	 * — a plain Gauntlet room's only one, and `http/routes.ts`'s own
	 * adapter, which has not yet been given a real one to pass (its own
	 * patch is this lane's report), reads exactly that table today.
	 */
	gauntlet(roomId: string, tableId?: string): GauntletState | null;
	/**
	 * Store a table's Gauntlet — `http/gauntlet.ts` is its only writer, and
	 * `gauntlet.ts` decides every move. `null` forgets it. False when there is
	 * no such room. `tableId` is LAST and optional, defaulting to `tables[0]`'s
	 * — `gauntlet`'s own doc on why, and the one place that distinction matters:
	 * an existing 2-argument call (`roomId`, `gauntlet`) must keep meaning what
	 * it always has.
	 */
	setGauntlet(roomId: string, gauntlet: GauntletState | null, tableId?: string): boolean;
	/**
	 * The pod pairing at `tableId`, a tournament's or a draft pod's — the two
	 * entrant ids (a member id, or a pod AI entrant's `` `ai:<seat>` ``), the
	 * AI's slot (if any) always last so `http/gauntlet.ts`'s own seat
	 * convention (the human is Gauntlet seat 0, a vs-AI table's synthetic AI
	 * player seat 1) lines up, and the AI's character. `null` for a table with
	 * no current pairing.
	 */
	tournamentPairingOf(roomId: string, tableId: string): TournamentPairing | null;
	/** At boot: rooms mid-draft whose draft the registry did not restore go back to their lobby. */
	releaseLostDrafts(draftExists: (roomId: string) => boolean): string[];
	/**
	 * Take a pod seat, in the `lobby` phase only (`draftStartedAt === null`).
	 * `seat` absent takes the first free one; given, it must be free and
	 * `0..7`. Moves the caller from any seat they already hold. The ready gate
	 * `startDraft` applies is over SEATED members only, once anybody has sat —
	 * see its own doc.
	 */
	sitPod(roomId: string, memberId: string, seat?: number): SitPodResult;
	/** Give up a pod seat, in the `lobby` phase only. Idempotent: not seated is not a failure. */
	standPod(roomId: string, memberId: string): StandPodResult;
	/** Put the AI in an open pod seat (`on`), or take it out — lobby phase only, any member. */
	aiPod(roomId: string, memberId: string, seat: number, on: boolean): SitPodResult;
	/** Close an empty pod seat, or open a closed one — lobby phase only, the owner's; never fewer than `POD_MIN_OPEN` open. */
	closePod(roomId: string, memberId: string, seat: number, closed: boolean): ClosePodResult;
	/**
	 * A drafter is done building — the deck editor's Play. Refused unless their
	 * saved deck is legal (`GameHooks.built`). Once EVERY human drafter has
	 * pressed it, round 1 is dealt with nobody else's say: one bo3-with-sideboarding
	 * table per pairing (`pairRound`, `@hadoku/draft`), both players seated with
	 * their saved deck (`GameHooks.seatState`), the bye recorded as a
	 * `MatchResult`. Its bots are entrants as its humans are (`draftEntrants`):
	 * a human paired with one plays it at a table, two paired together play a
	 * bot game. Every later round starts by itself, as the last of a round ends.
	 * Answered `ok` once the rounds have started, so a late press is harmless.
	 */
	playPod(roomId: string, memberId: string): PlayPodResult;
}

/** Structured, and never carries a password, hash or salt. */
type LobbyLog = (entry: Record<string, unknown>) => void;

interface OpenLobbyOptions {
	/** Where room snapshots live. Created if missing. Never tmpfs in production. */
	dir: string;
	log?: LobbyLog;
	/** Injected for tests. */
	now?: () => number;
	/**
	 * One era every new room starts on, in place of a random one, and what a
	 * record written before the field reads back as. Absent, a new room draws its
	 * own (`randomFormat`) and such a record reads back on `newestFormat(formats)`.
	 * For tests and the e2e harnesses, whose specs read a fresh room's pool.
	 */
	defaultFormat?: FormatId;
	/** Injected for tests: the draw behind a new room's random format. `Math.random` otherwise. */
	random?: () => number;
	/**
	 * The eras a new room's format is drawn from: the `formats` of the library the
	 * server loaded at boot (`index.ts`), so a room only ever opens on an era the
	 * same server will serve — a pool fixture that failed to parse is in that
	 * library's `faults`, not its `formats`, and so never reaches a room. Absent,
	 * the catalog is empty and a new room opens on `NO_FORMAT`.
	 */
	formats?: readonly CatalogFormat[];
	/** Where a pod goes once it has finished or its room is closed (`tournaments.ts`). */
	onTournament?: (t: Tournament) => void;
	/** Every series result, once (`SeriesEnd`). */
	onSeriesEnd?: (end: SeriesEnd) => void;
	/**
	 * `room/plan.ts`'s `checkPlan`, bound to the server's cube lookup and Forge
	 * checker — the SAME function `PUT …/pod/plan` runs, injected here so a
	 * room whose plan has no verdict yet (just created; just restored with one
	 * still `null`) gets one WITHOUT a PUT. Absent (every test that does not
	 * pass it), a plan is simply never auto-checked — `planVerdict` stays
	 * `null`, same as before this existed.
	 */
	checkPlan?: (plan: DraftPlan) => Promise<PoolVerdict>;
}



/**
 * A table's record, as `RoomTable` on the wire — names each seated member
 * from `members`.
 *
 * **`series.length` is LIVE while `phase` is `'seating'`** (no game of this
 * series has started yet): it tracks the room's CURRENT `seriesFormatOf`, so
 * a room switched to a Gauntlet reads "best of 3" at once. Once a game
 * starts, `setTableMatch` snapshots the length, and only a Rematch's
 * conversion changes it.
 */
function tableView(table: TableRecord, members: readonly MemberRecord[], room: RoomRecord): RoomTable {
	return {
		id: table.id,
		players: seatList(table).map(({ memberId }) => ({ memberId, name: members.find((m) => m.id === memberId)?.name ?? '' })),
		matchId: table.matchId,
		series: {
			length: table.series.phase === 'seating' ? seriesFormatOf(seriesRoomOf(room)).length : table.series.length,
			wins: [...table.series.wins] as [number, number],
			games: table.series.games.map((g) => ({ matchId: g.matchId, winner: g.winner })),
			phase: table.series.phase,
		},
	};
}

/**
 * The tournament's deck policy as it plays. A Gauntlet has none to lock: every table's decks are its
 * own draw and ban/pick between the two seats at it, so a Gauntlet tournament is `per-round`
 * whatever the setting says (the operator, 2026-10-23: *"let's just disable 'decks locked' for
 * guantlet mode since it seems pointless"*). The stored setting is kept, so a room switched back
 * to Classic or All Random keeps the leader's choice.
 */
function tournamentDecksOf(room: RoomRecord): RoomSettings['tournamentDecks'] {
	return room.mode === 'gauntlet' ? 'per-round' : room.settings.tournamentDecks;
}

function viewOf(room: RoomRecord, locked: boolean, checks: GameHooks, part: GameViewPart | undefined): RoomView {
	return {
		id: room.id,
		name: room.name,
		creator: room.creator,
		leader: room.leader,
		gameType: room.gameType,
		settings: { ...room.settings, tournamentDecks: tournamentDecksOf(room) },
		locks: roomLocks(room),
		locked,
		members: room.members.map((m) => ({
			id: m.id,
			name: m.name,
			joinedAt: new Date(m.joinedAt).toISOString(),
			ready: isMemberReady(room, m.id),
			// Spread, not `avatarId: m.avatarId`. The key is ABSENT for a member
			// who has no avatar rather than present-and-undefined, so an
			// in-process reader and a JSON reader see the same two states —
			// `JSON.stringify` drops an undefined value and would otherwise be
			// the only thing making them agree.
			...(m.avatarId === undefined ? {} : { avatarId: m.avatarId }),
			...(m.look === undefined ? {} : { look: m.look }),
		})),
		seats: gameSeatsOf(room),
		tables: room.tables.map((t) => tableView(t, room.members, room)),
		// The FIRST table's live match — unchanged, so every existing reader
		// keeps working (`docs/planning/wave71-2026-10-17.md`'s wire contract).
		matchId: room.tables[0]?.matchId ?? null,
		createdAt: new Date(room.createdAt).toISOString(),
		testing: room.testing,
		scheduledFor: room.scheduledFor === undefined ? null : new Date(room.scheduledFor).toISOString(),
		...part?.(room, checks),
	};
}



/** What a bound room is made as. The leader changes the game type and pool afterwards. */
const WATCHPARTY_ROOM: CreateRoomInput = { name: 'Watchparty table', gameType: DEFAULT_GAME_TYPE, clientMode: DEFAULT_CLIENT_MODE };

/**
 * `room/room-list.ts`'s `RoomBusyHook`, wired to Magic: a draft dealing is
 * the one extra reason `offered()` keeps a room past staleness; a
 * tournament's own idle window (`usesPod`) and its post-deal grace
 * (`POD_SPARED_MS`) are what `sweep()` reads past the plain rule.
 */
const MAGIC_ROOM_BUSY: RoomBusyHook<RoomRecord> = {
	extraOffered: (room) => room.draftStartedAt !== null,
	defaultIdleMs: (room) => (usesPod(room) ? ROOM_IDLE_MS : CASUAL_ROOM_IDLE_MS),
	sparedFromSweep: (room, now) => room.draftStartedAt !== null && room.draftStartedAt > now - POD_SPARED_MS,
};

/**
 * Every readiness flag and deck hold — what a change to the table's pool or
 * mode costs everybody. The per-member blob `http/routes.ts` owns — the
 * choice, the verdict, the checked `.dck` — was produced for the table that
 * just changed, so it is dropped whole rather than edited. The seats stay
 * (the operator, 2026-10-23: "can we try to keep players seated?") unless
 * `unseat`: a game type change or a tournament's lock retires the tables.
 */
function dropHolds(room: RoomRecord, unseat: boolean): void {
	clearReady(room.ledger);
	for (const member of room.members) member.state = undefined;
	for (const table of room.tables) {
		if (unseat) table.seats = [null, null];
		table.ready = [false, false];
	}
}

/** Two option objects are the same when every key holds the same value. Options are flat. */
function sameOptions(a: ModeOptions, b: ModeOptions): boolean {
	const ka = Object.keys(a) as (keyof typeof a)[];
	const kb = Object.keys(b);
	return ka.length === kb.length && ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

/**
 * Whether a constructed room's mode can no longer change (operator ruling 8:
 * *"not anymore once players ready up"*). Every reason a mode freezes is one
 * line here, so `setMode` and `setGameType` ask one question.
 */
function modeLocked(room: RoomRecord): boolean {
	return room.tables.some((t) => t.ready.some(Boolean)) || inPlay(room);
}

/**
 * A game is being played: a table has its match, or a Gauntlet is under way.
 * Nothing that would interrupt a series (`#interruptSeries`) happens then,
 * the pool included, though a Ready alone does not freeze the pool.
 */
function inPlay(room: RoomRecord): boolean {
	return room.tables.some((t) => t.matchId !== null) || gauntletUnderWay(room.gauntlets);
}

/**
 * Why each of the room's controls cannot change now, or null where it can (`RoomLocks`, `@hadoku/shared`).
 * ONE answer for both sides: every setter below refuses with it, and the room view carries it, so the
 * screen never offers a control the server would refuse (the operator, 2026-11-02: *"why was it even
 * possible to click?"*). Once the pod is dealt nothing about the room changes; before that, what the
 * room plays and its event freeze with a Ready or a game (`modeLocked`), its pool and rules with a game.
 */
function roomLocks(room: RoomRecord): RoomLocks {
	const started = room.draftStartedAt !== null ? 'draft-started' : null;
	const plays = started ?? (modeLocked(room) ? 'mode-locked' : null);
	const playing = started ?? (inPlay(room) ? 'mode-locked' : null);
	// A historical replay room is born with every answer the event already
	// gave: its format, its mode (constructed classic), its settings. Nothing
	// about what it plays was ever this room's leader's choice, so nothing is
	// offered — the same "never a control the server would refuse" rule the
	// operator set for stale locks (2026-11-02), applied from creation.
	if (room.historical === true) {
		const historical = started ?? 'historical';
		return { gameType: historical, mode: historical, event: historical, format: historical, rules: historical };
	}
	return { gameType: plays, mode: plays, event: plays, format: playing, rules: playing };
}

/** The settings that make the room's event, locked with what it plays (`roomLocks`'s `event`); the rest are its match rules. */
const EVENT_SETTING_KEYS: readonly (keyof RoomSettings)[] = ['tournament', 'tournamentDecks'];

/** A Gauntlet whose reveal has started, and that is not yet done — true if ANY of the room's tables is one. */
/**
 * A Gauntlet as the room file keeps it: a member player's name left out (R12). The AI's is the
 * room's persona and stays.
 */
function gauntletWithoutNames(g: GauntletState): GauntletState {
	if (g.players === null) return g;
	const [a, b] = g.players.map((p) => (p.memberId === null ? p : { ...p, name: '' }));
	return { ...g, players: [a!, b!] };
}

/**
 * Each table's Gauntlet that one of its member players has left the room, with no game in play: gone,
 * as Abandon drops one. Its series was recorded when they left (`#settleSeries`); kept, it would hold
 * the table for good (`gauntletHoldsTable`) — nobody could sit or stand, and the one still seated
 * could never get their seat back on a disconnect (`releaseAbandonedSeats`).
 */
function dropDesertedGauntlets(room: RoomRecord): void {
	const present = new Set(room.members.map((m) => m.id));
	const deserted = room.tables.filter((t) => {
		const g = room.gauntlets[t.id];
		return t.matchId === null && g !== undefined && g.players?.some((p) => p.memberId !== null && !present.has(p.memberId)) === true;
	});
	if (deserted.length === 0) return;
	const next = { ...room.gauntlets };
	for (const t of deserted) delete next[t.id];
	room.gauntlets = next;
}

/** A Gauntlet's member players named as the room knows them now; a leaver keeps what the state said. */
function gauntletNamed(g: GauntletState, members: readonly MemberRecord[]): GauntletState {
	if (g.players === null) return g;
	const [a, b] = g.players.map((p) => {
		const m = p.memberId === null ? undefined : members.find((x) => x.id === p.memberId);
		return m === undefined ? p : { ...p, name: m.name };
	});
	return { ...g, players: [a!, b!] };
}

function seriesUnderWay(series: SeriesRecord): boolean {
	return series.phase === 'playing' || series.phase === 'sideboarding' || series.phase === 'between';
}

function gauntletUnderWay(gauntlets: Record<string, GauntletState>): boolean {
	return Object.values(gauntlets).some((g) => g.phase !== 'options' && g.phase !== 'done');
}

/**
 * A table stored before this file held its seats. Its `seats` were a copy,
 * refreshed only when the table was read, of what each member's
 * `http/routes.ts` blob said: the table it sat at (none meant the first), when
 * it sat (`seatedAt`, the seat order) and its Ready. So the seats are rebuilt
 * from the blobs, which were the record; the blobs' own copies are then
 * ignored.
 */
function seatsFromMembers(table: StoredTable, first: boolean, members: readonly MemberRecord[]): TableRecord {
	const held = members.flatMap((m) => {
		const s = m.state as { v?: unknown; table?: unknown; seatedAt?: unknown; ready?: unknown } | undefined;
		if (typeof s !== 'object' || s === null || s.v !== 1 || typeof s.seatedAt !== 'number') return [];
		if (typeof s.table === 'string' ? s.table !== table.id : !first) return [];
		return [{ memberId: m.id, seatedAt: s.seatedAt, ready: s.ready === true }];
	});
	held.sort((a, b) => a.seatedAt - b.seatedAt);
	const [one, two] = held;
	return { ...table, seats: [one?.memberId ?? null, two?.memberId ?? null], ready: [one?.ready ?? false, two?.ready ?? false] };
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
	/** Seats taken in this process, each by its number in the order they were taken (`seatMark`). Not kept: after a restart every seat counts as taken before any disconnect. */
	#seatTaken = new Map<string, number>();
	#seatsTaken = 0;
	#log: LobbyLog;
	readonly #avatarListeners = new Set<AvatarChangeListener>();
	readonly #changeListeners = new Set<RoomChangeListener>();
	#rooms = new Map<string, RoomRecord>();
	/** Room files still being deleted (`#forget`): `removed` waits for them. */
	readonly #removing = new Set<Promise<void>>();
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

	/** The pool a room minted here starts on, asked once per room. Resolved by `openLobby`. */
	#newRoomFormat: () => FormatId;

	/**
	 * Wave 72 §P. Every game type `useGameType` has wired its own `GameHooks`
	 * for, keyed by `RoomRecord.gameType`. `#hooksFor` is the one reader.
	 */
	#hooksByType = new Map<string, GameHooks>();
	/** Each game type's own part of its rooms' views (`useGameView`): Magic's for Magic's two types from the start, none for any other until wired. */
	#viewParts = new Map<string, GameViewPart>(GAME_TYPES.map((type) => [type, magicViewPart]));
	/** Bot games being played now, by room, round and players: one game per pairing, however often it is asked. */
	readonly #botGamesPlaying = new Set<string>();

	/** See {@link Lobby.onRelayRoomOpened}'s doc for why this file never imports `runtimes/relay-match.ts` to call it directly. */
	#relayRoomOpened: (roomId: string, seatCount: number, gameType: string) => void = () => {};

	#onTournament: (t: Tournament) => void;

	#onSeriesEnd: (end: SeriesEnd) => void;

	/** Wave 73 §A follow-up. `null` when `openLobby` was not given one — a plan then simply never auto-checks. */
	#checkPlan: ((plan: DraftPlan) => Promise<PoolVerdict>) | null = null;
	/**
	 * In-flight auto-checks, keyed by plan content (`#planKey`) — not by room —
	 * so two rooms created in the same instant on the identical default plan
	 * share the one call rather than firing it twice. Cleared as soon as the
	 * shared promise settles; a later room on the same (still-unchecked) plan
	 * starts a fresh one.
	 */
	readonly #planChecks = new Map<string, Promise<PoolVerdict>>();

	constructor(store: FileRoomStore, now: () => number, log: LobbyLog, newRoomFormat: () => FormatId, onTournament: (t: Tournament) => void, onSeriesEnd: (end: SeriesEnd) => void, checkPlan: ((plan: DraftPlan) => Promise<PoolVerdict>) | null) {
		this.#store = store;
		this.#checkPlan = checkPlan;
		this.#now = now;
		this.#log = log;
		this.#newRoomFormat = newRoomFormat;
		this.#onTournament = onTournament;
		this.#onSeriesEnd = onSeriesEnd;
	}

	/** Boot only: install a room decoded from disk. */
	restore(room: RoomRecord, secret: Secret | null): void {
		this.#rooms.set(room.id, room);
		this.#lastCreatedAt = Math.max(this.#lastCreatedAt, room.createdAt);
		if (secret !== null) this.#secrets.set(room.id, secret);
		// A saved verdict judged the previous process's cubes, catalog and Forge
		// pin. Any of them can be gone now (a shortlist swap, an importer's
		// delete, a pin that refuses a card), so every draft room is checked
		// again rather than trusting it — including a snapshot written mid-check,
		// which still has `planVerdict: null`.
		if (room.gameType === 'draft') room.planVerdict = null;
		dropDesertedGauntlets(room);
		this.#ensurePlanChecked(room);
	}

	/** This room's own `GameHooks` — whatever `useGameType` wired for its `gameType`, or the unwired defaults. */
	#hooksFor(gameType: string): GameHooks {
		return this.#hooksByType.get(gameType) ?? NO_GAME_HOOKS;
	}

	#view(room: RoomRecord): RoomView {
		return viewOf(room, this.#secrets.has(room.id), this.#hooksFor(room.gameType), this.#viewParts.get(room.gameType));
	}

	#persist(room: RoomRecord): void {
		for (const table of room.tables) this.#settleSeries(room, table, false);
		dropDesertedGauntlets(room);
		const now = this.#now();
		room.updatedAt = now;
		const members: SerializedMember[] = room.members.map((m) => {
			// No name and no avatar id (R12): a member is saved as who they are, not as what they
			// were called. Both come back from their next request (`rename`, the avatar assert).
			const ready = isMemberReady(room, m.id);
			const member: SerializedMember = {
				participantId: m.id,
				...(m.userId === null ? {} : { accountId: m.userId }),
				joinedAt: m.joinedAt,
				lastSeen: m.joinedAt,
				// Boxed, so a state of `null` survives a restart as `null`, and
				// `ready` rides the same blob — it is per-member state like the
				// deck choice. A member with neither still writes `null`, which
				// is byte-for-byte what a pre-wave-23 room wrote.
				app: m.state === undefined && !ready ? null : { state: structuredClone(m.state), ready },
			};
			return member;
		});
		const app: StoredApp = {
			name: room.name,
			creator: room.creator,
			leader: room.leader,
			gameType: room.gameType,
			settings: { ...room.settings },
			tables: room.tables.map((t) => ({ ...t, seats: [...t.seats] as [string | null, string | null], series: { ...t.series, wins: [...t.series.wins] as [number, number], games: t.series.games.map((g) => ({ ...g })) } })),
			// Restated for a rollback to a pre-wave-71 build (see `StoredApp.matchId`'s doc).
			matchId: room.tables[0]?.matchId ?? null,
			matches: [...room.matches],
			testing: room.testing,
			...(room.scheduledFor === undefined ? {} : { scheduledFor: room.scheduledFor }),

			secret: this.#secrets.get(room.id) ?? null,
			game: {
				format: room.format,
				mode: room.mode,
				modeOptions: room.modeOptions === null ? null : { ...room.modeOptions },
				clientMode: room.clientMode,
				draftStartedAt: room.draftStartedAt,
				plan: room.plan,
				planVerdict: room.planVerdict,
				podSeats: [...room.podSeats],
				podAi: [...room.podAi],
				...(room.podDrafts === null ? {} : { podDrafts: room.podDrafts.map((p) => [...p]) }),
				...(room.podSplit === null ? {} : { podSplit: copySplit(room.podSplit) }),
				podPlaying: [...room.podPlaying],
				lockedDecks: { ...room.lockedDecks },
				gauntlets: Object.fromEntries(Object.entries(room.gauntlets).map(([t, g]) => [t, gauntletWithoutNames(g)])),
				...(room.scenario === undefined ? {} : { scenario: room.scenario }),
				...(room.historical === true ? { historical: true } : {}),
				...(room.historicalStructure === undefined ? {} : { historicalStructure: { ...room.historicalStructure } }),
				...(room.aiDeckAssignments === undefined ? {} : { aiDeckAssignments: { ...room.aiDeckAssignments } }),
				...(room.seatDecks === undefined ? {} : { seatDecks: { ...room.seatDecks } }),
				pod:
					room.pod === null
						? null
						: {
								...room.pod,
								humans: [...room.pod.humans],
								results: room.pod.results.map((r) => ({ ...r })),
								pairings: room.pod.pairings.map((p) => ({ tableId: p.tableId, players: [...p.players] as [string, string] })),
							},
			},
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
			app: appCodec.serialize(app),
			appVersion: APP_VERSION,
		};
		this.#store.saveSync(snapshot);
		this.#changed(room.id);
	}

	#changed(roomId: string): void {
		for (const listener of [...this.#changeListeners]) {
			try {
				listener(roomId);
			} catch (err) {
				// A broken subscriber must not undo a change that is already stored.
				this.#log({ event: 'room-change-listener-failed', roomId, error: (err as Error).message });
			}
		}
	}

	onChange(listener: RoomChangeListener): () => void {
		this.#changeListeners.add(listener);
		return () => {
			this.#changeListeners.delete(listener);
		};
	}

	poolNamesChanged(): void {
		for (const room of this.#rooms.values()) {
			if (room.gameType === 'draft') this.#changed(room.id);
		}
	}

	/** Two plans are the same deal — same grouping `@hadoku/draft`'s `deal()` and `room/plan.ts`'s `checkPlan` use, and the same cards left out. */
	#planKey(plan: DraftPlan): string {
		const rounds = plan.rounds.map((src: PoolSource) => (src.kind === 'cube' ? `cube:${src.cubeId}` : `set:${src.code}:${src.style}`)).join('|');
		return plan.without === undefined || plan.without.length === 0 ? rounds : `${rounds}|without:${[...plan.without].sort().join('\u0000')}`;
	}

	/**
	 * A room whose plan has no verdict yet gets one, in the background, with
	 * no PUT — see this class's `#checkPlan` and `OpenLobbyOptions.checkPlan`'s
	 * own doc for why this exists at all. Called from `#insert` (every new
	 * room starts on the Settled default, unchecked) and `restore` (a snapshot
	 * written mid-check, before the previous process could finish one).
	 *
	 * Only a `draft` room's plan is ever read, so a constructed room's (always
	 * the Settled default, never shown or acted on) is never checked — that
	 * would be Forge work spent on a value nobody looks at.
	 */
	#ensurePlanChecked(room: RoomRecord): void {
		if (room.gameType !== 'draft') return;
		if (room.planVerdict !== null) return;
		if (this.#checkPlan === null) return;
		const checkPlan = this.#checkPlan;
		const roomId = room.id;

		const key = this.#planKey(room.plan);
		let pending = this.#planChecks.get(key);
		if (pending === undefined) {
			pending = checkPlan(room.plan);
			this.#planChecks.set(key, pending);
			// Not `.finally` chained onto what callers await: this is the cache
			// entry's own cleanup, run once regardless of how many rooms are
			// waiting on it, so a plan nobody has checked successfully yet gets a
			// fresh attempt the next time a room asks rather than being stuck
			// replaying a rejected promise forever.
			pending.catch(() => undefined).then(() => this.#planChecks.delete(key));
		}

		pending.then(
			(verdict) => {
				// The room may have been deleted, or already given a real verdict by
				// a PUT that landed while this background check was in flight — a
				// stale background result must never overwrite either.
				const current = this.#rooms.get(roomId);
				if (current === undefined || current.planVerdict !== null) return;
				current.planVerdict = verdict;
				this.#persist(current);
			},
			(err: unknown) => {
				this.#log({ event: 'plan-check-failed', roomId, error: (err as Error).message });
			},
		);
	}

	list(): RoomView[] {
		return sortRoomsByCreation([...this.#rooms.values()]).map((r) => this.#view(r));
	}

	/** In memory only: a read is not a mutation and must not write a file. */
	#touchedAt = new Map<string, number>();

	touch(roomId: string, memberId: string): void {
		if (this.isMember(roomId, memberId)) this.#touchedAt.set(roomId, this.#now());
	}

	offered(staleMs: number = ROOM_STALE_MS): RoomView[] {
		const now = this.#now();
		return sortRoomsByCreation(
			[...this.#rooms.values()].filter((r) => isOfferedRoom(r, MAGIC_ROOM_BUSY, now, staleMs, this.#touchedAt.get(r.id))),
		).map((r) => this.#view(r));
	}

	roomOfMatch(matchId: string): RoomView | undefined {
		for (const room of this.#rooms.values()) {
			if (room.tables.some((t) => t.matchId === matchId) || room.matches.includes(matchId)) return this.#view(room);
		}
		return undefined;
	}

	stillPlaying(matchId: string, memberId: string): boolean {
		for (const room of this.#rooms.values()) {
			for (const { matchId: live, series } of room.tables) {
				if (series.settled || !series.played.includes(memberId)) continue;
				if (live === matchId || series.games.some((g) => g.matchId === matchId)) return true;
			}
		}
		return false;
	}

	get(roomId: string): RoomView | undefined {
		const room = this.#rooms.get(roomId);
		return room === undefined ? undefined : this.#view(room);
	}

	isMember(roomId: string, memberId: string): boolean {
		const room = this.#rooms.get(roomId);
		return room !== undefined && isRoomMember(room, memberId);
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

	#table(roomId: string, tableId: string): { room: RoomRecord; table: TableRecord } | undefined {
		const room = this.#rooms.get(roomId);
		const table = room?.tables.find((t) => t.id === tableId);
		return room === undefined || table === undefined ? undefined : { room, table };
	}

	/**
	 * Everyone in a room is a player or a spectator, whatever the room plays (the operator,
	 * 2026-11-02: "it's irrelevant what type of room it is"). A newcomer takes the first open
	 * seat: the 1v1 table's, or the pod's before its draft is dealt ("new people who join
	 * automatically fill in seats as they join rooms"). Only on entering, never on a member's
	 * return, so someone who chose to watch stays watching, and never ahead of a member already
	 * in the room without a seat: at a party the watcher who waited takes the loser's seat, not
	 * the loser coming back in (`e2e/turnover.spec.ts`). Nothing moves once the table is locked:
	 * a live match or a Gauntlet that holds it.
	 */
	#autoSeat(room: RoomRecord, memberId: string): void {
		if (this.#seatsShut(room) !== null) return;
		const players = playersOf(room);
		if (room.members.some((m) => m.id !== memberId && !players.includes(m.id))) return;
		if (usesPod(room)) {
			if (room.draftStartedAt !== null) return;
			const open = room.podSeats.indexOf(null);
			if (open === -1) return;
			room.podSeats = room.podSeats.map((s, i) => (i === open ? memberId : s));
			this.#log({ event: 'seat-auto', roomId: room.id, seat: open, memberId });
			return;
		}
		const table = room.tables[0];
		if (table === undefined || table.matchId !== null) return;
		const gauntlet = room.gauntlets[table.id];
		if (gauntlet !== undefined && gauntletHoldsTable(gauntlet)) return;
		if (!sitAt(room.tables, table, memberId)) return;
		this.#tookSeat(room.id, table.id, memberId);
		this.#log({ event: 'seat-auto', roomId: room.id, tableId: table.id, memberId });
	}

	/** `Lobby.seatsShutUntil`, for a room in hand. */
	#seatsShut(room: RoomRecord): number | null {
		if (room.scheduledFor === undefined) return null;
		const opens = seatsOpenAt(room.scheduledFor);
		return this.#now() < opens ? opens : null;
	}

	seatsShutUntil(roomId: string): number | null {
		const room = this.#rooms.get(roomId);
		return room === undefined ? null : this.#seatsShut(room);
	}

	gameSeatOf(roomId: string, memberId: string): number | null {
		const room = this.#rooms.get(roomId);
		const seat = room === undefined ? -1 : gameSeatsOf(room).indexOf(memberId);
		return seat === -1 ? null : seat;
	}

	#tookSeat(roomId: string, tableId: string, memberId: string): void {
		this.#seatTaken.set(`${roomId}\u0000${tableId}\u0000${memberId}`, ++this.#seatsTaken);
	}

	seatMark(): number {
		return this.#seatsTaken;
	}

	/**
	 * A change between the 1v1 table and the pod (a game type, or Tournament on or off) changes
	 * which seats the room has; its players keep playing in the new ones, in the order they sat,
	 * and its spectators keep watching. A 1v1 table takes its own game type's `seats.max`
	 * (Magic's own two types are always 2); the rest watch.
	 */
	#carryPlayers(room: RoomRecord, players: readonly string[]): void {
		if (usesPod(room)) {
			const seats: (string | null)[] = room.podSeats.map((s) => (s === null || s === POD_AI || s === POD_CLOSED ? s : null));
			for (const id of players) {
				const open = seats.indexOf(null);
				if (open === -1) break;
				seats[open] = id;
			}
			room.podSeats = seats;
			return;
		}
		const table = room.tables[0];
		if (table === undefined) return;
		for (const id of seatList(table).map((s) => s.memberId)) leaveSeat(table, id);
		const tableSeatCount = gameTypeSpec(room.gameType)?.seats.max ?? 2;
		for (const id of players.slice(0, tableSeatCount)) if (sitAt(room.tables, table, id)) this.#tookSeat(room.id, table.id, id);
	}

	#recordMatch(room: RoomRecord, matchId: string): void {
		if (!room.matches.includes(matchId)) room.matches = [...room.matches, matchId].slice(-ROOM_MATCHES_KEPT);
	}

	seats(roomId: string, tableId: string): TableSeat[] {
		const found = this.#table(roomId, tableId);
		return found === undefined ? [] : seatList(found.table);
	}

	sit(roomId: string, tableId: string, memberId: string, seat?: number): boolean {
		const found = this.#table(roomId, tableId);
		if (found === undefined || !found.room.members.some((m) => m.id === memberId)) return false;
		const { room, table } = found;
		const held = table.seats.indexOf(memberId);
		if (seat === undefined ? held !== -1 : held === seat) return true;
		if (this.#seatsShut(room) !== null || !sitAt(room.tables, table, memberId, seat)) return false;
		this.#tookSeat(room.id, table.id, memberId);
		this.#persist(room);
		return true;
	}

	stand(roomId: string, tableId: string, memberId: string): boolean {
		const found = this.#table(roomId, tableId);
		if (found === undefined) return false;
		if (leaveSeat(found.table, memberId)) this.#persist(found.room);
		return true;
	}

	releaseAbandonedSeats(memberId: string, mark = Infinity): { roomId: string; tableId: string }[] {
		const released: { roomId: string; tableId: string }[] = [];
		for (const room of this.#rooms.values()) {
			for (const table of room.tables) {
				if (!table.seats.includes(memberId)) continue;
				if ((this.#seatTaken.get(`${room.id}\u0000${table.id}\u0000${memberId}`) ?? 0) > mark) continue;
				// A series under way keeps its seats between games too (sideboarding,
				// between, or a game whose match went away): only a settled or unstarted one frees them.
				if (table.matchId !== null || seriesUnderWay(table.series)) continue;
				const gauntlet = room.gauntlets[table.id];
				if (gauntlet !== undefined && gauntletHoldsTable(gauntlet)) continue;
				if (!leaveSeat(table, memberId)) continue;
				const member = room.members.find((m) => m.id === memberId);
				if (member !== undefined) member.state = undefined;
				released.push({ roomId: room.id, tableId: table.id });
			}
			if (released.some((r) => r.roomId === room.id)) this.#persist(room);
		}
		for (const { roomId, tableId } of released) this.#log({ event: 'seat-released-disconnected', roomId, tableId, memberId });
		return released;
	}

	setSeatReady(roomId: string, tableId: string, memberId: string, ready: boolean): boolean {
		const found = this.#table(roomId, tableId);
		if (found === undefined || !readySeat(found.table, memberId, ready)) return false;
		this.#persist(found.room);
		return true;
	}

	setTableMatch(roomId: string, tableId: string, matchId: string): boolean {
		const found = this.#table(roomId, tableId);
		if (found === undefined || found.table.matchId !== null) return false;
		const { room, table } = found;
		if (table.series.phase === 'seating' || table.series.phase === 'done') {
			// A finished series this start replaces is over, Rematch or not.
			this.#settleSeries(room, table, true);
			table.series = newSeries(seriesRoomOf(room), seatOrder(table), 'playing');
		} else if (table.series.phase === 'sideboarding' || table.series.phase === 'between') {
			table.series = { ...table.series, phase: 'playing' };
		}
		// `phase === 'playing'` already (a replacement match after the previous
		// one simply vanished, `releaseTableMatch`): nothing about the series changes.
		table.matchId = matchId;
		table.ready = [false, false];
		table.series = { ...table.series, gameStartedAt: this.#now() };
		this.#recordMatch(room, matchId);
		this.#persist(room);
		this.#log({ event: 'table-match-started', roomId, tableId, matchId });
		return true;
	}

	releaseTableMatch(roomId: string, tableId: string): boolean {
		const found = this.#table(roomId, tableId);
		if (found === undefined) return false;
		const { room, table } = found;
		// Idempotent, and a no-op write is not persisted: the same discipline
		// `setAvatar` keeps for its own idempotent case.
		if (table.matchId === null) return true;
		table.matchId = null;
		table.ready = [false, false];
		this.#persist(room);
		this.#log({ event: 'table-match-released', roomId, tableId });
		return true;
	}

	recordGameResult(roomId: string, tableId: string, result: { matchId: string; winner: 0 | 1 | null }): RecordGameResultResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		const table = room.tables.find((t) => t.id === tableId);
		if (table === undefined) return { ok: false, reason: 'no-such-table' };
		table.matchId = null;
		// A game that ends after its series was left is discarded: that series is already recorded.
		const startedAt = table.series.gameStartedAt ?? null;
		const ms = startedAt === null ? {} : { ms: Math.max(0, this.#now() - startedAt) };
		const open = !table.series.settled;
		if (open) table.series = recordGame(table.series, seriesFormatOf(seriesRoomOf(room)), { matchId: result.matchId, winner: result.winner, ...ms });
		table.series = { ...table.series, gameStartedAt: null };
		table.ready = [false, false];
		// Wave 72 §P: a pod round advances ITSELF the instant every one of its
		// tables is `done` — see `#finishPodTable`.
		if (table.series.phase === 'done' && room.pod !== null) this.#finishPodTable(room, table);
		this.#persist(room);
		this.#log({ event: 'table-game-recorded', roomId, tableId, matchId: result.matchId, winner: result.winner, phase: table.series.phase });
		return { ok: true, room: this.#view(room), phase: table.series.phase };
	}

	abandonTable(roomId: string, callerId: string, tableId: string): ResolveTableResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		const table = room.tables.find((t) => t.id === tableId);
		if (table === undefined) return { ok: false, reason: 'no-such-table' };
		if (room.pod !== null) return { ok: false, reason: 'pod-table' };
		if (!table.seats.includes(callerId)) return { ok: false, reason: 'not-seated' };
		const { matchId } = table;
		// A finished series is a result still to be recorded (a Bo1 open to its Rematch), never abandoned.
		if (matchId === null && (table.series.games.length === 0 || table.series.phase === 'done')) return { ok: false, reason: 'nothing-to-abandon' };
		table.matchId = null;
		table.ready = [false, false];
		// Replaced, not settled: `#settleSeries` never sees it, so nothing is recorded.
		table.series = newSeries(seriesRoomOf(room), seatOrder(table), 'seating');
		const next = { ...room.gauntlets };
		delete next[table.id];
		room.gauntlets = next;
		this.#persist(room);
		this.#log({ event: 'table-abandoned', roomId, tableId, by: callerId, matchId });
		return { ok: true, matchId };
	}

	dropTableMatch(roomId: string, callerId: string, tableId: string): ResolveTableResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		const table = room.tables.find((t) => t.id === tableId);
		if (table === undefined) return { ok: false, reason: 'no-such-table' };
		const pairing = room.pod?.pairings.find((p) => p.tableId === tableId);
		if (room.pod === null || pairing === undefined) return { ok: false, reason: 'not-pod-table' };
		if (!table.seats.includes(callerId) || !pairing.players.includes(callerId)) return { ok: false, reason: 'not-seated' };
		if (table.series.phase === 'done') return { ok: false, reason: 'nothing-to-drop' };
		const { matchId } = table;
		const wins = this.#forfeit(room, table, callerId);
		this.#persist(room);
		this.#log({ event: 'table-dropped', roomId, tableId, by: callerId, matchId, wins });
		return { ok: true, matchId };
	}

	/**
	 * `loser`'s pod match at `table`, still under way, is forfeited: the other side wins the series — its
	 * wins raised to the majority, the loser's won games standing below it — recorded as any finished
	 * series is, and the round advances once its last table is done. A game in play is let go of.
	 */
	#forfeit(room: RoomRecord, table: TableRecord, loser: string): [number, number] {
		const { series } = table;
		const order = seatOrder(table);
		const dropper = isAiEntrant(loser) ? order.indexOf(null) : order.indexOf(loser);
		const needed = Math.floor(series.length / 2) + 1;
		const other = dropper === 0 ? 1 : 0;
		const wins: [number, number] = [0, 0];
		wins[other] = Math.max(series.wins[other] ?? 0, needed);
		wins[dropper === 0 ? 0 : 1] = Math.min(series.wins[dropper === 0 ? 0 : 1] ?? 0, needed - 1);
		table.matchId = null;
		table.ready = [false, false];
		// Before a first game the series names nobody; the seats are who played it.
		const played: [string | null, string | null] = series.games.length === 0 ? order : series.played;
		table.series = { ...series, played, wins, phase: 'done', gameStartedAt: null };
		this.#settleSeries(room, table, true);
		table.series = { ...table.series, settled: true };
		this.#finishPodTable(room, table);
		return wins;
	}

	dqPlayer(roomId: string, leaderId: string, entrantId: string): DqPlayerResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (room.leader !== leaderId) return { ok: false, reason: 'not-leader' };
		const pod = room.pod;
		if (pod === null || pod.round > pod.rounds) return { ok: false, reason: 'no-pod' };
		if (!pod.humans.includes(entrantId)) return { ok: false, reason: 'not-entrant' };
		if ((pod.dropped ?? []).includes(entrantId)) return { ok: false, reason: 'already-dropped' };
		const { tableId, matchIds } = this.#dropEntrant(room, pod, entrantId);
		this.#persist(room);
		this.#log({ event: 'player-dq', roomId, by: leaderId, memberId: entrantId, tableId, matchIds });
		return { ok: true, tableId, matchIds };
	}

	/**
	 * `entrantId` is out of the pod's rounds — disqualified (`dqPlayer`) or gone from the room (`leave`):
	 * marked dropped, and their current match, still under way, forfeited (`#forfeit`). Later pairings
	 * of theirs are byes (`#pairRound`).
	 */
	#dropEntrant(room: RoomRecord, pod: PodRecord, entrantId: string): { tableId: string | null; matchIds: string[] } {
		// Marked first: a forfeit that finishes the round pairs the next one, which must already know.
		room.pod = { ...pod, dropped: [...(pod.dropped ?? []), entrantId] };
		const pairing = pod.pairings.find((p) => p.players.includes(entrantId));
		const table = pairing === undefined ? undefined : room.tables.find((t) => t.id === pairing.tableId);
		if (table === undefined || table.series.phase === 'done') return { tableId: table?.id ?? null, matchIds: [] };
		const matchIds = table.matchId === null ? [] : [table.matchId];
		this.#forfeit(room, table, entrantId);
		return { tableId: table.id, matchIds };
	}

	resetGame(roomId: string, leaderId: string, tableId: string): ResetGameResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (room.leader !== leaderId) return { ok: false, reason: 'not-leader' };
		const table = room.tables.find((t) => t.id === tableId);
		if (table === undefined) return { ok: false, reason: 'no-such-table' };
		const { matchId } = table;
		if (matchId === null || table.series.phase !== 'playing') return { ok: false, reason: 'no-game' };
		// `releaseTableMatch`'s letting-go: no result, and the series' phase stays `playing`, so
		// `setTableMatch` starts the same game again.
		table.matchId = null;
		table.ready = [false, false];
		table.series = { ...table.series, gameStartedAt: null };
		this.#persist(room);
		this.#log({ event: 'game-reset', roomId, tableId, by: leaderId, matchId, wins: table.series.wins });
		return { ok: true, matchId };
	}

	resetRoom(roomId: string, leaderId: string): ResetRoomResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (room.leader !== leaderId) return { ok: false, reason: 'not-leader' };
		if (room.pod !== null || room.draftStartedAt !== null) return { ok: false, reason: 'pod-under-way' };
		const matchIds = room.tables.flatMap((t) => (t.matchId === null ? [] : [t.matchId]));
		// Let go of first, so a stopped game's end finds no table naming it and records nothing.
		for (const table of room.tables) table.matchId = null;
		this.#interruptSeries(room, false);
		room.gauntlets = {};
		room.lockedDecks = {};
		this.#persist(room);
		this.#log({ event: 'room-reset', roomId, by: leaderId, matches: matchIds.length });
		return { ok: true, tableIds: room.tables.map((t) => t.id), matchIds };
	}

	/**
	 * This table's series just went `done`, and the room HAS a pod — record
	 * its pairing's `MatchResult` and, once every one of the CURRENT round's
	 * tables is `done` too, advance to the next round (or to `done`).
	 *
	 * A no-op for a table that is not one of the pod's CURRENT pairings: a
	 * table from an already-finished round (kept only for its own history),
	 * or any table a pod does not own.
	 */
	#finishPodTable(room: RoomRecord, table: TableRecord): void {
		const pod = room.pod;
		if (pod === null) return;
		const pairing = pod.pairings.find((p) => p.tableId === table.id);
		if (pairing === undefined) return;
		const [a, b] = pairing.players;
		// Recorded once: a game of a dropped series that ends afterwards finds the result already there.
		if (pod.results.some((r) => r.round === pod.round && r.playerA === a && r.playerB === b)) return;
		// The series counts by the seat each played from (`played`, Forge's AI `null`), and a pairing that
		// names its AI first seats the human at 0 (`#newPodTable`): each entrant's games are its own seat's.
		const played = table.series.played;
		const seatOf = (id: string, fallback: 0 | 1): number => {
			const seat = isPodAi(id) ? played.indexOf(null) : played.indexOf(id);
			return seat === -1 ? fallback : seat;
		};
		const gameMs = table.series.games.flatMap((g) => (g.ms === undefined ? [] : [g.ms]));
		// A series against the AI counts like any other (the operator: "i lost so it
		// should show my standings").
		pod.results = [
			...pod.results,
			{ round: pod.round, playerA: a, playerB: b, gamesA: table.series.wins[seatOf(a, 0)] ?? 0, gamesB: table.series.wins[seatOf(b, 1)] ?? 0, ...(gameMs.length === 0 ? {} : { gameMs }) },
		];
		if (!this.#roundStillPlaying(room, pod, table.id)) this.#advancePodRound(room, pod);
	}

	/** Whether any of the current round's matches is not over yet: a table (but `except`, just finished) or a bot game. */
	#roundStillPlaying(room: RoomRecord, pod: PodRecord, except: string | null): boolean {
		if ((pod.botGames ?? []).length > 0) return true;
		return pod.pairings.some((p) => {
			if (p.tableId === except) return false;
			const t = room.tables.find((x) => x.id === p.tableId);
			return t === undefined || t.series.phase !== 'done';
		});
	}

	/**
	 * Every one of the current round's tables is `done`. Pair the next round
	 * (`pairRound`, `@hadoku/draft`) and make its tables, or — this was the
	 * last round — mark the pod `done`: `round` moves one PAST `rounds`,
	 * which is what `podPhaseOf` reads as `done`.
	 *
	 * A round can pair two AI entrants against each other (`#pairRound`'s own
	 * split): that pairing is a bot game, played with no table, and the round
	 * waits on it like on any table (`#botGameEnded`). When EVERY pairing of
	 * the round settled at once (no tables, no bot games), there is nothing
	 * live to wait on, so this advances past it immediately rather than
	 * stranding the pod on a round with nothing in it.
	 */
	#advancePodRound(room: RoomRecord, pod: PodRecord): void {
		if (pod.round >= pod.rounds) {
			room.pod = { ...pod, round: pod.rounds + 1, pairings: [], botGames: [], bye: null };
			this.#log({ event: 'pod-done', roomId: room.id });
			this.#archive(room);
			return;
		}
		const nextRound = pod.round + 1;
		const { pairings, settled, bots, bye } = this.#pairRound(room, podPlayers(room, pod.humans), pod.results, nextRound);
		const byeResult: MatchResult[] = bye === null ? [] : [{ round: nextRound, playerA: bye, playerB: null, gamesA: 2, gamesB: 0 }];
		const results = [...pod.results, ...byeResult, ...settled];
		room.pod = { ...pod, round: nextRound, results, pairings, botGames: bots.map((players) => ({ players })), bye };
		this.#log({ event: 'pod-round-started', roomId: room.id, round: nextRound, tables: pairings.length, bye, settled: settled.length, botGames: bots.length });
		if (pairings.length === 0 && bots.length === 0) this.#advancePodRound(room, room.pod);
		else this.#playPairedBots(room);
	}

	/**
	 * Play every bot game of the room's current round not already being played (`GameHooks.playBotGame`).
	 * Called when a round pairs, and again for every room restored with one still owed (`useGameType`): a
	 * restart plays the game again from its start, never waits on the one it lost.
	 */
	#playPairedBots(room: RoomRecord): void {
		const pod = room.pod;
		const playBotGame = this.#hooksFor(room.gameType).playBotGame;
		if (pod === null || playBotGame === undefined) return;
		const bestOf = seriesFormatOf(seriesRoomOf(room)).length === 1 ? 1 : 3;
		for (const { players } of pod.botGames ?? []) {
			const key = `${room.id}:${pod.round}:${players.join(':')}`;
			if (this.#botGamesPlaying.has(key)) continue;
			this.#botGamesPlaying.add(key);
			const ask: BotGameAsk = {
				roomId: room.id,
				round: pod.round,
				players,
				names: [entrantPersona(room, players[0], this.#hooksFor(room.gameType)).name, entrantPersona(room, players[1], this.#hooksFor(room.gameType)).name],
				decks: [this.#botDeckSource(room, players[0]), this.#botDeckSource(room, players[1])],
				bestOf,
			};
			this.#log({ event: 'bot-game-started', roomId: room.id, round: pod.round, players, bestOf });
			const ended = (result: { wins: [number, number]; gameMs: number[] } | null, error: string | null): void => {
				this.#botGamesPlaying.delete(key);
				this.#botGameEnded(room.id, ask, result, error);
			};
			playBotGame(ask).then(
				(result) => ended(result, null),
				(err: unknown) => ended(null, (err as Error).message),
			);
		}
	}

	/** Where `entrant`'s deck for a bot game comes from (`BotDeckSource`). */
	#botDeckSource(room: RoomRecord, entrant: string): BotDeckSource {
		if (!isTournamentRoom(room)) return { kind: 'drafted', draftId: memberDraftId(room, entrant), seat: aiEntrantSeat(entrant) };
		const locked = tournamentDecksOf(room) === 'locked' ? (room.lockedDecks[entrant] ?? null) : null;
		return locked === null ? { kind: 'deal' } : { kind: 'locked', deck: locked };
	}

	/**
	 * A bot game ended: its result goes into the pod's results, as a table's does (`#finishPodTable`),
	 * and the round moves on once nothing of it is left. No result settles the pairing the way it was
	 * settled before bot games existed (`settledBotGame`), so a round never waits for good. A game that
	 * ends after its room, round or pairing has gone is let go.
	 */
	#botGameEnded(roomId: string, ask: BotGameAsk, result: { wins: [number, number]; gameMs: number[] } | null, error: string | null): void {
		const room = this.#rooms.get(roomId);
		const pod = room?.pod ?? null;
		const [a, b] = ask.players;
		const owed = pod?.botGames?.find((g) => g.players[0] === a && g.players[1] === b);
		if (room === undefined || pod === null || pod.round !== ask.round || owed === undefined) {
			this.#log({ event: 'bot-game-dropped', roomId, round: ask.round, players: ask.players });
			return;
		}
		const recorded: MatchResult =
			result === null
				? settledBotGame(ask.round, a, b)
				: { round: ask.round, playerA: a, playerB: b, gamesA: result.wins[0], gamesB: result.wins[1], ...(result.gameMs.length === 0 ? {} : { gameMs: result.gameMs }) };
		if (result === null) this.#log({ event: 'bot-game-fallback', roomId, round: ask.round, players: ask.players, error, settled: [recorded.playerA, recorded.playerB] });
		else this.#log({ event: 'bot-game-finished', roomId, round: ask.round, players: ask.players, wins: result.wins, gameMs: result.gameMs });
		room.pod = { ...pod, results: [...pod.results, recorded], botGames: (pod.botGames ?? []).filter((g) => g !== owed) };
		if (!this.#roundStillPlaying(room, room.pod, null)) this.#advancePodRound(room, room.pod);
		this.#persist(room);
	}

	/**
	 * One round's pairings, split three ways: a LIVE pairing gets a table
	 * (`#newPodTable`); two AI entrants paired together are a bot game
	 * (`bots`), played in Forge with no table (`#playPairedBots`) — the operator,
	 * 2026-11-07, superseding 2026-10-22's *"settle that match without a
	 * game… rather than spin up an AI-vs-AI Forge match"*, so the bracket shows
	 * a real score for every pairing. With no `GameHooks.playBotGame` wired
	 * (a server without Forge, most tests) or in a seeded testing room such a
	 * pairing is still settled at once (`settledBotGame`), and so is a
	 * disqualified entrant's.
	 */
	#pairRound(
		room: RoomRecord,
		players: PodPlayer[],
		results: MatchResult[],
		round: number,
	): { pairings: { tableId: string; players: [string, string] }[]; settled: MatchResult[]; bots: [string, string][]; bye: string | null } {
		const paired = pairRound({
			players,
			results,
			round,
			...(room.historicalStructure === undefined ? {} : { structure: room.historicalStructure, seed: room.id }),
		});
		const pairings: { tableId: string; players: [string, string] }[] = [];
		const settled: MatchResult[] = [];
		const bots: [string, string][] = [];
		const dropped = new Set(room.pod?.dropped ?? []);
		for (const [a, b] of paired.tables) {
			// A disqualified entrant's pairing is its opponent's bye (`dqPlayer`); two of them, nothing.
			if (dropped.has(a) || dropped.has(b)) {
				const other = dropped.has(a) ? b : a;
				if (!dropped.has(other)) settled.push({ round, playerA: other, playerB: null, gamesA: 2, gamesB: 0 });
			} else if (isAiEntrant(a) && isAiEntrant(b)) {
				// A seeded testing room's rounds are a fixture, never played (`#archive` keeps them out of the stats too).
				if (this.#hooksFor(room.gameType).playBotGame === undefined || room.testing === true) settled.push(settledBotGame(round, a, b));
				else bots.push([a, b]);
			} else {
				pairings.push({ tableId: this.#newPodTable(room, a, b), players: [a, b] });
			}
		}
		return { pairings, settled, bots, bye: paired.bye !== null && dropped.has(paired.bye) ? null : paired.bye };
	}

	/**
	 * One pod table: bo3 with sideboarding (`seriesFormatOf` of any draft room
	 * or tournament pod, `draft-pods-plan.md` ruling 1 and
	 * `docs/planning/tournament-mode-plan.md`'s Design).
	 *
	 * A DRAFT pod seats both players with their saved built deck
	 * (`GameHooks.seatState`); a player `seatState` answers `null` for
	 * (should not happen — `playPod` already checked `built` for everyone)
	 * is left to load one the ordinary way rather than crash the round.
	 *
	 * A TOURNAMENT pod's Classic/All Random table additionally seats each
	 * entrant's deck (`#seatTournamentDeck`) — never for Gauntlet, whose own
	 * `playing` phase deals a game's decks itself once its seats ready up, the
	 * same way a non-tournament Gauntlet table already does. Either `a` or
	 * `b` (never both — an AI-vs-AI pairing never reaches here, see
	 * `#pairRound`) may be a tournament AI entrant id (`isAiEntrant`), which
	 * never gets a real table seat: the pairing's HUMAN seat takes the live
	 * seat and the AI's is `null`, the same convention a draft pod's
	 * solo-vs-bots table already uses — the AI's own deck then rides its
	 * human partner's `state.aiDeck`, exactly as a vs-bot table always has.
	 */
	#newPodTable(room: RoomRecord, a: string, b: string): string {
		const aIsAi = isAiEntrant(a);
		const seats: [string, string | null] = aIsAi ? [b, null] : [a, isAiEntrant(b) ? null : b];
		const table: TableRecord = {
			id: mintTableId(room.tables.map((t) => t.id)),
			seats,
			ready: [false, false],
			matchId: null,
			series: newSeries(seriesRoomOf(room), seats, 'seating'),
		};
		room.tables = [...room.tables, table];
		for (const id of seats) {
			if (id === null) continue;
			const member = room.members.find((m) => m.id === id);
			if (member === undefined) continue;
			const state = this.#hooksFor(room.gameType).seatState(memberDraftId(room, id), id);
			if (state !== null && state !== undefined) member.state = state;
		}
		if (isTournamentRoom(room) && room.mode !== 'gauntlet') {
			this.#seatTournamentDeck(room, table.id, a);
			this.#seatTournamentDeck(room, table.id, b);
		}
		return table.id;
	}

	/**
	 * Tournament, Classic/All Random: `entrant`'s deck for `tableId` —
	 * `locked`'s stored snapshot (`room.lockedDecks`, filled once at the lock
	 * — `#lockTournament`) replayed as-is, or `null` for `per-round` (a fresh
	 * pick or deal — `GameHooks.seatTournamentDeck`'s own doc). `entrant` may
	 * be a member id or a tournament AI entrant id; which it is, and what to
	 * do about it, is `GameHooks`'s own business, never this file's.
	 */
	#seatTournamentDeck(room: RoomRecord, tableId: string, entrant: string): void {
		const locked = tournamentDecksOf(room) === 'locked' ? room.lockedDecks[entrant] ?? null : null;
		this.#hooksFor(room.gameType).seatTournamentDeck(room.id, tableId, entrant, locked);
	}

	beginSideboarding(roomId: string, tableId: string): boolean {
		const found = this.#table(roomId, tableId);
		if (found === undefined) return false;
		const { room, table } = found;
		const converted = this.#rematchable(room, table) ? convertToBo3(table.series) : null;
		if (converted === null) return false;
		table.series = converted;
		this.#persist(room);
		this.#log({ event: 'table-series-converted', roomId, tableId, wins: converted.wins });
		return true;
	}

	/**
	 * A finished Bo1 is open to a Rematch for as long as the room has not moved
	 * on: the room still plays Bo1 series, the same players sit in the same
	 * seats, and each still holds the deck it played (`GameHooks.holdsSeriesDeck`
	 * — a deck, format or mode change drops or replaces it).
	 *
	 * Never a board-state room's (`scenario`): every game there starts from its scripted board, whatever
	 * deck was held, so its Rematch starts that board again, a series of its own, rather than a Bo3
	 * with a sideboard step in front of it (the operator, 2026-10-23: "just make sure that it resets
	 * properly when i try it again").
	 */
	#rematchable(room: RoomRecord, table: TableRecord): boolean {
		const { series } = table;
		if (room.scenario !== undefined) return false;
		if (series.phase !== 'done' || series.length !== 1 || series.settled || seriesFormatOf(seriesRoomOf(room)).length !== 1) return false;
		return this.#stillSeated(table) && series.played.every((id) => id === null || this.#hooksFor(room.gameType).holdsSeriesDeck(room.members.find((m) => m.id === id)?.state));
	}

	/** Whoever played the table's series still sits as they played it. */
	#stillSeated(table: TableRecord): boolean {
		const order = seatOrder(table);
		return table.series.played.every((id, seat) => order[seat] === id);
	}

	/**
	 * Whether a series' players have left it: one stood up from their seat or
	 * left the room (`leave`, which settles first, while the leaver is still a
	 * member to name). A draft room's tables are the pod's: its rounds decide
	 * who plays whom, so nobody leaves a pod series this way.
	 */
	#leftSeries(room: RoomRecord, table: TableRecord, leaving: string | null = null): boolean {
		if (room.gameType === 'draft') return false;
		return !this.#stillSeated(table) || (leaving !== null && table.series.played.includes(leaving));
	}

	/**
	 * The ONE place a series result is recorded (`SeriesEnd`), run on every
	 * write (`#persist`), when a member leaves (`leave`, with `leaving`), when a
	 * room goes away (`#forget`, `over`) and when the room changes under it
	 * (`#interruptSeries`, `'interrupted'`). A decided series is recorded
	 * unless it is a Bo1 still open to a Rematch.
	 *
	 * A Bo3 can also end undecided, two ways, and both are recorded alike:
	 * - its players left it (`#leftSeries`, or the room going away; ruling 10);
	 * - the room changed so its next game would not continue it — the game
	 *   type, mode, mode options or pool (ruling 14: *"if mid-Bo3 was
	 *   interrupted, the match should be considered complete"*).
	 * Either way one finished game is a Bo1 of that game, and two (1-1) are
	 * still the Bo3, drawn (ruling 14's *"if they walked away at 1-1 then it's
	 * still Bo3 but result is a draw"*). A game still in play is discarded
	 * (`recordGameResult` adds nothing to a settled series). Once recorded,
	 * `settled` (and `done`) keep it from being recorded, continued or
	 * converted again.
	 */
	#settleSeries(room: RoomRecord, table: TableRecord, over: boolean | 'interrupted', leaving: string | null = null): void {
		const { series } = table;
		if (series.settled || series.games.length === 0) return;
		const decided = series.phase === 'done';
		const ended = over !== false || this.#leftSeries(room, table, leaving);
		if (!ended && (!decided || this.#rematchable(room, table))) return;
		table.series = { ...series, phase: 'done', settled: true };
		const seat = (id: string | null) => (id === null ? null : { memberId: id, name: room.members.find((m) => m.id === id)?.name ?? '' });
		const bestOf = decided || series.games.length > 1 ? series.length : 1;
		const end: SeriesEnd = {
			roomId: room.id,
			tableId: table.id,
			mode: series.mode,
			bestOf,
			seats: [seat(series.played[0]), seat(series.played[1])],
			wins: [...series.wins],
			games: series.games.map((g) => ({ matchId: g.matchId, winner: g.winner })),
			winner: seriesWinner({ length: bestOf, wins: series.wins }),
		};
		const undecided = decided ? {} : { undecided: over === 'interrupted' ? 'interrupted' : 'left', recordedAs: bestOf };
		this.#log({ event: 'table-series-ended', roomId: room.id, tableId: table.id, bestOf: series.length, wins: series.wins, ...undecided });
		// A testing room's series never reaches the real match-stats store — not
		// even one a seeded tournament actually "played" (`recordGameResult`
		// calls fed with fabricated matchIds to stand up round 1 before an admin
		// ever sits down). The ledger write above still happens: a testing room's
		// own history is real and worth logging, only the EXTERNAL report is
		// skipped. Without this, a seed identity's later `leave()` (freeing its
		// seat for a real admin — `room/testing-rooms.ts`'s tournament rooms)
		// re-settles a decided-but-unsettled round here and would otherwise write
		// that fabricated series into production stats.
		if (!room.testing) {
			try {
				this.#onSeriesEnd(end);
			} catch (err) {
				// A broken subscriber must not undo the write that ended the series.
				this.#log({ event: 'series-end-listener-failed', roomId: room.id, error: (err as Error).message });
			}
		}
	}

	/**
	 * The room is about to change so that no table's next game continues its
	 * series (`setGameType`, `setMode`, `setFormat`): each series ends here
	 * (`#settleSeries`), and each table starts over with a fresh one, so
	 * nothing is left to continue or rematch. `inPlay` has already refused the
	 * change while a game is being played.
	 */
	#interruptSeries(room: RoomRecord, unseat: boolean): void {
		for (const table of room.tables) {
			this.#settleSeries(room, table, 'interrupted');
			table.series = newSeries(room, unseat ? [null, null] : seatOrder(table), 'seating');
		}
		dropHolds(room, unseat);
	}

	addTable(roomId: string, callerId: string): AddTableResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (room.leader !== callerId) return { ok: false, reason: 'not-leader' };
		const table: TableRecord = {
			id: mintTableId(room.tables.map((t) => t.id)),
			seats: [null, null],
			ready: [false, false],
			matchId: null,
			series: newSeries(room, [null, null], 'seating'),
		};
		room.tables = [...room.tables, table];
		this.#persist(room);
		this.#log({ event: 'table-added', roomId, tableId: table.id });
		return { ok: true, room: this.#view(room), table: tableView(table, room.members, room) };
	}

	removeTable(roomId: string, callerId: string, tableId: string): RemoveTableResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (room.leader !== callerId) return { ok: false, reason: 'not-leader' };
		if (room.tables[0]?.id === tableId) return { ok: false, reason: 'first-table' };
		const index = room.tables.findIndex((t) => t.id === tableId);
		if (index === -1) return { ok: false, reason: 'no-such-table' };
		const table = room.tables[index]!;
		const empty = table.seats.every((s) => s === null);
		const idle = table.matchId === null && (table.series.phase === 'seating' || table.series.phase === 'done');
		if (!empty || !idle) return { ok: false, reason: 'not-idle' };
		room.tables = room.tables.filter((_, i) => i !== index);
		this.#persist(room);
		this.#log({ event: 'table-removed', roomId, tableId });
		return { ok: true, room: this.#view(room) };
	}

	leave(roomId: string, memberId: string): LeaveResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (!isRoomMember(room, memberId)) return { ok: false, reason: 'not-member' };
		// An entrant who leaves mid-tournament has dropped out. Not a testing room's seed, which stands in
		// for an entrant through round 1 and leaves so a real admin can take its seat (`testing-rooms.ts`).
		const pod = room.pod;
		let forfeited: { tableId: string; matchIds: string[] } | undefined;
		if (pod !== null && pod.round <= pod.rounds && pod.humans.includes(memberId) && !(pod.dropped ?? []).includes(memberId) && room.testing !== true) {
			const { tableId, matchIds } = this.#dropEntrant(room, pod, memberId);
			if (tableId !== null) forfeited = { tableId, matchIds };
			this.#log({ event: 'pod-entrant-left', roomId, memberId, tableId, matchIds });
		}
		for (const table of room.tables) {
			this.#settleSeries(room, table, false, memberId);
			leaveSeat(table, memberId);
		}
		// R16: leadership (whoever remains joined earliest) passes on here if `memberId` held it.
		removeRoomMember(room, memberId);
		// A split drafter leaving takes their Ready with them: the split no longer stands, and the seats it fixed are free again.
		if (room.podSplit?.pods.some((p) => p.includes(memberId)) === true) room.podSplit = null;
		this.#persist(room);
		this.#log({ event: 'room-left', roomId, members: room.members.length, newLeader: room.leader });
		return { ok: true, room: this.#view(room), ...(forfeited === undefined ? {} : { forfeited }) };
	}

	create(caller: Caller, input: CreateRoomInput): CreateResult {
		if (!isDurableParticipantId(caller.id)) return { ok: false, reason: 'not-durable' };
		let id = mintRoomId();
		while (this.#rooms.has(id)) id = mintRoomId();
		return { ok: true, room: this.#insert(id, caller, input) };
	}

	bindWatchparty(caller: Caller, watchpartyRoom: string): JoinResult {
		if (!isDurableParticipantId(caller.id)) return { ok: false, reason: 'not-durable' };
		const id = watchpartyRoomId(watchpartyRoom);
		if (this.#rooms.has(id)) return this.join(id, caller);
		return { ok: true, room: this.#insert(id, caller, WATCHPARTY_ROOM), alreadyMember: false };
	}

	#insert(id: string, caller: Caller, input: CreateRoomInput): RoomView {
		const now = Math.max(this.#now(), this.#lastCreatedAt + 1);
		this.#lastCreatedAt = now;
		const ledger = createMembershipLedger();
		addMember(ledger, caller.id, now);
		const room: RoomRecord = {
			id,
			name: input.name,
			creator: caller.id,
			leader: caller.id,
			gameType: input.gameType,
			// A random era (`randomFormat`) unless the lobby was opened on a fixed one.
			// There is no field for it in `CreateRoomInput` on purpose: a room is
			// created on the server's pick and the leader moves it from there, so one
			// setting has one mutator.
			format: this.#newRoomFormat(),
			settings: { ...DEFAULT_ROOM_SETTINGS },
			mode: input.mode?.mode ?? null,
			modeOptions: input.mode === undefined ? null : { ...input.mode.modeOptions },
			clientMode: input.clientMode,
			tables: [
				{
					id: mintTableId([]),
					seats: [null, null],
					ready: [false, false],
					matchId: null,
					series: newSeries({ gameType: input.gameType, mode: input.mode?.mode ?? null }, [null, null], 'seating'),
				},
			],
			matches: [],
			draftStartedAt: null,
			plan: DEFAULT_PLAN,
			planVerdict: null,
			podSeats: new Array<string | null>(initialPodSize(input.gameType)).fill(null),
			podAi: new Array<string | null>(initialPodSize(input.gameType)).fill(null),
			podDrafts: null,
			podSplit: null,
			pod: null,
			podPlaying: [],
			lockedDecks: {},
			gauntlets: {},
			testing: input.testing === true,
			...(input.scenario === undefined ? {} : { scenario: input.scenario }),
			...(input.scheduledFor === undefined ? {} : { scheduledFor: input.scheduledFor }),
			...(input.historical === true
				? {
						historical: true,
						// The event's answers, not a leader's: format set at birth because the
						// room is born locked against changing it, mode always constructed Classic
						// (a historical replay IS a constructed tournament), settings the event's
						// shape (tournament on, decks locked) unless the caller named their own.
						format: (input.historicalFormat ?? this.#newRoomFormat()) as FormatId,
						mode: 'classic',
						modeOptions: {},
						settings: input.historicalSettings ?? {
							...DEFAULT_ROOM_SETTINGS,
							tournament: true,
							tournamentDecks: 'locked',
						},
						...(input.historicalStructure === undefined ? {} : { historicalStructure: { ...input.historicalStructure } }),
					}
				: {}),
			...(input.aiDeckAssignments === undefined ? {} : { aiDeckAssignments: { ...input.aiDeckAssignments } }),
			...(input.historical === true && input.seatDecks !== undefined ? { seatDecks: { ...input.seatDecks } } : {}),
			createdAt: now,
			updatedAt: now,
			members: [newMember(caller, now)],
			ledger,
		};
		if (room.historical === true && input.historicalField !== undefined) seatHistoricalField(room, input.historicalField);
		this.#rooms.set(id, room);
		// A `runtime: 'relay'` room IS its own match — there is no separate "start" a
		// non-Magic room's UI ever presses (`rooms/BundleSlot.tsx`'s own doc) — so its `RelayMatch`
		// is registered the moment the room exists, under the room's own id, from its game type's
		// own seat count. `#relayRoomOpened` is `onRelayRoomOpened`'s hook, wired by
		// `plugins/relay.ts` (see that method's own doc for why this file calls a hook rather than
		// importing `runtimes/relay-match.ts` directly).
		this.#openRelayMatch(id, room.gameType);
		this.#autoSeat(room, caller.id);
		if (input.password !== undefined && input.password !== '') {
			this.#secrets.set(id, makeSecret(input.password));
		}
		this.#persist(room);
		this.#log({
			event: 'room-created',
			roomId: id,
			gameType: room.gameType,
			format: room.format,
			mode: room.mode,
			clientMode: room.clientMode,
			locked: this.#secrets.has(id),
		});
		this.#ensurePlanChecked(room);
		return this.#view(room);
	}

	join(roomId: string, caller: Caller, password?: string): JoinResult {
		if (!isDurableParticipantId(caller.id)) return { ok: false, reason: 'not-durable' };
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-match' };
		if (isRoomMember(room, caller.id)) {
			return { ok: true, room: this.#view(room), alreadyMember: true };
		}
		if (!passwordAdmits(this.#secrets.get(roomId), password)) {
			return { ok: false, reason: 'no-match' };
		}
		const now = this.#now();
		// An empty ledger's first member becomes its leader (an emptied room's new arrival leads it).
		addRoomMember(room, newMember(caller, now), now);
		this.#autoSeat(room, caller.id);
		this.#persist(room);
		this.#log({ event: 'room-joined', roomId, members: room.members.length });
		return { ok: true, room: this.#view(room), alreadyMember: false };
	}

	rename(caller: Pick<Caller, 'id' | 'name'>): void {
		for (const room of this.#rooms.values()) {
			const member = room.members.find((m) => m.id === caller.id);
			if (member === undefined || member.name === caller.name) continue;
			member.name = caller.name;
			this.#persist(room);
		}
	}

	setReady(roomId: string, memberId: string, ready: boolean): boolean {
		const room = this.#rooms.get(roomId);
		const member = room?.members.find((m) => m.id === memberId);
		if (room === undefined || member === undefined) return false;
		// Once the leader has split the room, every position is locked (the operator, 2026-10-31: *"once
		// everyone is ready and the pods are created, noone can unready anymore"*): Ready stays on.
		if (!ready && room.gameType === 'draft' && heldSplit(room) !== null) return true;
		setMemberReady(room, memberId, ready);
		// In a pod's lobby, Ready is "I am playing": a member who has not sat takes
		// the first open seat. A full pod leaves them watching, ready or not — the
		// deal never waits on a member who holds no seat.
		if (ready && room.gameType === 'draft' && room.draftStartedAt === null && !room.podSeats.includes(memberId) && this.#seatsShut(room) === null) {
			const open = room.podSeats.indexOf(null);
			if (open !== -1) room.podSeats = room.podSeats.map((id, i) => (i === open ? memberId : id));
		}
		this.#persist(room);
		this.#log({ event: 'room-ready', roomId, ready });
		// Ruling 7: a tournament's Ready is also its own Lock seats, the moment
		// the field is valid (`#maybeLockTournament`'s own doc).
		this.#maybeLockTournament(room);
		return true;
	}

	setAvatar(roomId: string, memberId: string, avatarId: string | null): boolean {
		const room = this.#rooms.get(roomId);
		const member = room?.members.find((m) => m.id === memberId);
		if (room === undefined || member === undefined) return false;
		const next = avatarIdOf(avatarId);
		// Idempotent, and it does not WRITE when nothing changed. A member's account
		// is written onto the room on every arrival and every change to the room
		// (`people.ts`'s `attachPeople`), which for a room somebody leaves open all
		// evening would otherwise be a snapshot write per change for a value that
		// never moved. `true` either way: the caller asked for a state and the room is in it.
		if (next === member.avatarId) return true;
		if (next === undefined) delete member.avatarId;
		else member.avatarId = next;
		this.#persist(room);
		this.#announceAvatar(roomId, member.id, member.avatarId ?? null);
		return true;
	}

	usersOf(roomId: string): { memberId: string; userId: string }[] {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return [];
		return room.members.flatMap((m) => (m.userId === null ? [] : [{ memberId: m.id, userId: m.userId }]));
	}

	setLook(roomId: string, memberId: string, look: Look | undefined): boolean {
		const room = this.#rooms.get(roomId);
		const member = room?.members.find((m) => m.id === memberId);
		if (room === undefined || member === undefined) return false;
		if (sameLook(member.look, look)) return true;
		if (look === undefined) delete member.look;
		else member.look = look;
		this.#log({ event: 'room-look', roomId, picture: look?.picture !== undefined, worn: Object.keys(look?.cosmetics ?? {}).length });
		this.#announceAvatar(roomId, memberId, member.avatarId ?? null);
		this.#changed(roomId);
		return true;
	}

	#announceAvatar(roomId: string, memberId: string, avatarId: string | null): void {
		// The id itself, not the member's: which character somebody picked is not
		// a secret, and a log line that could not name it could not be read.
		this.#log({ event: 'room-avatar', roomId, avatarId });
		for (const listener of [...this.#avatarListeners]) {
			try {
				listener({ roomId, memberId, avatarId });
			} catch (err) {
				// A broken subscriber must not undo a change that is already stored.
				this.#log({ event: 'room-avatar-listener-failed', roomId, error: (err as Error).message });
			}
		}
	}

	onAvatarChange(listener: AvatarChangeListener): () => void {
		this.#avatarListeners.add(listener);
		return () => {
			this.#avatarListeners.delete(listener);
		};
	}

	/**
	 * A draft room's deal, OR a tournament's "Lock seats" — the same route,
	 * reusing the draft pod's own start (`docs/planning/tournament-mode-plan.md`'s
	 * Design: *"Lock seats (the leader; reuse or extend the draft pod's start
	 * route)"*).
	 */
	startDraft(roomId: string, callerId: string): StartDraftResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (!room.members.some((m) => m.id === callerId)) return { ok: false, reason: 'not-member' };
		// Idempotent, and checked BEFORE readiness: the two browsers both ask, and
		// the second one arrives after the first member's flags may already have
		// been cleared by a leave. A room that has started has started.
		if (room.draftStartedAt !== null) return { ok: true, room: this.#view(room) };
		if (this.#seatsShut(room) !== null) return { ok: false, reason: 'not-open' };
		if (isTournamentRoom(room)) return this.#lockTournament(room);
		if (room.gameType !== 'draft') return { ok: false, reason: 'not-draft' };
		const gate = dealGate(room);
		if (gate !== null) return { ok: false, reason: gate };
		const seated = seatedHumans(room);
		// More than one pod's drafters: the draft deals only from the leader's split, when the leader confirms it.
		const split = heldSplit(room);
		if (seated.length > POD_SEATS && split === null) return { ok: false, reason: 'not-split' };
		if (split !== null && callerId !== room.leader) return { ok: false, reason: 'not-leader' };
		room.draftStartedAt = this.#now();
		if (split !== null) room.podDrafts = split.pods.map((p) => [...p]);
		else if (room.podSeats.length > POD_SEATS) room.podDrafts = [seated];
		room.podSplit = null;
		this.#persist(room);
		this.#log({ event: 'room-draft-started', roomId, members: room.members.length, seated: seated.length, pods: room.podDrafts?.map((p) => p.length) ?? [seated.length] });
		return { ok: true, room: this.#view(room) };
	}

	splitPod(roomId: string, callerId: string): SplitPodResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (!room.members.some((m) => m.id === callerId)) return { ok: false, reason: 'not-member' };
		if (room.gameType !== 'draft' || isTournamentRoom(room) || room.draftStartedAt !== null) return { ok: false, reason: 'not-draft' };
		if (room.leader !== callerId) return { ok: false, reason: 'not-leader' };
		const seated = seatedHumans(room);
		if (seated.length <= POD_SEATS) return { ok: false, reason: 'one-pod' };
		const gate = dealGate(room);
		if (gate !== null) return { ok: false, reason: gate };
		if (heldSplit(room) === null) {
			const seed = randomBytes(8).toString('hex');
			room.podSplit = { seed, pods: splitIntoPods(seated, seed) };
			this.#persist(room);
			this.#log({ event: 'room-pods-split', roomId, seed, pods: room.podSplit.pods.map((p) => p.length) });
		}
		return { ok: true, room: this.#view(room) };
	}

	/**
	 * The operator, 2026-10-22 (ruling 7): *"why is there a 'lock seats'
	 * button? that seems pointless the seats lock when all players are ready
	 * and the games start."* The lock fires BY ITSELF the instant the field
	 * is valid — mirrored from a draft pod's own last-Play-press deal
	 * (`playPod`'s own `#dealPodRounds` call, the one other place a pod's
	 * start is a side effect of readiness rather than an explicit press), so
	 * called from every place a tournament's entrants or their readiness can
	 * change: `setReady`, `sitPod`, `standPod`, `aiPod`. `#lockTournament`
	 * itself is UNCHANGED and still the one locking routine — its own
	 * `not-ready` refusal, discarded here, is exactly the right answer when
	 * the field is not valid yet; `draftStartedAt !== null` makes a second
	 * call once locked a no-op, so calling this from several places is safe.
	 */
	#maybeLockTournament(room: RoomRecord): void {
		if (!isTournamentRoom(room) || room.draftStartedAt !== null || this.#seatsShut(room) !== null) return;
		this.#lockTournament(room);
	}

	/**
	 * Lock a tournament's seats and deal round 1 — called the instant the
	 * field is valid (`#maybeLockTournament`'s own doc; ruling 7). ≥ 2
	 * entrants, at least one human (the operator, 2026-10-22: reversing the
	 * plan's "no AI seats", but *"an all-AI field makes no sense"*), each
	 * HUMAN ready per the mode (Classic: a legal deck already held —
	 * `GameHooks.hasLegalSeatDeck`; Gauntlet/All Random: the room's own
	 * `ready` flag). An AI entrant is always ready and never checked.
	 *
	 * `tournamentDecks === 'locked'` snapshots every entrant's CURRENT deck
	 * here for Classic/All Random (`GameHooks.currentTournamentDeck`); a
	 * Gauntlet has no locked decks (`tournamentDecksOf`).
	 *
	 * The field is fixed from here: `sitPod`/`standPod`/`aiPod`/`closePod`
	 * all refuse once `draftStartedAt !== null`, same as a draft pod's does.
	 */
	#lockTournament(room: RoomRecord): StartDraftResult {
		const entrants = podEntrants(room);
		if (entrants.length < POD_MIN_OPEN || entrants.every(isAiEntrant)) return { ok: false, reason: 'not-ready' };
		// A historical structure names a bracket the seated field must be able to
		// play; a cut larger than the field, or not a power of two, is a seed
		// fault, and the lock is the last moment it can be refused cleanly.
		if (room.historicalStructure !== undefined && !structureOk(room.historicalStructure, entrants.length)) {
			this.#log({ event: 'historical-structure-refused', roomId: room.id, structure: room.historicalStructure, field: entrants.length });
			return { ok: false, reason: 'not-ready' };
		}
		// A Challenge's seat comes with its real player's list, so its human is ready by their Ready alone.
		const pressedReady = (id: string): boolean => isMemberReady(room, id);
		const humanReady = (id: string): boolean => (room.mode === 'classic' && room.seatDecks === undefined ? this.#hooksFor(room.gameType).hasLegalSeatDeck(room.id, id) : pressedReady(id));
		if (entrants.some((id) => !isAiEntrant(id) && !humanReady(id))) return { ok: false, reason: 'not-ready' };
		if (room.seatDecks !== undefined) {
			// Whoever sits in a Challenge's open seat plays that seat's list: dealt by the lock like an AI's.
			const dealt = { ...room.aiDeckAssignments };
			for (const id of entrants) {
				const deck = isAiEntrant(id) ? undefined : room.seatDecks[String(room.podSeats.indexOf(id))];
				if (deck !== undefined) dealt[id] = deck;
			}
			room.aiDeckAssignments = dealt;
		}
		if (tournamentDecksOf(room) === 'locked') {
			// `currentTournamentDeck` may itself re-enter `rooms.get()` (its real
			// `routes.ts` implementation reads the room to find a pool/format).
			// Safe here: `draftStartedAt` is still null, so any such read answers
			// `lobby`, same as it would before this function was ever called.
			const lockedDecks = { ...room.lockedDecks };
			for (const id of entrants) lockedDecks[id] = this.#hooksFor(room.gameType).currentTournamentDeck(room.id, id);
			room.lockedDecks = lockedDecks;
		}
		// A tournament room has no 1v1 table once it locks (a real run,
		// 2026-10-22: the leader had sat at the room's own default table
		// BEFORE turning Tournament on, and nothing ever unseated it — the
		// screen kept drawing that stale, un-ready table forever after,
		// because `tables[0]` is exactly what it reads for "my table"). Every
		// table this room holds right now PREDATES the pod — `#dealPodRounds`,
		// below, is what makes its real ones — so unseating them all here,
		// before that call, retires the lot: `#interruptSeries` ends
		// whatever series they were mid-via `#settleSeries`, and clears every
		// seat, ready flag and deck hold (`dropHolds`) the same way a mode or
		// format change already does.
		this.#interruptSeries(room, true);
		// `draftStartedAt` and `pod` change together, as ONE atomic mutation —
		// gather every deck above, BEFORE this point, then mutate, then read.
		// `#dealPodRounds`, below, pairs the round and makes its tables
		// (`#newPodTable`'s `GameHooks.seatTournamentDeck` re-enters
		// `rooms.get()` per table, same as `currentTournamentDeck` above can);
		// a read that lands inside THAT window must see a pod that genuinely
		// is in `rounds` — not `draftStartedAt` set with no pod to show for it
		// (`podPhaseOf`'s own doc: that is the exact crash a real run hit). The
		// skeleton this sets is overwritten with the real pairings before this
		// function returns.
		room.draftStartedAt = this.#now();
		room.pod = {
			humans: entrants,
			round: 1,
			rounds: room.historicalStructure !== undefined ? roundsOf(room.historicalStructure) : roundsFor(entrants.length),
			results: [],
			pairings: [],
			bye: null,
		};
		this.#dealPodRounds(room, entrants);
		this.#persist(room);
		this.#log({ event: 'tournament-locked', roomId: room.id, entrants: entrants.length, humans: entrants.filter((id) => !isAiEntrant(id)).length });
		return { ok: true, room: this.#view(room) };
	}

	setGameType(roomId: string, callerId: string, gameType: GameType): SetGameTypeResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (room.leader !== callerId) return { ok: false, reason: 'not-leader' };
		if (room.gameType === gameType) return { ok: true, room: this.#view(room) };
		// The type is the room's shape, the mode a part of it: what freezes the mode freezes the type
		// (`roomLocks`). Once the draft is dealt, switching the game under it would leave a live pod in
		// a room that says it is playing constructed, and nothing would ever close the pod.
		const locked = roomLocks(room).gameType;
		if (locked !== null) return { ok: false, reason: locked };
		const players = playersOf(room);
		room.gameType = gameType;
		room.mode = null;
		room.modeOptions = null;
		room.gauntlets = {};
		this.#interruptSeries(room, true);
		this.#carryPlayers(room, players);
		// Readiness is readiness for a particular game: a member who readied for
		// a draft has not agreed to a constructed match. Cleared for everyone,
		// including the leader making the change.
		clearReady(room.ledger);
		this.#persist(room);
		this.#log({ event: 'room-game-type', roomId, gameType });
		return { ok: true, room: this.#view(room) };
	}

	setFormat(roomId: string, callerId: string, format: FormatId): SetFormatResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (room.leader !== callerId) return { ok: false, reason: 'not-leader' };
		// Setting the pool a room is already on changes nothing and clears nothing:
		// a leader clicking the option that is already selected must not un-ready
		// the table under everybody.
		if (room.format === format) return { ok: true, room: this.#view(room) };
		const locked = roomLocks(room).format;
		if (locked !== null) return { ok: false, reason: locked };
		room.format = format;
		this.#interruptSeries(room, false);
		this.#persist(room);
		this.#log({ event: 'room-format', roomId, format });
		return { ok: true, room: this.#view(room) };
	}

	setMode(roomId: string, callerId: string, mode: RoomMode): SetModeResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (room.leader !== callerId) return { ok: false, reason: 'not-leader' };
		if (room.gameType !== 'constructed-1v1') return { ok: false, reason: 'not-constructed' };
		if (room.mode === mode.mode && room.modeOptions !== null && sameOptions(room.modeOptions, mode.modeOptions)) {
			return { ok: true, room: this.#view(room) };
		}
		const locked = roomLocks(room).mode;
		if (locked !== null) return { ok: false, reason: locked };
		room.mode = mode.mode;
		room.modeOptions = { ...mode.modeOptions };
		room.gauntlets = {};
		// A deck held for one mode was chosen for that mode's table, exactly as a
		// deck held in one pool was checked in that pool.
		this.#interruptSeries(room, false);
		this.#persist(room);
		this.#log({ event: 'room-mode', roomId, mode: mode.mode, modeOptions: mode.modeOptions });
		return { ok: true, room: this.#view(room) };
	}

	setSettings(roomId: string, callerId: string, settings: Partial<RoomSettings>): SetSettingsResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (room.leader !== callerId) return { ok: false, reason: 'not-leader' };
		const next = { ...room.settings, ...settings };
		const changed = SETTING_KEYS.filter((k) => next[k] !== room.settings[k]);
		if (changed.length === 0) return { ok: true, room: this.#view(room) };
		const locks = roomLocks(room);
		// The event's lock holds whenever the rules' does (a game in play froze both), so it answers for a change to either.
		const locked = changed.some((k) => EVENT_SETTING_KEYS.includes(k)) ? locks.event : locks.rules;
		if (locked !== null) return { ok: false, reason: locked };
		const players = playersOf(room);
		const podBefore = usesPod(room);
		room.settings = next;
		if (usesPod(room) !== podBefore) this.#carryPlayers(room, players);
		this.#persist(room);
		this.#log({ event: 'room-settings', roomId, settings: next });
		return { ok: true, room: this.#view(room) };
	}

	sweep(idleMs?: number): string[] {
		const dropped: string[] = [];
		const now = this.#now();
		for (const [id, room] of this.#rooms) {
			if (!isSweepableRoom(room, MAGIC_ROOM_BUSY, now, idleMs)) continue;
			const idle = idleMs ?? MAGIC_ROOM_BUSY.defaultIdleMs(room);
			this.#archive(room);
			this.#forget(id);
			dropped.push(id);
			this.#log({ event: 'room-forgotten', roomId: id, idleMs: idle });
		}
		return dropped;
	}

	async removed(): Promise<void> {
		await Promise.all([...this.#removing]);
	}

	anonymise(ids: ReadonlySet<string>, to: string): number {
		let changed = 0;
		for (const room of this.#rooms.values()) {
			// A Gauntlet keeps a leaver's name in memory (`gauntletNamed`); a saved one never has it.
			for (const [tableId, g] of Object.entries(room.gauntlets)) {
				if (g.players?.some((p) => p.memberId !== null && ids.has(p.memberId)) === true) room.gauntlets[tableId] = gauntletWithoutNames(g);
			}
			if (replaceIds(room, ids, to) === 0) continue;
			changed++;
			this.#persist(room);
		}
		return changed;
	}

	reschedule(roomId: string, at: number): boolean {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return false;
		room.scheduledFor = at;
		this.#persist(room);
		return true;
	}

	close(roomId: string, callerId: string): CloseRoomResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		// Any admin in a testing room may close (reset) it, leader or not: the
		// HTTP layer has already checked admin and membership.
		if (room.leader !== callerId && !room.testing) return { ok: false, reason: 'not-leader' };
		this.#archive(room);
		const matches = room.tables.flatMap((t) => (t.matchId === null ? [] : [t.matchId]));
		this.#forget(roomId);
		this.#log({ event: 'room-closed', roomId, matches: matches.length });
		return { ok: true, matches };
	}

	/** Gone from the list the moment it leaves the map, and from disk best-effort. */
	#forget(id: string): void {
		const room = this.#rooms.get(id);
		if (room !== undefined) for (const table of room.tables) this.#settleSeries(room, table, true);
		this.#rooms.delete(id);
		for (const key of this.#seatTaken.keys()) if (key.startsWith(`${id}\u0000`)) this.#seatTaken.delete(key);
		this.#secrets.delete(id);
		this.#touchedAt.delete(id);
		// Logged, because a store that cannot delete must not resurrect the room on the next boot silently.
		const removing = this.#store.remove(id).catch((err: unknown) => {
			this.#log({ event: 'room-forget-failed', roomId: id, err: String(err) });
		});
		this.#removing.add(removing);
		void removing.finally(() => this.#removing.delete(removing));
		this.#changed(id);
	}

	/** A pod that finished a match goes to the tournaments: finished, or ended early by a close or the sweep. Never a testing room's. */
	#archive(room: RoomRecord): void {
		const pod = room.pod;
		// A seeded testing room's "tournament" was never played (`#settleSeries` keeps its games out of the stats the same way).
		if (pod === null || room.testing || room.draftStartedAt === null || !pod.results.some((r) => r.playerB !== null)) return;
		// A draft pod's shared bot (`POD_AI`) is named once; a tournament
		// pod's own AI entrants (one per AI seat, `aiEntrantId`) are each
		// named from the character its seat was given (`room.podAi`, kept
		// through the pod's life — see the field's own doc).
		const ais = pod.humans.filter(isAiEntrant).map((id) => [id, entrantPersona(room, id, this.#hooksFor(room.gameType))] as const);
		const aiNames = Object.fromEntries(ais.map(([id, p]) => [id, p.name]));
		this.#onTournament({
			id: tournamentId(room),
			name: room.name,
			startedAt: room.draftStartedAt,
			endedAt: this.#now(),
			closed: pod.round <= pod.rounds,
			rounds: pod.rounds,
			// The AI entrants' names only: a person is kept by userId and named when shown (R12; #27).
			names: { [POD_AI]: roomAi(room).name, ...aiNames },
			// The people by userId, looked up when shown; the AI's characters are the room's own, and kept.
			users: Object.fromEntries(room.members.flatMap((m) => (m.userId === null ? [] : [[m.id, m.userId]]))),
			faces: { [POD_AI]: { avatarId: roomAi(room).avatarId }, ...Object.fromEntries(ais.map(([id, p]) => [id, { avatarId: p.avatarId }])) },
			standings: podStandings(room, pod.humans, pod.results),
			results: pod.results,
		});
	}

	/* ── the pod (wave 72 §P) ───────────────────────────────────────────── */

	useGameType(type: string, hooks: GameHooks): void {
		this.#hooksByType.set(type, hooks);
		for (const room of this.#rooms.values()) if (room.gameType === type && (room.pod?.botGames ?? []).length > 0) this.#playPairedBots(room);
	}

	useGameView(type: string, part: GameViewPart): void {
		this.#viewParts.set(type, part);
	}

	onRelayRoomOpened(hook: (roomId: string, seatCount: number, gameType: string) => void): void {
		this.#relayRoomOpened = hook;
		for (const [id, room] of this.#rooms) this.#openRelayMatch(id, room.gameType);
	}

	#openRelayMatch(id: string, gameType: string): void {
		const spec = gameTypeSpec(gameType);
		if (spec?.runtime !== 'relay') return;
		this.#relayRoomOpened(id, spec.table?.seats ?? spec.seats.max, gameType);
	}

	/**
	 * Once the draft registry has restored itself at boot: every room mid-draft
	 * whose draft did not come back goes back to its lobby, rather than
	 * advertising a pod nobody can join. Returns the rooms released. A
	 * constructed tournament also sets `draftStartedAt` but never has a draft,
	 * so it is never one of them — its pod is restored whole by itself.
	 */
	releaseLostDrafts(draftExists: (roomId: string) => boolean): string[] {
		const released: string[] = [];
		for (const room of this.#rooms.values()) {
			if (room.gameType !== 'draft' || room.draftStartedAt === null || draftExists(room.id)) continue;
			room.draftStartedAt = null;
			room.podDrafts = null;
			room.pod = null;
			room.podPlaying = [];
			this.#persist(room);
			released.push(room.id);
		}
		return released;
	}

	gauntlet(roomId: string, tableId?: string): GauntletState | null {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return null;
		const g = room.gauntlets[tableId ?? room.tables[0]!.id];
		return g === undefined ? null : gauntletNamed(g, room.members);
	}

	setGauntlet(roomId: string, gauntlet: GauntletState | null, tableId?: string): boolean {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return false;
		const table = tableId ?? room.tables[0]!.id;
		const next = { ...room.gauntlets };
		if (gauntlet === null) delete next[table];
		else next[table] = gauntlet;
		room.gauntlets = next;
		this.#persist(room);
		return true;
	}

	tournamentPairingOf(roomId: string, tableId: string): TournamentPairing | null {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return null;
		const pairing = room.pod?.pairings.find((p) => p.tableId === tableId);
		if (pairing === undefined) return null;
		const [a, b] = pairing.players;
		// The AI's slot (if either is one) always LAST, matching the seat
		// convention `http/gauntlet.ts`'s vs-AI ready already uses (the human is
		// Gauntlet seat 0, the synthesized AI player seat 1) — never both: an
		// AI-vs-AI pairing plays a bot game without a table (`#pairRound`'s own doc).
		const entrants: [string, string] = isAiEntrant(a) ? [b, a] : [a, b];
		return isAiEntrant(entrants[1]) ? { entrants, ai: entrantPersona(room, entrants[1], this.#hooksFor(room.gameType)) } : { entrants };
	}

	podDraft(draftId: string): PodDeal | null {
		const { roomId, pod } = podOfDraftId(draftId);
		const room = this.#rooms.get(roomId);
		if (room === undefined) return null;
		if (room.podDrafts !== null) return this.#podDeal(room, pod);
		if (pod !== 0) return null;
		const table = podTable(room);
		return {
			seats: table.length,
			humans: table.flatMap((place, seat) => {
				if (place.kind !== 'human') return [];
				const member = room.members.find((m) => m.id === place.id);
				return member === undefined ? [] : [{ participantId: place.id, displayName: member.name, seat, ...(member.avatarId === undefined ? {} : { avatarId: member.avatarId }) }];
			}),
			bots: table.flatMap((place, seat) => (place.kind === 'ai' ? [place.persona === null ? { name: `Bot ${seat}` } : { name: place.persona.name, avatarId: place.persona.avatarId }] : [])),
			plan: room.plan,
		};
	}

	/**
	 * Pod `pod` of a room that drafts as several (`RoomRecord.podDrafts`): its drafters in the first seats, the AI
	 * in the rest of a full table of 8 (as a one-pod room's open seats are), and every drafter's own draft id so
	 * a seam that knows only the room id finds the right pod (`DraftRooms.findFor`).
	 */
	#podDeal(room: RoomRecord, pod: number): PodDeal | null {
		const pods = room.podDrafts ?? [];
		const drafters = pods[pod];
		if (drafters === undefined) return null;
		const humans = drafters.flatMap((id, seat) => {
			const member = room.members.find((m) => m.id === id);
			return member === undefined ? [] : [{ participantId: id, displayName: member.name, seat, ...(member.avatarId === undefined ? {} : { avatarId: member.avatarId }) }];
		});
		const worn = humans.map((h) => h.avatarId);
		const faces: string[] = [];
		for (let seat = drafters.length; seat < POD_SEATS; seat++) faces.push(drawAvatar(`${room.id}:${pod}:${seat}`, [...worn, ...faces], faces.slice(-1)));
		const bots = faces.map((face) => {
			const persona = personaOf(face);
			return { name: persona.name, avatarId: persona.avatarId };
		});
		const podOf = Object.fromEntries(pods.flatMap((ids, k) => ids.map((id) => [id, podDraftId(room.id, k)])));
		return { seats: POD_SEATS, humans, bots, plan: room.plan, podOf };
	}

	setPodPlan(roomId: string, memberId: string, plan: DraftPlan, verdict: PoolVerdict): SetPodPlanResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (!room.members.some((m) => m.id === memberId)) return { ok: false, reason: 'not-member' };
		// A draft plan only — a tournament pod drafts no pool at all (`PodView.plan`'s own doc).
		if (room.gameType !== 'draft') return { ok: false, reason: 'not-draft' };
		if (room.draftStartedAt !== null) return { ok: false, reason: 'not-lobby' };
		if (room.leader !== memberId) return { ok: false, reason: 'not-leader' };
		if (!verdict.ok) return { ok: false, reason: 'refused', verdict };
		room.plan = plan;
		room.planVerdict = verdict;
		this.#persist(room);
		this.#log({ event: 'pod-plan-set', roomId, memberId, planName: planDisplayName(plan, this.#hooksFor(room.gameType).roundNamesOf(plan)) });
		return { ok: true, room: this.#view(room) };
	}

	sitPod(roomId: string, memberId: string, seat?: number): SitPodResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (!room.members.some((m) => m.id === memberId)) return { ok: false, reason: 'not-member' };
		// `not-draft` also covers a constructed room with tournament off: `usesPod` is the one question for both.
		if (!usesPod(room)) return { ok: false, reason: 'not-draft' };
		if (seatsFixed(room)) return { ok: false, reason: 'not-lobby' };
		if (this.#seatsShut(room) !== null) return { ok: false, reason: 'not-open' };
		if (seat !== undefined && !seatInReach(room, seat)) return { ok: false, reason: 'bad-seat' };
		const already = room.podSeats.indexOf(memberId);
		let target = seat;
		if (target === undefined) {
			// Their own seat counts as open, as it always has: a sit with no seat never moves them past it.
			const open = room.podSeats.findIndex((id, i) => id === null || i === already);
			// No seat open: one past the last, growing the room by that seat.
			target = open === -1 ? room.podSeats.length : open;
			if (target >= podSeatCeiling(room)) return { ok: false, reason: 'pod-full' };
		} else if (target !== already && (room.podSeats[target] ?? null) !== null) {
			return { ok: false, reason: 'seat-taken' };
		}
		grownSeats(room, target);
		const seats = [...room.podSeats];
		if (already !== -1) seats[already] = null;
		seats[target] = memberId;
		room.podSeats = seats;
		trimmedSeats(room);
		this.#persist(room);
		this.#log({ event: 'pod-sit', roomId, memberId, seat: target });
		// Ruling 7: sitting (the 2nd entrant, say) can itself complete the field.
		this.#maybeLockTournament(room);
		return { ok: true, room: this.#view(room) };
	}

	standPod(roomId: string, memberId: string): StandPodResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (!room.members.some((m) => m.id === memberId)) return { ok: false, reason: 'not-member' };
		// `not-draft` also covers a constructed room with tournament off: `usesPod` is the one question for both.
		if (!usesPod(room)) return { ok: false, reason: 'not-draft' };
		if (seatsFixed(room)) return { ok: false, reason: 'not-lobby' };
		const index = room.podSeats.indexOf(memberId);
		if (index === -1) return { ok: true, room: this.#view(room) };
		const seats = [...room.podSeats];
		seats[index] = null;
		room.podSeats = seats;
		trimmedSeats(room);
		this.#persist(room);
		this.#log({ event: 'pod-stand', roomId, memberId });
		// Ruling 7: an un-ready human standing can leave an all-ready field behind.
		this.#maybeLockTournament(room);
		return { ok: true, room: this.#view(room) };
	}

	aiPod(roomId: string, memberId: string, seat: number, on: boolean): SitPodResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (!room.members.some((m) => m.id === memberId)) return { ok: false, reason: 'not-member' };
		// `not-draft` also covers a constructed room with tournament off: `usesPod` is the one question for both.
		if (!usesPod(room)) return { ok: false, reason: 'not-draft' };
		if (seatsFixed(room)) return { ok: false, reason: 'not-lobby' };
		if (room.historical === true) return { ok: false, reason: 'historical' };
		if (on && this.#seatsShut(room) !== null) return { ok: false, reason: 'not-open' };
		if (!seatInReach(room, seat) || (!on && seat >= room.podSeats.length)) return { ok: false, reason: 'bad-seat' };
		const now = room.podSeats[seat] ?? null;
		if (on ? now === POD_AI : now === null) return { ok: true, room: this.#view(room) };
		if (now !== (on ? null : POD_AI)) return { ok: false, reason: 'seat-taken' };
		const avatar = on ? freeAiAvatar(room, seat) : null;
		grownSeats(room, seat);
		const seats = [...room.podSeats];
		seats[seat] = on ? POD_AI : null;
		room.podSeats = seats;
		room.podAi = room.podAi.map((a, i) => (i === seat ? avatar : a));
		trimmedSeats(room);
		this.#persist(room);
		this.#log({ event: on ? 'pod-ai-sit' : 'pod-ai-stand', roomId, memberId, seat });
		// Ruling 7: an AI is always ready, so seating one can itself complete the field.
		this.#maybeLockTournament(room);
		return { ok: true, room: this.#view(room) };
	}

	closePod(roomId: string, memberId: string, seat: number, closed: boolean): ClosePodResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (!room.members.some((m) => m.id === memberId)) return { ok: false, reason: 'not-member' };
		if (room.leader !== memberId) return { ok: false, reason: 'not-leader' };
		// `not-draft` also covers a constructed room with tournament off: `usesPod` is the one question for both.
		if (!usesPod(room)) return { ok: false, reason: 'not-draft' };
		if (seatsFixed(room)) return { ok: false, reason: 'not-lobby' };
		if (room.historical === true) return { ok: false, reason: 'historical' };
		if (!seatInReach(room, seat) || seat >= room.podSeats.length) return { ok: false, reason: 'bad-seat' };
		const now = room.podSeats[seat] ?? null;
		if (closed ? now === POD_CLOSED : now === null) return { ok: true, room: this.#view(room) };
		if (now !== (closed ? null : POD_CLOSED)) return { ok: false, reason: 'seat-taken' };
		if (closed && podSize(room) <= POD_MIN_OPEN) return { ok: false, reason: 'too-few' };
		room.podSeats = room.podSeats.map((id, i) => (i === seat ? (closed ? POD_CLOSED : null) : id));
		trimmedSeats(room);
		this.#persist(room);
		this.#log({ event: closed ? 'pod-seat-closed' : 'pod-seat-opened', roomId, memberId, seat, size: podSize(room) });
		return { ok: true, room: this.#view(room) };
	}

	playPod(roomId: string, memberId: string): PlayPodResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		const phase = room.gameType === 'draft' ? podPhaseOf(room, this.#hooksFor(room.gameType)) : 'lobby';
		if (phase === 'rounds' || phase === 'done') return { ok: true, room: this.#view(room) };
		const humans = seatedHumans(room);
		if (phase !== 'building' || !humans.includes(memberId)) return { ok: false, reason: 'not-drafter' };
		if (!this.#hooksFor(room.gameType).built(memberDraftId(room, memberId), memberId)) return { ok: false, reason: 'not-built' };
		if (!room.podPlaying.includes(memberId)) room.podPlaying = [...room.podPlaying, memberId];
		this.#log({ event: 'pod-play', roomId, memberId });
		if (humans.every((id) => room.podPlaying.includes(id) && this.#hooksFor(room.gameType).built(memberDraftId(room, id), id))) this.#dealPodRounds(room, draftEntrants(room, humans));
		this.#persist(room);
		return { ok: true, room: this.#view(room) };
	}

	/**
	 * Round 1: a draft pod's, once every drafter is done building
	 * (`playPod`); a tournament pod's, at the lock (`#lockTournament`) —
	 * `entrants` is the one list either caller fixes `PodRecord.humans` to.
	 */
	#dealPodRounds(room: RoomRecord, entrants: string[]): void {
		const rounds = roundsFor(entrants.length);
		const { pairings, settled, bots, bye } = this.#pairRound(room, podPlayers(room, entrants), [], 1);
		const byeResult: MatchResult[] = bye === null ? [] : [{ round: 1, playerA: bye, playerB: null, gamesA: 2, gamesB: 0 }];
		room.pod = { humans: entrants, round: 1, rounds, results: [...byeResult, ...settled], pairings, botGames: bots.map((players) => ({ players })), bye };
		this.#log({ event: 'pod-rounds-started', roomId: room.id, rounds, tables: pairings.length, bye, settled: settled.length, botGames: bots.length });
		if (pairings.length === 0 && bots.length === 0) this.#advancePodRound(room, room.pod);
		else this.#playPairedBots(room);
	}
}

/**
 * Open the lobby over `dir`, restoring every room a previous process wrote.
 *
 * Async because the store's read path is (`list`/`load`/`quarantine`); every
 * operation on the returned lobby is synchronous. A record this build cannot
 * read is quarantined and logged by room id and reason — the reason names what
 * was wrong, never the bytes, since the bytes could include a password hash.
 */
export async function openLobby(opts: OpenLobbyOptions): Promise<Lobby> {
	const store = new FileRoomStore(opts.dir);
	const now = opts.now ?? Date.now;
	const log = opts.log ?? (() => {});
	const fixed = opts.defaultFormat;
	const random = opts.random ?? Math.random;
	const formats = opts.formats ?? [];
	const lobby = new FileLobby(
		store,
		now,
		log,
		fixed === undefined ? () => randomFormat(random, formats) : () => fixed,
		opts.onTournament ?? (() => {}),
		opts.onSeriesEnd ?? (() => {}),
		opts.checkPlan ?? null,
	);

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
			const decoded = decodeSnapshot(snapshot, roomCodec, {
				roomId,
				restoreId: `boot-${now()}`,
				restoredAt: now(),
			});
			const app = decoded.app;
			const game = app.game;
			// A constructed room a leader put on a pod before 2026-10-20, when a
			// room's format could still be `draft:<podId>`. It comes back on the
			// newest era with every deck hold and ready flag dropped — exactly what
			// a format change does (`setFormat`) — since nothing held there was ever
			// checked against a pool a constructed room can be on now.
			const offPod = app.gameType !== 'draft' && game.format !== null && game.format.startsWith(DRAFT_POOL_PREFIX);
			if (offPod) log({ event: 'room-format-off-pod', roomId, format: game.format });
			// A constructed room stored before modes existed was a Classic room.
			const restoredAsClassic = game.mode === undefined && app.gameType === 'constructed-1v1';
			if (restoredAsClassic) log({ event: 'room-mode-restored', roomId, mode: 'classic' });
			const members: MemberRecord[] = [];
			// Rebuilt, not persisted; `leaderId` is set explicitly below, from disk.
			const ledger = createMembershipLedger();
			for (const m of decoded.members) {
				// Nothing names or dresses a member on disk (R12): they are `UNNAMED` and wear
				// no character until their account is read again (`people.ts`, the boot's sweep).
				// Kept across the restart, unlike the draft itself: the room comes
				// back in its lobby phase with everybody still ready, which is one
				// click from starting again rather than four.
				const ready = !offPod && unboxReady(m.app);
				addMember(ledger, m.participantId, m.joinedAt);
				if (ready) ledgerSetReady(ledger, m.participantId, true);
				members.push({
					id: m.participantId,
					userId: m.accountId ?? null,
					name: UNNAMED,
					joinedAt: m.joinedAt,
					state: offPod ? undefined : unboxState(m.app),
				});
			}
			ledger.leaderId = app.leader;
			lobby.restore(
				{
					id: roomId,
					name: app.name,
					creator: app.creator,
					leader: app.leader,
					gameType: app.gameType,
					// **Restored, like the match and unlike the draft.** A room that came
					// back on a different pool from the one its players loaded their
					// decks against is exactly the bug this field exists to prevent:
					// the decks are restored too (the per-member blob), so the pool
					// they were checked in has to come back with them.
					format: (offPod ? null : game.format) ?? fixed ?? newestFormat(formats),
					settings: app.settings,
					...(restoredAsClassic
						? { mode: 'classic' as const, modeOptions: {} }
						: { mode: game.mode ?? null, modeOptions: game.modeOptions }),
					clientMode: game.clientMode,
					// **Restored, tables and all** — already migrated into the one-table
					// shape by `appCodec.deserialize` for a pre-wave-71 record. Each
					// table's `matchId`: a match's JVM outlives the process that started
					// it and play adopts it at boot, so the room is still playing it.
					// Whether it came back is play's registry's answer: once adoption is
					// done, `http/routes.ts`'s `releaseGoneMatches` lets go of every
					// match that did not — a room must never advertise "playing" a game
					// that died with the old process.
					tables: app.tables.map((t, i) => (t.ready === undefined ? seatsFromMembers(t, i === 0, members) : { ...t, ready: t.ready })),
					matches: app.matches,
					// **Restored, the draft with it.** `room/draftRooms.ts` writes every
					// pod to disk and restores them all at boot, so a deploy mid-pod
					// resumes it. `releaseLostDrafts`, called once the draft registry
					// exists, puts back in its lobby only a room whose draft did not
					// come back — `open` would deal a brand new one over the top.
					draftStartedAt: game.draftStartedAt,
					// Restored, same as any other lobby setting: the leader's pool
					// choice (and its last verdict) outlive a restart same as `format`.
					// `?? ` covers a record written before wave 73 §A, same as `podAi` below.
					plan: game.plan ?? DEFAULT_PLAN,
					planVerdict: game.planVerdict ?? null,
					// Restored, like `ready` and unlike the draft itself: who sat in the
					// pod lobby is a property of the ROOM, not of the in-memory draft, so
					// it survives a restart the room comes back from in its lobby phase.
					podSeats: game.podSeats,
					podAi: game.podAi ?? new Array<string | null>(POD_SEATS).fill(null),
					podDrafts: game.podDrafts ?? null,
					podSplit: game.podSplit ?? null,
					// Restored with `draftStartedAt`, and released with it.
					pod: game.pod,
					podPlaying: game.podPlaying ?? [],
					// Restored, like `podPlaying`: a tournament's locked deck(s) survive a restart with it.
					lockedDecks: game.lockedDecks ?? {},
					gauntlets: game.gauntlets ?? {},
					// Restored, like every other room-level flag: a restart never turns
					// a testing room into an ordinary one or back.
					testing: app.testing === true,
					...(game.scenario === undefined ? {} : { scenario: game.scenario }),
					...(app.scheduledFor === undefined ? {} : { scheduledFor: app.scheduledFor }),
					...(game.historical === true ? { historical: true } : {}),
					...(game.historicalStructure === undefined ? {} : { historicalStructure: { ...game.historicalStructure } }),
					...(game.aiDeckAssignments === undefined ? {} : { aiDeckAssignments: { ...game.aiDeckAssignments } }),
					...(game.seatDecks === undefined ? {} : { seatDecks: { ...game.seatDecks } }),
					createdAt: decoded.createdAt,
					// The raw snapshot's clock: when this room was last touched
					// by the process that wrote it. `decoded` does not carry it.
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
	log({ event: 'lobby-open', rooms: lobby.list().length, newRoomFormat: fixed ?? 'random' });
	return lobby;
}

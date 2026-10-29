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
 * on a second request, and room-store drops non-durable members from every
 * snapshot anyway. So `create`/`join` refuse an ephemeral caller (the HTTP layer
 * answers 403). Behind the edge every friend-tier caller carries a friend key,
 * so in production this never bites; it exists so the answer is a clear refusal
 * rather than a member who silently vanishes on the next restart.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
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
import {
	AVATAR_ID_MAX,
	ClientModeSchema,
	DEFAULT_CLIENT_MODE,
	DEFAULT_GAME_TYPE,
	DEFAULT_ROOM_SETTINGS,
	DRAFT_POOL_PREFIX,
	DraftPlanSchema,
	GameTypeSchema,
	isPodAi,
	newestStandardEra,
	POD_SEATS,
	PoolVerdictSchema,
	ROOM_ID_RE,
	RoomModeSchema,
	RoomSettingsSchema,
	SeriesPhaseSchema,
	type ClientMode,
	type ConstructedMode,
	type DraftPlan,
	type GameType,
	planDisplayName,
	type ModeOptions,
	type PoolSource,
	type PoolVerdict,
	type RoomMode,
	type RoomSettings,
	type RoomView as PublicRoomView,
	type Tournament,
	type PodMember,
	type PodPhase,
	type PodView,
	type RoomTable,
	type SeriesPhase,
} from '@hadoku/shared';
// `@hadoku/draft` depends on `@hadoku/shared`, never the reverse, so `pod.ts`
// (which `@hadoku/shared` holds) cannot import these — this file is the one
// place both sides meet (wave 72 §P).
import { botSeatAcross, pairRound, rankStandings, roundsFor, standings, type MatchResult, type PodPlayer, type RankedStandingsRow } from '@hadoku/draft';
import { DEFAULT_PLAN, type PodDeal } from './draftRooms.ts';
import { gauntletHoldsTable, isGauntletState, type GauntletState } from './gauntlet.ts';
import { roundNamesOf } from './plan.ts';
import { leaveSeat, readySeat, seatList, sitAt, type TableSeat, type TableSeats } from './seats.ts';
import { convertToBo3, newSeries, recordGame, seriesFormatOf, seriesWinner, statsModeOf, type SeriesGame, type SeriesRecord, type SeriesRoom } from './series.ts';

// A type only: the catalog itself is loaded once, at boot, by `index.ts`
// (`http/library.ts`'s `loadTablesLibrary`) and handed in as `formats`.
import type { TableFormat } from '../http/library.js';

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

/**
 * The characters a room hands out to a member who has not picked one, in the
 * order it hands them out: watchparty's `CHARACTER_ORDER`
 * (`hadoku-watchparty` `packages/shared/src/protocol.ts`), which its server
 * draws from on join (`apps/server/src/ws/join.ts`). Copied because that
 * package is private to their repo; `docs/requests/ROOMS_AVATAR_POOL.md` asks
 * for it to be published. A picked avatar is never checked against this list.
 */
export const AVATAR_POOL = ['sage', 'herald', 'cleric', 'knight', 'mage', 'brawler', 'wanderer', 'rogue'] as const;

/**
 * The first character in the pool no current member wears — watchparty's
 * `getAvailableSprites(room)[0]` (`@wolffm/rooms-server`'s `availableAvatars`,
 * which reads a socket room's claim set; ours is the members themselves).
 * Undefined when all are taken: that member goes without, as in watchparty.
 */
function freeAvatar(members: readonly MemberRecord[]): string | undefined {
	const worn = new Set(members.map((m) => m.avatarId));
	return AVATAR_POOL.find((a) => !worn.has(a));
}

/** A new member, wearing the room's next free character. */
function newMember(room: readonly MemberRecord[], caller: Caller, joinedAt: number): MemberRecord {
	const avatarId = freeAvatar(room);
	return {
		id: caller.id,
		name: caller.name,
		joinedAt,
		state: undefined,
		ready: false,
		...(avatarId === undefined ? {} : { avatarId, avatarGiven: true }),
	};
}

/**
 * The PUBLIC shape. Every response body that carries a room uses exactly this:
 * `@hadoku/shared`'s `RoomView`, which the browser parses with, and the AI this
 * room plays as (`roomAi`), which only the pod screen reads.
 */
export interface RoomView extends PublicRoomView {
	ai: AiPersona;
}

/** Who is asking. `id` from `identityFromHeaders`, `name` from `userIdOf`. */
export interface Caller {
	id: string;
	name: string;
}

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
	| { ok: false; reason: 'no-room' | 'not-leader' | 'draft-started' | 'mode-locked' };

/** `setFormat`'s refusals, plus a draft room (which has no mode). */
type SetModeResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'no-room' | 'not-leader' | 'not-constructed' | 'mode-locked' };

/** Deliberately the same refusals as `SetGameTypeResult`: one leader, one shape. */
type SetFormatResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'no-room' | 'not-leader' | 'draft-started' | 'mode-locked' };

/** Every setting has a default, so a room stored before a setting existed reads back on it without a migration. */
const SETTING_KEYS = Object.keys(DEFAULT_ROOM_SETTINGS) as (keyof RoomSettings)[];
/** Settings a room stored before they were retired: read and dropped, so the room still parses. */
const RETIRED_SETTING_KEYS = ['matchLength', 'sideboarding'];

/** `SetFormatResult`'s three refusals (one leader, one shape). */
type SetSettingsResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'no-room' | 'not-leader' | 'draft-started' | 'mode-locked' };

type AddTableResult = | { ok: true; room: RoomView; table: RoomTable } | { ok: false; reason: 'no-room' | 'not-leader' };

type RemoveTableResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'no-room' | 'not-leader' | 'no-such-table' | 'first-table' | 'not-idle' };

/** A table's series resolved from its card: the game it let go of, if one was in play, for the caller to stop. */
type ResolveTableResult =
	| { ok: true; matchId: string | null }
	| { ok: false; reason: 'no-room' | 'no-such-table' | 'not-seated' | 'pod-table' | 'not-pod-table' | 'nothing-to-abandon' | 'nothing-to-drop' };

type RecordGameResultResult =
	| { ok: true; room: RoomView; phase: SeriesPhase }
	| { ok: false; reason: 'no-room' | 'no-such-table' };

type StartDraftResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'no-room' | 'not-member' | 'not-draft' | 'not-ready' | 'plan-not-ready' };

/**
 * `not-member` covers a room that does not exist too (same bucket `join` and
 * `setReady` already use): there is no sentence a caller who is not in a room
 * needs that is different from "no such room".
 */
type LeaveResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'no-room' | 'not-member' };

/* ── the pod (wave 72 §P) ─────────────────────────────────────────────────── */

type SitPodResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'no-room' | 'not-member' | 'not-draft' | 'not-lobby' | 'bad-seat' | 'seat-taken' | 'pod-full' };

type ClosePodResult =
	| { ok: true; room: RoomView }
	| { ok: false; reason: 'no-room' | 'not-member' | 'not-leader' | 'not-draft' | 'not-lobby' | 'bad-seat' | 'seat-taken' | 'too-few' };

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
 * The opponent at a pod table that has one human: the one drafter of a pod of
 * bots plays Forge's AI. Stands in `PodRecord.pairings` and the results where a
 * member id would, and is never a member — but once it has played, a row of the standings.
 */
export const POD_AI = 'ai';

/**
 * A tournament pod's OWN AI entrant, one per AI seat (operator, 2026-10-22:
 * *"AI can sit in the tournament, but we can also allow byes"*) — distinct
 * from `POD_AI`, a draft pod's single shared bot, because a tournament can
 * seat several AI at once and each needs its own identity to pair and stand
 * separately. `${AI_ENTRANT_PREFIX}<seat>` so two different AI seats never
 * collide and an entrant id is never mistaken for a member's (`ROOM_ID_RE`'s
 * member ids never contain `:`).
 */
const AI_ENTRANT_PREFIX = 'ai:';

/** The entrant id a tournament pod's AI seat `seat` pairs and stands under. */
function aiEntrantId(seat: number): string {
	return `${AI_ENTRANT_PREFIX}${seat}`;
}

/** Whether `id` is a tournament pod's own AI entrant (never a member id, which never contains `:`). */
export function isAiEntrant(id: string): boolean {
	return id.startsWith(AI_ENTRANT_PREFIX);
}

/** The pod seat an AI entrant id names — the inverse of `aiEntrantId`. */
function aiEntrantSeat(id: string): number {
	return Number(id.slice(AI_ENTRANT_PREFIX.length));
}

/**
 * A Constructed room playing a Swiss pod of its own mode
 * (`docs/planning/tournament-mode-plan.md`): `settings.tournament` on. A
 * `draft` room is never this, even though it uses the same pod machinery —
 * `usesPod` is the question "does this room's lobby use `podSeats`/`pod` at
 * all", which is true for both.
 */
function isTournamentRoom(room: Pick<RoomRecord, 'gameType' | 'settings'>): boolean {
	return room.gameType === 'constructed-1v1' && room.settings.tournament;
}

/** Whether this room's lobby seats through `podSeats` and plays its rounds through `pod` — a `draft` room, or a constructed tournament. */
function usesPod(room: Pick<RoomRecord, 'gameType' | 'settings'>): boolean {
	return room.gameType === 'draft' || isTournamentRoom(room);
}

/**
 * `room` as `series.ts`'s `seriesFormatOf`/`newSeries` read it. `RoomRecord`
 * has no top-level `tournament` field (it rides under `settings`), so a
 * `RoomRecord` passed directly where a `SeriesRoom` is wanted reads back
 * `tournament: undefined` — never a type error (the field is optional), but
 * always the wrong answer for a tournament table. Every call that answers a
 * REAL table's format must go through this, not hand `room` straight to
 * `series.ts`.
 */
function seriesRoomOf(room: Pick<RoomRecord, 'gameType' | 'mode' | 'settings'>): SeriesRoom {
	return { gameType: room.gameType, mode: room.mode, tournament: isTournamentRoom(room) };
}

/**
 * A pod seat its owner closed (the operator, 2026-10-19: *"closing seats changes
 * how many people are in the tournament and draft"*): no one sits there, and the
 * draft deals one seat fewer.
 */
export const POD_CLOSED = 'closed';

/** The fewest seats a pod is left with: one player and one more. */
export const POD_MIN_OPEN = 2;

/** The seats the draft deals: every one not closed. */
function podSize(room: RoomRecord): number {
	return podTable(room).length;
}

/** An AI seat as a player: one of the room's characters, by its own name (the operator, 2026-10-19). */
interface AiPersona {
	name: string;
	avatarId: string;
}

/** A tournament table's two entrants, the AI's last, and — at a vs-AI table — the character this round's AI plays as, not the room's own `ai`. */
export interface TournamentPairing {
	entrants: [string, string];
	ai?: AiPersona;
}

/** `knight` → Knight. */
function personaOf(avatarId: string): AiPersona {
	return { name: avatarId.charAt(0).toUpperCase() + avatarId.slice(1), avatarId };
}

/** A character for a new AI seat: one nobody in the room wears and no other AI seat has, else any the AI seats have not. */
function freeAiAvatar(room: RoomRecord): string {
	const ai = new Set(room.podAi.filter((a): a is string => a !== null));
	const worn = new Set(room.members.flatMap((m) => (m.avatarId === undefined ? [] : [m.avatarId])));
	return AVATAR_POOL.find((a) => !ai.has(a) && !worn.has(a)) ?? AVATAR_POOL.find((a) => !ai.has(a)) ?? AVATAR_POOL[0];
}

/** One place at the pod's table: a member, or the AI (with no character for a seat nobody filled). */
type PodPlace = { kind: 'human'; id: string } | { kind: 'ai'; persona: AiPersona | null };

/**
 * The pod's table: every seat not closed, in seat order. Index === the seat the
 * draft deals, so this is the one order behind everything that depends on
 * where someone sits — who passes packs to whom, the AI across the table, and
 * round 1's pairings. Nothing else orders a pod.
 */
function podTable(room: RoomRecord): PodPlace[] {
	return room.podSeats.flatMap((id, i): PodPlace[] => {
		if (id === POD_CLOSED) return [];
		if (id !== null && id !== POD_AI) return [{ kind: 'human', id }];
		const avatar = id === POD_AI ? room.podAi[i] : null;
		return [{ kind: 'ai', persona: avatar === null || avatar === undefined ? null : personaOf(avatar) }];
	});
}

/**
 * A TOURNAMENT pod's own place at the table: a human, an EXPLICITLY AI seat
 * (the AI button), or an untouched EMPTY one. Unlike `podTable` (a draft
 * pod's own compaction, where an untouched seat IS the AI — a draft always
 * deals every seat, empty ones to bots), a tournament's lock never invents an
 * entrant nobody named: an empty seat plays no part in it at all. Closed
 * seats are dropped, same as `podTable`, and for the same reason — this is
 * the one order "across the table" pairing reads (`podTable`'s own doc).
 */
type TournamentPlace = { kind: 'human'; id: string } | { kind: 'ai' } | { kind: 'empty' };

function tournamentTable(room: RoomRecord): TournamentPlace[] {
	return room.podSeats.flatMap((id): TournamentPlace[] => {
		if (id === POD_CLOSED) return [];
		if (id === POD_AI) return [{ kind: 'ai' }];
		if (id === null) return [{ kind: 'empty' }];
		return [{ kind: 'human', id }];
	});
}

/**
 * These entrants as pairing players, each at their place at the pod's table.
 * A DRAFT pod's `entrants` are its humans (an AI seat's derived id never
 * matches one, so `podTable`'s own compaction — empty seats included as
 * bots — is unchanged from before this file knew about tournaments). A
 * TOURNAMENT pod's `entrants` are `podEntrants`'s own list, read against the
 * SAME compaction (`tournamentTable`) that produced it, so an id's `podSeat`
 * here is always the one it was minted with — an empty seat is no seat at
 * all, never a numbering gap.
 */
function podPlayers(room: RoomRecord, entrants: readonly string[]): PodPlayer[] {
	if (isTournamentRoom(room)) {
		return tournamentTable(room).flatMap((place, podSeat) => {
			if (place.kind === 'empty') return [];
			const id = place.kind === 'human' ? place.id : aiEntrantId(podSeat);
			return entrants.includes(id) ? [{ id, podSeat }] : [];
		});
	}
	return podTable(room).flatMap((place, podSeat) => {
		const id = place.kind === 'human' ? place.id : aiEntrantId(podSeat);
		return entrants.includes(id) ? [{ id, podSeat }] : [];
	});
}

/**
 * Every pairing entrant seated in a TOURNAMENT pod, in seat order: every
 * human AND every EXPLICITLY AI seat, each AI given its own entrant id
 * (`aiEntrantId`) — the operator, 2026-10-22, reversing the plan's original
 * "no AI seats in a tournament pod". An untouched empty seat is not an
 * entrant (`tournamentTable`'s own doc). A draft pod never calls this: its
 * AI seats fill the drafting table but never pair (`seatedHumans` is its own
 * entrant list).
 */
function podEntrants(room: RoomRecord): string[] {
	return tournamentTable(room).flatMap((place, seat) => {
		if (place.kind === 'human') return [place.id];
		if (place.kind === 'ai') return [aiEntrantId(seat)];
		return [];
	});
}

/** The AI this room's games are played against: a pod's across-the-table bot, or for a 1v1 room a character nobody here wears. */
export function roomAi(room: RoomRecord): AiPersona {
	if (room.gameType === 'draft') {
		const opponent = aiOpponent(room);
		if (opponent !== null) return opponent;
	}
	const worn = new Set(room.members.flatMap((m) => (m.avatarId === undefined ? [] : [m.avatarId])));
	return personaOf(AVATAR_POOL.find((a) => !worn.has(a)) ?? AVATAR_POOL[0]);
}

/** An AI entrant's character: a tournament pod's own (its seat's, kept through the pod's life), or a draft pod's shared bot (`roomAi`). */
function entrantPersona(room: RoomRecord, id: string): AiPersona {
	return isAiEntrant(id) ? personaOf(room.podAi[aiEntrantSeat(id)] ?? AVATAR_POOL[0]) : roomAi(room);
}

/** `PodView.personas`: every AI entrant the pod's players, pairings and results name. */
function podPersonas(room: RoomRecord, humans: readonly string[]): PodView['personas'] {
	const pod = room.pod;
	const ids = [...humans, ...(pod?.pairings.flatMap((p) => p.players) ?? []), ...(pod?.results.flatMap((r) => [r.playerA, r.playerB ?? r.playerA]) ?? [])];
	return Object.fromEntries([...new Set(ids)].filter((id) => id === POD_AI || isAiEntrant(id)).map((id) => [id, entrantPersona(room, id)]));
}

/** The AI a pod of one plays: the bot that drafted across the table from its human (`draftRooms.ts`'s `botPoolAcross`, by the same rule). */
function aiOpponent(room: RoomRecord): AiPersona | null {
	const table = podTable(room);
	const human = table.findIndex((place) => place.kind === 'human');
	const seat = botSeatAcross(Math.max(0, human), table.length, (s) => table[s]?.kind === 'ai');
	const place = seat === null ? undefined : table[seat];
	return place?.kind === 'ai' ? place.persona : null;
}

/**
 * What `RoomView.pod` needs that this file cannot answer on its own: whether
 * a pod's DRAFT is complete (`draftRooms.ts`'s `DraftState.status`), whether
 * a given drafter's deck is saved and legal (`draftRooms.ts`'s `builtDeckOf`
 * plus `gate.ts`'s own check — "the gate's draft check" the brief names),
 * and the table player-state to seat a drafter with once a round pairs them
 * (same opaque shape `http/routes.ts` itself reads back through
 * `playerState`/`setPlayerState`; this file never looks inside it).
 *
 * Wired once, from `http/routes.ts`'s `attachTables` — which already holds
 * `draftRooms`, the gate's `checkSeat`, and this very `Lobby` (as
 * `TablesRooms`) — via `setPodChecks`. `index.ts` is not touched for this:
 * `attachTables` is called with the same `rooms`/`draftRooms` it always was.
 * Unwired (every test that never calls `setPodChecks`, and the instant
 * between `openLobby` returning and `attachTables` running at boot) answers
 * as if nothing has ever been built — a room can only wait longer in
 * `drafting`/`building`, never see a wrong answer the other way.
 *
 * `holdsSeriesDeck` is the one question about a Constructed table: whether a
 * member's table state still holds the deck it played the current series
 * with — what keeps a finished Bo1 open to a Rematch (`#rematchable`).
 * Unwired, every seat does, so only the seats and members decide.
 */
export interface PodChecks {
	draftComplete(podId: string): boolean;
	built(podId: string, memberId: string): boolean;
	seatState(podId: string, memberId: string): unknown;
	holdsSeriesDeck(state: unknown): boolean;
	/**
	 * Each round's bare name (`PodView.roundNames`) — `room/plan.ts`'s
	 * `roundNamesOf`, bound to `draftRooms.ts`'s resolver for a single
	 * source's own name (the same rule `cubeMetaOf` labels it from).
	 */
	roundNamesOf(plan: DraftPlan): [string, string, string];
	/**
	 * Tournament, Classic only: whether `memberId`'s own per-room state
	 * (`member.state`, the same blob `PUT …/deck` writes) already holds a
	 * deck legal for the room's pool — the lock's own "ready" check for
	 * Classic (`docs/planning/tournament-mode-plan.md`'s Design: *"Classic: a
	 * legal deck chosen"*). An AI entrant is always ready and never reaches
	 * here (`#lockTournament`'s own gate).
	 */
	hasLegalSeatDeck(roomId: string, memberId: string): boolean;
	/**
	 * Tournament, Classic/All Random, `tournamentDecks === 'locked'`: this
	 * entrant's deck right now, to snapshot as its locked choice at the lock
	 * — a human's own CURRENT `PUT …/deck` state, read back verbatim, or a
	 * freshly dealt one for an AI entrant (the room's format/library, the
	 * same way a vs-bot table deals the AI one). Opaque to `room/lobby.ts`,
	 * which only stores and replays whatever this returns.
	 */
	currentTournamentDeck(roomId: string, entrant: string): unknown;
	/**
	 * Tournament, Classic/All Random, every round's `#newPodTable`: seat
	 * `entrant` (a member id, or a tournament AI entrant id — `isAiEntrant`)
	 * at `tableId` with `deck` — a `locked` snapshot (`currentTournamentDeck`'s
	 * own shape) replayed as-is, or `null` for `per-round` (a human's own
	 * deck is cleared so `PUT …/deck` is required again for Classic, or left
	 * for the table's own ready-time deal for All Random; an AI entrant is
	 * dealt fresh here instead). The table's OTHER seat, when it is an AI
	 * entrant (`null` in `TableRecord.seats`), holds nothing of its own: its
	 * deck rides the human partner's `state.aiDeck`, exactly as a vs-bot
	 * table already works.
	 */
	seatTournamentDeck(roomId: string, tableId: string, entrant: string, deck: unknown | null): void;
}

/** The bare name a single source gets with no `DraftRooms` wired (no jar/no cube store): its id or code, which is also what the real resolver falls back to. */
function fallbackSourceName(source: PoolSource): string {
	return source.kind === 'cube' ? source.cubeId : source.code;
}

const NO_POD_CHECKS: PodChecks = {
	draftComplete: () => false,
	built: () => false,
	seatState: () => null,
	holdsSeriesDeck: () => true,
	roundNamesOf: (plan) => roundNamesOf(plan, fallbackSourceName),
	hasLegalSeatDeck: () => false,
	currentTournamentDeck: () => null,
	seatTournamentDeck: () => {},
};

/**
 * A series' result, recorded once when the series ends (`#settleSeries`): a
 * Bo3 when it is decided, a Bo1 when the room moves on without a Rematch. A
 * Bo3 that ends undecided is a Bo1 of its one finished game, or the Bo3 drawn
 * (`winner: null`) once two are finished. A seat is the member who played it,
 * or `null` for Forge's AI.
 */
export interface SeriesEnd {
	roomId: string;
	tableId: string;
	mode: string;
	bestOf: 1 | 3;
	seats: [{ memberId: string; name: string } | null, { memberId: string; name: string } | null];
	wins: [number, number];
	games: SeriesGame[];
	winner: 0 | 1 | null;
}

/**
 * A draft room's rounds, once `playPod` has dealt round 1. Null before
 * that (still `lobby`, `drafting` or `building` — see `podPhaseOf`).
 */
interface PodRecord {
	/** The humans seated for the draft, in POD SEAT order — `pairing.ts`'s own player list. Fixed for the pod's life. */
	humans: string[];
	/** 1-based once round 1 has started; never 0 once `pod` exists. One past `rounds` once the pod is done. */
	round: number;
	/** `roundsFor(humans.length)`, fixed once `pod` exists. */
	rounds: number;
	/** Every finished round's results so far, byes included. */
	results: MatchResult[];
	/** The CURRENT round's pairings. Empty once the pod is done. */
	pairings: { tableId: string; players: [string, string] }[];
	/** The CURRENT round's bye, or null. Cleared once the pod is done. */
	bye: string | null;
}

function isStoredMatchResult(v: unknown): v is MatchResult {
	if (typeof v !== 'object' || v === null) return false;
	const r = v as Record<string, unknown>;
	return (
		typeof r.round === 'number' &&
		typeof r.playerA === 'string' &&
		(r.playerB === null || typeof r.playerB === 'string') &&
		typeof r.gamesA === 'number' &&
		typeof r.gamesB === 'number' &&
		(r.gameMs === undefined || (Array.isArray(r.gameMs) && r.gameMs.every((ms) => typeof ms === 'number')))
	);
}

function isStoredPodPairing(v: unknown): v is { tableId: string; players: [string, string] } {
	if (typeof v !== 'object' || v === null) return false;
	const p = v as Record<string, unknown>;
	return (
		typeof p.tableId === 'string' &&
		Array.isArray(p.players) &&
		p.players.length === 2 &&
		p.players.every((x) => typeof x === 'string')
	);
}

function isStoredPodRecord(v: unknown): v is PodRecord {
	if (typeof v !== 'object' || v === null) return false;
	const p = v as Record<string, unknown>;
	if (!Array.isArray(p.humans) || !p.humans.every((h) => typeof h === 'string')) return false;
	if (typeof p.round !== 'number' || typeof p.rounds !== 'number') return false;
	if (!Array.isArray(p.results) || !p.results.every(isStoredMatchResult)) return false;
	if (!Array.isArray(p.pairings) || !p.pairings.every(isStoredPodPairing)) return false;
	return p.bye === null || typeof p.bye === 'string';
}

function isStoredPodSeats(v: unknown): v is (string | null)[] {
	return Array.isArray(v) && v.length === POD_SEATS && v.every((s) => s === null || typeof s === 'string');
}

/** Each entrant's locked deck is an object (Classic/Random's opaque deck choice; an older record's Gauntlet deck-id array) — never a bare primitive. */
function isStoredLockedDecks(v: unknown): v is Record<string, unknown> {
	if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
	return Object.values(v).every((x) => typeof x === 'object' && x !== null);
}

/** A room's Gauntlets by table id (`RoomRecord.gauntlets`'s own doc): a plain object, every value a Gauntlet this build understands. */
function isStoredGauntlets(v: unknown): v is Record<string, GauntletState> {
	if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
	return Object.values(v).every(isGauntletState);
}

/**
 * The room's own gate-free phase: `lobby`/`drafting`/`building`/`rounds`/`done`
 * — see `PodChecks`. Only called for a room `usesPod`.
 *
 * A TOURNAMENT pod never sees `drafting`/`building`: `#lockTournament` sets
 * `draftStartedAt` and a (possibly still-empty) `pod` as ONE atomic
 * mutation, specifically so that nothing — not even a RE-ENTRANT read
 * through `PodChecks` mid-lock (`#newPodTable`'s `seatTournamentDeck` calls
 * back into `rooms.get()` before pairing is finished) — can ever observe
 * `draftStartedAt !== null` with `pod === null`. If it ever does, that is a
 * real bug upstream, not a case this function silently answers a phase for:
 * `rounds`/`done` with no pod is impossible, so this throws rather than
 * lying about which phase it is (a real run of exactly that lie is what
 * crashed `podViewOf`'s blind cast below, 2026-10-22).
 */
function podPhaseOf(room: RoomRecord, checks: PodChecks): PodPhase {
	if (room.draftStartedAt === null) return 'lobby';
	if (room.gameType === 'draft') {
		if (!checks.draftComplete(room.id)) return 'drafting';
		if (room.pod === null) return 'building';
	}
	if (room.pod === null) throw new Error(`podPhaseOf: room ${room.id} has draftStartedAt set and no pod`);
	return room.pod.round > room.pod.rounds ? 'done' : 'rounds';
}

/** `PodView.seats` once the pod has left the `lobby` phase — see `podViewOf`. */
const EMPTY_POD_SEATS: PodView['seats'] = new Array(POD_SEATS).fill(null) as PodView['seats'];

/**
 * The members seated in the pod, in seat order — not the open seats, and not
 * the seats the AI holds (`POD_AI`, the AI button: the operator, 2026-10-19,
 * *"i need an AI button same as how it's used in the constructed 1v1 lobby"*).
 */
function seatedHumans(room: RoomRecord): string[] {
	return podTable(room).flatMap((place) => (place.kind === 'human' ? [place.id] : []));
}

function podSeatsView(room: RoomRecord): PodView['seats'] {
	return room.podSeats.map((id, i) => {
		if (id === null) return null;
		if (id === POD_AI) {
			const persona = personaOf(room.podAi[i] ?? AVATAR_POOL[0]);
			return { memberId: POD_AI, name: persona.name, avatarId: persona.avatarId } as PodMember;
		}
		if (id === POD_CLOSED) return { memberId: POD_CLOSED, name: '' } as PodMember;
		const member = room.members.find((m) => m.id === id);
		return member === undefined ? null : ({ memberId: id, name: member.name } as PodMember);
	}) as PodView['seats'];
}

/**
 * The standings' players: the pod's humans, and the draft pod's single
 * shared bot once a result names it. A literal `=== POD_AI`, deliberately —
 * a TOURNAMENT pod's own AI entrant (`isAiEntrant`) is always already in
 * `humans` (`podEntrants`'s own doc), so adding it again here on a looser
 * `isPodAi` match would double it in the standings.
 */
function players(humans: string[], results: MatchResult[]): { id: string }[] {
	const ai = results.some((r) => r.playerA === POD_AI || r.playerB === POD_AI);
	return [...humans, ...(ai ? [POD_AI] : [])].map((id) => ({ id }));
}

/** The pod's standings, ranked 1-based, each row naming the tiebreak that put it below the one above. */
function rankedStandings(humans: string[], results: MatchResult[]): RankedStandingsRow[] {
	return rankStandings(standings(players(humans, results), results));
}

/**
 * `RoomView.pod`, for a room `usesPod` — `viewOf` answers `null` for every
 * other room. A DRAFT room's `planFields` are `room.plan`'s, frozen the
 * instant `draftStartedAt` is set (`PUT …/pod/plan` refuses from there — see
 * `RoomRecord.plan`'s own doc), so reading it here is right in every phase,
 * not just `lobby`. A constructed TOURNAMENT pod drafts no pool at all:
 * `plan`/`roundNames`/`verdict` are `null` (`PodView.plan`'s own doc).
 */
function podViewOf(room: RoomRecord, checks: PodChecks): PodView {
	const phase = podPhaseOf(room, checks);
	const tournament = isTournamentRoom(room);
	const planFields = tournament ? { plan: null, roundNames: null, verdict: null } : { plan: room.plan, roundNames: checks.roundNamesOf(room.plan), verdict: room.planVerdict };
	// Filled only in `lobby` — the wire contract's own words ("lobby phase: the
	// 8 pod seats"). Once drafting starts, who is at what SEAT is the draft
	// engine's own business (`room/draftRooms.ts`'s `viewForParticipant`), and
	// `startPodRounds`'s `PodRecord.humans`/`pairings` are what `rounds`/`done`
	// answer from — this field is not a second source for either.
	const seats = phase === 'lobby' ? podSeatsView(room) : EMPTY_POD_SEATS;
	if (phase === 'lobby') {
		return { phase, seats, round: 0, rounds: 0, results: [], standings: [], pairings: [], bye: null, drafters: [], built: [], personas: {}, ...planFields };
	}
	// Seated at `draftStartedAt` and fixed from there (`#dealPodRounds`'s own
	// `humans`), falling back to the CURRENT seats for a pod whose rounds have
	// not started yet (`drafting`/`building`) — there is no fixed list to fall
	// back to before `#dealPodRounds` has run.
	const humans = room.pod?.humans ?? seatedHumans(room);
	if (phase === 'drafting') {
		return { phase, seats, round: 0, rounds: 0, results: [], standings: [], pairings: [], bye: null, drafters: humans, built: [], personas: podPersonas(room, humans), ...planFields };
	}
	// Done building: pressed Play (`playPod`) with a deck that is still legal.
	const built = humans.filter((id) => room.podPlaying.includes(id) && checks.built(room.id, id));
	if (phase === 'building') {
		return { phase, seats, round: 0, rounds: roundsFor(humans.length), results: [], standings: [], pairings: [], bye: null, drafters: humans, built, personas: podPersonas(room, humans), ...planFields };
	}
	// `podPhaseOf` already answers `rounds`/`done` only when `room.pod !== null`
	// (it throws otherwise, above) — but this cast is the one place that
	// invariant actually gets relied on, so it checks again rather than
	// trusting a call several lines back never to drift out of sync with it.
	if (room.pod === null) throw new Error(`podViewOf: room ${room.id} is ${phase} with no pod`);
	const pod = room.pod;
	// The AI you played is ranked beside you (the operator, 2026-10-19: "why am i the only one in that room").
	const ranked = rankedStandings(humans, pod.results);
	return {
		phase,
		seats,
		round: Math.min(pod.round, pod.rounds),
		rounds: pod.rounds,
		results: pod.results,
		standings: ranked,
		pairings: pod.pairings,
		bye: pod.bye,
		drafters: humans,
		// A tournament pod never builds a deck: every entrant who locked in
		// counts as "built" at once, rather than reading as permanently empty.
		built: tournament ? humans : built,
		personas: podPersonas(room, humans),
		...planFields,
	};
}

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

/**
 * How long a room may go without a touch before the front page stops
 * OFFERING it (wave 31). The room is not deleted (`ROOM_IDLE_MS` does that, much
 * later); it just stops advertising itself.
 *
 * The operator: *"why are 'hi there' and 'hi there2' still showing up?"* Rooms
 * restore on boot and live twelve hours, and the list prints a room's STORED
 * members, not who is connected, so a dead table looked alive with an Enter
 * button. A room someone has open is touched by its screen's reads and, for as
 * long as the screen stays open, by the room feed (`room/feed.ts`), so "nobody
 * touched it for thirty minutes" means nobody is there. A room with a match or
 * a draft under way is exempt: its players are on another screen.
 */
export const ROOM_STALE_MS = 30 * 60_000;

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
	 * Be told every time a room is written, created or forgotten. Every mutation
	 * goes through one persist, so this is every change a read could see and
	 * nothing else: a read (`touch`, `get`, `list`) never fires it. The room feed
	 * pushes from here (`room/feed.ts`). Returns the unsubscribe.
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
	/** Who sits at `tableId`, in seat order, with each seat's Ready. Empty when there is no such room or table. */
	seats(roomId: string, tableId: string): TableSeat[];
	/**
	 * `memberId` takes the first open seat at `tableId`, giving up a seat held
	 * at any other table of the room. True when they hold one there afterwards
	 * (a seat already held is a no-op); false when there is no such room, table
	 * or member, or both seats are someone else's.
	 */
	sit(roomId: string, tableId: string, memberId: string): boolean;
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
	releaseAbandonedSeats(memberId: string): { roomId: string; tableId: string }[];
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
	/** Move the start of the event a room was made for (`CreateRoomInput.scheduledFor`). False when there is no such room. */
	reschedule(roomId: string, at: number): boolean;
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
	rename(caller: Caller): void;
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

	/** Wires `PodChecks` — see its own doc. Called once, from `http/routes.ts`'s `attachTables`. */
	setPodChecks(checks: PodChecks): void;
	/**
	 * How the pod's draft is dealt (`draftRooms.ts`'s pod lookup, wired the same
	 * way as `setPodChecks`), read off `podTable`: the seats not closed, each
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
	 * The tournament pairing at `tableId` — the two entrant ids (a member id,
	 * or a pod AI entrant's `` `ai:<seat>` ``), the AI's slot (if any) always
	 * last so `http/gauntlet.ts`'s own seat convention (the human is Gauntlet
	 * seat 0, a vs-AI table's synthetic AI player seat 1) lines up. `null` for a
	 * non-tournament room, or a table with no current pairing.
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
	 * saved deck is legal (`PodChecks.built`). Once EVERY human drafter has
	 * pressed it, round 1 is dealt with nobody else's say: one bo3-with-sideboarding
	 * table per pairing (`pairRound`, `@hadoku/draft`), both players seated with
	 * their saved deck (`PodChecks.seatState`), the bye recorded as a
	 * `MatchResult`. A pod with one human gets one table against the AI
	 * (`POD_AI`). Every later round starts by itself, from `recordGameResult`.
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

/** One of a room's tables: who sits at it and their Readys (`seats.ts`), its live match and its series. */
interface TableRecord extends TableSeats {
	id: string;
	matchId: string | null;
	series: SeriesRecord;
}

interface MemberRecord {
	id: string;
	name: string;
	joinedAt: number;
	state: unknown;
	ready: boolean;
	/** Normalised by `avatarIdOf` on the way in, so this is never `''` and never `null`. */
	avatarId?: string;
	/**
	 * The room handed `avatarId` out (`newMember`) rather than the member picking
	 * it, so a member who picks the same character takes it over. In memory only:
	 * after a restart a handed-out avatar counts as picked, which costs at most a
	 * shared face until somebody picks again.
	 */
	avatarGiven?: true;
}

interface RoomRecord {
	id: string;
	name: string;
	creator: string;
	leader: string;
	gameType: GameType;
	format: FormatId;
	settings: RoomSettings;
	mode: ConstructedMode | null;
	modeOptions: ModeOptions | null;
	clientMode: ClientMode;
	/** Always at least one — wave 71. The first table's id is stable for the room's life. */
	tables: TableRecord[];
	/** Every match ANY of this room's tables started, newest last, at most `ROOM_MATCHES_KEPT`. See `roomOfMatch`. */
	matches: string[];
	/** ms since epoch once the draft was dealt; null in the lobby phase. */
	draftStartedAt: number | null;
	/**
	 * A draft room's pool choice (wave 73 §A) — the Settled default (Vintage
	 * Cube 2025-12 × 3) until the leader picks otherwise. Meaningful only while
	 * `draftStartedAt === null` — `PUT …/pod/plan` refuses once it is set, so
	 * `podDraft`'s own read of this is frozen by construction from there, same
	 * as `podSeats` below.
	 */
	plan: DraftPlan;
	/** The last verdict run on `plan` — null while a check is in flight, or before the first one ever ran. */
	planVerdict: PoolVerdict | null;
	/** The 8 pod seats (wave 72 §P), by member id. Meaningful only while `draftStartedAt === null`; frozen from there — `#dealPodRounds`'s own `PodRecord.humans` is what the pod plays. */
	podSeats: (string | null)[];
	/** The character each AI seat plays as, by pod seat — null where no AI sits. Kept the tournament through. */
	podAi: (string | null)[];
	/** The pod's rounds, once dealt. Null until every drafter has pressed Play (`playPod`). */
	pod: PodRecord | null;
	/** Who has pressed Play in `building` (`playPod`). Persisted with `pod`, so a restart mid-build keeps the presses. */
	podPlaying: string[];
	/**
	 * A tournament's locked deck(s) by entrant id, meaningful only with
	 * `settings.tournament` on and `tournamentDecks === 'locked'` — empty
	 * otherwise. Classic / All Random: each entrant's one deck choice,
	 * opaque to this file (the same discipline `MemberRecord.state` already
	 * keeps), snapshotted at the lock (`#lockTournament`) and read back by
	 * `#seatTournamentDeck` every round. A Gauntlet tournament locks none
	 * (`tournamentDecksOf`); a record stored before that may still hold a
	 * Gauntlet entrant's deck-id array here, which nothing reads.
	 */
	lockedDecks: Record<string, unknown>;
	/**
	 * A Gauntlet room's Gauntlet (`gauntlet.ts`), kept whole so a reconnect
	 * replays the same draw — one per TABLE, keyed by table id, so a
	 * tournament round's several Gauntlet tables each keep their own
	 * (`docs/planning/tournament-mode-plan.md`: Gauntlet in tournament mode).
	 * A plain Gauntlet room has exactly one key, `tables[0].id`. Absent for a
	 * table that has never moved.
	 */
	gauntlets: Record<string, GauntletState>;
	/** A seeded, admin-only room (`room/testing-rooms.ts`). Never swept, never stale (`sweep`, `offered`), and `close()` bypasses the leader check for it. */
	testing: boolean;
	/** A board-state testing room's own scenario (`CreateRoomInput.scenario`'s doc). Absent for every room that is not one. */
	scenario?: string;
	/** When its event starts (`CreateRoomInput.scheduledFor`'s doc). Absent for a room no event made. */
	scheduledFor?: number;
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
	/** Absent on disk for a room written before the field; `deserialize` fills in the defaults. */
	settings: RoomSettings;
	/**
	 * Undefined ONLY on the way out of `deserialize`, for a record written before
	 * modes existed: `openLobby` restores that room as Classic, which it was.
	 */
	mode: ConstructedMode | null | undefined;
	modeOptions: ModeOptions | null;
	clientMode: ClientMode;
	/**
	 * Always resolved by `deserialize`: a record written before wave 71 (which
	 * plays exactly one table) is migrated into a one-table list holding
	 * `matchId` below (kept on disk too, for a rollback: see `#persist`).
	 * `ready` is absent only for a table stored before the lobby held its seats,
	 * which `openLobby` seats from its members (`seatsFromMembers`).
	 */
	tables: StoredTable[];
	/** Pre-wave-71 shape, and `tables[0].matchId` restated for a build that rolls back to reading it. */
	matchId: string | null;
	/** A finished match's result screen still asks which room it was. */
	matches: string[];
	/**
	 * Restored with the pod (`openLobby`): the draft itself is on disk too
	 * (`draftRooms.ts`'s snapshots), so a restart resumes it. A room whose draft
	 * did NOT come back is put back in its lobby (`releaseLostDrafts`).
	 */
	draftStartedAt: number | null;
	/** Absent for a room written before wave 73 §A: the Settled default (Vintage Cube 2025-04 × 3), same as every pod drafted before a plan existed. */
	plan?: DraftPlan;
	/** Absent for a room written before wave 73 §A, or whose plan has never been checked. */
	planVerdict?: PoolVerdict | null;
	/** Absent on disk for a room written before wave 72 §P: the default (8 nulls) is nobody seated, same as before the pod lobby existed. */
	podSeats: (string | null)[];
	/** Absent for a room written before AI seats had characters: none has one. */
	podAi?: (string | null)[];
	/** Absent for a room written before wave 72 §P, or whose rounds have never started. */
	pod: PodRecord | null;
	/** Absent for a room written before it was persisted: nobody has pressed Play. */
	podPlaying?: string[];
	/** Absent for a room written before tournament mode: nothing was ever locked. */
	lockedDecks?: Record<string, unknown>;
	/** Absent for a room written before Gauntlets, or whose Gauntlet has never moved. The pre-per-table shape, kept ONLY so `appCodec.deserialize` can migrate it onto `tables[0].id` (`gauntlets`'s own doc) — never written again. */
	gauntlet?: GauntletState | null;
	/** Absent for a room written before Gauntlet tournaments: one per table, keyed by table id (`RoomRecord.gauntlets`'s own doc). */
	gauntlets?: Record<string, GauntletState>;
	/** Absent for a room written before testing rooms existed, which reads back `false` — every such room is an ordinary one. */
	testing?: boolean;
	/** Absent for a room written before board-state testing rooms existed, or that is not one: every such room has no scenario. */
	scenario?: string;
	/** Absent for a room no event made, and for every room written before events existed. */
	scheduledFor?: number;
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

/**
 * A stored mode and its options: both null (unchosen), or a pair `RoomModeSchema`
 * accepts. Undefined when the record predates modes.
 */
function storedMode(a: Record<string, unknown>): Pick<StoredApp, 'mode' | 'modeOptions'> {
	if (a.mode === undefined && a.modeOptions === undefined) return { mode: undefined, modeOptions: null };
	if (a.mode === null && a.modeOptions === null) return { mode: null, modeOptions: null };
	const parsed = RoomModeSchema.safeParse({ mode: a.mode, modeOptions: a.modeOptions });
	if (!parsed.success) throw new Error('app.mode is not a known mode with its options');
	return parsed.data;
}

/**
 * Each setting is validated against its OWN schema (`RoomSettingsSchema.shape`,
 * not every setting is a boolean any more — `tournamentDecks` is an enum). A
 * retired one is accepted whatever it holds, and dropped by `storedSettings`.
 */
function isStoredSettings(v: unknown): v is Partial<RoomSettings> {
	if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
	return Object.entries(v).every(([k, value]) => {
		if (RETIRED_SETTING_KEYS.includes(k)) return true;
		if (!(SETTING_KEYS as string[]).includes(k)) return false;
		return RoomSettingsSchema.shape[k as keyof RoomSettings].safeParse(value).success;
	});
}

function storedSettings(v: Partial<RoomSettings> | undefined): RoomSettings {
	const settings = { ...DEFAULT_ROOM_SETTINGS } as Record<keyof RoomSettings, RoomSettings[keyof RoomSettings]>;
	for (const k of SETTING_KEYS) {
		const value = v?.[k];
		if (value !== undefined) settings[k] = value;
	}
	return settings as RoomSettings;
}

function isSecret(v: unknown): v is Secret {
	if (typeof v !== 'object' || v === null) return false;
	const s = v as Record<string, unknown>;
	return typeof s.salt === 'string' && typeof s.hash === 'string';
}

function isStoredGame(v: unknown): v is SeriesGame {
	if (typeof v !== 'object' || v === null) return false;
	const g = v as Record<string, unknown>;
	return typeof g.matchId === 'string' && (g.winner === 0 || g.winner === 1 || g.winner === null) && (g.ms === undefined || typeof g.ms === 'number');
}

const isSeat = (s: unknown): s is string | null => s === null || typeof s === 'string';

type StoredTable = Omit<TableRecord, 'ready'> & Partial<Pick<TableRecord, 'ready'>>;

type StoredSeries = Omit<SeriesRecord, 'played' | 'mode' | 'settled'> & Partial<SeriesRecord>;

/** `played`, `mode` and `settled` may be absent: a record written before them (see `storedTable`). */
function isStoredSeries(v: unknown): v is StoredSeries {
	if (typeof v !== 'object' || v === null) return false;
	const s = v as Record<string, unknown>;
	if (s.length !== 1 && s.length !== 3) return false;
	if (!Array.isArray(s.wins) || s.wins.length !== 2 || !s.wins.every((n) => typeof n === 'number')) return false;
	if (!Array.isArray(s.games) || !s.games.every(isStoredGame)) return false;
	if (s.played !== undefined && !(Array.isArray(s.played) && s.played.length === 2 && s.played.every(isSeat))) return false;
	if (s.settled !== undefined && typeof s.settled !== 'boolean') return false;
	if (s.mode !== undefined && typeof s.mode !== 'string') return false;
	if (s.gameStartedAt !== undefined && s.gameStartedAt !== null && typeof s.gameStartedAt !== 'number') return false;
	return SeriesPhaseSchema.safeParse(s.phase).success;
}

function isStoredTable(v: unknown): v is Omit<StoredTable, 'series'> & { series: unknown } {
	if (typeof v !== 'object' || v === null) return false;
	const t = v as Record<string, unknown>;
	if (typeof t.id !== 'string') return false;
	if (!Array.isArray(t.seats) || t.seats.length !== 2 || !t.seats.every(isSeat)) return false;
	if (t.ready !== undefined && !(Array.isArray(t.ready) && t.ready.length === 2 && t.ready.every((r) => typeof r === 'boolean'))) return false;
	if (t.matchId !== null && typeof t.matchId !== 'string') return false;
	return isStoredSeries(t.series);
}

/**
 * A stored table as this build holds it. A series written before `played`
 * existed was played by the table's seats, and one before `mode` in the mode
 * its room is in now (Classic for every room restored without one); one written before `settled`
 * existed is settled once finished, so a result from before is never recorded
 * now. A retired field (`rematchOf`) is dropped.
 */
function storedTable(t: Omit<StoredTable, 'series'> & { series: StoredSeries }, room: SeriesRoom): StoredTable {
	const { length, wins, games, phase, played, mode, settled, gameStartedAt } = t.series;
	return {
		id: t.id,
		seats: [...t.seats],
		...(t.ready === undefined ? {} : { ready: [...t.ready] }),
		matchId: t.matchId,
		series: {
			length,
			wins: [...wins],
			games: games.map((g) => ({ ...g })),
			phase,
			played: played ?? [...t.seats],
			mode: mode ?? statsModeOf(room),
			settled: settled ?? phase === 'done',
			gameStartedAt: gameStartedAt ?? null,
		},
	};
}

/**
 * The room-level codec. Its errors name the FIELD, never a value — the message
 * reaches the quarantine reason and the log, and a value here could be the hash.
 */
const appCodec: AppCodec<StoredApp> = {
	version: APP_VERSION,
	serialize: (value) => structuredClone(value),
	deserialize(raw, _version, ctx) {
		if (typeof raw !== 'object' || raw === null) throw new Error('app is not an object');
		const a = raw as Record<string, unknown>;
		if (typeof a.name !== 'string') throw new Error('app.name is not a string');
		if (typeof a.creator !== 'string') throw new Error('app.creator is not a string');
		if (typeof a.leader !== 'string') throw new Error('app.leader is not a string');
		const gameType = GameTypeSchema.safeParse(a.gameType);
		if (!gameType.success) throw new Error('app.gameType is not a known game type');
		// Written before wave 18: absent means `builtin`, which is what those rooms
		// are. A field that is PRESENT and unknown is not defaulted away — that is
		// a record this build does not understand, so it quarantines like any other.
		const clientMode = ClientModeSchema.default(DEFAULT_CLIENT_MODE).safeParse(a.clientMode);
		if (!clientMode.success) {
			throw new Error('app.clientMode is not a known client mode');
		}
		// Absent is a room written before wave 25, which starts on the newest
		// frozen pool (`openLobby`). Present and not a format id is a record this
		// build does not understand — including an explicit `null`, which this
		// build never writes.
		if (a.format !== undefined && !isFormatId(a.format)) throw new Error('app.format is not a format id');
		// Absent is a room written before settings existed, and so is a single
		// setting that is absent: each reads back on its default. A value of the
		// wrong type, or a setting this build does not know, quarantines.
		if (a.settings !== undefined && !isStoredSettings(a.settings)) throw new Error('app.settings is invalid');
		if (a.matchId !== null && typeof a.matchId !== 'string') throw new Error('app.matchId is invalid');
		// Absent is a room written before the field, which remembers no match.
		if (a.matches !== undefined && !(Array.isArray(a.matches) && a.matches.every((m) => typeof m === 'string'))) {
			throw new Error('app.matches is not a list of match ids');
		}
		// Absent is a room written before wave 71, which plays exactly one table —
		// migrated below from `matchId`. Present and not a list of tables is a
		// record this build does not understand.
		if (a.tables !== undefined && !(Array.isArray(a.tables) && a.tables.every(isStoredTable))) {
			throw new Error('app.tables is not a list of tables');
		}
		// Absent is a room written before wave 23, which is every room that
		// existed then and no room that was mid-draft. Present and not a number
		// is a record this build does not understand.
		if (a.draftStartedAt !== undefined && a.draftStartedAt !== null && typeof a.draftStartedAt !== 'number') {
			throw new Error('app.draftStartedAt is not a number');
		}
		// Absent is a room written before wave 73 §A, which drafted the server's one global cube.
		if (a.plan !== undefined && !DraftPlanSchema.safeParse(a.plan).success) throw new Error('app.plan is invalid');
		if (a.planVerdict !== undefined && a.planVerdict !== null && !PoolVerdictSchema.safeParse(a.planVerdict).success) {
			throw new Error('app.planVerdict is invalid');
		}
		// Absent is a room written before wave 72 §P, which has nobody seated.
		if (a.podSeats !== undefined && !isStoredPodSeats(a.podSeats)) throw new Error('app.podSeats is invalid');
		if (a.podAi !== undefined && !isStoredPodSeats(a.podAi)) throw new Error('app.podAi is invalid');
		// Absent is a room written before wave 72 §P, or whose rounds never started.
		if (a.pod !== null && a.pod !== undefined && !isStoredPodRecord(a.pod)) throw new Error('app.pod is invalid');
		if (a.podPlaying !== undefined && !(Array.isArray(a.podPlaying) && a.podPlaying.every((m) => typeof m === 'string'))) {
			throw new Error('app.podPlaying is not a list of member ids');
		}
		// Absent is a room written before tournament mode. Each value's own shape
		// (a Classic/Random deck) is opaque
		// here, the same discipline `MemberRecord.state` already keeps.
		if (a.lockedDecks !== undefined && !isStoredLockedDecks(a.lockedDecks)) throw new Error('app.lockedDecks is invalid');
		// `gauntlets` (per-table) is the current shape; `gauntlet` (per-room) is
		// the pre-tournament one, read ONLY when `gauntlets` is absent (a record
		// this build never writes both for — see the migration below).
		if (a.gauntlets !== undefined && !isStoredGauntlets(a.gauntlets)) throw new Error('app.gauntlets is invalid');
		if (a.gauntlets === undefined && a.gauntlet !== undefined && a.gauntlet !== null && !isGauntletState(a.gauntlet)) {
			throw new Error('app.gauntlet is invalid');
		}
		if (a.testing !== undefined && typeof a.testing !== 'boolean') throw new Error('app.testing is invalid');
		if (a.scenario !== undefined && typeof a.scenario !== 'string') throw new Error('app.scenario is invalid');
		if (a.scheduledFor !== undefined && typeof a.scheduledFor !== 'number') throw new Error('app.scheduledFor is invalid');
		if (a.secret !== null && !isSecret(a.secret)) throw new Error('app.secret is invalid');
		const mode = storedMode(a);
		const settings = storedSettings(a.settings as Partial<RoomSettings> | undefined);
		const matchId = a.matchId as string | null;
		// Migrated from the pre-wave-71 shape: one table, holding the room's old
		// `matchId`, sized by `seriesFormatOf` from the `gameType` already read
		// above. The id is DERIVED from the room id (`migratedTableId`),
		// not minted randomly: nothing here persists the migration (a read must
		// not write), so re-deserializing the same pre-wave-71 record on every
		// boot has to land on the SAME id each time for "stable for the room's
		// life" to hold — a format id (`newestFormat()`) and `clientMode`
		// (`'builtin'`) are migrated the same deterministic way already.
		const seriesRoom: SeriesRoom = { gameType: gameType.data, mode: mode.mode };
		const tables: StoredTable[] =
			a.tables === undefined
				? [
						{
							id: migratedTableId(ctx.roomId),
							seats: [null, null],
							matchId,
							series: newSeries(seriesRoom, [null, null], matchId !== null ? 'playing' : 'seating'),
						},
					]
				: (a.tables as Parameters<typeof storedTable>[0][]).map((t) => storedTable(t, seriesRoom));
		return {
			name: a.name,
			creator: a.creator,
			leader: a.leader,
			gameType: gameType.data,
			format: a.format === undefined ? null : (a.format as FormatId),
			settings,
			...mode,
			clientMode: clientMode.data,
			tables,
			matchId,
			matches: a.matches === undefined ? [] : [...(a.matches as string[])],
			draftStartedAt: a.draftStartedAt === undefined ? null : (a.draftStartedAt as number | null),
			plan: a.plan === undefined ? DEFAULT_PLAN : (a.plan as DraftPlan),
			planVerdict: a.planVerdict === undefined ? null : (a.planVerdict as PoolVerdict | null),
			podSeats: a.podSeats === undefined ? new Array<string | null>(POD_SEATS).fill(null) : [...(a.podSeats as (string | null)[])],
			podAi: a.podAi === undefined ? new Array<string | null>(POD_SEATS).fill(null) : [...(a.podAi as (string | null)[])],
			pod: a.pod === undefined || a.pod === null ? null : (a.pod as PodRecord),
			podPlaying: a.podPlaying === undefined ? [] : [...(a.podPlaying as string[])],
			lockedDecks: a.lockedDecks === undefined ? {} : { ...(a.lockedDecks as Record<string, unknown>) },
			// Migrated from the pre-tournament one-per-room shape (`gauntlets`'s own
			// doc): a record with the old field and no new one lands its single
			// Gauntlet on `tables[0]`, the only table such a record could ever have
			// had. Never both — `#persist` only ever writes `gauntlets` from here on.
			gauntlets:
				a.gauntlets !== undefined
					? { ...(a.gauntlets as Record<string, GauntletState>) }
					: a.gauntlet !== undefined && a.gauntlet !== null && tables.length > 0
						? { [tables[0]!.id]: a.gauntlet as GauntletState }
						: {},
			// Absent is a room written before testing rooms existed: every such room is an ordinary one.
			testing: a.testing === true,
			...(a.scenario === undefined ? {} : { scenario: a.scenario as string }),
			...(a.scheduledFor === undefined ? {} : { scheduledFor: a.scheduledFor as number }),
			secret: a.secret === null ? null : { salt: (a.secret as Secret).salt, hash: (a.secret as Secret).hash },
		};
	},
};

const codec: RoomCodec<StoredApp, unknown> = { app: appCodec };

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

function viewOf(room: RoomRecord, locked: boolean, checks: PodChecks): RoomView {
	return {
		id: room.id,
		name: room.name,
		creator: room.creator,
		leader: room.leader,
		gameType: room.gameType,
		format: room.format,
		settings: { ...room.settings, tournamentDecks: tournamentDecksOf(room) },
		mode: room.mode,
		modeOptions: room.modeOptions === null ? null : { ...room.modeOptions },
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
		tables: room.tables.map((t) => tableView(t, room.members, room)),
		// The FIRST table's live match — unchanged, so every existing reader
		// keeps working (`docs/planning/wave71-2026-10-17.md`'s wire contract).
		matchId: room.tables[0]?.matchId ?? null,
		draftStartedAt: room.draftStartedAt === null ? null : new Date(room.draftStartedAt).toISOString(),
		pod: usesPod(room) ? podViewOf(room, checks) : null,
		ai: roomAi(room),
		createdAt: new Date(room.createdAt).toISOString(),
		testing: room.testing,
		...(room.scenario === undefined ? {} : { scenario: room.scenario }),
		scheduledFor: room.scheduledFor === undefined ? null : new Date(room.scheduledFor).toISOString(),
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

/** `t-` plus 8 hex characters, per the wire contract. Re-rolls on a collision against `existing`. */
function mintTableId(existing: readonly string[]): string {
	const held = new Set(existing);
	let id = `t-${randomBytes(4).toString('hex')}`;
	while (held.has(id)) id = `t-${randomBytes(4).toString('hex')}`;
	return id;
}

/**
 * The first table's id for a room migrated from before wave 71 — DETERMINISTIC,
 * unlike `mintTableId`: nothing persists the migration on its own (a read must
 * not write, and `appCodec.deserialize` runs on every boot until something
 * else touches the room), so the same room id has to land on the same table
 * id every time for "stable for the room's life" to hold.
 */
function migratedTableId(roomId: string): string {
	return `t-${createHash('sha256').update(roomId).digest('hex').slice(0, 8)}`;
}

/**
 * The cardtable room a watchparty room's game slot is bound to.
 *
 * A digest, not the watchparty name. Watchparty hands the embed its room ID
 * (the same for the leader and viewers), but that id is opaque to us — any
 * length or alphabet — and a room id must fit `ROOM_ID_RE` and is printed in
 * the list and every log line. Were a leader KEY ever passed by mistake
 * (`<room>-<16 hex>`, a credential), the digest still never prints it. `wp-`
 * keeps it apart from `r-` (minted) ids; 20 hex is 80 bits.
 */
export function watchpartyRoomId(watchpartyRoom: string): string {
	return `wp-${createHash('sha256').update(watchpartyRoom).digest('hex').slice(0, 20)}`;
}

/** What a bound room is made as. The leader changes the game type and pool afterwards. */
const WATCHPARTY_ROOM: CreateRoomInput = { name: 'Watchparty table', gameType: DEFAULT_GAME_TYPE, clientMode: DEFAULT_CLIENT_MODE };

/**
 * Every readiness flag and deck hold — what a change to the table's pool or
 * mode costs everybody. The per-member blob `http/routes.ts` owns — the
 * choice, the verdict, the checked `.dck` — was produced for the table that
 * just changed, so it is dropped whole rather than edited. The seats stay
 * (the operator, 2026-10-23: "can we try to keep players seated?") unless
 * `unseat`: a game type change or a tournament's lock retires the tables.
 */
function dropHolds(room: RoomRecord, unseat: boolean): void {
	for (const member of room.members) {
		member.ready = false;
		member.state = undefined;
	}
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

/** A Gauntlet whose reveal has started, and that is not yet done — true if ANY of the room's tables is one. */
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
	#log: LobbyLog;
	readonly #avatarListeners = new Set<AvatarChangeListener>();
	readonly #changeListeners = new Set<RoomChangeListener>();
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

	/** The pool a room minted here starts on, asked once per room. Resolved by `openLobby`. */
	#newRoomFormat: () => FormatId;

	/** Wave 72 §P. Unwired until `setPodChecks` runs — see `PodChecks`'s own doc. */
	#podChecks: PodChecks = NO_POD_CHECKS;

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
		this.#ensurePlanChecked(room);
	}

	#view(room: RoomRecord): RoomView {
		return viewOf(room, this.#secrets.has(room.id), this.#podChecks);
	}

	#persist(room: RoomRecord): void {
		for (const table of room.tables) this.#settleSeries(room, table, false);
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
			settings: { ...room.settings },
			mode: room.mode,
			modeOptions: room.modeOptions === null ? null : { ...room.modeOptions },
			clientMode: room.clientMode,
			tables: room.tables.map((t) => ({ ...t, seats: [...t.seats] as [string | null, string | null], series: { ...t.series, wins: [...t.series.wins] as [number, number], games: t.series.games.map((g) => ({ ...g })) } })),
			// Restated for a rollback to a pre-wave-71 build (see `StoredApp.matchId`'s doc).
			matchId: room.tables[0]?.matchId ?? null,
			matches: [...room.matches],
			draftStartedAt: room.draftStartedAt,
			plan: room.plan,
			planVerdict: room.planVerdict,
			podSeats: [...room.podSeats],
			podAi: [...room.podAi],
			podPlaying: [...room.podPlaying],
			lockedDecks: { ...room.lockedDecks },
			gauntlets: { ...room.gauntlets },
			testing: room.testing,
			...(room.scenario === undefined ? {} : { scenario: room.scenario }),
			...(room.scheduledFor === undefined ? {} : { scheduledFor: room.scheduledFor }),
			pod:
				room.pod === null
					? null
					: {
							...room.pod,
							humans: [...room.pod.humans],
							results: room.pod.results.map((r) => ({ ...r })),
							pairings: room.pod.pairings.map((p) => ({ tableId: p.tableId, players: [...p.players] as [string, string] })),
						},
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
		return [...this.#rooms.values()]
			.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
			.map((r) => this.#view(r));
	}

	/** In memory only: a read is not a mutation and must not write a file. */
	#touchedAt = new Map<string, number>();

	touch(roomId: string, memberId: string): void {
		if (this.isMember(roomId, memberId)) this.#touchedAt.set(roomId, this.#now());
	}

	offered(staleMs: number = ROOM_STALE_MS): RoomView[] {
		const cutoff = this.#now() - staleMs;
		return [...this.#rooms.values()]
			.filter(
				(r) =>
					// A seeded testing room is never empty-hidden and never stale: it is
					// seeded with its system creator as its only member and nobody else
					// ever has to touch it for an admin to keep seeing it offered.
					r.testing ||
					// An empty room is hidden AT ONCE (R16) — there is nobody left to read
					// it, so waiting out `staleMs` would advertise it, untouched, for up to
					// thirty more minutes after its last member walked out.
					(r.members.length > 0 &&
						(r.tables.some((t) => t.matchId !== null) ||
							r.draftStartedAt !== null ||
							// A room made for an event is advertised until it has been
							// untouched for `staleMs` past its start, however far off that is.
							Math.max(r.updatedAt, this.#touchedAt.get(r.id) ?? 0, r.scheduledFor ?? 0) > cutoff)),
			)
			.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
			.map((r) => this.#view(r));
	}

	roomOfMatch(matchId: string): RoomView | undefined {
		for (const room of this.#rooms.values()) {
			if (room.tables.some((t) => t.matchId === matchId) || room.matches.includes(matchId)) return this.#view(room);
		}
		return undefined;
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

	#table(roomId: string, tableId: string): { room: RoomRecord; table: TableRecord } | undefined {
		const room = this.#rooms.get(roomId);
		const table = room?.tables.find((t) => t.id === tableId);
		return room === undefined || table === undefined ? undefined : { room, table };
	}

	#recordMatch(room: RoomRecord, matchId: string): void {
		if (!room.matches.includes(matchId)) room.matches = [...room.matches, matchId].slice(-ROOM_MATCHES_KEPT);
	}

	seats(roomId: string, tableId: string): TableSeat[] {
		const found = this.#table(roomId, tableId);
		return found === undefined ? [] : seatList(found.table);
	}

	sit(roomId: string, tableId: string, memberId: string): boolean {
		const found = this.#table(roomId, tableId);
		if (found === undefined || !found.room.members.some((m) => m.id === memberId)) return false;
		const { room, table } = found;
		if (table.seats.includes(memberId)) return true;
		if (!sitAt(room.tables, table, memberId)) return false;
		this.#persist(room);
		return true;
	}

	stand(roomId: string, tableId: string, memberId: string): boolean {
		const found = this.#table(roomId, tableId);
		if (found === undefined) return false;
		if (leaveSeat(found.table, memberId)) this.#persist(found.room);
		return true;
	}

	releaseAbandonedSeats(memberId: string): { roomId: string; tableId: string }[] {
		const released: { roomId: string; tableId: string }[] = [];
		for (const room of this.#rooms.values()) {
			for (const table of room.tables) {
				if (!table.seats.includes(memberId)) continue;
				if (table.matchId !== null) continue;
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
			table.series = newSeries(seriesRoomOf(room), table.seats, 'playing');
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
		if (!table.series.settled) table.series = recordGame(table.series, seriesFormatOf(seriesRoomOf(room)), { matchId: result.matchId, winner: result.winner, ...ms });
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
		table.series = newSeries(seriesRoomOf(room), table.seats, 'seating');
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
		const dropper = table.seats.indexOf(callerId);
		if (dropper === -1 || !pairing.players.includes(callerId)) return { ok: false, reason: 'not-seated' };
		if (table.series.phase === 'done') return { ok: false, reason: 'nothing-to-drop' };
		const { matchId } = table;
		const { series } = table;
		const needed = Math.floor(series.length / 2) + 1;
		const other = dropper === 0 ? 1 : 0;
		const wins: [number, number] = [0, 0];
		wins[other] = Math.max(series.wins[other] ?? 0, needed);
		wins[dropper] = Math.min(series.wins[dropper] ?? 0, needed - 1);
		table.matchId = null;
		table.ready = [false, false];
		// Before a first game the series names nobody; the seats are who played it.
		const played: [string | null, string | null] = series.games.length === 0 ? [table.seats[0] ?? null, table.seats[1] ?? null] : series.played;
		table.series = { ...series, played, wins, phase: 'done', gameStartedAt: null };
		this.#settleSeries(room, table, true);
		table.series = { ...table.series, settled: true };
		this.#finishPodTable(room, table);
		this.#persist(room);
		this.#log({ event: 'table-dropped', roomId, tableId, by: callerId, matchId, wins });
		return { ok: true, matchId };
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
		const stillPlaying = pod.pairings.some((p) => {
			if (p.tableId === table.id) return false;
			const t = room.tables.find((x) => x.id === p.tableId);
			return t === undefined || t.series.phase !== 'done';
		});
		if (!stillPlaying) this.#advancePodRound(room, pod);
	}

	/**
	 * Every one of the current round's tables is `done`. Pair the next round
	 * (`pairRound`, `@hadoku/draft`) and make its tables, or — this was the
	 * last round — mark the pod `done`: `round` moves one PAST `rounds`,
	 * which is what `podPhaseOf` reads as `done`.
	 *
	 * A tournament pod's round can pair two AI entrants against each other
	 * (`#pairRound`'s own split): that pairing settles at once, with no
	 * table. When EVERY pairing of the round does (a round of nothing but AI
	 * vs AI — rare, but a few AI entrants can outnumber the humans left after
	 * byes), there is nothing live to wait on, so this advances past it
	 * immediately rather than stranding the pod on a round with zero tables.
	 */
	#advancePodRound(room: RoomRecord, pod: PodRecord): void {
		if (pod.round >= pod.rounds) {
			room.pod = { ...pod, round: pod.rounds + 1, pairings: [], bye: null };
			this.#log({ event: 'pod-done', roomId: room.id });
			this.#archive(room);
			return;
		}
		const nextRound = pod.round + 1;
		const { pairings, settled, bye } = this.#pairRound(room, podPlayers(room, pod.humans), pod.results, nextRound);
		const byeResult: MatchResult[] = bye === null ? [] : [{ round: nextRound, playerA: bye, playerB: null, gamesA: 2, gamesB: 0 }];
		const results = [...pod.results, ...byeResult, ...settled];
		room.pod = { ...pod, round: nextRound, results, pairings, bye };
		this.#log({ event: 'pod-round-started', roomId: room.id, round: nextRound, tables: pairings.length, bye, settled: settled.length });
		if (pairings.length === 0) this.#advancePodRound(room, room.pod);
	}

	/**
	 * One round's pairings, split in two: a LIVE pairing gets a table
	 * (`#newPodTable`); an AI-vs-AI pairing — possible only in a TOURNAMENT
	 * pod, which is the only one that ever seats more than one AI entrant —
	 * is settled at once with no game at all (the operator, 2026-10-22:
	 * *"settle that match without a game… rather than spin up an AI-vs-AI
	 * Forge match"*). Deterministic, not random, so a restart and a test both
	 * see the same answer: the lower pod seat wins 2-0.
	 */
	#pairRound(
		room: RoomRecord,
		players: PodPlayer[],
		results: MatchResult[],
		round: number,
	): { pairings: { tableId: string; players: [string, string] }[]; settled: MatchResult[]; bye: string | null } {
		const paired = pairRound({ players, results, round });
		const pairings: { tableId: string; players: [string, string] }[] = [];
		const settled: MatchResult[] = [];
		for (const [a, b] of paired.tables) {
			if (isAiEntrant(a) && isAiEntrant(b)) {
				const [winner, loser] = aiEntrantSeat(a) < aiEntrantSeat(b) ? [a, b] : [b, a];
				settled.push({ round, playerA: winner, playerB: loser, gamesA: 2, gamesB: 0 });
			} else {
				pairings.push({ tableId: this.#newPodTable(room, a, b), players: [a, b] });
			}
		}
		return { pairings, settled, bye: paired.bye };
	}

	/**
	 * One pod table: bo3 with sideboarding (`seriesFormatOf` of any draft room
	 * or tournament pod, `draft-pods-plan.md` ruling 1 and
	 * `docs/planning/tournament-mode-plan.md`'s Design).
	 *
	 * A DRAFT pod seats both players with their saved built deck
	 * (`PodChecks.seatState`); a player `seatState` answers `null` for
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
	#newPodTable(room: RoomRecord, a: string, b: string | null): string {
		const aIsAi = isAiEntrant(a);
		const bIsAi = b !== null && isAiEntrant(b);
		const seats: [string, string | null] = aIsAi ? [b!, null] : [a, bIsAi ? null : b];
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
			const state = this.#podChecks.seatState(room.id, id);
			if (state !== null && state !== undefined) member.state = state;
		}
		if (isTournamentRoom(room) && room.mode !== 'gauntlet') {
			this.#seatTournamentDeck(room, table.id, a);
			if (b !== null) this.#seatTournamentDeck(room, table.id, b);
		}
		return table.id;
	}

	/**
	 * Tournament, Classic/All Random: `entrant`'s deck for `tableId` —
	 * `locked`'s stored snapshot (`room.lockedDecks`, filled once at the lock
	 * — `#lockTournament`) replayed as-is, or `null` for `per-round` (a fresh
	 * pick or deal — `PodChecks.seatTournamentDeck`'s own doc). `entrant` may
	 * be a member id or a tournament AI entrant id; which it is, and what to
	 * do about it, is `PodChecks`'s own business, never this file's.
	 */
	#seatTournamentDeck(room: RoomRecord, tableId: string, entrant: string): void {
		const locked = tournamentDecksOf(room) === 'locked' ? room.lockedDecks[entrant] ?? null : null;
		this.#podChecks.seatTournamentDeck(room.id, tableId, entrant, locked);
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
	 * seats, and each still holds the deck it played (`PodChecks.holdsSeriesDeck`
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
		return this.#stillSeated(table) && series.played.every((id) => id === null || this.#podChecks.holdsSeriesDeck(room.members.find((m) => m.id === id)?.state));
	}

	/** Whoever played the table's series still holds the seat they played it in. */
	#stillSeated(table: TableRecord): boolean {
		return table.series.played.every((id, seat) => table.seats[seat] === id);
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
			table.series = newSeries(room, unseat ? [null, null] : table.seats, 'seating');
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
		const index = room.members.findIndex((m) => m.id === memberId);
		if (index === -1) return { ok: false, reason: 'not-member' };
		const wasLeader = room.leader === memberId;
		for (const table of room.tables) {
			this.#settleSeries(room, table, false, memberId);
			leaveSeat(table, memberId);
		}
		room.members.splice(index, 1);
		// The operator's ruling: leadership passes to whoever remaining joined
		// EARLIEST, not to array order (today the same thing, since `join`
		// appends — restated explicitly so that stops being an assumption).
		if (wasLeader && room.members.length > 0) {
			room.leader = room.members.reduce((earliest, m) => (m.joinedAt < earliest.joinedAt ? m : earliest)).id;
		}
		this.#persist(room);
		this.#log({ event: 'room-left', roomId, members: room.members.length, newLeader: room.leader });
		return { ok: true, room: this.#view(room) };
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
			podSeats: new Array<string | null>(POD_SEATS).fill(null),
			podAi: new Array<string | null>(POD_SEATS).fill(null),
			pod: null,
			podPlaying: [],
			lockedDecks: {},
			gauntlets: {},
			testing: input.testing === true,
			...(input.scenario === undefined ? {} : { scenario: input.scenario }),
			...(input.scheduledFor === undefined ? {} : { scheduledFor: input.scheduledFor }),
			createdAt: now,
			updatedAt: now,
			members: [newMember([], caller, now)],
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
		if (room.members.some((m) => m.id === caller.id)) {
			return { ok: true, room: this.#view(room), alreadyMember: true };
		}
		const secret = this.#secrets.get(roomId);
		if (secret !== undefined && !passwordMatches(secret, password ?? '')) {
			return { ok: false, reason: 'no-match' };
		}
		// An emptied room's leader left with everyone else: whoever comes in
		// first leads it (a seeded testing room is empty from the start).
		if (room.members.length === 0) room.leader = caller.id;
		room.members.push(newMember(room.members, caller, this.#now()));
		this.#persist(room);
		this.#log({ event: 'room-joined', roomId, members: room.members.length });
		return { ok: true, room: this.#view(room), alreadyMember: false };
	}

	rename(caller: Caller): void {
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
		member.ready = ready;
		// In a pod's lobby, Ready is "I am playing": a member who has not sat takes
		// the first open seat. A full pod leaves them watching, ready or not — the
		// deal never waits on a member who holds no seat.
		if (ready && room.gameType === 'draft' && room.draftStartedAt === null && !room.podSeats.includes(memberId)) {
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
		// Idempotent, and it does not WRITE when nothing changed. The browser
		// asserts its avatar on every page load (`apps/ui/src/room/RoomShell.tsx`),
		// which for a room somebody leaves open all evening would otherwise be a
		// snapshot write per reload for a value that never moved. `true` either
		// way: the caller asked for a state and the room is in it.
		// A pick of the character the room handed out makes it picked, which
		// changes nothing anybody sees.
		delete member.avatarGiven;
		if (next === member.avatarId) return true;
		if (next === undefined) delete member.avatarId;
		else member.avatarId = next;
		// A pick wins over a character the room handed somebody else: they are
		// given the next free one, as watchparty's join gives a taken sprite's
		// asker the next free one. Their own pick, when they have one, is never moved.
		const moved = room.members.filter((m) => m !== member && m.avatarGiven === true && m.avatarId === next);
		for (const m of moved) {
			const free = freeAvatar(room.members);
			if (free === undefined) {
				delete m.avatarId;
				delete m.avatarGiven;
			} else m.avatarId = free;
		}
		this.#persist(room);
		for (const m of [member, ...moved]) this.#announceAvatar(roomId, m.id, m.avatarId ?? null);
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
		if (isTournamentRoom(room)) return this.#lockTournament(room);
		if (room.gameType !== 'draft') return { ok: false, reason: 'not-draft' };
		// Every seat filled — a member or the AI — and every seated member ready.
		// The operator, 2026-10-19: *"drafts should not immediately start with
		// open seats"* and *"the room should not wait on spectators to be
		// ready"*: a member who never sat is watching, and is not waited on.
		const seated = seatedHumans(room);
		if (seated.length === 0 || room.podSeats.includes(null)) return { ok: false, reason: 'not-ready' };
		if (seated.some((id) => room.members.find((m) => m.id === id)?.ready !== true)) return { ok: false, reason: 'not-ready' };
		// The operator, on playability: "it shouldn't even get to the drafting
		// stage" — a SERVER rule, checked last (after every other gate, so an
		// unrelated refusal still reports its OWN reason), because this is the
		// one gate nothing upstream of here can be trusted to have enforced. A
		// UI disabling Start on a bad verdict is not this: a direct POST must
		// refuse too. `null` (never checked, or a check still in flight) and
		// `ok: false` (refused) are the same answer here — neither may deal.
		if (room.planVerdict === null || !room.planVerdict.ok) return { ok: false, reason: 'plan-not-ready' };
		room.draftStartedAt = this.#now();
		this.#persist(room);
		this.#log({ event: 'room-draft-started', roomId, members: room.members.length, seated: seated.length });
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
		if (!isTournamentRoom(room) || room.draftStartedAt !== null) return;
		this.#lockTournament(room);
	}

	/**
	 * Lock a tournament's seats and deal round 1 — called the instant the
	 * field is valid (`#maybeLockTournament`'s own doc; ruling 7). ≥ 2
	 * entrants, at least one human (the operator, 2026-10-22: reversing the
	 * plan's "no AI seats", but *"an all-AI field makes no sense"*), each
	 * HUMAN ready per the mode (Classic: a legal deck already held —
	 * `PodChecks.hasLegalSeatDeck`; Gauntlet/All Random: the room's own
	 * `ready` flag). An AI entrant is always ready and never checked.
	 *
	 * `tournamentDecks === 'locked'` snapshots every entrant's CURRENT deck
	 * here for Classic/All Random (`PodChecks.currentTournamentDeck`); a
	 * Gauntlet has no locked decks (`tournamentDecksOf`).
	 *
	 * The field is fixed from here: `sitPod`/`standPod`/`aiPod`/`closePod`
	 * all refuse once `draftStartedAt !== null`, same as a draft pod's does.
	 */
	#lockTournament(room: RoomRecord): StartDraftResult {
		const entrants = podEntrants(room);
		if (entrants.length < POD_MIN_OPEN || entrants.every(isAiEntrant)) return { ok: false, reason: 'not-ready' };
		const humanReady = (id: string): boolean =>
			room.mode === 'classic' ? this.#podChecks.hasLegalSeatDeck(room.id, id) : room.members.find((m) => m.id === id)?.ready === true;
		if (entrants.some((id) => !isAiEntrant(id) && !humanReady(id))) return { ok: false, reason: 'not-ready' };
		if (tournamentDecksOf(room) === 'locked') {
			// `currentTournamentDeck` may itself re-enter `rooms.get()` (its real
			// `routes.ts` implementation reads the room to find a pool/format).
			// Safe here: `draftStartedAt` is still null, so any such read answers
			// `lobby`, same as it would before this function was ever called.
			const lockedDecks = { ...room.lockedDecks };
			for (const id of entrants) lockedDecks[id] = this.#podChecks.currentTournamentDeck(room.id, id);
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
		// (`#newPodTable`'s `PodChecks.seatTournamentDeck` re-enters
		// `rooms.get()` per table, same as `currentTournamentDeck` above can);
		// a read that lands inside THAT window must see a pod that genuinely
		// is in `rounds` — not `draftStartedAt` set with no pod to show for it
		// (`podPhaseOf`'s own doc: that is the exact crash a real run hit). The
		// skeleton this sets is overwritten with the real pairings before this
		// function returns.
		room.draftStartedAt = this.#now();
		room.pod = { humans: entrants, round: 1, rounds: roundsFor(entrants.length), results: [], pairings: [], bye: null };
		this.#dealPodRounds(room, entrants);
		this.#persist(room);
		this.#log({ event: 'tournament-locked', roomId: room.id, entrants: entrants.length, humans: entrants.filter((id) => !isAiEntrant(id)).length });
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
		// The type is the room's shape, the mode a part of it: what freezes the mode freezes the type.
		if (room.gameType !== gameType && modeLocked(room)) return { ok: false, reason: 'mode-locked' };
		if (room.gameType !== gameType) {
			room.gameType = gameType;
			room.mode = null;
			room.modeOptions = null;
			room.gauntlets = {};
			this.#interruptSeries(room, true);
		}
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
		if (inPlay(room)) return { ok: false, reason: 'mode-locked' };
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
		if (modeLocked(room)) return { ok: false, reason: 'mode-locked' };
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
		if (room.draftStartedAt !== null) return { ok: false, reason: 'draft-started' };
		const next = { ...room.settings, ...settings };
		if (SETTING_KEYS.every((k) => next[k] === room.settings[k])) return { ok: true, room: this.#view(room) };
		room.settings = next;
		this.#persist(room);
		this.#log({ event: 'room-settings', roomId, settings: next });
		return { ok: true, room: this.#view(room) };
	}

	sweep(idleMs?: number): string[] {
		const dropped: string[] = [];
		for (const [id, room] of this.#rooms) {
			// A seeded testing room is never idle-reaped — it is seeded with its
			// system creator as its only member for its whole life, so "nobody has
			// touched it" would otherwise be true of it the instant it is created.
			if (room.testing) continue;
			// A game in progress: its players are on the match's screen, not touching the lobby. A
			// game that never ends is the sweep's other half, called a draw at `GAME_DRAWN_AFTER_MS`.
			if (room.tables.some((t) => t.matchId !== null)) continue;
			const idle = idleMs ?? (usesPod(room) ? ROOM_IDLE_MS : CASUAL_ROOM_IDLE_MS);
			// A room made for an event ages from its start, not from when it was made.
			if (Math.max(room.updatedAt, room.scheduledFor ?? 0) > this.#now() - idle) continue;
			// A pod in progress. Nobody touches the lobby for the forty minutes a
			// draft takes, and the room is the pod's container — reaping it would
			// end the game. A pod survives restarts now, so the spare is bounded by
			// its age, or an abandoned pod would keep its room forever.
			if (room.draftStartedAt !== null && room.draftStartedAt > this.#now() - POD_SPARED_MS) continue;
			this.#archive(room);
			this.#forget(id);
			dropped.push(id);
			this.#log({ event: 'room-forgotten', roomId: id, idleMs: idle });
		}
		return dropped;
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
		this.#secrets.delete(id);
		this.#touchedAt.delete(id);
		// Logged, because a store that cannot delete must not resurrect the room on the next boot silently.
		void this.#store.remove(id).catch((err: unknown) => {
			this.#log({ event: 'room-forget-failed', roomId: id, err: String(err) });
		});
		this.#changed(id);
	}

	/** A pod that finished a match goes to the tournaments: finished, or ended early by a close or the sweep. */
	#archive(room: RoomRecord): void {
		const pod = room.pod;
		if (pod === null || room.draftStartedAt === null || !pod.results.some((r) => r.playerB !== null)) return;
		// A draft pod's shared bot (`POD_AI`) is named once; a tournament
		// pod's own AI entrants (one per AI seat, `aiEntrantId`) are each
		// named from the character its seat was given (`room.podAi`, kept
		// through the pod's life — see the field's own doc).
		const aiNames = Object.fromEntries(pod.humans.filter(isAiEntrant).map((id) => [id, entrantPersona(room, id).name]));
		this.#onTournament({
			id: `${room.id}-${room.draftStartedAt}`,
			name: room.name,
			startedAt: room.draftStartedAt,
			endedAt: this.#now(),
			closed: pod.round <= pod.rounds,
			rounds: pod.rounds,
			names: { ...Object.fromEntries(room.members.map((m) => [m.id, m.name])), [POD_AI]: roomAi(room).name, ...aiNames },
			standings: rankedStandings(pod.humans, pod.results),
			results: pod.results,
		});
	}

	/* ── the pod (wave 72 §P) ───────────────────────────────────────────── */

	setPodChecks(checks: PodChecks): void {
		this.#podChecks = checks;
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
		return room.gauntlets[tableId ?? room.tables[0]!.id] ?? null;
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
		if (room === undefined || !isTournamentRoom(room)) return null;
		const pairing = room.pod?.pairings.find((p) => p.tableId === tableId);
		if (pairing === undefined) return null;
		const [a, b] = pairing.players;
		// The AI's slot (if either is one) always LAST, matching the seat
		// convention `http/gauntlet.ts`'s vs-AI ready already uses (the human is
		// Gauntlet seat 0, the synthesized AI player seat 1) — never both: an
		// AI-vs-AI pairing settles without a table (`#pairRound`'s own doc).
		const entrants: [string, string] = isAiEntrant(a) ? [b, a] : [a, b];
		return isAiEntrant(entrants[1]) ? { entrants, ai: entrantPersona(room, entrants[1]) } : { entrants };
	}

	podDraft(roomId: string): PodDeal | null {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return null;
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
		this.#log({ event: 'pod-plan-set', roomId, memberId, planName: planDisplayName(plan, this.#podChecks.roundNamesOf(plan)) });
		return { ok: true, room: this.#view(room) };
	}

	sitPod(roomId: string, memberId: string, seat?: number): SitPodResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		if (!room.members.some((m) => m.id === memberId)) return { ok: false, reason: 'not-member' };
		// `not-draft` also covers a constructed room with tournament off: `usesPod` is the one question for both.
		if (!usesPod(room)) return { ok: false, reason: 'not-draft' };
		if (room.draftStartedAt !== null) return { ok: false, reason: 'not-lobby' };
		if (seat !== undefined && (!Number.isInteger(seat) || seat < 0 || seat >= POD_SEATS)) {
			return { ok: false, reason: 'bad-seat' };
		}
		const seats = [...room.podSeats];
		const already = seats.indexOf(memberId);
		if (already !== -1) seats[already] = null;
		let target = seat;
		if (target === undefined) {
			target = seats.indexOf(null);
			if (target === -1) return { ok: false, reason: 'pod-full' };
		} else if (seats[target] !== null) {
			return { ok: false, reason: 'seat-taken' };
		}
		seats[target] = memberId;
		room.podSeats = seats;
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
		if (room.draftStartedAt !== null) return { ok: false, reason: 'not-lobby' };
		const index = room.podSeats.indexOf(memberId);
		if (index === -1) return { ok: true, room: this.#view(room) };
		const seats = [...room.podSeats];
		seats[index] = null;
		room.podSeats = seats;
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
		if (room.draftStartedAt !== null) return { ok: false, reason: 'not-lobby' };
		if (!Number.isInteger(seat) || seat < 0 || seat >= POD_SEATS) return { ok: false, reason: 'bad-seat' };
		const now = room.podSeats[seat] ?? null;
		if (on ? now === POD_AI : now === null) return { ok: true, room: this.#view(room) };
		if (now !== (on ? null : POD_AI)) return { ok: false, reason: 'seat-taken' };
		const avatar = on ? freeAiAvatar(room) : null;
		const seats = [...room.podSeats];
		seats[seat] = on ? POD_AI : null;
		room.podSeats = seats;
		room.podAi = room.podAi.map((a, i) => (i === seat ? avatar : a));
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
		if (room.draftStartedAt !== null) return { ok: false, reason: 'not-lobby' };
		if (!Number.isInteger(seat) || seat < 0 || seat >= POD_SEATS) return { ok: false, reason: 'bad-seat' };
		const now = room.podSeats[seat] ?? null;
		if (closed ? now === POD_CLOSED : now === null) return { ok: true, room: this.#view(room) };
		if (now !== (closed ? null : POD_CLOSED)) return { ok: false, reason: 'seat-taken' };
		if (closed && podSize(room) <= POD_MIN_OPEN) return { ok: false, reason: 'too-few' };
		room.podSeats = room.podSeats.map((id, i) => (i === seat ? (closed ? POD_CLOSED : null) : id));
		this.#persist(room);
		this.#log({ event: closed ? 'pod-seat-closed' : 'pod-seat-opened', roomId, memberId, seat, size: podSize(room) });
		return { ok: true, room: this.#view(room) };
	}

	playPod(roomId: string, memberId: string): PlayPodResult {
		const room = this.#rooms.get(roomId);
		if (room === undefined) return { ok: false, reason: 'no-room' };
		const phase = room.gameType === 'draft' ? podPhaseOf(room, this.#podChecks) : 'lobby';
		if (phase === 'rounds' || phase === 'done') return { ok: true, room: this.#view(room) };
		const humans = seatedHumans(room);
		if (phase !== 'building' || !humans.includes(memberId)) return { ok: false, reason: 'not-drafter' };
		if (!this.#podChecks.built(roomId, memberId)) return { ok: false, reason: 'not-built' };
		if (!room.podPlaying.includes(memberId)) room.podPlaying = [...room.podPlaying, memberId];
		this.#log({ event: 'pod-play', roomId, memberId });
		if (humans.every((id) => room.podPlaying.includes(id) && this.#podChecks.built(roomId, id))) this.#dealPodRounds(room, humans);
		this.#persist(room);
		return { ok: true, room: this.#view(room) };
	}

	/**
	 * Round 1: a draft pod's, once every drafter is done building
	 * (`playPod`); a tournament pod's, at the lock (`#lockTournament`) —
	 * `entrants` is the one list either caller fixes `PodRecord.humans` to.
	 */
	#dealPodRounds(room: RoomRecord, entrants: string[]): void {
		if (entrants.length === 1) {
			// One drafter, the rest bots: one table, against the AI. A draft
			// pod only — a tournament's lock refuses fewer than two entrants.
			const tableId = this.#newPodTable(room, entrants[0]!, null);
			room.pod = { humans: entrants, round: 1, rounds: 1, results: [], pairings: [{ tableId, players: [entrants[0]!, POD_AI] }], bye: null };
			this.#log({ event: 'pod-rounds-started', roomId: room.id, rounds: 1, tables: 1, opponent: 'ai' });
			return;
		}
		const rounds = roundsFor(entrants.length);
		const { pairings, settled, bye } = this.#pairRound(room, podPlayers(room, entrants), [], 1);
		const byeResult: MatchResult[] = bye === null ? [] : [{ round: 1, playerA: bye, playerB: null, gamesA: 2, gamesB: 0 }];
		room.pod = { humans: entrants, round: 1, rounds, results: [...byeResult, ...settled], pairings, bye };
		this.#log({ event: 'pod-rounds-started', roomId: room.id, rounds, tables: pairings.length, bye, settled: settled.length });
		if (pairings.length === 0) this.#advancePodRound(room, room.pod);
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
			const decoded = decodeSnapshot(snapshot, codec, {
				roomId,
				restoreId: `boot-${now()}`,
				restoredAt: now(),
			});
			const app = decoded.app;
			// A constructed room a leader put on a pod before 2026-10-20, when a
			// room's format could still be `draft:<podId>`. It comes back on the
			// newest era with every deck hold and ready flag dropped — exactly what
			// a format change does (`setFormat`) — since nothing held there was ever
			// checked against a pool a constructed room can be on now.
			const offPod = app.gameType !== 'draft' && app.format !== null && app.format.startsWith(DRAFT_POOL_PREFIX);
			if (offPod) log({ event: 'room-format-off-pod', roomId, format: app.format });
			// A constructed room stored before modes existed was a Classic room.
			const restoredAsClassic = app.mode === undefined && app.gameType === 'constructed-1v1';
			if (restoredAsClassic) log({ event: 'room-mode-restored', roomId, mode: 'classic' });
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
					state: offPod ? undefined : unboxState(m.app),
					// Kept across the restart, unlike the draft itself: the room comes
					// back in its lobby phase with everybody still ready, which is one
					// click from starting again rather than four.
					ready: !offPod && unboxReady(m.app),
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
					// **Restored, like the match and unlike the draft.** A room that came
					// back on a different pool from the one its players loaded their
					// decks against is exactly the bug this field exists to prevent:
					// the decks are restored too (the per-member blob), so the pool
					// they were checked in has to come back with them.
					format: (offPod ? null : app.format) ?? fixed ?? newestFormat(formats),
					settings: app.settings,
					...(restoredAsClassic
						? { mode: 'classic' as const, modeOptions: {} }
						: { mode: app.mode ?? null, modeOptions: app.modeOptions }),
					clientMode: app.clientMode,
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
					draftStartedAt: app.draftStartedAt,
					// Restored, same as any other lobby setting: the leader's pool
					// choice (and its last verdict) outlive a restart same as `format`.
					// `?? ` covers a record written before wave 73 §A, same as `podAi` below.
					plan: app.plan ?? DEFAULT_PLAN,
					planVerdict: app.planVerdict ?? null,
					// Restored, like `ready` and unlike the draft itself: who sat in the
					// pod lobby is a property of the ROOM, not of the in-memory draft, so
					// it survives a restart the room comes back from in its lobby phase.
					podSeats: app.podSeats,
					podAi: app.podAi ?? new Array<string | null>(POD_SEATS).fill(null),
					// Restored with `draftStartedAt`, and released with it.
					pod: app.pod,
					podPlaying: app.podPlaying ?? [],
					// Restored, like `podPlaying`: a tournament's locked deck(s) survive a restart with it.
					lockedDecks: app.lockedDecks ?? {},
					gauntlets: app.gauntlets ?? {},
					// Restored, like every other room-level flag: a restart never turns
					// a testing room into an ordinary one or back.
					testing: app.testing === true,
					...(app.scenario === undefined ? {} : { scenario: app.scenario }),
					...(app.scheduledFor === undefined ? {} : { scheduledFor: app.scheduledFor }),
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
	log({ event: 'lobby-open', rooms: lobby.list().length, newRoomFormat: fixed ?? 'random' });
	return lobby;
}

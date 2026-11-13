/**
 * The saved-room codec: `RoomRecord`/`MemberRecord`/`TableRecord` (the shape a
 * `FileLobby` instance holds in memory) and `StoredApp`/`StoredMagicGame` (the
 * shape `@wolffm/rooms-server/store` persists them as), with the codec that
 * reads one back into the other — `decodeMagicGame`, `appCodec`, `roomCodec`.
 * An unreadable or future-format record is QUARANTINED (`room/lobby.ts`'s own
 * doc), never half-applied.
 *
 * Moved out of `room/lobby.ts` (split, wave 99 §L). `room/lobby.ts` still
 * holds every mutation (`FileLobby`'s own methods); this file only decodes
 * and encodes the record those mutations act on.
 */

import { createHash } from 'node:crypto';
import type { AppCodec, RoomCodec } from '@wolffm/rooms-server/store';
import type { MembershipLedger } from '@wolffm/rooms-server';
import {
	ClientModeSchema,
	DEFAULT_CLIENT_MODE,
	DEFAULT_ROOM_SETTINGS,
	DraftPlanSchema,
	GameTypeSchema,
	MAGIC_ROOM_STORED_KEYS,
	PoolVerdictSchema,
	RoomModeSchema,
	RoomSettingsSchema,
	SeriesPhaseSchema,
	type ClientMode,
	type ConstructedMode,
	type DraftPlan,
	type GameType,
	type Look,
	type ModeOptions,
	type PoolVerdict,
	type RoomSettings,
} from '@hadoku/shared';
import type { PodStructure } from '@hadoku/draft';
import { isGauntletState, type GauntletState } from './gauntlet.ts';
import type { TableSeats } from '@hadoku/game-server/room/seats';
import { newSeries, statsModeOf, type SeriesGame, type SeriesRecord, type SeriesRoom } from './series.ts';
import { DEFAULT_PLAN } from './draftRooms.ts';
import {
	copySplit,
	isStoredGauntlets,
	isStoredLockedDecks,
	isStoredPodRecord,
	initialPodSize,
	isStoredPodSeats,
	isStoredPodSplit,
	type PodRecord,
	type PodSplit,
} from './pods.ts';
import type { Secret } from '@hadoku/game-server/room/provisioning';
import type { FormatId } from './lobby.ts';

/** Every setting has a default, so a room stored before a setting existed reads back on it without a migration. */
export const SETTING_KEYS = Object.keys(DEFAULT_ROOM_SETTINGS) as (keyof RoomSettings)[];
/** Settings a room stored before they were retired: read and dropped, so the room still parses. */
const RETIRED_SETTING_KEYS = ['matchLength', 'sideboarding'];

// ── the stored record ────────────────────────────────────────────────────────

/** One of a room's tables: who sits at it and their Readys (`seats.ts`), its live match and its series. */
export interface TableRecord extends TableSeats {
	id: string;
	matchId: string | null;
	series: SeriesRecord;
}

export interface MemberRecord {
	id: string;
	/** The registry userId, saved with the room. null for a member the edge named nobody. */
	userId: string | null;
	/**
	 * In memory only, from the member's own requests (`rename`): a saved room keeps no names (R12).
	 * A member restored from disk is `UNNAMED` until their next request.
	 */
	name: string;
	joinedAt: number;
	state: unknown;
	/**
	 * In memory only: their account's character (`people.ts`'s `applyPerson`), absent until it has
	 * been read. Normalised by `avatarIdOf` on the way in, so this is never `''` and never `null`.
	 */
	avatarId?: string;
	/** In memory only (`Lobby.setLook`): their picture and cosmetics. */
	look?: Look;
}

export interface RoomRecord {
	id: string;
	name: string;
	creator: string;
	/** Mirrors `ledger.leaderId`, kept non-null (`join`/`leave` sync the two); stale on the last member out, for `sweep`/the next `join`. */
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
	/**
	 * The drafters of each pod, fixed when a room of more than one pod's seats starts its draft (the
	 * leader's `podSplit`); pod `k` drafts on `podDraftId(id, k)`. Null for a room that drafts as one pod on
	 * its own id, as every room did before multi-pod rooms.
	 */
	podDrafts: string[][] | null;
	/**
	 * The leader's Split & randomize in the lobby of a room of more than 8 drafters: the seed and the
	 * pods it made (`splitIntoPods`). It stands only while its pods hold exactly the drafters seated
	 * (`heldSplit`); it fixes every seat and Ready, and a split drafter leaving clears it (`leave`).
	 * The leader's `startDraft` deals from it. Null before a split and once the draft is dealt.
	 */
	podSplit: PodSplit | null;
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
	/** A historical-tournament replay room (`CreateRoomInput.historical`'s doc). Born locked. */
	historical?: boolean;
	/** Entrant id → library deck id, the decks the real event's players played (`CreateRoomInput.aiDeckAssignments`'s doc). */
	aiDeckAssignments?: Record<string, string>;
	/** A historical room's open seat → its real player's list (`CreateRoomInput.seatDecks`'s doc). */
	seatDecks?: Record<string, string>;
	/** A historical room's tournament structure (`PodStructure`): Swiss rounds then a single-elimination cut. Absent: Swiss only, no cut. */
	historicalStructure?: PodStructure;
	createdAt: number;
	/** Last mutation, in ms. What `sweep` ages a room out on. */
	updatedAt: number;
	members: MemberRecord[];
	/** Membership/ready/leader engine (`@wolffm/rooms-server`'s `seats.ts`). In memory only — rebuilt from `members`/`leader` on restore. */
	ledger: MembershipLedger;
}

/**
 * Magic's part of the room-level `app` blob, nested under `game` on disk since
 * app version 2 (`MAGIC_ROOM_STORED_KEYS`). Version 1 kept these fields flat
 * beside the rest, and `appCodec.deserialize` lifts them.
 */
interface StoredMagicGame {
	/**
	 * Null ONLY on the way out of `deserialize`, and only for a record written
	 * before the field existed: `openLobby` turns that into the default. Never
	 * null on the way in — `#persist` always writes the room's concrete id — so a
	 * record that stores an explicit `null` is a record this build did not write
	 * and does not understand, and the codec quarantines it like any other.
	 */
	format: FormatId | null;
	/**
	 * Undefined ONLY on the way out of `deserialize`, for a record written before
	 * modes existed: `openLobby` restores that room as Classic, which it was.
	 */
	mode: ConstructedMode | null | undefined;
	modeOptions: ModeOptions | null;
	clientMode: ClientMode;
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
	/** Absent for a room that drafts as one pod (`RoomRecord.podDrafts`). */
	podDrafts?: string[][];
	/** Absent for a room with no split standing (`RoomRecord.podSplit`). */
	podSplit?: PodSplit;
	/** Absent for a room written before wave 72 §P, or whose rounds have never started. */
	pod: PodRecord | null;
	/** Absent for a room written before it was persisted: nobody has pressed Play. */
	podPlaying?: string[];
	/** Absent for a room written before tournament mode: nothing was ever locked. */
	lockedDecks?: Record<string, unknown>;
	/** Absent for a room written before Gauntlets, or whose Gauntlet has never moved. The pre-per-table shape, kept ONLY so `decodeMagicGame` can migrate it onto `tables[0].id` (`gauntlets`'s own doc) — never written again. */
	gauntlet?: GauntletState | null;
	/** Absent for a room written before Gauntlet tournaments: one per table, keyed by table id (`RoomRecord.gauntlets`'s own doc). */
	gauntlets?: Record<string, GauntletState>;
	/** Absent for a room written before board-state testing rooms existed, or that is not one: every such room has no scenario. */
	scenario?: string;
	/** Absent for every room that is not a historical replay (`RoomRecord.historical`'s doc). */
	historical?: boolean;
	/** A historical room's tournament structure (`RoomRecord.historicalStructure`'s doc). */
	historicalStructure?: { swiss: number; cut: number };
	/** Absent for a room with no entrant deck assignments (`RoomRecord.aiDeckAssignments`'s doc). */
	aiDeckAssignments?: Record<string, string>;
	/** Absent for every room that is not a historical replay (`RoomRecord.seatDecks`'s doc). */
	seatDecks?: Record<string, string>;
}

/** The room-level `app` blob on disk. The secret is here and ONLY here on disk. */
export interface StoredApp {
	name: string;
	creator: string;
	leader: string;
	gameType: GameType;
	/** Absent on disk for a room written before the field; `deserialize` fills in the defaults. */
	settings: RoomSettings;
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
	/** Absent for a room written before testing rooms existed, which reads back `false` — every such room is an ordinary one. */
	testing?: boolean;
	/** Absent for a room no event made, and for every room written before events existed. */
	scheduledFor?: number;
	secret: Secret | null;
	/** Magic's own fields (`StoredMagicGame`). */
	game: StoredMagicGame;
}

/**
 * Version 2 nests Magic's fields under `game`; version 1 kept them flat, and
 * `deserialize` still reads it (nothing writes it). Not bumped for additive
 * fields — `clientMode`, `ready`/`draftStartedAt`, `format` — because each is
 * read with a default (`builtin`, `false`, `null`, the newest frozen pool), so a
 * record written before it existed decodes without a migration.
 */
export const APP_VERSION = 2;

/** Any non-blank string. Whether it names a pool THIS server has is not this file's question. */
function isFormatId(v: unknown): v is FormatId {
	return typeof v === 'string' && v.trim() !== '';
}

/**
 * A stored mode and its options: both null (unchosen), or a pair `RoomModeSchema`
 * accepts. Undefined when the record predates modes.
 */
function storedMode(a: Record<string, unknown>): Pick<StoredMagicGame, 'mode' | 'modeOptions'> {
	if (a.mode === undefined && a.modeOptions === undefined) return { mode: undefined, modeOptions: null };
	if (a.mode === null && a.modeOptions === null) return { mode: null, modeOptions: null };
	const parsed = RoomModeSchema.safeParse({ mode: a.mode, modeOptions: a.modeOptions });
	if (!parsed.success) throw new Error('app.game.mode is not a known mode with its options');
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

export type StoredTable = Omit<TableRecord, 'ready'> & Partial<Pick<TableRecord, 'ready'>>;

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

/** A version-1 app, which kept Magic's fields flat, with them lifted under `game` as version 2 stores them. */
function liftV1(a: Record<string, unknown>): Record<string, unknown> {
	const app: Record<string, unknown> = {};
	const game: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(a)) ((MAGIC_ROOM_STORED_KEYS as readonly string[]).includes(k) ? game : app)[k] = v;
	return { ...app, game };
}

/**
 * Magic's half of the app codec: its `game` blob, each field read with its own
 * default when absent. A pre-tournament `gauntlet` comes back as it was stored;
 * `deserialize` moves it onto the room's first table.
 */
function decodeMagicGame(raw: unknown, gameType: string): StoredMagicGame {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('app.game is not an object');
	const g = raw as Record<string, unknown>;
	// Written before wave 18: absent means `builtin`, which is what those rooms
	// are. A field that is PRESENT and unknown is not defaulted away — that is
	// a record this build does not understand, so it quarantines like any other.
	const clientMode = ClientModeSchema.default(DEFAULT_CLIENT_MODE).safeParse(g.clientMode);
	if (!clientMode.success) throw new Error('app.game.clientMode is not a known client mode');
	// Absent is a room written before wave 25, which starts on the newest
	// frozen pool (`openLobby`). Present and not a format id is a record this
	// build does not understand — including an explicit `null`, which this
	// build never writes.
	if (g.format !== undefined && !isFormatId(g.format)) throw new Error('app.game.format is not a format id');
	// Absent is a room written before wave 23, which is every room that
	// existed then and no room that was mid-draft. Present and not a number
	// is a record this build does not understand.
	if (g.draftStartedAt !== undefined && g.draftStartedAt !== null && typeof g.draftStartedAt !== 'number') {
		throw new Error('app.game.draftStartedAt is not a number');
	}
	// Absent is a room written before wave 73 §A, which drafted the server's one global cube.
	if (g.plan !== undefined && !DraftPlanSchema.safeParse(g.plan).success) throw new Error('app.game.plan is invalid');
	if (g.planVerdict !== undefined && g.planVerdict !== null && !PoolVerdictSchema.safeParse(g.planVerdict).success) {
		throw new Error('app.game.planVerdict is invalid');
	}
	// Absent is a room written before wave 72 §P, which has nobody seated.
	if (g.podSeats !== undefined && !isStoredPodSeats(g.podSeats, gameType)) throw new Error('app.game.podSeats is invalid');
	if (g.podAi !== undefined && !isStoredPodSeats(g.podAi, gameType)) throw new Error('app.game.podAi is invalid');
	if (g.podDrafts !== undefined && !(Array.isArray(g.podDrafts) && g.podDrafts.every((p) => Array.isArray(p) && p.every((m) => typeof m === 'string')))) {
		throw new Error('app.game.podDrafts is invalid');
	}
	if (g.podSplit !== undefined && !isStoredPodSplit(g.podSplit)) throw new Error('app.game.podSplit is invalid');
	// Absent is a room written before wave 72 §P, or whose rounds never started.
	if (g.pod !== null && g.pod !== undefined && !isStoredPodRecord(g.pod)) throw new Error('app.game.pod is invalid');
	if (g.podPlaying !== undefined && !(Array.isArray(g.podPlaying) && g.podPlaying.every((m) => typeof m === 'string'))) {
		throw new Error('app.game.podPlaying is not a list of member ids');
	}
	// Absent is a room written before tournament mode. Each value's own shape
	// (a Classic/Random deck) is opaque here, the same discipline
	// `MemberRecord.state` already keeps.
	if (g.lockedDecks !== undefined && !isStoredLockedDecks(g.lockedDecks)) throw new Error('app.game.lockedDecks is invalid');
	// `gauntlets` (per-table) is the current shape; `gauntlet` (per-room) is
	// the pre-tournament one, read ONLY when `gauntlets` is absent (a record
	// this build never writes both for — see `deserialize`'s migration).
	if (g.gauntlets !== undefined && !isStoredGauntlets(g.gauntlets)) throw new Error('app.game.gauntlets is invalid');
	if (g.gauntlets === undefined && g.gauntlet !== undefined && g.gauntlet !== null && !isGauntletState(g.gauntlet)) {
		throw new Error('app.game.gauntlet is invalid');
	}
	if (g.scenario !== undefined && typeof g.scenario !== 'string') throw new Error('app.game.scenario is invalid');
	if (g.historical !== undefined && typeof g.historical !== 'boolean') throw new Error('app.game.historical is invalid');
	if (
		g.historicalStructure !== undefined &&
		(typeof g.historicalStructure !== 'object' ||
			g.historicalStructure === null ||
			typeof (g.historicalStructure as Record<string, unknown>).swiss !== 'number' ||
			typeof (g.historicalStructure as Record<string, unknown>).cut !== 'number')
	) {
		throw new Error('app.game.historicalStructure is invalid');
	}
	if (
		g.aiDeckAssignments !== undefined &&
		(typeof g.aiDeckAssignments !== 'object' || g.aiDeckAssignments === null || Array.isArray(g.aiDeckAssignments))
	) {
		throw new Error('app.game.aiDeckAssignments is invalid');
	}
	if (g.seatDecks !== undefined && (typeof g.seatDecks !== 'object' || g.seatDecks === null || Array.isArray(g.seatDecks))) {
		throw new Error('app.game.seatDecks is invalid');
	}
	return {
		format: g.format === undefined ? null : (g.format as FormatId),
		...storedMode(g),
		clientMode: clientMode.data,
		draftStartedAt: g.draftStartedAt === undefined ? null : (g.draftStartedAt as number | null),
		plan: g.plan === undefined ? DEFAULT_PLAN : (g.plan as DraftPlan),
		planVerdict: g.planVerdict === undefined ? null : (g.planVerdict as PoolVerdict | null),
		podSeats: g.podSeats === undefined ? new Array<string | null>(initialPodSize(gameType)).fill(null) : [...(g.podSeats as (string | null)[])],
		podAi: g.podAi === undefined ? new Array<string | null>(initialPodSize(gameType)).fill(null) : [...(g.podAi as (string | null)[])],
		...(g.podDrafts === undefined ? {} : { podDrafts: (g.podDrafts as string[][]).map((p) => [...p]) }),
		...(g.podSplit === undefined ? {} : { podSplit: copySplit(g.podSplit as PodSplit) }),
		pod: g.pod === undefined || g.pod === null ? null : (g.pod as PodRecord),
		podPlaying: g.podPlaying === undefined ? [] : [...(g.podPlaying as string[])],
		lockedDecks: g.lockedDecks === undefined ? {} : { ...(g.lockedDecks as Record<string, unknown>) },
		...(g.gauntlets !== undefined ? { gauntlets: { ...(g.gauntlets as Record<string, GauntletState>) } } : {}),
		...(g.gauntlets === undefined && g.gauntlet !== undefined && g.gauntlet !== null ? { gauntlet: g.gauntlet as GauntletState } : {}),
		...(g.scenario === undefined ? {} : { scenario: g.scenario as string }),
		...(g.historical === true ? { historical: true } : {}),
		...(g.historicalStructure === undefined ? {} : { historicalStructure: { swiss: (g.historicalStructure as { swiss: number }).swiss, cut: (g.historicalStructure as { cut: number }).cut } }),
		...(g.aiDeckAssignments === undefined ? {} : { aiDeckAssignments: { ...(g.aiDeckAssignments as Record<string, string>) } }),
		...(g.seatDecks === undefined ? {} : { seatDecks: { ...(g.seatDecks as Record<string, string>) } }),
	};
}

/**
 * The room-level codec. Its errors name the FIELD, never a value — the message
 * reaches the quarantine reason and the log, and a value here could be the hash.
 */
export const appCodec: AppCodec<StoredApp> = {
	version: APP_VERSION,
	serialize: (value) => structuredClone(value),
	deserialize(raw, version, ctx) {
		if (typeof raw !== 'object' || raw === null) throw new Error('app is not an object');
		if (version !== 1 && version !== APP_VERSION) throw new Error('app version is not one this build reads');
		const a = version === 1 ? liftV1(raw as Record<string, unknown>) : (raw as Record<string, unknown>);
		if (typeof a.name !== 'string') throw new Error('app.name is not a string');
		if (typeof a.creator !== 'string') throw new Error('app.creator is not a string');
		if (typeof a.leader !== 'string') throw new Error('app.leader is not a string');
		const gameType = GameTypeSchema.safeParse(a.gameType);
		if (!gameType.success) throw new Error('app.gameType is not a known game type');
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
		if (a.testing !== undefined && typeof a.testing !== 'boolean') throw new Error('app.testing is invalid');
		if (a.scheduledFor !== undefined && typeof a.scheduledFor !== 'number') throw new Error('app.scheduledFor is invalid');
		if (a.secret !== null && !isSecret(a.secret)) throw new Error('app.secret is invalid');
		const { gauntlet, gauntlets, ...game } = decodeMagicGame(a.game, gameType.data);
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
		const seriesRoom: SeriesRoom = { gameType: gameType.data, mode: game.mode };
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
			settings,
			tables,
			matchId,
			matches: a.matches === undefined ? [] : [...(a.matches as string[])],
			// Absent is a room written before testing rooms existed: every such room is an ordinary one.
			testing: a.testing === true,
			...(a.scheduledFor === undefined ? {} : { scheduledFor: a.scheduledFor as number }),
			secret: a.secret === null ? null : { salt: (a.secret as Secret).salt, hash: (a.secret as Secret).hash },
			game: {
				...game,
				// Migrated from the pre-tournament one-per-room shape (`gauntlets`'s own
				// doc): a record with the old field and no new one lands its single
				// Gauntlet on `tables[0]`, the only table such a record could ever have
				// had. Never both — `#persist` only ever writes `gauntlets` from here on.
				gauntlets: gauntlets ?? (gauntlet !== undefined && gauntlet !== null && tables.length > 0 ? { [tables[0]!.id]: gauntlet } : {}),
			},
		};
	},
};

/** A saved room's codec: what `openLobby` restores every room file through. */
export const roomCodec: RoomCodec<StoredApp, unknown> = { app: appCodec };

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

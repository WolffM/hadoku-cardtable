/**
 * The saved-room codec: `RoomRecord`/`TableRecord` (the shape a
 * `FileLobby` instance holds in memory) and `StoredApp`/`StoredMagicGame` (the
 * shape `@wolffm/rooms-server/store` persists them as), with the codec that
 * reads one back into the other — `decodeMagicGame`, `decodeMagicApp`, `roomCodec`.
 * An unreadable or future-format record is QUARANTINED (`room/lobby.ts`'s own
 * doc), never half-applied.
 *
 * Moved out of `room/lobby.ts` (split, wave 99 §L). `room/lobby.ts` still
 * holds every mutation (`FileLobby`'s own methods); this file only decodes
 * and encodes the record those mutations act on.
 */

import { createHash } from 'node:crypto';
import type { RoomCodec } from '@wolffm/rooms-server/store';
import {
	ClientModeSchema,
	DEFAULT_CLIENT_MODE,
	DEFAULT_ROOM_SETTINGS,
	DRAFT_POOL_PREFIX,
	DraftPlanSchema,
	gameTypeSpec,
	isMagicGameType,
	MAGIC_ROOM_STORED_KEYS,
	PoolVerdictSchema,
	RoomModeSchema,
	RoomSettingsSchema,
	SeriesPhaseSchema,
	type ClientMode,
	type ConstructedMode,
	type DraftPlan,
	type GameType,
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
	isConstructedType,
	isDraftType,
	isStoredPodSeats,
	isStoredPodSplit,
	type PodRecord,
	type PodSplit,
} from './pods.ts';
import type { GameSeats, PlatformRoomRecord } from '@hadoku/game-server/room/record';
import { plainRoomType, roomAppCodec, type LobbyMember, type RoomCreateInput, type RoomTypeHooks, type StoredRoomApp } from '@hadoku/game-server/room/lobby';
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

/**
 * Magic's part of a room's record (`RoomRecord.game`): every field a Magic room has that a room of
 * another game would not. The room's own fields, and its game seats (the pod's seats), are the
 * platform's (`PlatformRoomRecord`, `docs/planning/room-record-generic.md`).
 */
export interface MagicRoomGame {
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
	 * as the room's seats.
	 */
	plan: DraftPlan;
	/** The last verdict run on `plan` — null while a check is in flight, or before the first one ever ran. */
	planVerdict: PoolVerdict | null;
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
	 * opaque to this file (the same discipline `LobbyMember.state` already
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
	/** A board-state testing room's own scenario (`CreateRoomInput.scenario`'s doc). Absent for every room that is not one. */
	scenario?: string;
	/** A historical-tournament replay room (`CreateRoomInput.historical`'s doc). Born locked. */
	historical?: boolean;
	/** Entrant id → library deck id, the decks the real event's players played (`CreateRoomInput.aiDeckAssignments`'s doc). */
	aiDeckAssignments?: Record<string, string>;
	/** A historical room's open seat → its real player's list (`CreateRoomInput.seatDecks`'s doc). */
	seatDecks?: Record<string, string>;
	/** A historical room's tournament structure (`PodStructure`): Swiss rounds then a single-elimination cut. Absent: Swiss only, no cut. */
	historicalStructure?: PodStructure;
}

/**
 * A Magic lobby's room: the platform's record with Magic's part under `game`. Its `seats` are the
 * pod's seats (8 at first, by member id or `ai`/`closed`), meaningful while `game.draftStartedAt`
 * is null and frozen from there — `#dealPodRounds`'s own `PodRecord.humans` is what the pod plays.
 * A room that plays one two-seat table keeps its seats on `game.tables[0]`.
 */
export interface RoomRecord extends PlatformRoomRecord<MagicRoomGame, LobbyMember> {
	gameType: GameType;
}

/**
 * Magic's part of the room-level `app` blob, nested under `game` on disk since
 * app version 2 (`MAGIC_ROOM_STORED_KEYS`). Version 1 kept these fields flat
 * beside the rest, and `decodeMagicApp` lifts them.
 */
interface StoredMagicGame {
	/**
	 * Null ONLY on the way out of `deserialize`, and only for a record written
	 * before the field existed: `openLobby` turns that into the default. Never
	 * null on the way in — `storedMagicGame` always writes the room's concrete id — so a
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
	/**
	 * Each setting has a default (`SETTING_KEYS`). Read from `app.game.settings`, else the top-level
	 * `app.settings` every record before the generic room record kept (and the rollback copy still holds).
	 */
	settings: RoomSettings;
	/**
	 * Always resolved by `deserialize`: from `app.game.tables`, else the top-level `app.tables`, else (a
	 * record written before wave 71, which plays exactly one table) a one-table list holding `app.matchId`.
	 * `ready` is absent only for a table stored before the lobby held its seats, which `openLobby` seats
	 * from its members (`seatsFromMembers`).
	 */
	tables: StoredTable[];
	/** A finished match's result screen still asks which room it was. From `app.game.matches`, else `app.matches`. */
	matches: string[];
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

/**
 * A Magic room's `app` blob as the codec reads it back: the platform's fields at the top
 * (`StoredRoomApp`), the game seats in `seats`, Magic's under `game` (`docs/planning/room-record-generic.md`).
 */
export interface StoredApp extends StoredRoomApp {
	gameType: GameType;
	game: StoredMagicGame;
}

/**
 * The copies of the old shape `serialize` writes beside the new one, so a rollback to a build that
 * reads only the old shape (v0.68.0 and before) loads every room this build wrote, nothing lost.
 * **Dated 2026-11-13: drop these, and `deserialize`'s fallback reads of them, in the first release
 * after the one that ships the generic room record.** `matchId` is `tables[0].matchId`, the
 * pre-wave-71 field, which that rollback reader still falls back to.
 */
interface RollbackCopies {
	settings: RoomSettings;
	tables: StoredTable[];
	matchId: string | null;
	matches: string[];
	game: StoredMagicGame & { podSeats: GameSeats };
}

/** `app` as written: the new shape plus `RollbackCopies`. */
export function withRollbackCopies(app: StoredRoomApp): StoredApp & RollbackCopies {
	const game = app.game as StoredMagicGame;
	return {
		...(app as StoredApp),
		settings: game.settings,
		tables: game.tables,
		matchId: game.tables[0]?.matchId ?? null,
		matches: game.matches,
		game: { ...game, podSeats: app.seats },
	};
}

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
function decodeMagicGame(g: Record<string, unknown>, gameType: string): Omit<StoredMagicGame, 'settings' | 'tables' | 'matches'> {
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
	// `LobbyMember.state` already keeps.
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
 * Magic's half of the room-level codec (`RoomTypeHooks.decode`): the game seats and Magic's `game`,
 * the platform's fields being the core's (`roomAppCodec`). Its errors name the FIELD, never a value.
 */
export function decodeMagicApp(raw: Record<string, unknown>, version: number, ctx: { roomId: string }): Pick<StoredApp, 'seats' | 'game'> {
		const a = version === 1 ? liftV1(raw) : raw;
		const gameType = a.gameType as GameType;
		if (typeof a.game !== 'object' || a.game === null || Array.isArray(a.game)) throw new Error('app.game is not an object');
		const g = a.game as Record<string, unknown>;
		// Each of these reads the new place first and falls back to where a record
		// before the generic room record kept it (`StoredMagicGame`'s and
		// `StoredApp.seats`' docs). A record holding both reads the new one.
		const settingsRaw = g.settings !== undefined ? g.settings : a.settings;
		const tablesRaw = g.tables !== undefined ? g.tables : a.tables;
		const matchesRaw = g.matches !== undefined ? g.matches : a.matches;
		const seatsRaw = a.seats !== undefined ? a.seats : g.podSeats;
		// Absent is a room written before settings existed, and so is a single
		// setting that is absent: each reads back on its default. A value of the
		// wrong type, or a setting this build does not know, quarantines.
		if (settingsRaw !== undefined && !isStoredSettings(settingsRaw)) throw new Error('app.settings is invalid');
		if (a.matchId !== undefined && a.matchId !== null && typeof a.matchId !== 'string') throw new Error('app.matchId is invalid');
		// Absent is a room written before the field, which remembers no match.
		if (matchesRaw !== undefined && !(Array.isArray(matchesRaw) && matchesRaw.every((m) => typeof m === 'string'))) {
			throw new Error('app.matches is not a list of match ids');
		}
		// Absent is a room written before wave 71, which plays exactly one table —
		// migrated below from `matchId`. Present and not a list of tables is a
		// record this build does not understand.
		if (tablesRaw !== undefined && !(Array.isArray(tablesRaw) && tablesRaw.every(isStoredTable))) {
			throw new Error('app.tables is not a list of tables');
		}
		// Absent is a room written before wave 72 §P, which has nobody seated.
		if (seatsRaw !== undefined && !isStoredPodSeats(seatsRaw, gameType)) throw new Error('app.seats is invalid');
		const { gauntlet, gauntlets, ...game } = decodeMagicGame(g, gameType);
		const settings = storedSettings(settingsRaw as Partial<RoomSettings> | undefined);
		const matchId = (a.matchId ?? null) as string | null;
		// Migrated from the pre-wave-71 shape: one table, holding the room's old
		// `matchId`, sized by `seriesFormatOf` from the `gameType` already read
		// above. The id is DERIVED from the room id (`migratedTableId`),
		// not minted randomly: nothing here persists the migration (a read must
		// not write), so re-deserializing the same pre-wave-71 record on every
		// boot has to land on the SAME id each time for "stable for the room's
		// life" to hold — a format id (`newestFormat()`) and `clientMode`
		// (`'builtin'`) are migrated the same deterministic way already.
		const seriesRoom: SeriesRoom = { gameType, mode: game.mode };
		const tables: StoredTable[] =
			tablesRaw === undefined
				? [
						{
							id: migratedTableId(ctx.roomId),
							seats: [null, null],
							matchId,
							series: newSeries(seriesRoom, [null, null], matchId !== null ? 'playing' : 'seating'),
						},
					]
				: (tablesRaw as Parameters<typeof storedTable>[0][]).map((t) => storedTable(t, seriesRoom));
		return {
			seats: seatsRaw === undefined ? new Array<string | null>(initialPodSize(gameType)).fill(null) : [...(seatsRaw as GameSeats)],
			game: {
				...game,
				settings,
				tables,
				matches: matchesRaw === undefined ? [] : [...(matchesRaw as string[])],
				// Migrated from the pre-tournament one-per-room shape (`gauntlets`'s own
				// doc): a record with the old field and no new one lands its single
				// Gauntlet on `tables[0]`, the only table such a record could ever have
				// had. Never both — `storedMagicGame` only ever writes `gauntlets` from here on.
				gauntlets: gauntlets ?? (gauntlet !== undefined && gauntlet !== null && tables.length > 0 ? { [tables[0]!.id]: gauntlet } : {}),
			},
		};
}

/**
 * What a room restored from disk needs from Magic before it becomes a record: whether it is a
 * constructed room a leader put on a draft pool's format before 2026-10-20 (`offPod`: it comes back on
 * the newest era with every deck hold and ready flag dropped, exactly what a format change does), and
 * whether it is a constructed room stored before modes existed (`restoredAsClassic`: it was Classic).
 */
export function magicRestoreRules(app: StoredApp): { offPod: boolean; restoredAsClassic: boolean } {
	const constructed = isConstructedType(app.gameType);
	return {
		offPod: !isDraftType(app.gameType) && app.game.format !== null && app.game.format.startsWith(DRAFT_POOL_PREFIX),
		restoredAsClassic: app.game.mode === undefined && constructed,
	};
}

/** How a Magic room's `app` blob is read and written: Magic's `game`, and the copies a rollback reads. */
export const MAGIC_STORED: Pick<RoomTypeHooks<MagicRoomGame>, 'decode' | 'writes'> = { decode: decodeMagicApp, writes: withRollbackCopies };

/**
 * A registered game type Magic does not play (bomberman): the platform's `plainRoomType`, sized by its
 * spec, which keeps nothing of its own. Its rooms were hosted by Magic's lobby before, so a record from
 * then holds its seats under `game.podSeats`, and one written now copies them there for a rollback.
 * **Both go at the dated drop, 2026-11-13, with `RollbackCopies`.** Undefined for a type nobody registered.
 */
export function hostedRoomType<I extends RoomCreateInput>(gameType: string): RoomTypeHooks<Record<string, never>, I> | undefined {
	const spec = gameTypeSpec(gameType);
	if (spec === undefined) return undefined;
	const plain = plainRoomType<I>({
		seats: initialPodSize(gameType),
		max: spec.seats.max,
		...(spec.runtime === 'relay' ? { relaySeats: spec.table?.seats ?? spec.seats.max } : {}),
	});
	return {
		...plain,
		decode: (app, version, ctx) => plain.decode(app.seats === undefined ? { ...app, seats: (app.game as { podSeats?: unknown } | undefined)?.podSeats } : app, version, ctx),
		writes: (app) => ({ ...app, game: { podSeats: app.seats } }),
	};
}

/** A saved room's codec: what the lobby restores every room file through. */
export const roomCodec: RoomCodec<StoredRoomApp, unknown> = roomAppCodec((gameType) => (isMagicGameType(gameType) ? MAGIC_STORED : hostedRoomType(gameType)));

/**
 * The first table's id for a room migrated from before wave 71 — DETERMINISTIC,
 * unlike `mintTableId`: nothing persists the migration on its own (a read must
 * not write, and `decodeMagicApp` runs on every boot until something
 * else touches the room), so the same room id has to land on the same table
 * id every time for "stable for the room's life" to hold.
 */
function migratedTableId(roomId: string): string {
	return `t-${createHash('sha256').update(roomId).digest('hex').slice(0, 8)}`;
}

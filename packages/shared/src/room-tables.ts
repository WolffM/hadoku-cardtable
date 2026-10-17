/*
 * Room tables — the wire shape of a room's tables, and the two match-length
 * settings that gate them.
 *
 * Wave 71 (`docs/planning/wave71-2026-10-17.md`, "Wire contract"): before this,
 * a room held exactly one table (`matchId` on the room itself). Now a room
 * holds `tables: RoomTable[]`, always at least one — a constructed 1v1 room is
 * the one-table case — and `RoomView.matchId` stays the FIRST table's live
 * match, so every reader that only ever knew one table keeps working with no
 * change. `RoomView.settings` gains `matchLength` (`'bo1' | 'bo3'`, default
 * `'bo1'`) and `sideboarding` (boolean, default `false`; `'bo3'` reads as
 * `true` regardless of the stored value — see `apps/server/src/room/lobby.ts`'s
 * `RoomSettings`, which owns the server side of both).
 *
 * A SERIES is a room concept, never Forge's: each game of a series is its own
 * fresh Forge match (`docs/planning/draft-pods-plan.md`, "Games of a match are
 * separate Forge matches"), and `RoomTable.series` is the room's own ledger of
 * those games — never `forge/`'s own `gamesPerMatch`, which stays unused.
 *
 * This file states only what crosses the wire. It exists apart from
 * `apps/ui/src/rooms/api.ts` (wave 70's hand-written `RoomView` parser) on
 * purpose: lane G's board strip reads `RoomView.tables` straight off a room
 * body through THIS schema, so wave 70's parser never has to learn the field
 * to stay correct, and this file never has to learn wave 70's.
 */

import { z } from 'zod';

/** `RoomSettings.matchLength`: best-of-one (default), or forced-rematch best-of-three. */
export const MATCH_LENGTHS = ['bo1', 'bo3'] as const;
export const MatchLengthSchema = z.enum(MATCH_LENGTHS);
export type MatchLength = z.infer<typeof MatchLengthSchema>;
export const DEFAULT_MATCH_LENGTH: MatchLength = 'bo1';
export const DEFAULT_SIDEBOARDING = false;

/** A series runs to one game or to three — the room's own count, never Forge's. */
export const SeriesLengthSchema = z.union([z.literal(1), z.literal(3)]);
export type SeriesLength = z.infer<typeof SeriesLengthSchema>;

/**
 * The phases a table's series moves through. `seating` is before the series'
 * first game has started (a freshly added table, or a room that has never
 * played one); `playing` is a game under way; `sideboarding` is the room step
 * between two games of the SAME series; `done` is a finished series, one
 * Rematch away from a new one (which starts back at `playing`, never back
 * through `seating`).
 */
export const SERIES_PHASES = ['seating', 'playing', 'sideboarding', 'done'] as const;
export const SeriesPhaseSchema = z.enum(SERIES_PHASES);
export type SeriesPhase = z.infer<typeof SeriesPhaseSchema>;

/** One of a table's (at most two) seats, in seat order. */
export const RoomTablePlayerSchema = z.strictObject({
  memberId: z.string().min(1),
  name: z.string(),
});
export type RoomTablePlayer = z.infer<typeof RoomTablePlayerSchema>;

/**
 * One game's result: the Forge match it was played as, and which seat won.
 * `winner` is `null` for a game this room could not attribute to a seat (an
 * ambiguous natural game-over — see `apps/server/src/http/routes.ts`'s
 * `winnerSeatOf`), never a guess.
 */
export const RoomTableGameSchema = z.strictObject({
  matchId: z.string().min(1),
  winner: z.union([z.literal(0), z.literal(1), z.null()]),
});
export type RoomTableGame = z.infer<typeof RoomTableGameSchema>;

export const RoomTableSeriesSchema = z.strictObject({
  length: SeriesLengthSchema,
  wins: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
  games: z.array(RoomTableGameSchema),
  phase: SeriesPhaseSchema,
});
export type RoomTableSeries = z.infer<typeof RoomTableSeriesSchema>;

/**
 * One table of a room. `id` is `"t-" + 8 hex`, and the first table's id is
 * stable for a room's life — minted once, at create or at migration, never
 * reissued. `players` is 0–2, in seat order; `matchId` is the table's live
 * game, or `null` between games (seating, sideboarding, or done).
 */
export const RoomTableSchema = z.strictObject({
  id: z.string().min(1),
  players: z.array(RoomTablePlayerSchema).max(2),
  matchId: z.string().nullable(),
  series: RoomTableSeriesSchema,
});
export type RoomTable = z.infer<typeof RoomTableSchema>;

/** `RoomView.tables`: always at least one. */
export const RoomTablesSchema = z.array(RoomTableSchema).min(1);

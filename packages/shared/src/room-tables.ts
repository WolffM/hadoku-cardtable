/*
 * Room tables — the wire shape of a room's tables and the series each plays.
 *
 * Wave 71 (`docs/planning/wave71-2026-10-17.md`, "Wire contract"): before this,
 * a room held exactly one table (`matchId` on the room itself). Now a room
 * holds `tables: RoomTable[]`, always at least one — a constructed 1v1 room is
 * the one-table case — and `RoomView.matchId` stays the FIRST table's live
 * match, so every reader that only ever knew one table keeps working with no
 * change. How long a series runs is the server's (`apps/server/src/room/series.ts`).
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

import { ManaColorSchema } from './draft.ts';

/** A series runs to one game or to three — the room's own count, never Forge's. */
export const SeriesLengthSchema = z.union([z.literal(1), z.literal(3)]);
export type SeriesLength = z.infer<typeof SeriesLengthSchema>;

/**
 * The phases a table's series moves through. `seating` is before the series'
 * first game has started (a freshly added table, or a room that has never
 * played one); `playing` is a game under way; `sideboarding` is the room step
 * between two games of the SAME series, and `between` is that step for a
 * series that does not sideboard (a Gauntlet), whose next game is set up in
 * the room rather than agreed on the result screen; `done` is a finished series,
 * one Rematch away from either its conversion to Bo3 (a Bo1) or a new one.
 */
export const SERIES_PHASES = ['seating', 'playing', 'sideboarding', 'between', 'done'] as const;
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
 * `winner` is `null` for a draw, or a game Forge called that no seat can be
 * told the winner of (`apps/server/src/play/match.ts`'s `gameOutcome`), never
 * a guess. A game that did not finish is not a game here at all.
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
 * game, or `null` between games (seating, sideboarding, between, or done).
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

/*
 * A table's game, as the table card draws it (`docs/planning/table-card-plan.md`): each seat's deck,
 * and while a game runs, where it stands. Not part of `RoomTable`, which is the room's own ledger:
 * the room body carries it beside `tables` as `tableGames`, by table id, read from the table's
 * latest match (`apps/server/src/play/table-game.ts`). A table that has never started a match has none.
 */

/** One seat's deck: its name, its colours, and the card whose art stands for it — a name, looked up for its art. */
export const TableSeatDeckSchema = z.strictObject({
  name: z.string(),
  colors: z.array(ManaColorSchema).max(5),
  art: z.string().nullable(),
});
export type TableSeatDeck = z.infer<typeof TableSeatDeckSchema>;

const SeatCount = z.number().int().min(0);

/** A game under way: Forge's turn, whose turn it is (a table seat), each seat's life and hand size. */
export const TableGameLiveSchema = z.strictObject({
  turn: SeatCount,
  active: z.union([z.literal(0), z.literal(1), z.null()]),
  life: z.tuple([z.number().int().nullable(), z.number().int().nullable()]),
  hand: z.tuple([SeatCount, SeatCount]),
});
export type TableGameLive = z.infer<typeof TableGameLiveSchema>;

export const TableGameSchema = z.strictObject({
  /** By table seat; null for a seat whose deck this server never saw (a random Forge precon). */
  decks: z.tuple([TableSeatDeckSchema.nullable(), TableSeatDeckSchema.nullable()]),
  /** Null between games, and once the table's game is over. */
  live: TableGameLiveSchema.nullable(),
});
export type TableGame = z.infer<typeof TableGameSchema>;

/** `tableGames` on a room body: by table id, only the tables that have played. */
export const TableGamesSchema = z.record(z.string(), TableGameSchema);

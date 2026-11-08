/*
 * Room tables, Magic's part (the tables are `@hadoku/platform-wire/tables`): a series' phases, and
 * each table's game. Each game of a series is its own fresh Forge match, never `forge/`'s own
 * `gamesPerMatch` (`docs/planning/draft-pods-plan.md`); its length is `apps/server/src/room/series.ts`'s.
 */

import { roomTableSchemas } from '@hadoku/platform-wire/tables';
import { z } from 'zod';

import { ManaColorSchema } from './draft.ts';

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
export const { SeriesPhaseSchema, RoomTableSeriesSchema, RoomTableSchema, RoomTablesSchema } = roomTableSchemas(SERIES_PHASES);
export type SeriesPhase = z.infer<typeof SeriesPhaseSchema>;
export type RoomTableSeries = z.infer<typeof RoomTableSeriesSchema>;
export type RoomTable = z.infer<typeof RoomTableSchema>;

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

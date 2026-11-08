/* Room tables: a room holds at least one, each seating up to two players for a series of one game
 * or three, each its own match. The phases a series moves through are the game's own list. */

import { z } from 'zod';

/** A series runs to one game or to three — the room's own count. */
export const SeriesLengthSchema = z.union([z.literal(1), z.literal(3)]);
export type SeriesLength = z.infer<typeof SeriesLengthSchema>;

/** One of a table's (at most two) seats, in seat order. */
export const RoomTablePlayerSchema = z.strictObject({
  memberId: z.string().min(1),
  name: z.string(),
});
export type RoomTablePlayer = z.infer<typeof RoomTablePlayerSchema>;

/** One finished game: the match it was, and which seat won — `null` for a draw or no knowable winner, never a guess. */
export const RoomTableGameSchema = z.strictObject({
  matchId: z.string().min(1),
  winner: z.union([z.literal(0), z.literal(1), z.null()]),
});
export type RoomTableGame = z.infer<typeof RoomTableGameSchema>;

/**
 * A table's schemas, its series moving through the game's `phases`. `id` is `"t-" + 8 hex`, the
 * first table's stable for the room's life; `matchId` is the live game, or `null` between games.
 */
export function roomTableSchemas<const P extends readonly [string, ...string[]]>(phases: P) {
  const SeriesPhaseSchema = z.enum(phases);
  const RoomTableSeriesSchema = z.strictObject({
    length: SeriesLengthSchema,
    wins: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
    games: z.array(RoomTableGameSchema),
    phase: SeriesPhaseSchema,
  });
  const RoomTableSchema = z.strictObject({
    id: z.string().min(1),
    players: z.array(RoomTablePlayerSchema).max(2),
    matchId: z.string().nullable(),
    series: RoomTableSeriesSchema,
  });
  return { SeriesPhaseSchema, RoomTableSeriesSchema, RoomTableSchema, RoomTablesSchema: z.array(RoomTableSchema).min(1) };
}

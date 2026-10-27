/*
 * `GET /api/replays` and `GET /api/replays/:matchId` (`apps/server/src/http/replays.ts`,
 * `docs/planning/wave77-2026-10-27.md` §C, contract 2). A replay is a finished match's public
 * stream, read back from `CARDTABLE_RECORDINGS_DIR` — the same `ServerEnvelope`s the watcher
 * channel sent while it was live, so the front page's `FeaturedMatch` and the `#/replay/<id>`
 * route (lane B) feed them through the same `MatchTransport` either way.
 *
 * `source` says where the list's row came from: `"stream"` when the public stream is still on
 * disk, `"rebuild"` when only the action log is (and lane D's `canRebuild` says it can be turned
 * back into one), `"none"` otherwise — a row the client can still show (it knows who played and
 * when) but not open.
 */
import { z } from 'zod';

import { ManaColorSchema } from './draft.ts';
import { ServerEnvelopeSchema } from './match-wire.ts';

export const ReplaySourceSchema = z.enum(['stream', 'rebuild', 'none']);
export type ReplaySource = z.infer<typeof ReplaySourceSchema>;

const WinnerSchema = z.union([z.literal(0), z.literal(1), z.null()]);
const DecksSchema = z.tuple([z.array(ManaColorSchema).nullable(), z.array(ManaColorSchema).nullable()]);
const PlayersSchema = z.tuple([z.string(), z.string()]);

/** One row of `GET /api/replays`. */
export const ReplaySummarySchema = z.strictObject({
  matchId: z.string().min(1),
  roomId: z.string().nullable(),
  players: PlayersSchema,
  decks: DecksSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  winner: WinnerSchema,
  source: ReplaySourceSchema,
});
export type ReplaySummary = z.infer<typeof ReplaySummarySchema>;

export const ReplayListResponseSchema = z.strictObject({ replays: z.array(ReplaySummarySchema) });
export type ReplayListResponse = z.infer<typeof ReplayListResponseSchema>;

/** `GET /api/replays/:matchId`'s own `header` — the public stream's line 1. */
export const ReplayHeaderSchema = z.strictObject({
  matchId: z.string().min(1),
  roomId: z.string().nullable(),
  players: PlayersSchema,
  ai: z.tuple([z.boolean(), z.boolean()]),
  decks: DecksSchema,
  startedAt: z.string(),
});
export type ReplayHeader = z.infer<typeof ReplayHeaderSchema>;

export const ReplayEnvSchema = z.strictObject({ at: z.number().nonnegative(), env: ServerEnvelopeSchema });
export type ReplayEnv = z.infer<typeof ReplayEnvSchema>;

export const ReplayEndSchema = z.strictObject({ endedAt: z.string(), winner: WinnerSchema });
export type ReplayEnd = z.infer<typeof ReplayEndSchema>;

export const ReplayDetailResponseSchema = z.strictObject({
  header: ReplayHeaderSchema,
  envs: z.array(ReplayEnvSchema),
  end: ReplayEndSchema,
});
export type ReplayDetailResponse = z.infer<typeof ReplayDetailResponseSchema>;

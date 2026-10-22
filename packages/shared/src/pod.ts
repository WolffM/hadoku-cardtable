/*
 * A draft pod's rounds, on the wire — `RoomView.pod` (wave 72 §P,
 * `docs/planning/wave72-2026-10-17.md`'s "Wire contract").
 *
 * `null` for a constructed room; for a `draft` room this is the whole of
 * "what phase is the pod in, and what has it decided so far" — the lobby's 8
 * seats, the round counter, every round's results, the standings, this
 * round's pairings, this round's bye, and who has a legal built deck saved.
 *
 * **`results`/`standings` mirror `@hadoku/draft`'s `MatchResult`/
 * `StandingsRow` shapes rather than importing them.** `@hadoku/draft` already
 * depends on `@hadoku/shared` (`packages/draft/package.json`), so the
 * dependency can only run this direction — importing back would be a cycle.
 * The shapes are restated here, field for field, the same discipline
 * `room-tables.ts`'s `RoomTableGame`/`RoomTableSeries` already keep for
 * `apps/server/src/room/lobby.ts`'s own mirrors of THEM. `apps/server/src/room/lobby.ts`
 * (lane P) is the one place that holds both a `MatchResult`/`StandingsRow`
 * from `@hadoku/draft` and a `PodMatchResult`/`PodStandingsRow` for the wire,
 * and it is responsible for the two staying byte-for-byte the same shape.
 *
 * `standings` on the wire adds `rank` (1-based, ties broken exactly as
 * `@hadoku/draft`'s `standings` already orders its array — the position IS
 * the rank) so a pod screen never has to re-sort or re-run the tiebreakers
 * itself to show a leaderboard.
 */

import { z } from 'zod';
import { DraftPlanSchema, PoolVerdictSchema } from './pool.ts';

/** A draft room's phases, lobby to done — `draft-pods-plan.md`'s "Pods". */
export const POD_PHASES = ['lobby', 'drafting', 'building', 'rounds', 'done'] as const;
export const PodPhaseSchema = z.enum(POD_PHASES);
export type PodPhase = z.infer<typeof PodPhaseSchema>;

/** How many pod seats there are on the seat UI (ruling 4: up to 8, reused from the 1v1 table's own seat components). */
export const POD_SEATS = 8;

/** One pod seat in the lobby phase: who is sitting there, or nobody. */
export const PodMemberSchema = z.strictObject({
  memberId: z.string().min(1),
  name: z.string(),
});
export type PodMember = z.infer<typeof PodMemberSchema>;

/** The 8 pod seats, in seat order. An empty seat is `null`. */
export const PodSeatsSchema = z.array(PodMemberSchema.nullable()).length(POD_SEATS);
export type PodSeats = z.infer<typeof PodSeatsSchema>;

/**
 * One finished round for one player's match — the wire mirror of
 * `@hadoku/draft`'s `MatchResult`. A bye is its own result (`playerB: null`),
 * counted as a 2-0 win for `playerA`; `gamesA`/`gamesB` are not read for one.
 */
export const PodMatchResultSchema = z.strictObject({
  round: z.number().int().min(1),
  playerA: z.string().min(1),
  playerB: z.string().min(1).nullable(),
  gamesA: z.number().int().min(0),
  gamesB: z.number().int().min(0),
});
export type PodMatchResult = z.infer<typeof PodMatchResultSchema>;

/**
 * One player's standing — the wire mirror of `@hadoku/draft`'s
 * `StandingsRow`, plus `rank`: this row's 1-based position in the ranked
 * list the engine already produced, so a pod screen draws a leaderboard
 * without re-deriving the tiebreak order itself.
 */
export const PodStandingsRowSchema = z.strictObject({
  id: z.string().min(1),
  matchPoints: z.number().min(0),
  opponentMatchWinPct: z.number().min(0).max(1),
  gameWinPct: z.number().min(0).max(1),
  opponentGameWinPct: z.number().min(0).max(1),
  rank: z.number().int().min(1),
});
export type PodStandingsRow = z.infer<typeof PodStandingsRowSchema>;

/** One of the current round's tables: the two players seated at it. */
export const PodPairingSchema = z.strictObject({
  tableId: z.string().min(1),
  players: z.tuple([z.string().min(1), z.string().min(1)]),
});
export type PodPairing = z.infer<typeof PodPairingSchema>;

/**
 * `RoomView.pod`'s own shape, present (non-`null`) whenever
 * `RoomView.gameType === 'draft'`.
 */
export const PodViewSchema = z.strictObject({
  phase: PodPhaseSchema,
  /** The 8 pod seats — filled only in the `lobby` phase; empty (all `null`) once drafting starts. */
  seats: PodSeatsSchema,
  /** 0 until rounds start; 1-based once they have. */
  round: z.number().int().min(0),
  /** `roundsFor(humans)` — fixed once the pod reaches `rounds`. */
  rounds: z.number().int().min(0),
  /** Every round's results so far, byes included. */
  results: z.array(PodMatchResultSchema),
  /** Ranked standings, `rank` 1-based. Empty before round 1 finishes. */
  standings: z.array(PodStandingsRowSchema),
  /** The CURRENT round's pairings. Empty outside `rounds`, or once the round is done and the next has not yet been made. */
  pairings: z.array(PodPairingSchema),
  /** The CURRENT round's bye, or `null` (an even round, or outside `rounds`). */
  bye: z.string().min(1).nullable(),
  /**
   * Every human drafting this pod, in pod seat order — the list `built` is a
   * subset of, and the one the server's own gate for starting `rounds` checks.
   * Empty in `lobby`, where `seats` says who is sitting.
   */
  drafters: z.array(z.string().min(1)),
  /** Drafters whose deck is saved and legal — `building`'s own gate for starting `rounds`. */
  built: z.array(z.string().min(1)),
  /**
   * The room's pool choice (wave 73 §A) — the Settled default (Vintage Cube
   * 2025-12 × 3) until the leader picks otherwise, frozen once drafting
   * starts (`PUT /api/rooms/:id/pod/plan` is `lobby`-phase only).
   */
  plan: DraftPlanSchema,
  /** The display name of round 1's source — `cube.name` for a cube, or a set's own name once wave 74 adds those. */
  planName: z.string(),
  /** `plan`'s last playability check, or `null` while one is running or before the first ever ran. */
  verdict: PoolVerdictSchema.nullable(),
});
export type PodView = z.infer<typeof PodViewSchema>;

/** `RoomView.pod`: `null` for a constructed room, a `PodView` for a draft room. */
export const RoomPodSchema = PodViewSchema.nullable();
export type RoomPod = z.infer<typeof RoomPodSchema>;

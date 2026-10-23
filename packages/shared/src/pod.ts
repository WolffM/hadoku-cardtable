/*
 * A pod's rounds, on the wire — `RoomView.pod` (wave 72 §P,
 * `docs/planning/wave72-2026-10-17.md`'s "Wire contract"; generalised to a
 * constructed tournament by `docs/planning/tournament-mode-plan.md`).
 *
 * `null` for a plain constructed room; for a `draft` room, or a
 * `constructed-1v1` one with `settings.tournament` on, this is the whole of
 * "what phase is the pod in, and what has it decided so far" — the lobby's 8
 * seats, the round counter, every round's results, the standings, this
 * round's pairings, this round's bye, and (a draft pod only) who has a legal
 * built deck saved.
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
  /** An AI seat's own character, the watchparty avatar id it drafts as. A member's comes from the room's members. */
  avatarId: z.string().min(1).optional(),
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

/**
 * A pod that played a round, kept past its room for the stats popout's
 * Tournaments tab: the server's stored record and `GET /api/tournaments`'s
 * rows are this one shape, so both keep the same records.
 */
export const TournamentSchema = z.object({
  /** `<roomId>-<draftStartedAt>`: one per pod, so a room that drafts twice keeps both. */
  id: z.string(),
  name: z.string(),
  /** ms since epoch: the draft's deal, and the last round's end or the close. */
  startedAt: z.number(),
  endedAt: z.number(),
  /** Closed by its owner before its last round finished. */
  closed: z.boolean(),
  rounds: z.number(),
  /** Display names by id, the AI included — the room that knew them is gone. */
  names: z.record(z.string(), z.string()),
  standings: z.array(PodStandingsRowSchema),
  results: z.array(PodMatchResultSchema),
});
export type Tournament = z.infer<typeof TournamentSchema>;

/** One of the current round's tables: the two players seated at it. */
export const PodPairingSchema = z.strictObject({
  tableId: z.string().min(1),
  players: z.tuple([z.string().min(1), z.string().min(1)]),
});
export type PodPairing = z.infer<typeof PodPairingSchema>;

/**
 * `RoomView.pod`'s own shape, present (non-`null`) whenever
 * `RoomView.gameType === 'draft'`, OR whenever it is `'constructed-1v1'` with
 * `RoomView.settings.tournament` on (`docs/planning/tournament-mode-plan.md`).
 * A constructed tournament's phases are only ever `lobby` / `rounds` / `done`
 * (it never drafts or builds a deck), so `plan`/`planName`/`verdict` — a
 * DRAFT's pool choice and its playability check — read `null`/`''`/`null`
 * there; every OTHER field (seats, round, standings, pairings, bye,
 * drafters, built) is filled exactly as a draft pod's, because it is the
 * same Swiss engine.
 *
 * An entrant id on the wire (`seats[].memberId`, `drafters`, `built`,
 * `pairings[].players`, `results[].playerA/B`, `standings[].id`) is either a
 * real member id, or one of the two AI sentinels: `'ai'` (`POD_AI`, a DRAFT
 * pod's single shared bot, unchanged) or `` `ai:<seat>` `` (a TOURNAMENT
 * pod's own AI entrant, one per AI seat — see `room/lobby.ts`'s
 * `aiEntrantId`). `isPodAi` is the one question "is this id an AI, of
 * either shape" — every reader of an entrant id, server and UI, answers it
 * through that rather than its own `=== 'ai'` or `startsWith('ai:')` check,
 * so a tournament AI entrant never silently reads as a human member.
 */
export const AI_ENTRANT_PREFIX = 'ai:';

/**
 * Whether `id` is an AI entrant on the wire: a draft pod's single shared bot
 * (`'ai'`) or a tournament pod's own per-seat one (`` `ai:<seat>` ``). Never a
 * real member id — a bare `'ai'` and the `'ai:'` prefix are both reserved
 * (`room/lobby.ts`'s `POD_AI`/`aiEntrantId`; no `identityFromHeaders` id is
 * ever either shape).
 */
export function isPodAi(id: string): boolean {
  return id === 'ai' || (id.startsWith(AI_ENTRANT_PREFIX) && /^\d+$/.test(id.slice(AI_ENTRANT_PREFIX.length)));
}

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
   * Every AI entrant's character past the lobby, by entrant id (`'ai'` or `` `ai:<seat>` ``): who the
   * bracket, the standings and a table draw for it. Empty in `lobby`, where `seats` carry their own.
   */
  personas: z.record(z.string(), z.strictObject({ name: z.string(), avatarId: z.string().min(1) })),
  /**
   * The room's pool choice (wave 73 §A) — the Settled default (Vintage Cube
   * 2025-12 × 3) until the leader picks otherwise, frozen once drafting
   * starts (`PUT /api/rooms/:id/pod/plan` is `lobby`-phase only). `null` for
   * a constructed tournament pod, which drafts no pool at all.
   */
  plan: DraftPlanSchema.nullable(),
  /** The display name of round 1's source — `cube.name` for a cube, or a set's own name once wave 74 adds those. `''` for a constructed tournament pod. */
  planName: z.string(),
  /** `plan`'s last playability check, or `null` while one is running or before the first ever ran. */
  verdict: PoolVerdictSchema.nullable(),
});
export type PodView = z.infer<typeof PodViewSchema>;

/** `RoomView.pod`: `null` for a constructed room, a `PodView` for a draft room. */
export const RoomPodSchema = PodViewSchema.nullable();
export type RoomPod = z.infer<typeof RoomPodSchema>;

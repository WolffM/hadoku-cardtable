/*
 * Pod pairings and standings.
 *
 * Pure and transport-free, like the rest of this package: no I/O, no room,
 * no socket. `pairRound` decides who plays whom for one round of the
 * tournament's single Swiss — every entrant of every pod in one field, at
 * most three rounds, no cut (the operator, 2026-10-31); `standings` ranks
 * that field between rounds and at the end. Its players are whoever the room
 * seated, bots included (a draft pod's every bot seat, the operator,
 * 2026-11-07); nothing here adds an AI to fill a bye.
 *
 * The tiebreaker order in `standings` — match points, then opponents'
 * match-win percentage (33% floor), then game-win percentage, then
 * opponents' game-win percentage (33% floor) — is the standard Swiss
 * tiebreak order used by organized Magic tournaments (Wizards' Magic
 * Tournament Rules, Appendix C, "Breaking Ties"). Cited from knowledge, not
 * fetched; nothing here was looked up on the web. A fifth is our own: the
 * faster median game ranks higher (the operator, 2026-10-23: *"it is still
 * possible to reach a tie this way. lets also add a 5th tie breaker for
 * game-speed. the player that had fastest median game wins"*). After those,
 * so that a winner is always decided (the operator, 2026-10-31: *"tiebreakers
 * at the end determine who wins"*): head-to-head among the players still
 * tied, then a draw seeded by the tournament id.
 */

import { POD_TIEBREAKS, type PodTiebreak } from '@hadoku/shared';

/** One pod seat, in the order the pod filled (1-based is fine; only order matters). */
export interface PodPlayer {
  id: string;
  podSeat: number;
}

/**
 * One finished round for one player's match.
 *
 * A bye is recorded as its own result with `playerB: null` — per the
 * ruling, it counts as a 2–0 win for `playerA`, so `gamesA`/`gamesB` are not
 * read for a bye; `pairRound` and `standings` treat it as 2 games won, 0 lost.
 * A real match's `gamesA`/`gamesB` are the games each side won; equal counts
 * are a draw (1 match point each). `gameMs` is how long each of its games
 * lasted, when the server timed them; a bye, an AI-vs-AI pairing settled
 * without a game (no bot game wired, or one with no result), or a result
 * recorded before games were timed has none.
 */
export interface MatchResult {
  round: number;
  playerA: string;
  playerB: string | null;
  gamesA: number;
  gamesB: number;
  gameMs?: number[];
}

export interface PairRoundResult {
  tables: [string, string][];
  bye: string | null;
}

/** Match points for one side of a result: win 3, draw 1, loss 0; a bye is a 3-point win. */
function pointsFor(result: MatchResult, side: 'A' | 'B'): number {
  if (result.playerB === null) return side === 'A' ? 3 : 0;
  if (result.gamesA === result.gamesB) return 1;
  if (side === 'A') return result.gamesA > result.gamesB ? 3 : 0;
  return result.gamesB > result.gamesA ? 3 : 0;
}

function matchPointsTotal(id: string, results: readonly MatchResult[]): number {
  let total = 0;
  for (const r of results) {
    if (r.playerA === id) total += pointsFor(r, 'A');
    else if (r.playerB === id) total += pointsFor(r, 'B');
  }
  return total;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Backtracking search for a perfect matching of `remaining`, order-preserving
 * where possible ("pair down from the top": the first player in `remaining`
 * is tried against the closest-ranked opponent first). `avoidRepeats` true
 * rejects any pair already in `played`; this is tried first, and only when it
 * has no solution does `pairRound` fall back to allowing one.
 *
 * The strict search cannot dead-end into an exhaustive one within
 * `roundsFor`'s three rounds: each player has met at most two others, so in
 * a group of six or more every player still has an unmet opponent among at
 * least half the rest, and a repeat-free matching exists and is found by the
 * first few branches.
 */
function tryPair(remaining: PodPlayer[], played: ReadonlySet<string>, avoidRepeats: boolean): [string, string][] | null {
  if (remaining.length === 0) return [];
  const first = remaining[0] as PodPlayer;
  const rest = remaining.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const candidate = rest[i] as PodPlayer;
    if (avoidRepeats && played.has(pairKey(first.id, candidate.id))) continue;
    const others = rest.slice(0, i).concat(rest.slice(i + 1));
    const sub = tryPair(others, played, avoidRepeats);
    if (sub !== null) return [[first.id, candidate.id], ...sub];
  }
  return null;
}

/** Pair an even-length, already-ranked list, preferring no repeat pairing. */
function pairDown(ranked: PodPlayer[], played: ReadonlySet<string>): [string, string][] {
  const strict = tryPair(ranked, played, true);
  if (strict !== null) return strict;
  // No repeat-free pairing exists for this group; pair anyway. For an even
  // list this always has a solution (any perfect matching), so the relaxed
  // search cannot return null.
  const relaxed = tryPair(ranked, played, false);
  if (relaxed === null) throw new Error('pairDown: no pairing exists for an even-length group');
  return relaxed;
}

/**
 * Round 1, across the table: players ordered by `podSeat`, player `i` (1-based
 * position in that order) plays player `i + ceil(H/2)`.
 *
 * Decision (the brief flags this as ambiguous): with an odd `H`, that formula
 * pairs positions `1..ceil(H/2)-1` with `ceil(H/2)+1..H`, and leaves exactly
 * position `ceil(H/2)` — the last seat of the top half — unpaired. That seat
 * gets the bye. (E.g. H=5: seats 1-4 and 2-5 play; seat 3 sits out.)
 */
function round1(players: PodPlayer[]): PairRoundResult {
  const sorted = [...players].sort((a, b) => a.podSeat - b.podSeat);
  const half = Math.ceil(sorted.length / 2);
  const pairedCount = sorted.length - half;
  const tables: [string, string][] = [];
  for (let i = 0; i < pairedCount; i++) {
    tables.push([(sorted[i] as PodPlayer).id, (sorted[i + half] as PodPlayer).id]);
  }
  const bye = sorted.length % 2 === 1 ? (sorted[half - 1] as PodPlayer).id : null;
  return { tables, bye };
}

/**
 * Round 2+, by score: match points from every prior result, pair down from
 * the top avoiding a repeat pairing while one exists. Ties in match points
 * break by `podSeat` (ascending), which keeps pairing deterministic without
 * needing the fuller `standings` tiebreakers mid-pod.
 *
 * The bye (when `players.length` is odd) goes to the lowest-ranked player who
 * has not already had one (a prior bye is a `MatchResult` with `playerB: null`
 * for that player, at any round).
 */
function laterRound(players: PodPlayer[], results: MatchResult[]): PairRoundResult {
  const hadBye = new Set<string>();
  const played = new Set<string>();
  for (const r of results) {
    if (r.playerB === null) hadBye.add(r.playerA);
    else played.add(pairKey(r.playerA, r.playerB));
  }

  const ranked = [...players].sort((a, b) => {
    const pa = matchPointsTotal(a.id, results);
    const pb = matchPointsTotal(b.id, results);
    if (pa !== pb) return pb - pa;
    return a.podSeat - b.podSeat;
  });

  let bye: string | null = null;
  let pool = ranked;
  if (ranked.length % 2 === 1) {
    let byeIndex = -1;
    for (let i = ranked.length - 1; i >= 0; i--) {
      if (!hadBye.has((ranked[i] as PodPlayer).id)) {
        byeIndex = i;
        break;
      }
    }
    // Every player has already had a bye (can't happen within roundsFor's
    // rounds, since there are always more players than rounds); fall back to
    // the lowest rank rather than crash.
    if (byeIndex === -1) byeIndex = ranked.length - 1;
    bye = (ranked[byeIndex] as PodPlayer).id;
    pool = ranked.slice(0, byeIndex).concat(ranked.slice(byeIndex + 1));
  }

  return { tables: pairDown(pool, played), bye };
}

/** One more question a round's pairing may be asked: the tournament's structure, if it has one. */
export interface PairRoundInput {
  players: PodPlayer[];
  results: MatchResult[];
  round: number;
  /** The tournament's structure; absent is the product's own — Swiss only, `roundsFor` rounds, no cut. */
  structure?: PodStructure;
  /** The tournament's own seed (`rankedStandings`'s), for a cut's seeding when Swiss was played. */
  seed?: string;
}

/** Pair one round of the whole field. See `round1` and `laterRound` for the Swiss rules; a cut round is bracketed by rank. */
export function pairRound(input: PairRoundInput): PairRoundResult {
  const { players, results, round, structure, seed = '' } = input;
  if (players.length === 0) return { tables: [], bye: null };
  if (players.length === 1) return { tables: [], bye: (players[0] as PodPlayer).id };
  if (structure !== undefined && structure.cut > 1 && round > structure.swiss) {
    return cutRound(players, results, seed, structure);
  }
  return round === 1 ? round1(players) : laterRound(players, results);
}

/** The most Swiss rounds a tournament plays, however large its field (the operator, 2026-10-31). */
export const MAX_ROUNDS = 3;

/** How many Swiss rounds a field of `n` entrants plays: `min(3, ceil(log2(n)))`. */
export function roundsFor(n: number): number {
  if (n <= 1) return 0;
  return Math.min(MAX_ROUNDS, Math.ceil(Math.log2(n)));
}

/**
 * A tournament's structure: how many Swiss rounds it plays, and whether a
 * single-elimination cut follows them.
 *
 * The product's own default — every room until structures existed — is
 * `cut: 0`: Swiss only, the whole field every round, standings deciding the
 * winner (the operator, 2026-10-31: "no cut"). A cut is how a Magic
 * Challenge is actually run: Swiss narrows the field, then the top
 * `cut` — a power of two, single elimination — plays bracket rounds to a
 * final. `swiss: 0` with a cut is a pure bracket: the whole field, seeded
 * by pod seat, one elimination per round. That shape is also what a
 * historical replay seeds, where round 1 IS the event's own quarterfinals.
 */
export interface PodStructure {
  /** Swiss rounds before any cut. 0 for a pure bracket. */
  readonly swiss: number;
  /** Single-elimination entrants after the Swiss (a power of two), or 0 for no cut. */
  readonly cut: number;
}

/** Whether `n` is a power of two (1, 2, 4, 8, …); a cut must be one. */
export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

/** Whether a structure is one a pod can play: a non-negative power-of-two cut, at most the field. */
export function structureOk(structure: PodStructure, field: number): boolean {
  if (!Number.isInteger(structure.swiss) || structure.swiss < 0) return false;
  if (!Number.isInteger(structure.cut) || structure.cut < 0) return false;
  if (structure.cut === 0) return true;
  return isPowerOfTwo(structure.cut) && structure.cut <= field && structure.cut >= 2;
}

/** The total rounds a structure plays over `field` entrants: Swiss rounds plus every elimination round. */
export function roundsOf(structure: PodStructure, field: number): number {
  return structure.swiss + (structure.cut > 1 ? Math.ceil(Math.log2(structure.cut)) : 0);
}

/** The survivors of `round` (1-based) under `structure`: players with no loss in an elimination round. */
export function cutSurvivors(structure: PodStructure, results: readonly MatchResult[], round: number): string[] {
  if (structure.cut <= 1 || round <= structure.swiss) return [];
  const losers = new Set<string>();
  for (const r of results) {
    if (r.round <= structure.swiss) continue;
    if (r.playerB === null) continue;
    if (r.gamesA > r.gamesB) losers.add(r.playerB);
    else if (r.gamesB > r.gamesA) losers.add(r.playerA);
  }
  const seen = new Set<string>(results.map((r) => r.playerA));
  for (const r of results) if (r.playerB !== null) seen.add(r.playerB);
  return [...seen].filter((id) => !losers.has(id));
}

/**
 * Pair one elimination round: the survivors, in rank order, across the
 * table — rank 1 vs rank `half+1`, rank 2 vs rank `half+2`, … — the bracket
 * seeding Magic itself uses. Rank comes from `standings` once any Swiss has
 * been played; a pure bracket (no Swiss) ranks by `podSeat`, so a seeded
 * field's seat order IS its bracket.
 */
function cutRound(players: PodPlayer[], results: readonly MatchResult[], seed: string, structure: PodStructure): PairRoundResult {
  // Every prior elimination round's losers are out; `round` here only gates
  // "are we past the Swiss", and a cut round always is.
  const survivors = cutSurvivors(structure, results, structure.swiss + 1);
  const pool = survivors.length > 0 ? players.filter((p) => survivors.includes(p.id)) : players;
  const ranked =
    structure.swiss > 0
      ? rankedStandings(pool.map((p) => ({ id: p.id })), results, seed).map((row) => {
          const player = pool.find((p) => p.id === row.id);
          return { ...player!, podSeat: row.rank };
        })
      : [...pool].sort((a, b) => a.podSeat - b.podSeat);
  const half = Math.ceil(ranked.length / 2);
  const tables: [string, string][] = [];
  for (let i = 0; i < ranked.length - half; i++) {
    tables.push([(ranked[i] as PodPlayer).id, (ranked[i + half] as PodPlayer).id]);
  }
  // An odd field cannot happen in a power-of-two cut, but a bye keeps the
  // function total rather than throwing on a hand-fed structure.
  const bye = ranked.length % 2 === 1 ? (ranked[ranked.length - 1] as PodPlayer).id : null;
  return { tables, bye };
}

export interface StandingsRow {
  id: string;
  matchPoints: number;
  opponentMatchWinPct: number;
  gameWinPct: number;
  opponentGameWinPct: number;
  /** The median length of every timed game this player played, in ms; `null` with none timed. */
  medianGameMs: number | null;
}

/** The ranking keys, in order (`@hadoku/shared`'s `POD_TIEBREAKS`, the wire's): what `RankedStandingsRow.decidedBy` names. */
export const TIEBREAKS = POD_TIEBREAKS;
export type Tiebreak = PodTiebreak;

export interface RankedStandingsRow extends StandingsRow {
  /** 1-based, and every row its own: the seeded draw leaves no two rows level. */
  rank: number;
  /** The first key on which this row ranks below the one above it; `null` only for the first row. */
  decidedBy: Tiebreak | null;
}

/** The five keys a row carries; head-to-head and the draw are read from the results and the seed. */
const ROW_KEYS = ['matchPoints', 'opponentMatchWinPct', 'gameWinPct', 'opponentGameWinPct', 'medianGameMs'] as const;
type RowKey = (typeof ROW_KEYS)[number];

/** 33% floor applied to a player's own percentage before it counts toward an opponent's average (MTR Appendix C). */
const FLOOR = 1 / 3;

function ownMatchWinPct(id: string, results: readonly MatchResult[]): number {
  let played = 0;
  let won = 0;
  for (const r of results) {
    if (r.playerA === id) {
      played++;
      if (r.playerB === null || r.gamesA > r.gamesB) won++;
    } else if (r.playerB === id) {
      played++;
      if (r.gamesB > r.gamesA) won++;
    }
  }
  return played === 0 ? 0 : won / played;
}

function ownGameWinPct(id: string, results: readonly MatchResult[]): number {
  let gamesPlayed = 0;
  let gamesWon = 0;
  for (const r of results) {
    if (r.playerA === id) {
      if (r.playerB === null) {
        gamesPlayed += 2;
        gamesWon += 2;
      } else {
        gamesPlayed += r.gamesA + r.gamesB;
        gamesWon += r.gamesA;
      }
    } else if (r.playerB === id) {
      gamesPlayed += r.gamesA + r.gamesB;
      gamesWon += r.gamesB;
    }
  }
  return gamesPlayed === 0 ? 0 : gamesWon / gamesPlayed;
}

/** Every opponent a player actually faced (a bye round contributes no opponent). */
function opponentsOf(id: string, results: readonly MatchResult[]): string[] {
  const out: string[] = [];
  for (const r of results) {
    if (r.playerB === null) continue;
    if (r.playerA === id) out.push(r.playerB);
    else if (r.playerB === id) out.push(r.playerA);
  }
  return out;
}

function average(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

/** Every timed game a player played, a bye none. */
function gameLengths(id: string, results: readonly MatchResult[]): number[] {
  return results.flatMap((r) => (r.playerB !== null && (r.playerA === id || r.playerB === id) ? (r.gameMs ?? []) : []));
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** How `b` compares to `a` on one key: negative ranks `b` higher. Faster is higher, and untimed last. */
function compareOn(key: RowKey, a: StandingsRow, b: StandingsRow): number {
  if (key !== 'medianGameMs') return b[key] - a[key];
  if (a.medianGameMs === b.medianGameMs) return 0;
  if (a.medianGameMs === null) return 1;
  if (b.medianGameMs === null) return -1;
  return a.medianGameMs - b.medianGameMs;
}

function compareRowKeys(a: StandingsRow, b: StandingsRow): number {
  for (const key of ROW_KEYS) {
    const c = compareOn(key, a, b);
    if (c !== 0) return c;
  }
  return 0;
}

/** FNV-1a, 32-bit: a stable hash with no dependency, enough to shuffle a handful of tied players. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** The seeded draw's ticket: lower ranks higher. The id itself settles the (vanishing) hash collision. */
function drawOrder(seed: string, a: string, b: string): number {
  const d = fnv1a(`${seed}\u0000${a}`) - fnv1a(`${seed}\u0000${b}`);
  if (d !== 0) return d;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Each row's head-to-head score: the match points it took from the other rows it is tied with on all
 * five keys (where the tied players met), so it compares within a tie group and means nothing across one.
 */
function headToHeadScores(rows: readonly StandingsRow[], results: readonly MatchResult[]): Map<string, number> {
  const groupOf = new Map<string, number>();
  const groups: StandingsRow[][] = [];
  for (const row of rows) {
    const group = groups.findIndex((g) => compareRowKeys(g[0]!, row) === 0);
    if (group === -1) {
      groupOf.set(row.id, groups.length);
      groups.push([row]);
    } else {
      groupOf.set(row.id, group);
      groups[group]!.push(row);
    }
  }
  const scores = new Map(rows.map((r) => [r.id, 0]));
  for (const r of results) {
    if (r.playerB === null) continue;
    const group = groupOf.get(r.playerA);
    if (group === undefined || group !== groupOf.get(r.playerB)) continue;
    scores.set(r.playerA, scores.get(r.playerA)! + pointsFor(r, 'A'));
    scores.set(r.playerB, scores.get(r.playerB)! + pointsFor(r, 'B'));
  }
  return scores;
}

/** The whole order, as a list of keys: the five a row carries, then head-to-head, then the draw. */
function comparator(rows: readonly StandingsRow[], results: readonly MatchResult[], seed: string) {
  const h2h = headToHeadScores(rows, results);
  const on = (key: Tiebreak, a: StandingsRow, b: StandingsRow): number => {
    if (key === 'headToHead') return h2h.get(b.id)! - h2h.get(a.id)!;
    if (key === 'seededDraw') return drawOrder(seed, a.id, b.id);
    return compareOn(key, a, b);
  };
  const compare = (a: StandingsRow, b: StandingsRow): number => {
    for (const key of TIEBREAKS) {
      const c = on(key, a, b);
      if (c !== 0) return c;
    }
    return 0;
  };
  return { on, compare };
}

/** Ranked standings' places, in the full order: every row its own rank, naming the key it fell below the row above on. */
export function rankStandings(rows: readonly StandingsRow[], results: readonly MatchResult[] = [], seed = ''): RankedStandingsRow[] {
  const { on, compare } = comparator(rows, results, seed);
  const ordered = [...rows].sort(compare);
  return ordered.map((row, i) => {
    const above = ordered[i - 1];
    const decidedBy = above === undefined ? null : (TIEBREAKS.find((key) => on(key, above, row) !== 0) ?? null);
    return { ...row, rank: i + 1, decidedBy };
  });
}

/**
 * Standings, ranked by match points, then opponents' match-win %, then
 * game-win %, then opponents' game-win %, then the faster median game, then
 * head-to-head among the still tied, then the draw `seed` (the tournament id)
 * makes — see the file header for the citations. A player who has faced no opponents yet (round 0, or an
 * all-byes run) gets 0 for both opponent percentages; there is no opponent
 * data to average.
 */
export function standings(players: readonly { id: string }[], results: readonly MatchResult[], seed = ''): StandingsRow[] {
  const rows = players.map((p): StandingsRow => {
    const opponents = opponentsOf(p.id, results);
    const opponentMatchPcts = opponents.map((o) => Math.max(FLOOR, ownMatchWinPct(o, results)));
    const opponentGamePcts = opponents.map((o) => Math.max(FLOOR, ownGameWinPct(o, results)));
    return {
      id: p.id,
      matchPoints: matchPointsTotal(p.id, results),
      opponentMatchWinPct: average(opponentMatchPcts),
      gameWinPct: ownGameWinPct(p.id, results),
      opponentGameWinPct: average(opponentGamePcts),
      medianGameMs: median(gameLengths(p.id, results)),
    };
  });
  return rows.sort(comparator(rows, results, seed).compare);
}

/** `standings` ranked: the field's one leaderboard, every place decided. `seed` is the tournament id. */
export function rankedStandings(players: readonly { id: string }[], results: readonly MatchResult[], seed: string): RankedStandingsRow[] {
  return rankStandings(standings(players, results, seed), results, seed);
}

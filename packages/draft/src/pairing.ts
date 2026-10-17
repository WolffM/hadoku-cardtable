/*
 * Pod pairings and standings.
 *
 * Pure and transport-free, like the rest of this package: no I/O, no room,
 * no socket. `pairRound` decides who plays whom for one round of a draft
 * pod's Swiss rounds; `standings` ranks the pod between rounds and at the
 * end. The AI-bye option the operator left open (`draft-pods-plan.md`
 * ruling 3) is not built here — an unpaired human always gets a bye, never
 * an AI seat.
 *
 * The tiebreaker order in `standings` — match points, then opponents'
 * match-win percentage (33% floor), then game-win percentage, then
 * opponents' game-win percentage (33% floor) — is the standard Swiss
 * tiebreak order used by organized Magic tournaments (Wizards' Magic
 * Tournament Rules, Appendix C, "Breaking Ties"). Cited from knowledge, not
 * fetched; nothing here was looked up on the web.
 */

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
 * are a draw (1 match point each).
 */
export interface MatchResult {
  round: number;
  playerA: string;
  playerB: string | null;
  gamesA: number;
  gamesB: number;
}

export interface PairRoundInput {
  players: PodPlayer[];
  results: MatchResult[];
  round: number;
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

function matchPointsTotal(id: string, results: MatchResult[]): number {
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
 * `remaining.length` is at most 8 (the pod cap), so the search space — at
 * most 7!! = 105 matchings — is trivial.
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
    // Every player has already had a bye (shouldn't happen within
    // roundsFor(players.length) rounds, since there are always more players
    // than rounds); fall back to the lowest rank rather than crash.
    if (byeIndex === -1) byeIndex = ranked.length - 1;
    bye = (ranked[byeIndex] as PodPlayer).id;
    pool = ranked.slice(0, byeIndex).concat(ranked.slice(byeIndex + 1));
  }

  return { tables: pairDown(pool, played), bye };
}

/** Pair one round of a pod. See `round1` and `laterRound` for the per-round rules. */
export function pairRound(input: PairRoundInput): PairRoundResult {
  const { players, results, round } = input;
  if (players.length === 0) return { tables: [], bye: null };
  if (players.length === 1) return { tables: [], bye: (players[0] as PodPlayer).id };
  return round === 1 ? round1(players) : laterRound(players, results);
}

/** How many Swiss rounds a pod of `n` humans plays: `ceil(log2(n))`. */
export function roundsFor(n: number): number {
  if (n <= 1) return 0;
  let rounds = 0;
  let capacity = 1;
  while (capacity < n) {
    capacity *= 2;
    rounds++;
  }
  return rounds;
}

export interface StandingsRow {
  id: string;
  matchPoints: number;
  opponentMatchWinPct: number;
  gameWinPct: number;
  opponentGameWinPct: number;
}

/** 33% floor applied to a player's own percentage before it counts toward an opponent's average (MTR Appendix C). */
const FLOOR = 1 / 3;

function ownMatchWinPct(id: string, results: MatchResult[]): number {
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

function ownGameWinPct(id: string, results: MatchResult[]): number {
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
function opponentsOf(id: string, results: MatchResult[]): string[] {
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

/**
 * Standings, ranked by match points, then opponents' match-win %, then
 * game-win %, then opponents' game-win % — see the file header for the
 * citation. A player who has faced no opponents yet (round 0, or an
 * all-byes run) gets 0 for both opponent percentages; there is no opponent
 * data to average.
 */
export function standings(players: readonly { id: string }[], results: MatchResult[]): StandingsRow[] {
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
    };
  });
  return rows.sort(
    (a, b) =>
      b.matchPoints - a.matchPoints ||
      b.opponentMatchWinPct - a.opponentMatchWinPct ||
      b.gameWinPct - a.gameWinPct ||
      b.opponentGameWinPct - a.opponentGameWinPct,
  );
}

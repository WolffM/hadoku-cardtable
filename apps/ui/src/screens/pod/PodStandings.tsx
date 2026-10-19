/*
 * The pod's standings — wave 72 §R.2. Drawn under the tables throughout
 * `rounds`, and alone once the pod reaches `done` (the brief's own
 * ordering: "Standings sit under the tables throughout rounds").
 *
 * `rows` is already ranked (`PodStandingsRow.rank`, 1-based — the wire
 * contract's own ordering, `@hadoku/draft`'s tiebreak order), so this never
 * re-sorts; it only resolves each row's `id` (a member id) to a display
 * name through `nameOf`, the same indirection `PodSeats`/`PodTables` use
 * rather than carrying a name on the row itself.
 */

import './PodStandings.css';

export interface PodStandingsRowLike {
  id: string;
  matchPoints: number;
  opponentMatchWinPct: number;
  gameWinPct: number;
  opponentGameWinPct: number;
  rank: number;
}

/** A finished match, as `PodView.results` carries it — `playerB` null for a bye. */
export interface PodResultLike {
  playerA: string;
  playerB: string | null;
}

export interface PodStandingsProps {
  rows: PodStandingsRowLike[];
  results: readonly PodResultLike[];
  nameOf: (memberId: string) => string;
  myMemberId: string | null;
}

/** `62%`, never `61.999…%`. */
function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** Match points over the most a player could have taken, three a match — a bye counts as a win. */
function matchWinPct(row: PodStandingsRowLike, results: readonly PodResultLike[]): number {
  const played = results.filter((r) => r.playerA === row.id || r.playerB === row.id).length;
  return played === 0 ? 0 : row.matchPoints / (3 * played);
}

export function PodStandings({ rows, results, nameOf, myMemberId }: PodStandingsProps) {
  if (rows.length === 0) return null;

  return (
    <table className="pod-standings" data-testid="pod-standings">
      <thead>
        <tr>
          <th scope="col">#</th>
          <th scope="col">Player</th>
          <th scope="col">Points</th>
          <th scope="col">Match Winrate%</th>
          <th scope="col">Game Winrate%</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} data-testid={`pod-standings-row-${row.rank}`} data-mine={row.id === myMemberId ? '' : undefined}>
            <td>{row.rank}</td>
            <td>{row.id === myMemberId ? `${nameOf(row.id)} (you)` : nameOf(row.id)}</td>
            <td>{row.matchPoints}</td>
            <td>{pct(matchWinPct(row, results))}</td>
            <td>{pct(row.gameWinPct)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

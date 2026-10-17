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

export interface PodStandingsProps {
  rows: PodStandingsRowLike[];
  nameOf: (memberId: string) => string;
  myMemberId: string | null;
}

/** `62%`, never `61.999…%` — a tiebreaker column, not a stat to compute from. */
function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function PodStandings({ rows, nameOf, myMemberId }: PodStandingsProps) {
  if (rows.length === 0) return null;

  return (
    <table className="pod-standings" data-testid="pod-standings">
      <thead>
        <tr>
          <th scope="col">#</th>
          <th scope="col">Player</th>
          <th scope="col">Points</th>
          <th scope="col">OMW%</th>
          <th scope="col">GW%</th>
          <th scope="col">OGW%</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} data-testid={`pod-standings-row-${row.rank}`} data-mine={row.id === myMemberId ? '' : undefined}>
            <td>{row.rank}</td>
            <td>{row.id === myMemberId ? `${nameOf(row.id)} (you)` : nameOf(row.id)}</td>
            <td>{row.matchPoints}</td>
            <td>{pct(row.opponentMatchWinPct)}</td>
            <td>{pct(row.gameWinPct)}</td>
            <td>{pct(row.opponentGameWinPct)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

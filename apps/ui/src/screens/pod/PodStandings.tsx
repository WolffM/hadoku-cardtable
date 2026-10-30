/*
 * The pod's standings — wave 72 §R.2. Drawn beside the bracket
 * (`PodBracket.tsx`) throughout `rounds` and once the pod reaches `done`.
 *
 * `rows` is already ranked (`PodStandingsRow.rank`, 1-based and shared by a
 * tie on every key — the wire contract's own ordering, `@hadoku/draft`'s
 * tiebreak order), so this never re-sorts; it only resolves each row's `id`
 * (a member id) to a display name through `nameOf`, the same indirection
 * `PodSeats`/`PodBracket` use rather than carrying a name on the row itself.
 *
 * Its columns are the ranking's keys, in order (the operator, 2026-10-23: *"how many tie-breakers do we
 * have? also that does need to be visible somewhere"*, then a fifth, the fastest median game), spelled
 * out (2026-10-19: *"i hate the 3 letter acroynms in the table"*). Where two rows are level on points,
 * the cell of the key that separated them is marked on both (`decidedBy`, the server's).
 */

import type { PodTiebreak } from '@hadoku/shared';

import './PodStandings.css';

export interface PodStandingsRowLike {
  id: string;
  matchPoints: number;
  opponentMatchWinPct: number;
  gameWinPct: number;
  opponentGameWinPct: number;
  medianGameMs: number | null;
  rank: number;
  decidedBy: PodTiebreak | null;
}

export interface PodStandingsProps {
  rows: PodStandingsRowLike[];
  nameOf: (memberId: string) => string;
  myMemberId: string | null;
  /** Entrants out of the rounds (`PodView.dropped`): ranked on their record, marked. */
  dropped?: readonly string[] | undefined;
}

/** `62%`, never `61.999…%`. */
function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** `12:34`; `—` for a player with no timed game. */
function minutes(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The tiebreak columns, in ranking order after Points. */
const TIEBREAK_COLUMNS: readonly { key: Exclude<PodTiebreak, 'matchPoints'>; head: string; show: (row: PodStandingsRowLike) => string }[] = [
  { key: 'opponentMatchWinPct', head: 'Opponent Match Winrate%', show: (r) => pct(r.opponentMatchWinPct) },
  { key: 'gameWinPct', head: 'Game Winrate%', show: (r) => pct(r.gameWinPct) },
  { key: 'opponentGameWinPct', head: 'Opponent Game Winrate%', show: (r) => pct(r.opponentGameWinPct) },
  { key: 'medianGameMs', head: 'Median Game', show: (r) => minutes(r.medianGameMs) },
];

export function PodStandings({ rows, nameOf, myMemberId, dropped = [] }: PodStandingsProps) {
  if (rows.length === 0) return null;
  // Each row's own `decidedBy` (against the row above), and the row above's (against this one).
  const decided = (i: number): ReadonlySet<PodTiebreak> =>
    new Set([rows[i]?.decidedBy, rows[i + 1]?.decidedBy].filter((k): k is PodTiebreak => k !== null && k !== undefined && k !== 'matchPoints'));

  return (
    <table className="pod-standings" data-testid="pod-standings">
      <thead>
        <tr>
          <th scope="col">#</th>
          <th scope="col">Player</th>
          <th scope="col">Points</th>
          {TIEBREAK_COLUMNS.map((c) => (
            <th key={c.key} scope="col">
              {c.head}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => {
          const marks = decided(i);
          return (
            <tr key={row.id} data-testid={`pod-standings-row-${row.rank}`} data-mine={row.id === myMemberId ? '' : undefined} data-dropped={dropped.includes(row.id) ? '' : undefined}>
              <td>{row.rank}</td>
              <td>
                {nameOf(row.id)}
                {dropped.includes(row.id) && <span className="pod-standings__dropped">Dropped</span>}
              </td>
              <td>{row.matchPoints}</td>
              {TIEBREAK_COLUMNS.map((c) => (
                <td key={c.key} data-key={c.key} data-decided={marks.has(c.key) ? '' : undefined}>
                  {c.show(row)}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

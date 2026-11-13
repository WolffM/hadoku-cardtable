/*
 * The pod's standings: rank, face, name, record, points (the operator, 2026-11-02: *"why does the score
 * standings view have all this useless tiebreaker info in it?"*). Drawn under the bracket
 * (`PodBracket.tsx`) throughout `rounds` and once the pod reaches `done`.
 *
 * `rows` is already ranked (`PodStandingsRow.rank`, 1-based and shared by a tie on every key — the
 * server's own ordering, `@hadoku/draft`'s tiebreak order), so this never re-sorts; it resolves each
 * row's `id` through `nameOf`/`avatarOf`, the same indirection the bracket uses.
 *
 * The tie-breakers stay one press away (2026-10-23: *"that does need to be visible somewhere"*; the
 * operator chose this over notes on the tied rows, 2026-11-02): Tie-breakers opens their columns, and on
 * rows level on points the cell of the key that separated them is marked on both (`decidedBy`, the
 * server's).
 */

import { useState } from 'react';
import type { PodMatchResult, PodTiebreak } from '@hadoku/shared';

import { Avatar, type Face } from '@hadoku/game-ui/components/Avatar.tsx';
import { PlayerName } from '@hadoku/game-ui/room/look.tsx';
import { records, recordText } from './swiss.ts';
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
  /** Every result so far (`PodView.results`): each row's record. */
  results: readonly PodMatchResult[];
  nameOf: (memberId: string) => string;
  avatarOf: (memberId: string) => Face;
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

/**
 * The tie-breaker columns, in ranking order after Points: a short head, and the full name on hover and to a
 * screen reader. The full names made the opened table far wider than its numbers (2026-11-08: *"way too
 * long"*), and the operator chose these heads that day: *"instead of 'game wins' i would show 'wins' and for
 * the others i would show OMW and OGW"* (superseding 2026-10-19's *"i hate the 3 letter acroynms"* here).
 */
const TIEBREAK_COLUMNS: readonly { key: Exclude<PodTiebreak, 'matchPoints'>; head: string; full: string; show: (r: PodStandingsRowLike) => string }[] = [
  { key: 'opponentMatchWinPct', head: 'OMW', full: 'Opponents’ match wins', show: (r) => pct(r.opponentMatchWinPct) },
  { key: 'gameWinPct', head: 'Wins', full: 'Game wins', show: (r) => pct(r.gameWinPct) },
  { key: 'opponentGameWinPct', head: 'OGW', full: 'Opponents’ game wins', show: (r) => pct(r.opponentGameWinPct) },
  { key: 'medianGameMs', head: 'Median', full: 'Median game length', show: (r) => minutes(r.medianGameMs) },
];

export function PodStandings({ rows, results, nameOf, avatarOf, myMemberId, dropped = [] }: PodStandingsProps) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  const rec = records({ results: [...results] });
  // The keys that separated a row from its neighbours on equal points: its own `decidedBy` (against the row above), and the next row's (against this one).
  const decided = (i: number): ReadonlySet<PodTiebreak> => new Set([rows[i]?.decidedBy, rows[i + 1]?.decidedBy].filter((k): k is PodTiebreak => k !== null && k !== undefined && k !== 'matchPoints'));
  const columns = open ? TIEBREAK_COLUMNS : [];
  return (
    // Opened, the table scrolls sideways inside its own box, never the page.
    <div className="pod-standings__wrap" data-testid="pod-standings-wrap">
      <button type="button" className="pod-standings__more" aria-expanded={open} data-testid="pod-standings-tiebreaks" onClick={() => setOpen(!open)}>
        Tie-breakers
      </button>
      <table className="pod-standings" data-testid="pod-standings">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Player</th>
            <th scope="col">Record</th>
            <th scope="col">Points</th>
            {columns.map((c) => (
              <th key={c.key} scope="col" title={c.full}>
                <abbr className="pod-standings__abbr" title={c.full}>
                  {c.head}
                </abbr>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const marks = decided(i);
            return (
              <tr key={row.id} data-testid={`pod-standings-row-${row.rank}`} data-mine={row.id === myMemberId ? '' : undefined} data-dropped={dropped.includes(row.id) ? '' : undefined}>
                <td className="pod-standings__rank">{row.rank}</td>
                <td>
                  <span className="pod-standings__who">
                    <Avatar {...avatarOf(row.id)} fallback="initial" name={nameOf(row.id)} className="pod-standings__face" fallbackClassName="pod-standings__face pod-standings__face--none" width={28} height={28} />
                    <PlayerName name={nameOf(row.id)} face={avatarOf(row.id)} className="pod-standings__name" />
                    {dropped.includes(row.id) && <span className="pod-standings__dropped">Dropped</span>}
                  </span>
                </td>
                <td className="pod-standings__num">{recordText(rec.get(row.id) ?? { w: 0, l: 0, d: 0 })}</td>
                <td className="pod-standings__num">{row.matchPoints}</td>
                {columns.map((c) => (
                  <td key={c.key} className="pod-standings__num" data-key={c.key} data-decided={marks.has(c.key) ? '' : undefined}>
                    {c.show(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

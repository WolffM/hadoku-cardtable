/*
 * Game-stats tables: a record, a leaderboard, a breakdown and a match list.
 *
 * Generic on purpose — nothing here knows it is Magic. Data is the game-stats
 * store's own read shapes (`@wolffm/prefs-client/games`), anything particular
 * to a game comes in through a render prop (`renderValue`, `describeSeat`), and
 * the only styling is `stats.css`'s theme tokens. So when a second game draws
 * the same screens, this file and its stylesheet lift into a shared package
 * unchanged; `StatsScreen.tsx` is cardtable's composition of them.
 */

import type { ReactNode } from 'react';

import {
  winRate,
  type BreakdownRow,
  type LeaderboardRow,
  type MatchView,
  type OutcomeTotals,
  type ProfileView,
  type SeatView,
} from '@wolffm/prefs-client/games';

import './stats.css';

const percent = (t: OutcomeTotals): string => (t.games === 0 ? '—' : `${Math.round(winRate(t) * 100)}%`);

const wld = (t: OutcomeTotals): string => `${t.wins}–${t.losses}${t.draws > 0 ? `–${t.draws}` : ''}`;

/** One player's totals, and their rating in one pool. */
export function RecordSummary({ profile, mode }: { profile: ProfileView; mode?: string }) {
  const rating = profile.ratings.find((r) => mode === undefined || r.mode === mode);
  return (
    <dl className="stats-record" data-testid="stats-record">
      <div className="stats-record__cell">
        <dt>Games</dt>
        <dd>{profile.totals.games}</dd>
      </div>
      <div className="stats-record__cell">
        <dt>W–L</dt>
        <dd>{wld(profile.totals)}</dd>
      </div>
      <div className="stats-record__cell">
        <dt>Win rate</dt>
        <dd>{percent(profile.totals)}</dd>
      </div>
      <div className="stats-record__cell">
        <dt>Rating</dt>
        <dd>{rating === undefined ? '—' : Math.round(rating.rating)}</dd>
      </div>
    </dl>
  );
}

export interface LeaderboardTableProps {
  rows: readonly LeaderboardRow[];
  valueLabel: string;
  formatValue?: (value: number) => ReactNode;
  /** A player's name, as a link or plain text. Plain text by default. */
  renderName?: (name: string) => ReactNode;
}

export function LeaderboardTable({ rows, valueLabel, formatValue = (v) => Math.round(v), renderName = (n) => n }: LeaderboardTableProps) {
  return (
    <table className="stats-table" data-testid="stats-leaderboard">
      <thead>
        <tr>
          <th className="stats-table__num">#</th>
          <th>Player</th>
          <th className="stats-table__num">{valueLabel}</th>
          <th className="stats-table__num">W–L</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.name} data-me={row.isMe || undefined}>
            <td className="stats-table__num">{row.rank}</td>
            <td>{renderName(row.name)}</td>
            <td className="stats-table__num">{formatValue(row.value)}</td>
            <td className="stats-table__num">{wld(row.totals)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface BreakdownTableProps {
  rows: readonly BreakdownRow[];
  /** The attr's column heading. */
  label: string;
  renderValue?: (value: string) => ReactNode;
  testId?: string;
}

/** Outcome totals grouped by one attr, most played first. */
export function BreakdownTable({ rows, label, renderValue = (v) => v, testId }: BreakdownTableProps) {
  const sorted = [...rows].sort((a, b) => b.games - a.games || winRate(b) - winRate(a));
  return (
    <table className="stats-table" data-testid={testId}>
      <thead>
        <tr>
          <th>{label}</th>
          <th className="stats-table__num">Games</th>
          <th className="stats-table__num">W–L</th>
          <th className="stats-table__num">Win rate</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => (
          <tr key={row.value}>
            <td>{renderValue(row.value)}</td>
            <td className="stats-table__num">{row.games}</td>
            <td className="stats-table__num">{wld(row)}</td>
            <td className="stats-table__num">{percent(row)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const OUTCOME_WORD = { win: 'Win', loss: 'Loss', draw: 'Draw' } as const;

export interface MatchListProps {
  matches: readonly MatchView[];
  /** Whose matches these are: the seat this name sits in is "you". Omitted, the caller's own (`isMe`). */
  player?: string;
  /** A seat's game-specific line — its deck, its faction. */
  describeSeat?: (seat: SeatView) => ReactNode;
  /** A match counter to show as a column, e.g. `{ key: 'turns', label: 'Turns' }`. */
  counter?: { key: string; label: string };
  renderName?: (name: string) => ReactNode;
}

export function MatchList({ matches, player, describeSeat, counter, renderName = (n) => n }: MatchListProps) {
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <table className="stats-table" data-testid="stats-matches">
      <thead>
        <tr>
          <th>Result</th>
          <th>Seats</th>
          {counter !== undefined && <th className="stats-table__num">{counter.label}</th>}
          <th className="stats-table__num">Played</th>
        </tr>
      </thead>
      <tbody>
        {matches.map((m) => {
          const mine = m.seats.find((s) => (player === undefined ? s.isMe : s.name === player));
          return (
            <tr key={m.matchId} data-outcome={mine?.outcome}>
              <td className="stats-table__outcome">{mine === undefined ? '—' : OUTCOME_WORD[mine.outcome]}</td>
              <td>
                <ul className="stats-seats">
                  {[...m.seats]
                    .sort((a, b) => Number(b === mine) - Number(a === mine))
                    .map((s) => (
                      <li key={s.seat} className="stats-seats__seat" data-outcome={s.outcome}>
                        <span className="stats-seats__name">{s.name === null ? '—' : s.kind === 'user' ? renderName(s.name) : s.name}</span>
                        {describeSeat?.(s)}
                      </li>
                    ))}
                </ul>
              </td>
              {counter !== undefined && <td className="stats-table__num">{m.counters[counter.key] ?? '—'}</td>}
              <td className="stats-table__num stats-table__date">{date.format(m.endedAt)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

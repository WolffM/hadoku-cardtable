/*
 * The page's five game-neutral blocks, as stand-ins until `@wolffm/game-stats-ui` ships them:
 * Rankings, Match history, the profile header, the rating chart and Head to head. The package
 * draws them for every hadoku game (the operator approved that split, 2026-11-02); cardtable
 * hands each one its rows and the Magic half — a seat's pips and deck (`renderAttr`), a player's
 * link (`renderName`), a match's format, turns and ending (`facts`).
 *
 * Each stand-in is deliberately thin: the props are the contract the page is written against, and
 * the markup is only enough to show the rows. Swapping one in is an import and nothing else; when
 * all five are in, this file goes.
 */

import type { ReactNode } from 'react';
import { LeaderboardTable, NONE, RecordSummary, formatRecord, type RenderAttr, type RenderName } from '@wolffm/game-stats-ui';
import type { LeaderboardBy, LeaderboardRow, MatchView, ProfileView, SeatView } from '@wolffm/prefs-client/games';

const BY_LABEL: Record<string, string> = { rating: 'Rating', winrate: 'Win rate', wins: 'Wins', games: 'Games' };

export interface RankingsProps {
  rows: readonly LeaderboardRow[];
  /** What the board ranks by: its value column. */
  by: LeaderboardBy;
  renderName: RenderName;
}

/** Stand-in for the package's Rankings table. */
export function Rankings({ rows, by, renderName }: RankingsProps) {
  return (
    <LeaderboardTable
      rows={rows}
      valueLabel={BY_LABEL[by] ?? by}
      formatValue={(v) => (by === 'winrate' ? `${Math.round(v * 100)}%` : Math.round(v))}
      renderName={renderName}
      testId={`gs-leaderboard-${by}`}
    />
  );
}

/** A player's seat in a match: the named player's, or the viewer's when no one is named. */
const seatOf = (m: MatchView, player: string | undefined): SeatView | undefined => m.seats.find((s) => (player === undefined ? s.isMe : s.name === player));

export interface MatchHistoryProps {
  matches: readonly MatchView[];
  /** Everyone's matches, winner first, rather than one player's results. */
  everyone?: boolean;
  /** Whose results these are; absent (and not `everyone`), the viewer's. */
  player?: string;
  /** Seat attrs drawn after each name, in order. */
  seatAttrs: readonly string[];
  renderAttr: RenderAttr;
  renderName: RenderName;
  /** A match's own facts, in order: its format, its turns, how it ended. */
  facts: (match: MatchView) => readonly string[];
}

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Stand-in for the package's Match history feed. */
export function MatchHistory({ matches, everyone = false, player, seatAttrs, renderAttr, renderName, facts }: MatchHistoryProps) {
  return (
    <ol className="gs-seats" data-testid="gs-matches">
      {matches.map((m) => {
        const lead = everyone ? m.seats.find((s) => s.outcome === 'win') : seatOf(m, player);
        const seats = [...m.seats].sort((a, b) => Number(b === lead) - Number(a === lead));
        return (
          <li key={m.matchId} className="gs-seats__seat" data-outcome={lead?.outcome}>
            {seats.map((s) => (
              <span key={s.seat} className="gs-seats__name" data-outcome={s.outcome}>
                {s.name === null ? NONE : s.kind === 'user' ? renderName(s.name) : s.name}
                {seatAttrs.map((key) => {
                  const value = s.attrs[key];
                  return value === undefined ? null : (
                    <span key={key} className="gs-seats__attr" data-attr={key}>
                      {renderAttr(key, value)}
                    </span>
                  );
                })}
              </span>
            ))}
            <span className="gs-seats__attr">{[...facts(m), WHEN.format(m.endedAt)].join(' · ')}</span>
          </li>
        );
      })}
    </ol>
  );
}

export interface ProfileHeaderProps {
  profile: ProfileView;
  /** The rating pool to show. */
  mode: string;
  /** Where the player stands on the rating board, when they are on it. */
  rank?: { rank: number; of: number } | undefined;
}

/** Stand-in for the package's profile header. */
export function ProfileHeader({ profile, mode, rank }: ProfileHeaderProps): ReactNode {
  return (
    <>
      <h2 data-testid="gs-profile-name">{profile.name}</h2>
      {rank !== undefined && <p>{`#${rank.rank} of ${rank.of}`}</p>}
      <RecordSummary profile={profile} mode={mode} />
    </>
  );
}

export interface RatingChartProps {
  /** The player's matches, newest first: their seat's rating after each is a point. */
  matches: readonly MatchView[];
  /** Whose rating; absent, the viewer's. */
  player?: string;
}

/** Stand-in for the package's rating chart: the line alone. */
export function RatingChart({ matches, player }: RatingChartProps) {
  const ratings = matches
    .map((m) => seatOf(m, player)?.ratingAfter)
    .filter((r): r is number => r !== null && r !== undefined)
    .reverse();
  if (ratings.length < 2) return null;
  const [lo, hi] = [Math.min(...ratings), Math.max(...ratings)];
  const y = (r: number): number => (hi === lo ? 50 : 95 - ((r - lo) * 90) / (hi - lo));
  const points = ratings.map((r, i) => `${(i * 100) / (ratings.length - 1)},${y(r)}`).join(' ');
  return (
    <svg className="ct-stats__chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`Rating from ${Math.round(ratings[0]!)} to ${Math.round(ratings.at(-1)!)}`} data-testid="gs-rating-chart">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export interface HeadToHeadProps {
  /** The player's matches: every other player seated in one is a rival. */
  matches: readonly MatchView[];
  /** Whose record against them; absent, the viewer's. */
  player?: string;
  renderName: RenderName;
}

/** Stand-in for the package's Head to head. */
export function HeadToHead({ matches, player, renderName }: HeadToHeadProps) {
  const rivals = new Map<string, { games: number; wins: number; losses: number; draws: number }>();
  for (const m of matches) {
    const mine = seatOf(m, player);
    if (mine === undefined) continue;
    for (const s of m.seats) {
      if (s === mine || s.kind !== 'user' || s.name === null) continue;
      const t = rivals.get(s.name) ?? { games: 0, wins: 0, losses: 0, draws: 0 };
      rivals.set(s.name, { games: t.games + 1, wins: t.wins + Number(mine.outcome === 'win'), losses: t.losses + Number(mine.outcome === 'loss'), draws: t.draws + Number(mine.outcome === 'draw') });
    }
  }
  return (
    <ul className="gs-seats" data-testid="gs-head-to-head">
      {[...rivals].map(([name, t]) => (
        <li key={name} className="gs-seats__seat">
          {renderName(name)} {formatRecord(t)}
        </li>
      ))}
    </ul>
  );
}

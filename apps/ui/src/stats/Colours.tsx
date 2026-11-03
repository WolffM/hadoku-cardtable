/*
 * The Colours tiles: one per colour of the pie, in its order, each its rated games' win rate. A
 * seat's `colors` is a set and the store counts a game once in each colour it played
 * (`breakdown('colors')`), so a white-blue deck's win counts for white and for blue. The
 * Leaderboard draws everyone's, the profile one player's with its record and a bar.
 */

import { formatRecord, formatWinRate, StatsCard, WinBar, type StatsCache } from '@wolffm/game-stats-ui';
import type { OutcomeTotals } from '@wolffm/prefs-client/games';

import { ManaPip } from '../components/ManaPip.tsx';
import { loaded, type Breakdown, type StatsRead } from './source.ts';

const PIE = ['W', 'U', 'B', 'R', 'G'] as const;
const NO_GAMES: OutcomeTotals = { games: 0, wins: 0, losses: 0, draws: 0 };

export function Colours({ read, cache, detailed = false, testId }: { read: StatsRead<Breakdown>; cache: StatsCache; detailed?: boolean; testId: string }) {
  return (
    <StatsCard title="Colours" {...loaded(read)} cache={cache} isEmpty={(b) => b.rows.length === 0} testId={testId}>
      {(b) => {
        const byColour = new Map(b.rows.map((row) => [row.value, row]));
        return (
          <ul className={detailed ? 'ct-colours ct-colours--detailed' : 'ct-colours'}>
            {PIE.map((colour) => {
              const t = byColour.get(colour) ?? NO_GAMES;
              return (
                <li key={colour} className="ct-colours__colour" data-colour={colour} data-testid="stats-colour">
                  <span className="ct-colours__pip">
                    <ManaPip token={colour} />
                  </span>
                  <span className="ct-colours__pct">{formatWinRate(t)}</span>
                  {detailed && <WinBar totals={t} />}
                  {detailed ? (
                    <span className="ct-colours__counts">
                      <span className="ct-colours__record">{formatRecord(t)}</span>
                      <span className="ct-colours__games">{`${t.games} games`}</span>
                    </span>
                  ) : (
                    <span className="ct-colours__games">{`${t.games} games`}</span>
                  )}
                </li>
              );
            })}
          </ul>
        );
      }}
    </StatsCard>
  );
}

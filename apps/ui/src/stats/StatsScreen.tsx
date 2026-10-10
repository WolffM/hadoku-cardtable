/*
 * `#/stats` and `#/stats/<name>`: a player's record and history, and the
 * friend group's boards — read from the game-stats store in prefs-api, which
 * this server reports every finished room match to (`apps/server/src/stats/`).
 *
 * The screen itself is `@wolffm/game-stats-ui`, shared by every hadoku game.
 * This file is where Magic comes in: the colour pips, the deck on each seat,
 * the turn count, and links to each player's page.
 */

import { useMemo } from 'react';

import { GameStats, formatAttr, type BreakdownSpec, type RenderAttr, type RenderName } from '@wolffm/game-stats-ui';
import '@wolffm/game-stats-ui/style.css';
import { createGameStatsClient, type GameStatsClient } from '@wolffm/prefs-client/games';

import { ManaPip } from '../components/ManaPip.tsx';
import { routeHash } from '../screens/route.ts';

/** The rating pool every room match is reported in. */
export const STATS_MODE = 'constructed';

export interface StatsScreenProps {
  /** A registry name; absent is the viewer. */
  player?: string;
  /** Tests pass a client over a stub fetch. Production passes nothing. */
  client?: GameStatsClient;
}

const BREAKDOWNS: readonly BreakdownSpec[] = [
  { attr: 'colors', title: 'Colours', label: 'Colour' },
  { attr: 'deck', title: 'Decks', label: 'Deck' },
  { attr: 'deck', title: 'Decks that win', label: 'Deck', everyone: true, wide: true },
];

/** A seat's `colors` is a set; a colour breakdown row is one colour. Both draw as pips. */
const renderAttr: RenderAttr = (key, value) => {
  if (key !== 'colors') return formatAttr(value);
  const colors = Array.isArray(value) ? value : [String(value)];
  return (
    <span className="cost" data-colors={colors.join('')}>
      {colors.map((c) => (
        <ManaPip key={c} token={c} />
      ))}
    </span>
  );
};

const renderName: RenderName = (name) => (
  <a className="shell__link" href={routeHash({ kind: 'stats', player: name })}>
    {name}
  </a>
);

export function StatsScreen({ player, client: given }: StatsScreenProps) {
  const client = useMemo(() => given ?? createGameStatsClient({ gameId: 'cardtable' }), [given]);
  return (
    <div className="shell stats" data-testid="stats">
      <header className="shell__head">
        <h1 className="shell__title">{player ?? 'Stats'}</h1>
      </header>
      <main>
        <GameStats
          client={client}
          mode={STATS_MODE}
          player={player}
          seatAttrs={['colors', 'deck']}
          matchCounters={['turns']}
          counterLabels={{ turns: 'Turns' }}
          breakdowns={BREAKDOWNS}
          renderAttr={renderAttr}
          renderName={renderName}
        />
      </main>
    </div>
  );
}

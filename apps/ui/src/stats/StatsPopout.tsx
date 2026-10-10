/*
 * Match stats, in a popout over the lobby: a player's record and history, and
 * the friend group's boards — read from the game-stats store in prefs-api,
 * which this server reports every finished room match to
 * (`apps/server/src/stats/`).
 *
 * The operator, 2026-10-10: the stats link was ugly, the screen loaded slowly
 * and drew as one thin column. So:
 *
 *   - **A trophy beside the settings gear** opens it, and it is route-driven
 *     (`#/stats`, `#/stats/<name>`): Back closes it, a player's name opens
 *     theirs, and a stats link still works from anywhere.
 *   - **Prefetched.** The button warms every read the popout makes when the
 *     lobby mounts and again on hover, into one cache, so opening draws at once
 *     and refreshes behind what it shows (`@wolffm/game-stats-ui`'s cache).
 *   - **A fixed, wide panel**, not a page in the flow: the old screen was a
 *     centred flex child with no width of its own, so it shrank to one column.
 *
 * Like the settings popover it stays inside the app's tree rather than a
 * portal, so the theme tokens resolved on an embed's root still reach it.
 *
 * The screen itself is `@wolffm/game-stats-ui`, shared by every hadoku game.
 * This file is where Magic comes in: the colour pips, the deck on each seat,
 * the turn count.
 */

import { useEffect, useId, useRef } from 'react';
import { Icon } from '@wolffm/themes';
import {
  createStatsCache,
  formatAttr,
  GameStats,
  prefetchGameStats,
  type BreakdownSpec,
  type RenderAttr,
  type RenderName,
  type StatsCache,
} from '@wolffm/game-stats-ui';
import '@wolffm/game-stats-ui/style.css';
import { createGameStatsClient, type GameStatsClient } from '@wolffm/prefs-client/games';

import { ManaPip } from '../components/ManaPip.tsx';
import { navigate, routeHash } from '../screens/route.ts';
import './stats.css';

/** The rating pool every room match is reported in. */
export const STATS_MODE = 'constructed';

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

export interface StatsSource {
  client: GameStatsClient;
  cache: StatsCache;
}

let shared: StatsSource | undefined;

/**
 * The prefs mount, when the page names one: `@wolffm/themes` reads the same
 * global, and the e2e harness sets it to the test server (`e2e/prefsLocal.ts`)
 * so no read leaves the machine. Production leaves it unset, and the SDK's own
 * `https://hadoku.me/prefs` stands. Read when the client is first built, after
 * any init script has run.
 */
export function prefsBaseUrl(): string | undefined {
  const base = (globalThis as { __HADOKU_PREFS_API_BASE__?: unknown }).__HADOKU_PREFS_API_BASE__;
  return typeof base === 'string' && base !== '' ? base : undefined;
}

/** The page's one stats client and the cache its reads are kept in. */
function sharedSource(): StatsSource {
  const baseUrl = prefsBaseUrl();
  shared ??= {
    client: createGameStatsClient({ gameId: 'cardtable', ...(baseUrl === undefined ? {} : { baseUrl }) }),
    cache: createStatsCache(),
  };
  return shared;
}

/** Starts every read the popout opens with, for the viewer, so it draws at once. */
export function prefetchStats(source: StatsSource = sharedSource()): void {
  prefetchGameStats({ ...source, mode: STATS_MODE, breakdowns: BREAKDOWNS });
}

/** The trophy beside the settings gear: opens the viewer's stats, and warms them first. */
export function StatsButton({ source }: { source?: StatsSource }) {
  useEffect(() => prefetchStats(source), [source]);
  return (
    <a
      className="ct-stats-button"
      href={routeHash({ kind: 'stats' })}
      aria-label="Stats"
      data-testid="lobby-stats"
      onPointerEnter={() => prefetchStats(source)}
    >
      <Icon name="trophy" size="1.1rem" />
    </a>
  );
}

const close = (): void => navigate({ kind: 'lobby' });

export interface StatsPopoutProps {
  /** A registry name; absent is the viewer. */
  player?: string;
  /** Tests pass a client over a stub fetch, and its cache. Production passes nothing. */
  source?: StatsSource;
}

export function StatsPopout({ player, source = sharedSource() }: StatsPopoutProps) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    const doc = globalThis.document;
    doc.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => doc.removeEventListener('keydown', onKey);
  }, []);

  return (
    // A press on the backdrop itself, not on the panel, closes it.
    <div className="ct-stats-popout__backdrop" onPointerDown={(event) => event.target === event.currentTarget && close()}>
      <div ref={ref} className="ct-stats-popout" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-testid="stats">
        <header className="ct-stats-popout__head">
          <h1 id={titleId} className="ct-stats-popout__title">
            {player ?? 'Stats'}
          </h1>
          {player !== undefined && (
            <a className="shell__link" href={routeHash({ kind: 'stats' })} data-testid="stats-mine">
              Mine
            </a>
          )}
          <a className="ct-stats-popout__close" href={routeHash({ kind: 'lobby' })} aria-label="Close stats" data-testid="stats-close">
            <Icon name="close" size="1rem" />
          </a>
        </header>
        <GameStats
          key={player ?? ''}
          client={source.client}
          cache={source.cache}
          mode={STATS_MODE}
          player={player}
          seatAttrs={['colors', 'deck']}
          matchCounters={['turns']}
          counterLabels={{ turns: 'Turns' }}
          breakdowns={BREAKDOWNS}
          renderAttr={renderAttr}
          renderName={renderName}
        />
      </div>
    </div>
  );
}

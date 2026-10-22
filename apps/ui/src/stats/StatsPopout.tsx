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
 *     and refreshes behind what it shows (`@wolffm/game-stats-ui`'s cache) —
 *     for a signed-in viewer only, and never again after a refusal
 *     (`signedInStatsClient`).
 *   - **A fixed, wide panel**, not a page in the flow: the old screen was a
 *     centred flex child with no width of its own, so it shrank to one column.
 *
 * Like the settings popover it stays inside the app's tree rather than a
 * portal, so the theme tokens resolved on an embed's root still reach it.
 *
 * The screen itself is `@wolffm/game-stats-ui`, shared by every hadoku game.
 * This file is where Magic comes in: the colour pips, the deck on each seat,
 * the turn count, and the Decks section's filters and peek (`StatsDecks.tsx`).
 *
 * **Rated matches only** — the operator, 2026-10-20: *"let's hide all bot
 * results/stats … noone should have their rating affected by bot data"*. The
 * server reports a match unrated when Forge's AI, a guest or a test account
 * sat in it (`apps/server/src/stats/report.ts`), and every read here asks for
 * rated matches only (`ratedOnly`), so the record, the history, every
 * breakdown and the picker's deck order count none of them. The store keeps
 * them (the operator, 2026-10-16: *"we should keep the logs"*).
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
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
import { whoami } from '@wolffm/prefs-client';
import { createGameStatsClient, GameStatsError, type GameStatsClient } from '@wolffm/prefs-client/games';

import { ManaPip } from '../components/ManaPip.tsx';
import type { DeckRecords } from './deckOrder.ts';
import { DeckPeekHost, DeckStatsFilterBar, deckLookup, decksSpec, NO_STATS_FILTER, StatsDeckName, type DeckLookup, type DeckStatsFilter } from './StatsDecks.tsx';
import { navigate, routeHash } from '../screens/route.ts';
import { Tournaments } from './Tournaments.tsx';
import './stats.css';
import { uiLength } from '../settings/ui-scale.ts';

/** The rating pool every room match is reported in. */
export const STATS_MODE = 'constructed';

const COLOURS: BreakdownSpec = { attr: 'colors', title: 'Colours', label: 'Colour' };

/** The sections a screen opens with: the Decks section unfiltered. */
const breakdownsFor = (decks: BreakdownSpec = decksSpec()): readonly BreakdownSpec[] => [COLOURS, decks];

/**
 * A seat's `colors` is a set; a colour breakdown row is one colour. Both draw
 * as pips. A Decks row draws its colours beside its name (`StatsDeckName`).
 */
const renderAttr: RenderAttr = (key, value, carried) => {
  if (key === 'deck' && carried !== undefined) return <StatsDeckName name={String(value)} carried={carried} />;
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

/** Whether the viewer has a session the stats store will answer: the fleet's `whoami`, shared per page. */
async function viewerSignedIn(): Promise<boolean> {
  return (await whoami()).userType !== 'public';
}

/**
 * The stats reads, kept off the network for a viewer the store will refuse.
 *
 * hadoku_site's request log (2026-10-10) had a signed-out viewer
 * reading all four stats endpoints ~6.5 times a minute for six hours, every
 * answer a 401: the cache keeps no failure, so every prefetch and every open
 * of the popout asked again. So:
 *
 *   - a viewer `whoami` calls public is never sent to the store at all; each
 *     read fails at once with the store's own 401, which the screen already
 *     draws as its signed-out state ("Sign in to see stats.");
 *   - a 401 or 403 from the store is final for the page: every later read
 *     answers it without asking. A session does not appear mid-page — signing
 *     in is a reload.
 */
export function signedInStatsClient(client: GameStatsClient, signedIn: () => Promise<boolean>): GameStatsClient {
  let refused: GameStatsError | null = null;
  let checked: Promise<boolean> | null = null;
  const guard =
    <A extends unknown[], R>(read: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      checked ??= signedIn();
      if (refused === null && !(await checked)) refused = new GameStatsError(401, 'signed out');
      if (refused !== null) throw refused;
      try {
        return await read(...args);
      } catch (err) {
        if (err instanceof GameStatsError && (err.status === 401 || err.status === 403)) refused = err;
        throw err;
      }
    };
  return {
    profile: guard(client.profile),
    matches: guard(client.matches),
    match: guard(client.match),
    leaderboard: guard(client.leaderboard),
    breakdown: guard(client.breakdown),
  };
}

/** The page's one stats client and the cache its reads are kept in. */
function sharedSource(): StatsSource {
  const baseUrl = prefsBaseUrl();
  shared ??= {
    client: signedInStatsClient(createGameStatsClient({ gameId: 'cardtable', ...(baseUrl === undefined ? {} : { baseUrl }) }), viewerSignedIn),
    cache: createStatsCache(),
  };
  return shared;
}

/** Everyone's record per library deck in rated matches, keyed by the deck id a room match reports — `deckOrder.ts` sorts the picker by it. */
export async function fetchDeckRecords(source: StatsSource = sharedSource()): Promise<DeckRecords> {
  const { rows } = await source.client.breakdown('deckId', { player: '*', mode: STATS_MODE, rated: true });
  return new Map(rows.map(({ value, ...totals }) => [value, totals]));
}

/** Starts every read the popout opens with, for the viewer, so it draws at once. */
export function prefetchStats(source: StatsSource = sharedSource()): void {
  prefetchGameStats({ ...source, mode: STATS_MODE, ratedOnly: true, breakdowns: breakdownsFor() });
}

/** The trophy beside the settings gear: opens the viewer's stats, and warms them first. */
export function StatsButton({ source }: { source?: StatsSource }) {
  useEffect(() => prefetchStats(source), [source]);
  return (
    <a
      className="ct-round-button"
      href={routeHash({ kind: 'stats' })}
      aria-label="Stats"
      data-testid="lobby-stats"
      onPointerEnter={() => prefetchStats(source)}
    >
      <Icon name="trophy" size={uiLength('1.1rem')} />
    </a>
  );
}

const close = (): void => navigate({ kind: 'lobby' });

export interface StatsPopoutProps {
  /** A registry name; absent is the viewer. */
  player?: string;
  /** The Tournaments tab in place of the players' stats. */
  tournaments?: boolean;
  /** Tests pass a client over a stub fetch, and its cache. Production passes nothing. */
  source?: StatsSource;
  /** Where a deck row's list comes from. Tests pass a stub; production the API's. */
  decks?: DeckLookup;
}

let sharedLookup: DeckLookup | undefined;

export function StatsPopout({ player, tournaments = false, source = sharedSource(), decks }: StatsPopoutProps) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const lookup = useMemo(() => decks ?? (sharedLookup ??= deckLookup()), [decks]);
  const [deckFilter, setDeckFilter] = useState<DeckStatsFilter>(NO_STATS_FILTER);
  const breakdowns = useMemo(
    () => breakdownsFor(decksSpec(deckFilter, <DeckStatsFilterBar filter={deckFilter} onChange={setDeckFilter} />)),
    [deckFilter],
  );

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
      <div ref={ref} className="ct-stats-popout ct-surface" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-testid="stats">
        <header className="ct-stats-popout__head">
          <h1 id={titleId} className="ct-stats-popout__title">
            {player ?? 'Stats'}
          </h1>
          {player !== undefined && (
            <a className="shell__link" href={routeHash({ kind: 'stats' })} data-testid="stats-mine">
              Mine
            </a>
          )}
          {player === undefined && (
            <nav className="ct-stats-popout__tabs">
              <a className="ct-stats-popout__tab" href={routeHash({ kind: 'stats' })} aria-current={tournaments ? undefined : 'page'} data-testid="stats-tab-players">
                Players
              </a>
              <a
                className="ct-stats-popout__tab"
                href={routeHash({ kind: 'stats', tournaments: true })}
                aria-current={tournaments ? 'page' : undefined}
                data-testid="stats-tab-tournaments"
              >
                Tournaments
              </a>
            </nav>
          )}
          <a className="ct-stats-popout__close" href={routeHash({ kind: 'lobby' })} aria-label="Close stats" data-testid="stats-close">
            <Icon name="close" size={uiLength('1rem')} />
          </a>
        </header>
        {tournaments ? (
          <Tournaments />
        ) : (
          <DeckPeekHost lookup={lookup} ownDecks={player === undefined}>
            <GameStats
              key={player ?? ''}
              client={source.client}
              cache={source.cache}
              mode={STATS_MODE}
              ratedOnly
              player={player}
              seatAttrs={['colors', 'deck']}
              matchCounters={['turns']}
              counterLabels={{ turns: 'Turns' }}
              breakdowns={breakdowns}
              renderAttr={renderAttr}
              renderName={renderName}
            />
          </DeckPeekHost>
        )}
      </div>
    </div>
  );
}

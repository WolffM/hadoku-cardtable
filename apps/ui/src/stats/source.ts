/*
 * Where the stats page's numbers come from: the game-stats store in prefs-api, which this server
 * reports every finished room match to (`apps/server/src/stats/`), read through one guarded client
 * into one cache, so a read the lobby made ahead of the page draws it at once.
 *
 * **Rated matches only** — the operator, 2026-10-20: *"let's hide all bot results/stats … noone
 * should have their rating affected by bot data"*. The server reports a match unrated when Forge's
 * AI, a guest or a test account sat in it (`apps/server/src/stats/report.ts`), and every read here
 * asks for rated matches only, so the record, the history, every breakdown and the picker's deck
 * order count none of them. The boards rank nothing else to begin with. The store keeps them (the
 * operator, 2026-10-16: *"we should keep the logs"*).
 *
 * Every read the page makes is named here, with the key it is kept under, so the page and its
 * prefetch can never ask for two different things under one name.
 */

import { createStatsCache, type StatsCache } from '@wolffm/game-stats-ui';
import { whoami } from '@wolffm/prefs-client';
import {
  createGameStatsClient,
  GameStatsError,
  type BreakdownRow,
  type GameStatsClient,
  type LeaderboardBy,
  type LeaderboardRow,
  type MatchPage,
  type ProfileView,
} from '@wolffm/prefs-client/games';

import type { DeckRecords } from './deckOrder.ts';

/** The rating pool every room match is reported in. */
export const STATS_MODE = 'constructed';

export interface StatsSource {
  client: GameStatsClient;
  cache: StatsCache;
}

/** One read: what it is kept under, and how it is asked for. */
export interface StatsRead<T> {
  key: string;
  load: () => Promise<T>;
}

export interface Breakdown {
  attr: string;
  rows: BreakdownRow[];
}

export interface Board {
  by: LeaderboardBy;
  rows: LeaderboardRow[];
}

/** The seat attrs a deck row carries off its latest seat: its pips, and what its list is found by. */
export const DECK_ROW_ATTRS = ['colors', 'deckId'] as const;

/** How many of everyone's matches the leaderboard's history shows at a time. */
export const FEED_PAGE = 10;
/** How many of a player's matches their profile reads: its rating chart, its recent matches and its head to head. */
export const PROFILE_MATCHES = 30;

const RATED = { mode: STATS_MODE, rated: true } as const;

/** A player's part of a key: a registry name, or the viewer. */
const whose = (player: string | undefined): string => player ?? '';
/** A match-attr filter's part of a key. */
const narrowed = (formats: readonly string[] | undefined): string => (formats === undefined ? '' : `|${formats.join(',')}`);
const byFormat = (formats: readonly string[] | undefined) => (formats === undefined ? {} : { match: { format: formats } });

/** Everyone's rows: the leaderboard's boards, its winning decks and colours, and its match history. */
export const everyone = {
  board: (client: GameStatsClient, by: LeaderboardBy): StatsRead<Board> => ({
    key: `board|${by}`,
    load: () => client.leaderboard({ by, mode: STATS_MODE }),
  }),
  decks: (client: GameStatsClient): StatsRead<Breakdown> => ({
    key: 'breakdown|deck|*',
    load: () => client.breakdown('deck', { ...RATED, player: '*', with: DECK_ROW_ATTRS }),
  }),
  colours: (client: GameStatsClient): StatsRead<Breakdown> => ({
    key: 'breakdown|colors|*',
    load: () => client.breakdown('colors', { ...RATED, player: '*' }),
  }),
  /** A page of them: the newest, or those that ended before `before` (the page above's `nextBefore`). */
  matches: (client: GameStatsClient, formats?: readonly string[], before?: number): StatsRead<MatchPage> => ({
    key: `matches|*${narrowed(formats)}${before === undefined ? '' : `|<${before}`}`,
    load: () => client.matches({ ...RATED, player: '*', limit: FEED_PAGE, ...byFormat(formats), ...(before === undefined ? {} : { before }) }),
  }),
};

/** One player's rows (absent, the viewer's): their profile, their matches, their colours and decks. */
export const onePlayer = {
  profile: (client: GameStatsClient, player?: string): StatsRead<ProfileView> => ({
    key: `profile|${whose(player)}`,
    load: () => client.profile({ ...RATED, ...(player === undefined ? {} : { player }) }),
  }),
  matches: (client: GameStatsClient, player?: string): StatsRead<MatchPage> => ({
    key: `matches|${whose(player)}`,
    load: () => client.matches({ ...RATED, limit: PROFILE_MATCHES, ...(player === undefined ? {} : { player }) }),
  }),
  colours: (client: GameStatsClient, player?: string): StatsRead<Breakdown> => ({
    key: `breakdown|colors|${whose(player)}`,
    load: () => client.breakdown('colors', { ...RATED, ...(player === undefined ? {} : { player }) }),
  }),
  /** The Decks table's read for a filter's formats; the bare one is what the profile opens with. */
  decks: (client: GameStatsClient, player?: string, formats?: readonly string[]): StatsRead<Breakdown> => ({
    key: `breakdown|deck|${whose(player)}${narrowed(formats)}`,
    load: () => client.breakdown('deck', { ...RATED, ...(player === undefined ? {} : { player }), with: DECK_ROW_ATTRS, ...byFormat(formats) }),
  }),
};

/** Starts `reads` into the cache. A failure is left for the section that draws it to report. */
function warm(cache: StatsCache, reads: readonly StatsRead<unknown>[]): void {
  for (const read of reads) cache.get(read.key, read.load).catch(() => undefined);
}

/** The reads `#/stats` opens with: the trophy's (`./StatsButton.tsx`), so the page opens drawn. */
export function prefetchLeaderboard({ client, cache }: StatsSource = sharedSource()): void {
  warm(cache, [everyone.board(client, 'rating'), everyone.decks(client), everyone.colours(client), everyone.matches(client)]);
}

/** The reads a profile opens with; the viewer's when `player` is absent. Its header's rank is the rating board's. */
export function prefetchProfile({ client, cache }: StatsSource = sharedSource(), player?: string): void {
  warm(cache, [
    onePlayer.profile(client, player),
    onePlayer.matches(client, player),
    onePlayer.decks(client, player),
    onePlayer.colours(client, player),
    everyone.board(client, 'rating'),
  ]);
}

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
 * of the page asked again. So:
 *
 *   - a viewer `whoami` calls public is never sent to the store at all; each
 *     read fails at once with the store's own 401, which every section draws
 *     as its signed-out state ("Sign in to see stats.");
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

let shared: StatsSource | undefined;

/** The page's one stats client and the cache its reads are kept in. */
export function sharedSource(): StatsSource {
  const baseUrl = prefsBaseUrl();
  shared ??= {
    client: signedInStatsClient(createGameStatsClient({ gameId: 'cardtable', ...(baseUrl === undefined ? {} : { baseUrl }) }), viewerSignedIn),
    cache: createStatsCache(),
  };
  return shared;
}

/** Everyone's record per library deck in rated matches, keyed by the deck id a room match reports — `deckOrder.ts` sorts the picker by it. */
export async function fetchDeckRecords(source: StatsSource = sharedSource()): Promise<DeckRecords> {
  const { rows } = await source.client.breakdown('deckId', { ...RATED, player: '*' });
  return new Map(rows.map(({ value, ...totals }) => [value, totals]));
}

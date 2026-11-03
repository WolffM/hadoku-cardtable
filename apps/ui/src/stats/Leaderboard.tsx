/*
 * The stats page's Leaderboard (`#/stats`): everyone's rankings, the decks and colours that win,
 * and everyone's rated matches, newest first, an older page at a press.
 */

import { useState } from 'react';
import type { StatsCache } from '@wolffm/game-stats-ui';
import type { GameStatsClient, LeaderboardBy, MatchPage } from '@wolffm/prefs-client/games';

import { ChipGroup, StatsCard } from './card.tsx';
import { Colours } from './Colours.tsx';
import { matchFacts, renderName, SEAT_ATTRS } from './magic.tsx';
import { MatchHistory, Rankings } from './slots.tsx';
import { everyone, type StatsSource } from './source.ts';
import { matchFormats, NO_STATS_FILTER, renderAttr, WinningDecks, type StatsRoom } from './StatsDecks.tsx';

const RANK_BY: readonly { id: LeaderboardBy; label: string }[] = [
  { id: 'rating', label: 'Rating' },
  { id: 'winrate', label: 'Win rate' },
  { id: 'wins', label: 'Wins' },
  { id: 'games', label: 'Games' },
];

type Shown = 'all' | StatsRoom;
const SHOW: readonly { id: Shown; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'constructed', label: 'Constructed' },
  { id: 'draft', label: 'Draft pod' },
];

export function Leaderboard({ source }: { source: StatsSource }) {
  const { client, cache } = source;
  const [by, setBy] = useState<LeaderboardBy>('rating');
  return (
    <>
      <div className="ct-stats__row">
        <StatsCard
          title="Rankings"
          sub="Elo, rated matches"
          tools={<ChipGroup label="Rank by" options={RANK_BY} value={by} onChange={setBy} testId="stats-rank-by" />}
          read={everyone.board(client, by)}
          cache={cache}
          isEmpty={(b) => b.rows.length === 0}
          flush
          className="ct-stats__main"
          testId="stats-rankings"
        >
          {(b) => <Rankings rows={b.rows} by={by} renderName={renderName} />}
        </StatsCard>
        <div className="ct-stats__side">
          <WinningDecks client={client} cache={cache} />
          <Colours read={everyone.colours(client)} cache={cache} testId="stats-colours" />
        </div>
      </div>
      <History client={client} cache={cache} />
    </>
  );
}

function History({ client, cache }: { client: GameStatsClient; cache: StatsCache }) {
  const [shown, setShown] = useState<Shown>('all');
  const formats = shown === 'all' ? undefined : matchFormats({ ...NO_STATS_FILTER, rooms: new Set([shown]) });
  return (
    <StatsCard
      title="Match history"
      sub="Everyone"
      tools={<ChipGroup label="Show" options={SHOW} value={shown} onChange={setShown} testId="stats-history-show" />}
      read={everyone.matches(client, formats)}
      cache={cache}
      isEmpty={(page) => page.matches.length === 0}
      flush
      testId="stats-history"
    >
      {(first) => <Pages key={shown} client={client} cache={cache} formats={formats} first={first} />}
    </StatsCard>
  );
}

/** The first page, and every older one asked for since. */
function Pages({ client, cache, formats, first }: { client: GameStatsClient; cache: StatsCache; formats: readonly string[] | undefined; first: MatchPage }) {
  const [older, setOlder] = useState<readonly MatchPage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = (older.at(-1) ?? first).nextBefore;
  const more = (before: number): void => {
    setBusy(true);
    setError(null);
    const read = everyone.matches(client, formats, before);
    cache.get(read.key, read.load).then(
      (page) => {
        setOlder((held) => [...held, page]);
        setBusy(false);
      },
      (err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      },
    );
  };
  return (
    <>
      <MatchHistory matches={[first, ...older].flatMap((p) => p.matches)} everyone seatAttrs={SEAT_ATTRS} renderAttr={renderAttr} renderName={renderName} facts={matchFacts} />
      {next !== null && (
        <div className="ct-stats__more">
          <button type="button" className="ct-stats__more-button" disabled={busy} data-testid="stats-history-older" onClick={() => more(next)}>
            Older matches
          </button>
        </div>
      )}
      {error !== null && (
        <p className="ct-stats__note" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

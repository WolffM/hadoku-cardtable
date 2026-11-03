/*
 * A player's profile on the stats page: Your profile (`#/profile`) or anyone's (`#/stats/<name>`).
 * Its header and rating, its recent matches and head to head, then its decks and colours. One
 * read of the player's last matches feeds the chart, the recent matches and the head to head.
 *
 * Unfinished games are the viewer's own (`./UnfinishedGames.tsx`), so only Your profile lists
 * them; a player's own name, followed from a board, is Your profile.
 */

import { useEffect } from 'react';
import { useStatsLoad } from '@wolffm/game-stats-ui';
import type { LeaderboardRow } from '@wolffm/prefs-client/games';

import { navigate } from '../screens/route.ts';
import { StatsCard } from './card.tsx';
import { Colours } from './Colours.tsx';
import { matchFacts, renderName, SEAT_ATTRS } from './magic.tsx';
import { HeadToHead, MatchHistory, ProfileHeader, RatingChart } from './slots.tsx';
import { everyone, onePlayer, PROFILE_MATCHES, STATS_MODE, type StatsSource } from './source.ts';
import { DecksTable, renderAttr } from './StatsDecks.tsx';
import { UnfinishedGames, type ParkedGame } from './UnfinishedGames.tsx';

/** How many of the player's last matches the Recent matches list shows. */
const RECENT = 10;

/** Where a player stands on the rating board, when they are on it. */
export function rankOf(rows: readonly LeaderboardRow[], name: string): { rank: number; of: number } | undefined {
  const row = rows.find((r) => r.name === name);
  return row === undefined ? undefined : { rank: row.rank, of: rows.length };
}

export interface ProfileProps {
  source: StatsSource;
  /** A registry name; absent, the viewer. */
  player?: string | undefined;
  /** The viewer's unfinished games. Tests pass a stub; production the server's. */
  parked?: (() => Promise<ParkedGame[]>) | undefined;
}

export function Profile({ source, player, parked }: ProfileProps) {
  const { client, cache } = source;
  const matches = onePlayer.matches(client, player);
  const isEmpty = (page: { matches: readonly unknown[] }): boolean => page.matches.length === 0;
  return (
    <>
      <Header source={source} player={player} />
      <div className="ct-stats__row">
        <StatsCard title="Rating" sub={`Last ${PROFILE_MATCHES} rated matches`} read={matches} cache={cache} isEmpty={isEmpty} className="ct-stats__main" testId="stats-rating">
          {(page) => <RatingChart matches={page.matches} player={player} />}
        </StatsCard>
        {player === undefined && <UnfinishedGames load={parked} />}
      </div>
      <div className="ct-stats__row">
        <StatsCard title="Recent matches" read={matches} cache={cache} isEmpty={isEmpty} flush className="ct-stats__main" testId="stats-recent">
          {(page) => (
            <MatchHistory matches={page.matches.slice(0, RECENT)} player={player} seatAttrs={SEAT_ATTRS} renderAttr={renderAttr} renderName={renderName} facts={matchFacts} />
          )}
        </StatsCard>
        <StatsCard title="Head to head" read={matches} cache={cache} isEmpty={isEmpty} className="ct-stats__side" testId="stats-head-to-head">
          {(page) => <HeadToHead matches={page.matches} player={player} renderName={renderName} />}
        </StatsCard>
      </div>
      <DecksTable client={client} cache={cache} player={player} />
      <Colours read={onePlayer.colours(client, player)} cache={cache} detailed testId="stats-colours" />
    </>
  );
}

/** The player's name, rank and record; the viewer's own name moves to Your profile. */
function Header({ source, player }: { source: StatsSource; player: string | undefined }) {
  const { client, cache } = source;
  const read = onePlayer.profile(client, player);
  const board = everyone.board(client, 'rating');
  const profile = useStatsLoad(read.load, read.key, cache);
  const ranks = useStatsLoad(board.load, board.key, cache);
  const mine = player !== undefined && profile.state === 'ok' && profile.value.isMe;
  useEffect(() => {
    if (mine) navigate({ kind: 'stats', tab: 'profile' }, { replace: true });
  }, [mine]);
  return (
    <section className="ct-stats__card ct-stats__profile" aria-busy={profile.state === 'loading'} aria-label={player ?? 'Your profile'} data-testid="stats-profile">
      {profile.state === 'loading' && <span className="skeleton skeleton--heading" />}
      {profile.state === 'ok' && <ProfileHeader profile={profile.value} mode={STATS_MODE} rank={ranks.state === 'ok' ? rankOf(ranks.value.rows, profile.value.name) : undefined} />}
      {profile.state === 'error' && (
        <p className="ct-stats__note" role="alert">
          {profile.message}
        </p>
      )}
    </section>
  );
}

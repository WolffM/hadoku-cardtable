/*
 * A player's profile on the stats page: Your profile (`#/profile`) or anyone's (`#/stats/<name>`).
 * Its header and rating line, its recent matches and head to head (`@wolffm/game-stats-ui`'s), then
 * its decks and colours (Magic).
 *
 * Unfinished games are the viewer's own (`./UnfinishedGames.tsx`), so only Your profile lists
 * them; a player's own name, followed from a board, is Your profile.
 */

import { useEffect } from 'react';
import { HeadToHead, MatchFeed, ProfileHeader, RatingHistory, useStatsLoad } from '@wolffm/game-stats-ui';

import { navigate } from '@hadoku/game-ui/screens/route.ts';
import { Colours } from './Colours.tsx';
import { renderAvatar } from './face.tsx';
import { COUNTER_LABELS, MATCH_META, renderName, SEAT_ATTRS } from './magic.tsx';
import { FEED_PAGE, onePlayer, STATS_MODE, type StatsSource } from './source.ts';
import { DecksTable, renderAttr } from './StatsDecks.tsx';
import { UnfinishedGames, type ParkedGame } from './UnfinishedGames.tsx';

export interface ProfileProps {
  source: StatsSource;
  /** A registry name; absent, the viewer. */
  player?: string | undefined;
  /** The viewer's unfinished games. Tests pass a stub; production the server's. */
  parked?: (() => Promise<ParkedGame[]>) | undefined;
}

export function Profile({ source, player, parked }: ProfileProps) {
  const { client, cache } = source;
  const scope = { client, cache, mode: STATS_MODE, ratedOnly: true, ...(player === undefined ? {} : { player }) };
  return (
    <>
      {player !== undefined && <OwnNameIsYourProfile source={source} player={player} />}
      <ProfileHeader {...scope} renderAvatar={renderAvatar} testId="stats-profile" />
      <div className="ct-stats__row">
        <div className="ct-stats__main">
          <RatingHistory {...scope} count={30} testId="stats-rating" />
        </div>
        {player === undefined && <UnfinishedGames load={parked} />}
      </div>
      <div className="ct-stats__row">
        <div className="ct-stats__main">
          <MatchFeed
            {...scope}
            pageSize={FEED_PAGE}
            title="Recent matches"
            seatAttrs={SEAT_ATTRS}
            renderAttr={renderAttr}
            renderName={renderName}
            meta={MATCH_META}
            counterLabels={COUNTER_LABELS}
            testId="stats-recent"
          />
        </div>
        <div className="ct-stats__side">
          <HeadToHead {...scope} renderName={renderName} testId="stats-head-to-head" />
        </div>
      </div>
      <DecksTable client={client} cache={cache} player={player} />
      <Colours read={onePlayer.colours(client, player)} cache={cache} detailed testId="stats-colours" />
    </>
  );
}

/** The viewer's own name, followed from a board or a feed, moves to Your profile, where their unfinished games are. */
function OwnNameIsYourProfile({ source, player }: { source: StatsSource; player: string }) {
  const read = onePlayer.profile(source.client, player);
  const profile = useStatsLoad(read.load, read.key, source.cache);
  const mine = profile.state === 'ok' && profile.value.isMe;
  useEffect(() => {
    if (mine) navigate({ kind: 'stats', tab: 'profile' }, { replace: true });
  }, [mine]);
  return null;
}

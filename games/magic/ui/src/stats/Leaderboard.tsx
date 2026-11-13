/*
 * The stats page's Leaderboard (`#/stats`): everyone's rankings, the decks and colours that win,
 * and everyone's rated matches, newest first, an older page at a press. The rankings and the feed
 * are `@wolffm/game-stats-ui`'s; the decks, the colours and the feed's room chips are Magic.
 */

import { useState } from 'react';
import { Chips, MatchFeed, Rankings } from '@wolffm/game-stats-ui';

import { Colours } from './Colours.tsx';
import { renderAvatar } from './face.tsx';
import { COUNTER_LABELS, MATCH_META, renderName, SEAT_ATTRS } from './magic.tsx';
import { everyone, FEED_PAGE, STATS_MODE, type StatsSource } from './source.ts';
import { matchFormats, NO_STATS_FILTER, renderAttr, WinningDecks, type StatsRoom } from './StatsDecks.tsx';

type Shown = 'all' | StatsRoom;
const SHOW: readonly { value: Shown; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'constructed', label: 'Constructed' },
  { value: 'draft', label: 'Draft pod' },
];

export function Leaderboard({ source }: { source: StatsSource }) {
  const { client, cache } = source;
  const [shown, setShown] = useState<Shown>('all');
  const formats = shown === 'all' ? undefined : matchFormats({ ...NO_STATS_FILTER, rooms: new Set([shown]) });
  return (
    <>
      <div className="ct-stats__row">
        <div className="ct-stats__main">
          <Rankings client={client} cache={cache} mode={STATS_MODE} renderName={renderName} renderAvatar={renderAvatar} testId="stats-rankings" />
        </div>
        <div className="ct-stats__side">
          <WinningDecks client={client} cache={cache} />
          <Colours read={everyone.colours(client)} cache={cache} testId="stats-colours" />
        </div>
      </div>
      <MatchFeed
        client={client}
        cache={cache}
        mode={STATS_MODE}
        ratedOnly
        player="*"
        pageSize={FEED_PAGE}
        {...(formats === undefined ? {} : { match: { format: formats } })}
        filters={<Chips label="Show" options={SHOW} value={shown} onChange={setShown} testId="stats-history-show" />}
        seatAttrs={SEAT_ATTRS}
        renderAttr={renderAttr}
        renderName={renderName}
        meta={MATCH_META}
        counterLabels={COUNTER_LABELS}
        testId="stats-history"
      />
    </>
  );
}

/*
 * The front door: a list of rooms. One door, and this is it.
 *
 * The operator's spec (2026-09-19): *"players go to cardtable and all they see
 * on the front page is a list of rooms and they can either join a room or
 * create a new one."* So the room list (`../rooms/RoomList.tsx`) is the only
 * thing here, and a room is where a game is set up — its members ready up
 * inside it, and what readiness leads to is the room's game type.
 *
 * ## What is gone, and why nothing replaces it
 *
 * The "Play constructed" button to `#/play`: that screen had one person pick
 * BOTH players' decks, because `POST /api/play/matches` takes two decks in one
 * call, and the operator rejected it.
 *
 * The draft-pods section — "Start a pod" and "Join a pod or a match" — with
 * wave 23. It existed because a draft was not a room: the id was minted in the
 * browser and the pod dealt itself the instant a socket connected. The operator
 * on seeing it: *"why do we have 'start a pod' as a button but we also have
 * 'game type' selector at the top? … only one entrypoint."* A draft is a room
 * now, so the create form's `draft` game type is the way to start one.
 *
 * The join box accepted a pasted invite link or a bare id. The room list
 * answers that need: an invite link is `#/room/<id>`, and entering a room joins
 * it — `ConstructedScreen`'s table read joins once on a refused read (its
 * "Entering a room joins it" comment has the live incident that put it there).
 * So a friend with a link clicks it, and a friend without one finds the room in
 * the list.
 */

import { RoomList } from '../rooms/RoomList.tsx';
import type { RoomsClient } from '../rooms/api.ts';
import type { RoomFeed } from '../rooms/feed.ts';
import { SettingsGear } from '../settings/Settings.tsx';
import { StatsButton, StatsPopout, type StatsSource } from '../stats/StatsPopout.tsx';
import { DecksButton } from './DecksButton.tsx';

export interface LobbyScreenProps {
  /** Tests pass a rooms client over a stubbed fetch. Production passes nothing. */
  rooms?: RoomsClient;
  /** Tests pass their own room feed. Production passes nothing. */
  feed?: RoomFeed;
  /** `#/stats[/<name>]`: the stats popout is open over the lobby, for this player (absent, the viewer). */
  stats?: { player?: string; tournaments?: boolean };
  /** Tests pass a stats client over a stubbed fetch. Production passes nothing. */
  statsSource?: StatsSource;
}

export function LobbyScreen({ rooms, feed, stats, statsSource }: LobbyScreenProps) {
  return (
    <div className="shell shell--fit" data-testid="lobby">
      {/* No title here. The fleet's AppHeader already says "Card Table" at the
          top of every route, from the catalogue (`app-name.ts`), and a second
          one in the page said it twice — operator, 2026-09-27. The other
          screens' `shell__head` earns its place by naming the ROOM or the
          deck; the lobby has nothing to add that the header has not said. */}
      <nav className="shell__tools">
        <DecksButton />
        <StatsButton source={statsSource} />
        <SettingsGear />
      </nav>
      <main className="front">
        <RoomList client={rooms} feed={feed} />
      </main>
      {stats !== undefined && <StatsPopout player={stats.player} tournaments={stats.tournaments === true} source={statsSource} />}
    </div>
  );
}

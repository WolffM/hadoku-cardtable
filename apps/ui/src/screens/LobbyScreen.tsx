/*
 * The front door: a Twitch-like banner, then a list of rooms.
 *
 * The operator's spec (2026-09-19): *"players go to cardtable and all they see
 * on the front page is a list of rooms and they can either join a room or
 * create a new one."* That is still the whole of the room list
 * (`../rooms/RoomList.tsx`): a room is where a game is set up — its members
 * ready up inside it, and what readiness leads to is the room's game type.
 *
 * Above it sits the banner (`docs/planning/wave77-2026-10-27.md` §A, the
 * operator, 2026-10-26: *"i want to show a live twitch-like frontpage
 * experience where we highlight a room that is currently active and
 * playing"*) — the live match the server already picked
 * (`GET /api/rooms`'s `featured`), patch notes, upcoming events and a
 * wildcard card. `RoomList` is still the one caller of `GET /api/rooms`; it
 * tells this screen the pick it read alongside the list (`onFeatured`)
 * rather than the banner fetching its own copy.
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
 *
 * ## Loading once
 *
 * The page shows itself once (`../front/gate.ts`): each part that reads stands as its skeleton, in its
 * loaded boxes, until all of them have their answers, then they crossfade in together. The live slot
 * does not start until the first room list has said what is live (`featured` is `undefined` until
 * then): started early, it fetched a replay and then threw it away for the live match.
 */

import { useEffect, useState } from 'react';

import { Banner } from '../front/Banner.tsx';
import { FrontGateContext, useFrontGateState } from '../front/gate.ts';
import { RoomList } from '../rooms/RoomList.tsx';
import type { FeaturedPick, RoomsClient } from '../rooms/api.ts';
import type { RoomFeed } from '../rooms/feed.ts';
import { SettingsGear } from '../settings/Settings.tsx';
import { useSiteTrim } from '../settings/siteTrim.ts';
import { StatsButton } from '../stats/StatsButton.tsx';
import type { StatsSource } from '../stats/source.ts';
import { DecksButton } from './DecksButton.tsx';
import { InventoryButton } from './InventoryButton.tsx';
import { useChromeShell } from '@hadoku/ui-shell/chrome/shell';

export interface LobbyScreenProps {
  /** Tests pass a rooms client over a stubbed fetch. Production passes nothing. */
  rooms?: RoomsClient;
  /** Tests pass their own room feed. Production passes nothing. */
  feed?: RoomFeed;
  /** Tests pass a stats client over a stubbed fetch. Production passes nothing. */
  statsSource?: StatsSource;
}

export function LobbyScreen({ rooms, feed, statsSource }: LobbyScreenProps) {
  const shellRef = useChromeShell('fit');
  /** The server's pick for the live slot; `undefined` until the first room list has answered. */
  const [featured, setFeatured] = useState<FeaturedPick | null | undefined>(undefined);
  const gate = useFrontGateState();
  const trimLoaded = useSiteTrim().loaded;
  const { settle } = gate;
  useEffect(() => {
    if (trimLoaded) settle('trim');
  }, [trimLoaded, settle]);
  return (
    <div ref={shellRef} className="shell shell--fit" data-testid="lobby">
      {/* No title here. The fleet's AppHeader already says "Card Table" at the
          top of every route, from the catalogue (`app-name.ts`), and a second
          one in the page said it twice — operator, 2026-09-27. The other
          screens' `shell__head` earns its place by naming the ROOM or the
          deck; the lobby has nothing to add that the header has not said. */}
      <nav className="shell__tools">
        <DecksButton />
        <InventoryButton />
        <StatsButton source={statsSource} />
        <SettingsGear />
      </nav>
      <FrontGateContext.Provider value={gate}>
        <main className="front" aria-busy={!gate.revealed}>
          <Banner featured={featured} />
          <RoomList client={rooms} feed={feed} onFeatured={setFeatured} />
        </main>
      </FrontGateContext.Provider>
      {/* LICENSING.md D25: strangers can sign up, so the Fan Content Policy's "unofficial" line is back,
          small, at the foot of the page's own scroll. D23 took the old bordered footer away. */}
      <p className="shell__disclaimer">
        Unofficial fan project, not affiliated with or endorsed by Wizards of the Coast. Card names, text and images
        are ™ &amp; © Wizards of the Coast.
      </p>
    </div>
  );
}

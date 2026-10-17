/*
 * The router, and nothing else.
 *
 * Until this wave `App.tsx` WAS the app: a Source switcher, a seed box and a
 * fixture picker, which is the harness that was built to exercise the engine.
 * The operator's report on opening production was exact — *"it still has the
 * weird dev ui… i still haven't seen actual gameplay of the engine"* — and the
 * diagnosis is that the harness was the front door. It is not deleted; it moved
 * to `#/debug` and is `DebugHarness`.
 *
 * What is here now is a switch over the hash — `screens/Screen.tsx`, which the
 * watchparty embed (`embed/`, D21) renders too — inside the standalone page's
 * header and room chrome. No router dependency, no server change: see
 * `screens/route.ts` for why the hash and not the path.
 *
 *   `#/`                 `LobbyScreen` — the room list, the one front door
 *   `#/room/<roomId>`    `ConstructedScreen` — a room: its lobby, then its game
 *   `#/draft/<draftId>`  LEGACY — redirected to `#/room/<draftId>`, renders nothing
 *   `#/deck/<draftId>`   `DeckScreen`
 *   `#/play`             `ConstructedScreen` — pick a format and a deck
 *   `#/match/<matchId>`  `MatchScreen` — the invite link and the live board
 *   `#/debug`            `DebugHarness` — the old front door
 *   `#/sounds`           `SoundBuilder` — admin-gated (wave 50 §U), renders nothing for anyone else
 *   `#/sounds/sandbox`   `SoundSandbox` — admin-gated the same way
 *   `#/stats[/<name>]`   the lobby with `StatsPopout` over it — a player's record, history and the boards
 *
 * An unknown hash renders the lobby, which is a screen that explains itself.
 *
 * `#/draft/<id>` has no screen of its own since wave 23 made a draft a room:
 * `PodScreen` is content `ConstructedScreen` renders once a draft room starts,
 * and the draft id IS the room id. The route survives only so a link somebody
 * was already sent keeps working — see `LegacyDraftRedirect` below.
 *
 * `transport` exists so a test can drive a draft without a server: it is
 * threaded to `ConstructedScreen` as `makeTransport` and to nothing else, and
 * production never passes it, so the default — a same-origin socket.io
 * connection — is what ships.
 */

import { useEffect, useState } from 'react';

import { AppHeader } from '@wolffm/task-ui-components';
import { Screen, type ScreenProps } from './screens/Screen.tsx';
import { useRoute } from './screens/route.ts';
import { setScreenMusic } from './sound/index.ts';
import { AppChrome } from './chrome/AppChrome.tsx';
import { RoomShell } from './room/RoomShell.tsx';
import { useWhoami } from './room/whoami.ts';
import { roomsClient } from './rooms/api.ts';

export type AppProps = ScreenProps;

/**
 * The room a live match belongs to, resolved once per match id — the same
 * call `MatchScreen.tsx` already makes for its own "back to the room" link
 * (`roomOfMatch`), asked again here because the chat has to know it BEFORE
 * `MatchScreen` ever mounts.
 *
 * Kept across matches rather than reset to `null` while a new one resolves
 * (wave 71 §G): `RoomShell` tears down and rebuilds watchparty's chrome
 * whenever the room id it is given changes, so a board switch that bounced
 * through `null` on every click would rejoin the chat twice for nothing — and
 * a player who switches to another table and back would watch their chat
 * column vanish and reappear both times. The two tables Carol moves between
 * in `e2e/w71-boards.spec.ts` are one room, so holding the last answer here
 * makes that switch a no-op render instead. The very first match a tab opens
 * still renders with no chrome for one tick, because there is no earlier
 * answer to hold on to — see the comment on `RoomShell`'s own `who === 'pending'`
 * guard for why that single bounce does not repeat.
 */
function useMatchRoomId(matchId: string | null): string | null {
  const [roomId, setRoomId] = useState<string | null>(null);
  useEffect(() => {
    if (matchId === null) return;
    let live = true;
    roomsClient()
      .roomOfMatch(matchId)
      .then(
        (room) => {
          if (live) setRoomId(room?.id ?? null);
        },
        () => {
          if (live) setRoomId(null);
        },
      );
    return () => {
      live = false;
    };
  }, [matchId]);
  return roomId;
}

/**
 * The watchparty room this route belongs in, or null for the routes that are
 * not a shared place: the lobby, the format picker and the debug harness.
 *
 * A draft room and its deck screen share one watchparty room on purpose — it is
 * the same people either side of the draft finishing, and making them rejoin a
 * new room to build a deck would drop the conversation they were having about
 * it. The legacy `draft` route maps to the same id the `room` route does, so
 * redirecting one to the other does not tear down and rebuild the chrome.
 *
 * **A `match` route resolves to the MATCH'S ROOM, not the match itself**
 * (wave 71 §G, `useMatchRoomId` above). Every member used to be pushed onto
 * `cardtable-m-<matchId>` here — a chat room keyed by the game, and a
 * DIFFERENT one from the room's own `cardtable-r-<roomId>` — so a room's
 * conversation stopped the moment anyone opened a board and could not be
 * resumed by opening another board of the same room (the board strip this
 * wave adds is exactly that second board). `matchRoomId` is the answer this
 * function now returns for a `match` route; it is `null` until the room is
 * known, same as a route this function always answered `null` for.
 */
export function roomIdFor(route: ReturnType<typeof useRoute>, matchRoomId: string | null): string | null {
  switch (route.kind) {
    case 'draft':
    case 'deck':
      return route.draftId;
    case 'match':
      return matchRoomId;
    case 'room':
      return route.roomId;
    default:
      return null;
  }
}

export function App({ transport }: AppProps) {
  const route = useRoute();
  const matchRoomId = useMatchRoomId(route.kind === 'match' ? route.matchId : null);

  // The lobby's music everywhere a player is, silence on the tools. A match
  // swaps in its own (`LiveBoard` → `setMatchMusic`).
  const silent = route.kind === 'debug' || route.kind === 'sounds' || route.kind === 'sounds-sandbox';
  useEffect(() => setScreenMusic(silent ? null : 'music.lobby'), [silent]);

  // The fleet's identity, read once here and threaded down. `RoomShell` reads
  // the same hook for its own use; `whoami()` shares one in-flight promise per
  // page (`globalThis.__hadokuWhoami`), so this is one identity path with two
  // consumers, not two paths. See `chrome/AppChrome.tsx`.
  const who = useWhoami();
  const viewer = who === 'pending' || who === null ? null : who;

  // The shared header, authored HERE at the root because that is the fleet's
  // convention and what its audit reads: the app root mounts the header, the
  // chrome frame slots it in inside the theme provider. The title is the
  // catalogue's name for this app, filled at build time — see app-name.ts, and
  // the tab title is the same string.
  const header = (
    <AppHeader
      // The title is the way HOME. The operator, 2026-09-26: *"'Card Table' at
      // the top should be clickable and bring you back to the entry page."*
      //
      // A real `<a href="#/">`, not an onClick on a heading: an anchor is
      // keyboard-reachable, announces itself as a link, and middle-clicks.
      // `AppHeader`'s `title` takes a NODE for exactly this — its own docs call
      // it "a node for custom markup (e.g. a clickable title button)" — and the
      // <h1> stays INSIDE the link, which is the shape the fleet's audit
      // documents (`check-header-fleet.mjs`, `appHeaderTitle`: "an <h1> nested
      // in a <button>"). The name is still `__HADOKU_APP_NAME__`, so the audit's
      // `header-name` rule still reads it as derived rather than hard-coded.
      title={
        <a className="cardtable-chrome__home" href="#/">
          <h1 className="cardtable-chrome__home-name">{__HADOKU_APP_NAME__}</h1>
        </a>
      }
      // NO `status`. The viewer's name used to render here, and that was a
      // deliberate break with the fleet's convention — identity lives in the
      // gear's popout and nowhere else. The justification was that the
      // operator had reported seeing `anon` where their name belongs, but the
      // fix for a WRONG name was to make the name right (the edge now injects
      // `X-User-Name`, wave 22), not to move it somewhere the fleet does not
      // put it. Operator, 2026-09-27: *"name 'Bella' should not show at the
      // top, that shows in the settings menu. why'd you break protocol with
      // this? this is not the standard header."* Do not reinstate it.
      //
      // Identity the page already knows, so the popout does not re-resolve it.
      // `ConnectedSettings` otherwise calls its own `whoami()` against
      // `/session/whoami`, which is a second identity path to the same fact.
      settingsProps={viewer === null ? undefined : { userType: viewer.tier, name: viewer.name }}
    />
  );

  // ONE chrome for the page. Their store and socket are module singletons, so
  // a second RoomChrome would share and then tear down the first's connection
  // — which is why this wraps the switch rather than living in a screen.
  //
  // `AppChrome` is the hadoku frame (theme root + the header's slot) and goes
  // OUTSIDE the room: the header belongs to the app, the room is one thing the
  // app renders. It mounts no room of its own.
  return (
    <AppChrome header={header}>
      {/* The operator, 2026-10-10: *"theres really no reason to close the chat
          in the lobby screen"*. A room's lobby keeps it open; the draft, deck
          and match screens still let a viewer hide it. */}
      <RoomShell roomId={roomIdFor(route, matchRoomId)} collapsible={route.kind !== 'room'}>
        <Screen transport={transport} />
      </RoomShell>
    </AppChrome>
  );
}

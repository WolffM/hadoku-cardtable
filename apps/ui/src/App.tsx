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
 * What is here now is a switch over the hash. No router dependency, no server
 * change: see `screens/route.ts` for why the hash and not the path.
 *
 *   `#/`                 `LobbyScreen` — the room list, the one front door
 *   `#/room/<roomId>`    `ConstructedScreen` — a room: its lobby, then its game
 *   `#/draft/<draftId>`  LEGACY — redirected to `#/room/<draftId>`, renders nothing
 *   `#/deck/<draftId>`   `DeckScreen`
 *   `#/play`             `ConstructedScreen` — pick a format and a deck
 *   `#/match/<matchId>`  `MatchScreen` — the invite link and the live board
 *   `#/debug`            `DebugHarness` — the old front door
 *   `#/sounds`           `SoundBuilder` — admin-gated (wave 50 §U), renders nothing for anyone else
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

import { useEffect } from 'react';

import { AppHeader } from '@wolffm/task-ui-components';
import { ConstructedScreen } from './screens/ConstructedScreen.tsx';
import { DebugHarness } from './screens/DebugHarness.tsx';
import { DeckScreen } from './screens/DeckScreen.tsx';
import { LobbyScreen } from './screens/LobbyScreen.tsx';
import { MatchScreen } from './screens/MatchScreen.tsx';
import { SoundBuilder } from './screens/SoundBuilder.tsx';
import { navigate, useRoute } from './screens/route.ts';
import { AppChrome } from './chrome/AppChrome.tsx';
import { RoomShell, useWhoami } from './room/RoomShell.tsx';
import type { DraftTransport } from './draft/socket.ts';
import './screens/screens.css';

export interface AppProps {
  /** Tests pass a stub socket. Production passes nothing. */
  transport?: () => DraftTransport;
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
 */
function roomIdFor(route: ReturnType<typeof useRoute>): string | null {
  switch (route.kind) {
    case 'draft':
    case 'deck':
      return route.draftId;
    case 'match':
      return route.matchId;
    case 'room':
      return route.roomId;
    default:
      return null;
  }
}

/**
 * `#/draft/<id>` → `#/room/<id>`, and nothing on screen in between.
 *
 * A draft id and its room id are one id now, so the whole translation is the
 * redirect. It is an effect rather than a render-time `navigate` because
 * navigating during render mutates `location` and notifies subscribers while
 * React is rendering them; the effect fires immediately after the empty commit,
 * so nothing flashes.
 *
 * A pod id that was never a room lands on the room screen's own "no such room".
 * That is the honest answer: the pod it named was in a server's memory and is
 * gone, and pretending otherwise would deal an empty table.
 */
function LegacyDraftRedirect({ draftId }: { draftId: string }) {
  useEffect(() => {
    navigate({ kind: 'room', roomId: draftId });
  }, [draftId]);
  return null;
}

function Screen({ transport }: AppProps) {
  const route = useRoute();

  switch (route.kind) {
    case 'debug':
      return <DebugHarness />;
    case 'sounds':
      return <SoundBuilder />;
    case 'draft':
      return <LegacyDraftRedirect draftId={route.draftId} />;
    case 'deck':
      return <DeckScreen draftId={route.draftId} />;
    case 'play':
      return <ConstructedScreen />;
    case 'match':
      return <MatchScreen matchId={route.matchId} />;
    case 'room':
      return <ConstructedScreen roomId={route.roomId} makeTransport={transport} />;
    case 'lobby':
      return <LobbyScreen />;
  }
}

export function App({ transport }: AppProps) {
  const route = useRoute();

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
      <RoomShell roomId={roomIdFor(route)}>
        <Screen transport={transport} />
      </RoomShell>
    </AppChrome>
  );
}

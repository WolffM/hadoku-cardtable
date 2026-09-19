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
 * What is here now is a switch over the hash. Six routes, no router
 * dependency, no server change: see `screens/route.ts` for why the hash and not
 * the path.
 *
 *   `#/`                 `LobbyScreen` — start a pod, or join one
 *   `#/draft/<draftId>`  `PodScreen`   — the invite link, the seats, the draft
 *   `#/deck/<draftId>`   `DeckScreen`
 *   `#/play`             `ConstructedScreen` — pick a format and a deck
 *   `#/match/<matchId>`  `MatchScreen` — the invite link and the live board
 *   `#/debug`            `DebugHarness` — the old front door
 *
 * An unknown hash renders the lobby, which is a screen that explains itself.
 *
 * `transport` exists so a test can drive the lobby into a real pod without a
 * server: it is threaded to `PodScreen` and to nothing else, and production
 * never passes it, so the default — a same-origin socket.io connection — is
 * what ships.
 */

import { ConstructedScreen } from './screens/ConstructedScreen.tsx';
import { DebugHarness } from './screens/DebugHarness.tsx';
import { DeckScreen } from './screens/DeckScreen.tsx';
import { LobbyScreen } from './screens/LobbyScreen.tsx';
import { MatchScreen } from './screens/MatchScreen.tsx';
import { PodScreen } from './screens/PodScreen.tsx';
import { useRoute } from './screens/route.ts';
import { RoomShell } from './room/RoomShell.tsx';
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
 * A pod and its deck screen share one room on purpose — it is the same people
 * either side of the draft finishing, and making them rejoin a new room to
 * build a deck would drop the conversation they were having about it.
 */
function roomIdFor(route: ReturnType<typeof useRoute>): string | null {
  switch (route.kind) {
    case 'draft':
    case 'deck':
      return route.draftId;
    case 'match':
      return route.matchId;
    default:
      return null;
  }
}

function Screen({ transport }: AppProps) {
  const route = useRoute();

  switch (route.kind) {
    case 'debug':
      return <DebugHarness />;
    case 'draft':
      return <PodScreen draftId={route.draftId} makeTransport={transport} />;
    case 'deck':
      return <DeckScreen draftId={route.draftId} />;
    case 'play':
      return <ConstructedScreen />;
    case 'match':
      return <MatchScreen matchId={route.matchId} />;
    case 'lobby':
      return <LobbyScreen />;
  }
}

export function App({ transport }: AppProps) {
  const route = useRoute();

  // ONE chrome for the page. Their store and socket are module singletons, so
  // a second RoomChrome would share and then tear down the first's connection
  // — which is why this wraps the switch rather than living in a screen.
  return (
    <RoomShell roomId={roomIdFor(route)}>
      <Screen transport={transport} />
    </RoomShell>
  );
}

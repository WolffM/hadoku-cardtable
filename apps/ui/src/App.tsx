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
import type { DraftTransport } from './draft/socket.ts';
import './screens/screens.css';

export interface AppProps {
  /** Tests pass a stub socket. Production passes nothing. */
  transport?: () => DraftTransport;
}

export function App({ transport }: AppProps) {
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

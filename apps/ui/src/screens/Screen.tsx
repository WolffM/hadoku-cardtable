/*
 * The switch from a route to the screen that draws it — shared by the
 * standalone app (`App.tsx`, inside its header and watchparty's room chrome)
 * and the watchparty embed (`embed/EmbedApp.tsx`, inside neither). The routes
 * themselves are listed in `App.tsx`'s header and `route.ts`.
 */

import { useEffect } from 'react';

import { ConstructedScreen } from './ConstructedScreen.tsx';
import { DeckScreen } from './DeckScreen.tsx';
import { DecksScreen } from './DecksScreen.tsx';
import { InventoryScreen } from './InventoryScreen.tsx';
import { LobbyScreen } from './LobbyScreen.tsx';
import { MatchScreen } from './MatchScreen.tsx';
import { MusicReview } from './MusicReview.tsx';
import { SoundBuilder } from './SoundBuilder.tsx';
import { SoundSandbox } from './SoundSandbox.tsx';
import { navigate, useRoute } from './route.ts';
import type { DraftTransport } from '../draft/socket.ts';
import { TrimScreen } from '../settings/TrimScreen.tsx';
import './screens.css';

export interface ScreenProps {
  /** Tests pass a stub socket. Production passes nothing. */
  transport?: () => DraftTransport;
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

export function Screen({ transport }: ScreenProps) {
  const route = useRoute();

  switch (route.kind) {
    case 'sounds':
      return <SoundBuilder />;
    case 'sounds-sandbox':
      return <SoundSandbox />;
    case 'sounds-music':
      return <MusicReview />;
    case 'ui':
      return <TrimScreen />;
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
    case 'stats':
      // The same element as the lobby's, so opening the popout keeps the lobby mounted.
      return <LobbyScreen stats={{ player: route.player, tournaments: route.tournaments === true }} />;
    case 'decks':
      return route.draftId === undefined ? <DecksScreen /> : <DeckScreen key={route.draftId} draftId={route.draftId} standalone />;
    case 'inventory':
      return <InventoryScreen />;
  }
}

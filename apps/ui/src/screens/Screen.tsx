/*
 * The switch from a route to the screen that draws it — shared by the
 * standalone app (`App.tsx`, inside its header and watchparty's room chrome)
 * and the watchparty embed (`embed/EmbedApp.tsx`, inside neither). The routes
 * themselves are listed in `App.tsx`'s header and `route.ts`.
 */

import { Suspense, useEffect } from 'react';

import { lazyComponent } from '@hadoku/game-ui/lazy.ts';
import { warmMatchesFrom } from '../play/live/matchStart.ts';
import { navigate, useRoute } from '@hadoku/game-ui/screens/route.ts';
import type { DraftTransport } from '../draft/socket.ts';

/*
 * Every screen but the lobby is a chunk of its own (`../lazy.ts`), loaded the first time its route
 * draws. The lobby is the front door and draws with the page. The two a player opens next, a room
 * and its match, are warmed once the page is idle ({@link preloadLikelyScreens}).
 *
 * The ORDER of the lines below is the cascade's: each screen's sheets sit in the one stylesheet
 * where its import is written, a lazy one included (`../../stylesheet.ts`), so the lobby's import
 * stays between the screens and `screens.css` comes after them all, as it always has.
 */
const ConstructedScreen = lazyComponent(() => import('./ConstructedScreen.tsx').then((m) => m.ConstructedScreen));
const DeckScreen = lazyComponent(() => import('./DeckScreen.tsx').then((m) => m.DeckScreen));
const DecksScreen = lazyComponent(() => import('./DecksScreen.tsx').then((m) => m.DecksScreen));
const InventoryScreen = lazyComponent(() => import('./InventoryScreen.tsx').then((m) => m.InventoryScreen));
import { LobbyScreen } from './LobbyScreen.tsx';
// The trophy beside the lobby's gear warms the stats page's chunk, so the page drawn here is the trophy's own.
import { StatsPage } from '../stats/StatsButton.tsx';
const matchScreen = () => import('./MatchScreen.tsx');
const MatchScreen = lazyComponent(() => matchScreen().then((m) => m.MatchScreen));
const MusicReview = lazyComponent(() => import('./MusicReview.tsx').then((m) => m.MusicReview));
const ReplayScreen = lazyComponent(() => import('../replay/ReplayScreen.tsx').then((m) => m.ReplayScreen));
const RallyEmbed = lazyComponent(() => import('../rally/RallyEmbed.tsx').then((m) => m.RallyEmbed));
const SoundBuilder = lazyComponent(() => import('./SoundBuilder.tsx').then((m) => m.SoundBuilder));
const SoundSandbox = lazyComponent(() => import('./SoundSandbox.tsx').then((m) => m.SoundSandbox));
const TrimScreen = lazyComponent(() => import('@hadoku/game-ui/settings/TrimScreen.tsx').then((m) => m.TrimScreen));
import './screens.css';

// A room opens its new match before it hands the page over, with the match screen's own opener.
warmMatchesFrom(() => matchScreen().then((m) => m.matchOpener));

/** Load a room's screen and its match's ahead of the press that opens them. The page calls this once it has drawn. */
export function preloadLikelyScreens(): void {
  void ConstructedScreen.preload();
  void MatchScreen.preload();
}

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

/** Nothing in the screen's place while its chunk loads: the chrome around it is already drawn. */
export function Screen(props: ScreenProps) {
  return (
    <Suspense fallback={null}>
      <RouteScreen {...props} />
    </Suspense>
  );
}

function RouteScreen({ transport }: ScreenProps) {
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
    case 'replay':
      return <ReplayScreen matchId={route.matchId} />;
    case 'room':
      return <ConstructedScreen roomId={route.roomId} tableId={route.tableId} makeTransport={transport} />;
    case 'lobby':
      return <LobbyScreen />;
    case 'stats':
      return <StatsPage tab={route.tab} player={route.player} />;
    case 'decks':
      return route.draftId === undefined ? <DecksScreen /> : <DeckScreen key={route.draftId} draftId={route.draftId} standalone />;
    case 'inventory':
      return <InventoryScreen />;
    case 'rally-embed':
      return <RallyEmbed key={`${route.catalogue}/${route.id}/${route.view}`} catalogue={route.catalogue} id={route.id} view={route.view} />;
  }
}

/*
 * Cardtable inside a watchparty room's game slot (D21) — chromeless.
 *
 * Watchparty draws the room around this: its header, chat, roster and
 * presence. So this renders none of ours — no `AppHeader`, no `RoomShell` /
 * `RoomChrome` (a second watchparty chrome on watchparty's own page would
 * share, then tear down, their singleton socket) — and only the table:
 * `screens/Screen.tsx`, the same switch the standalone app renders.
 *
 * ## What it takes from the context, and what it does not
 *
 * - **The room.** The table is the one the server binds to this watchparty
 *   room (`POST /api/rooms/watchparty`) from `roomKey`, watchparty's room id,
 *   so every member lands at the same one.
 * - **The theme**, as `data-theme` on this tree's root, which is how
 *   `@wolffm/themes` resolves its tokens on any container; and as the theme
 *   context, so anything below that reads `useHadokuTheme()` reads the host's
 *   theme rather than throwing. Changing it is the host's: `setTheme` here is
 *   inert, there is no picker.
 * - **NOT the identity.** Who you are at the table is what the edge tells
 *   cardtable's server on every request (same origin, so the edge cookie rides
 *   along); no screen takes identity from the client. Using `ctx.identity` for
 *   anything would be a second identity path beside the one that is enforced.
 * - **NOT `isLeader`.** Cardtable's room has its own leader — whoever bound it
 *   first, then whoever has been in it longest — and the server enforces it.
 *   A client-side gate on watchparty's leader would be a second authority that
 *   the server does not know about; D21 records the choice.
 * - **NOT `close()`.** Leaving a match goes back to this room's table, never
 *   out of the slot. Watchparty's `close()` is heavier than "leave": for its
 *   leader it stops the game for everyone. That is watchparty's own control.
 *
 * ## Routes
 *
 * In memory (`routeInMemory`, set up by `./index.tsx`), never the page's hash.
 * The routes that are not a table — the room list, the stats popout over it,
 * the format picker, the debug harness, the sound tools — go to the bound room
 * instead: in a watchparty room there is exactly one table, and "back to the
 * lobby" means it.
 */

import { useEffect, useMemo, useState } from 'react';
import { HadokuThemeProvider, THEME_FAMILIES, type HadokuThemeValue } from '@wolffm/themes';

import { roomsClient, type RoomBindClient } from '../rooms/api.ts';
import { Screen } from '../screens/Screen.tsx';
import { navigate, useRoute, type Route } from '../screens/route.ts';
import type { GameBundleContext } from './contract.ts';
import './embed.css';

const NOT_A_TABLE: ReadonlySet<Route['kind']> = new Set(['lobby', 'stats', 'play', 'debug', 'sounds', 'sounds-sandbox']);

export interface EmbedAppProps {
  ctx: GameBundleContext;
  /** Tests pass a stub. Production passes nothing. */
  rooms?: RoomBindClient;
}

type Binding = { state: 'binding' } | { state: 'bound'; roomId: string } | { state: 'failed'; message: string };

function useBoundRoom(watchpartyRoom: string, rooms: RoomBindClient): Binding {
  const [binding, setBinding] = useState<Binding>({ state: 'binding' });
  useEffect(() => {
    let live = true;
    setBinding({ state: 'binding' });
    void rooms.bindWatchparty(watchpartyRoom).then((outcome) => {
      if (!live) return;
      setBinding(outcome.ok ? { state: 'bound', roomId: outcome.room.id } : { state: 'failed', message: outcome.message });
      if (outcome.ok) navigate({ kind: 'room', roomId: outcome.room.id });
    });
    return () => {
      live = false;
    };
  }, [watchpartyRoom, rooms]);
  return binding;
}

function themeValue(theme: string): HadokuThemeValue {
  return {
    theme,
    setTheme: () => undefined,
    themeFamilies: [...THEME_FAMILIES],
    getThemeIcon: () => null,
    isDarkTheme: theme === 'dark' || theme.endsWith('-dark'),
    isThemeReady: true,
    isInitialThemeLoad: false,
  };
}

/** A route that is not a table goes to the bound one. An effect, for the reason `LegacyDraftRedirect` gives. */
function ToRoom({ roomId }: { roomId: string }) {
  useEffect(() => {
    navigate({ kind: 'room', roomId });
  }, [roomId]);
  return null;
}

export function EmbedApp({ ctx, rooms: givenRooms }: EmbedAppProps) {
  const rooms = useMemo(() => givenRooms ?? roomsClient(), [givenRooms]);
  const binding = useBoundRoom(ctx.roomKey, rooms);
  const route = useRoute();
  const theme = useMemo(() => themeValue(ctx.theme), [ctx.theme]);

  let body = null;
  if (binding.state === 'failed') {
    body = (
      <p className="cardtable-embed__error" role="alert" data-testid="embed-error">
        {binding.message}
      </p>
    );
  } else if (binding.state === 'bound') {
    body = NOT_A_TABLE.has(route.kind) ? <ToRoom roomId={binding.roomId} /> : <Screen />;
  }

  return (
    <HadokuThemeProvider value={theme}>
      <main
        className="cardtable-chrome cardtable-chrome--embed"
        data-theme={ctx.theme}
        data-dark-theme={theme.isDarkTheme ? 'true' : 'false'}
        data-testid="cardtable-embed"
        data-bound-room={binding.state === 'bound' ? binding.roomId : undefined}
      >
        <div className="cardtable-chrome__content">{body}</div>
      </main>
    </HadokuThemeProvider>
  );
}

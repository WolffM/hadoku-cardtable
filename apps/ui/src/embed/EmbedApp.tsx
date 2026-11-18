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
 *   Their name, picture and character come from their account, server-side
 *   (`packages/game-server/src/people.ts`'s `applyPerson`), embedded or not.
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
 * The binding and the redirect are every game's (`@hadoku/game-ui/embed/bound-room.tsx`).
 * The routes that are not a table — the room list, the stats page,
 * the format picker, the sound tools — go to the bound room
 * instead: in a watchparty room there is exactly one table, and "back to the
 * lobby" means it.
 */

import { useCallback, useMemo, useRef } from 'react';
import { HadokuThemeProvider } from '@wolffm/themes';

import { bindWatchpartyRoom, hostThemeValue, ToRoom, useBoundRoom, type BindRoom } from '@hadoku/game-ui/embed/bound-room.tsx';
import { Screen } from '../screens/Screen.tsx';
import { navigate, useRoute, type Route } from '@hadoku/game-ui/screens/route.ts';
import { useUiScale } from '@hadoku/game-ui/settings/Settings.tsx';
import { useTrim } from '@hadoku/game-ui/settings/siteTrim.ts';
import { useSoundPrefs } from '@hadoku/ui-shell/sound';
import { scaleRootOf } from '@hadoku/ui-shell/settings';
import type { GameBundleContext } from './contract.ts';
import { composeGame } from '../composition.tsx';
import './embed.css';
composeGame();

const NOT_A_TABLE: ReadonlySet<Route['kind']> = new Set(['lobby', 'stats', 'decks', 'play', 'sounds', 'sounds-sandbox', 'sounds-music', 'ui']);

const BIND = bindWatchpartyRoom();
const toRoom = (roomId: string): void => navigate({ kind: 'room', roomId });

export interface EmbedAppProps {
  ctx: GameBundleContext;
  /** Tests pass a stub. Production passes nothing. */
  bind?: BindRoom;
}

export function EmbedApp({ ctx, bind = BIND }: EmbedAppProps) {
  const binding = useBoundRoom(ctx.roomKey, bind);
  const route = useRoute();
  const theme = useMemo(() => hostThemeValue(ctx.theme), [ctx.theme]);
  // Embedded, the tokens resolve on the shadow host (`:root` is rewritten as `:host`).
  const main = useRef<HTMLElement>(null);
  useUiScale(useCallback(() => (main.current === null ? null : scaleRootOf(main.current)), []));
  // Trim's attributes go on the chrome root itself: the stylesheet, inside the shadow root, cannot see the host's.
  useTrim(useCallback(() => main.current, []));
  useSoundPrefs();

  let body = null;
  if (binding.state === 'failed') {
    body = (
      <p className="ct-error cardtable-embed__error" role="alert" data-testid="embed-error">
        {binding.message}
      </p>
    );
  } else if (binding.state === 'bound') {
    body = NOT_A_TABLE.has(route.kind) ? <ToRoom roomId={binding.roomId} go={toRoom} /> : <Screen />;
  }

  return (
    <HadokuThemeProvider value={theme}>
      <main
        ref={main}
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

/*
 * The router, and nothing else.
 *
 * It is a switch over the hash — `screens/Screen.tsx`, which the
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
 *   `#/sounds`           `SoundBuilder` — friend tier and above; its editing is admin-only
 *   `#/sounds/sandbox`   `SoundSandbox` — friend tier and above; its gain saves are admin-only
 *   `#/sounds/music`     `MusicReview` — friend tier and above: compare the match music, submit picks
 *   `#/ui`               `TrimScreen` — admin only: the trim composer
 *   `#/stats`, `#/profile`, `#/stats/<name>`, `#/tournaments`  `StatsPage` — the leaderboard, a profile, past pods
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
import { RouteLink } from './screens/BackLink.tsx';
import { Screen, type ScreenProps } from './screens/Screen.tsx';
import { useRoute } from './screens/route.ts';
import { setScreenMusic } from './sound/index.ts';
import { AppChrome } from '@hadoku/ui-shell/chrome';
import { HeaderLinks } from './chrome/HeaderLinks.tsx';
import { RoomShell } from './room/RoomShell.tsx';
import { SessionPrompt, sessionBlocks, useRoomSession } from './room/SessionPrompt.tsx';
import { useWhoami } from './room/whoami.ts';
import { knownRoomOfMatch, roomOfMatch } from './play/live/matchStart.ts';
import { useJoined } from './rooms/joined.ts';
import { CARDTABLE_SETTINGS_TABS, HostDrawsSettingsProvider, useUiScale } from './settings/Settings.tsx';
import { useTrim } from './settings/siteTrim.ts';
import { useSoundPrefs } from '@hadoku/ui-shell/sound';
import { composeGame } from './composition.tsx';
composeGame();

export type AppProps = ScreenProps;

/**
 * The room a live match belongs to, resolved once per match id — the page's
 * one ask (`matchStart.ts`'s `roomOfMatch`), whose answer `MatchScreen.tsx`
 * takes for its own "back to the room" link; asked here first because the
 * chat has to know it BEFORE `MatchScreen` ever mounts.
 *
 * Returns `pending: true` until the FIRST fetch this hook instance has ever
 * made (for any match id) has answered, and `pending: false` forever after —
 * never flipped back, even while a LATER match's own fetch is still in
 * flight.
 *
 * **`roomId` is kept across matches rather than reset to `null` while a new
 * one resolves** (wave 71 §G): `RoomShell` tears down and rebuilds
 * watchparty's chrome whenever the room id it is given changes, so a board
 * switch that bounced through `null` on every click would rejoin the chat
 * twice for nothing — and a player who switches to another table and back
 * would watch their chat column vanish and reappear both times. The two
 * tables Carol moves between in `e2e/w71-boards.spec.ts` are one room, so
 * holding the last answer here makes that switch a no-op render instead.
 * `pending` follows the same rule for the same reason: once ANY match has
 * ever resolved, it stays `false`, so a later match id's own fetch being
 * still in flight never re-opens the "nothing known yet" window — it rides
 * on the HELD `roomId` above (correct, because the held room id came from a
 * DIFFERENT match in the SAME room) rather than falling back to its own key
 * for no reason.
 *
 * ## Why `pending` has to be tracked explicitly (wave 72 §R)
 *
 * This used to answer a bare `roomId: string | null`, and `roomIdFor` passed
 * that straight to `RoomShell` whether it meant "not answered yet" or
 * "answered: no room" — the SAME value either way. That let the board's
 * first frame or two draw with no chrome and widen the canvas, then narrow
 * once the real room answered — `.shell--match` measured at 1216px wide for
 * several frames, then 896px once the fetch landed (a scratch harness
 * confirmed it: see the wave file). The tempting one-line fix —
 * `roomIdFor`'s `match` case falling back to the route's own `matchId`
 * whenever `roomId` is falsy, so there is ALWAYS a truthy key from the first
 * render — fixes that, but breaks something `e2e/w71-boards.spec.ts` already
 * covers: a watcher's chat briefly joins the match's OWN key before the real
 * room answers, a SECOND, DIFFERENT room from the one every other board in
 * the room uses, if only for one frame. `App` (below) holds the board itself
 * back while `pending`, so the chrome's presence, AND which room it is in,
 * are decided together, before either is drawn — never flipped after the
 * fact, and never a guess that gets corrected. A single boolean DERIVED from
 * `roomId === null` cannot tell "not answered yet" apart from "answered: no
 * room" by itself — which is why this is its own piece of state, set
 * alongside `roomId` in the very same update, rather than computed from it.
 */
export function useMatchRoomId(matchId: string | null): { roomId: string | null; pending: boolean } {
  const [state, setState] = useState<{ roomId: string | null; everAnswered: boolean }>({ roomId: null, everAnswered: false });
  // A match entered from its room had its room asked before the route changed (`matchStart.ts`):
  // the board then draws in the route's first frame, with no empty one while this asks again.
  const known = matchId === null ? undefined : knownRoomOfMatch(matchId);
  useEffect(() => {
    if (matchId === null) return;
    if (known !== undefined) {
      setState({ roomId: known?.id ?? null, everAnswered: true });
      return;
    }
    let live = true;
    roomOfMatch(matchId).then(
      (room) => {
        if (live) setState({ roomId: room?.id ?? null, everAnswered: true });
      },
      () => {
        if (live) setState({ roomId: null, everAnswered: true });
      },
    );
    return () => {
      live = false;
    };
  }, [matchId, known]);
  if (matchId !== null && known !== undefined) return { roomId: known?.id ?? null, pending: false };
  return { roomId: state.roomId, pending: matchId !== null && !state.everAnswered };
}

/**
 * The room this route belongs in — its chat and its roster — or null for the
 * routes that are not a shared place: the lobby and the format picker.
 *
 * A room has ONE chat, from its lobby through its draft, deck and every game
 * at every table (the operator, 2026-11-11: *"lets persist the chat between
 * lobby and game. rooms should maintain their chat"*, reversing 2026-10-19's
 * separate table chat). Because the key never changes while the viewer stays
 * in the room, `RoomShell` keeps the one chrome, and the conversation, across
 * every screen in it. The legacy `draft` route maps to the same id the `room`
 * route does, so redirecting one to the other does not rebuild the chrome.
 *
 * A `match` route's room is `matchRoom`, `useMatchRoomId`'s settled answer,
 * and **falls back to the match's own id when that is `null`** (wave 72 §R):
 * a match no room holds (a scenario, a direct vs-AI game) keeps its own
 * `cardtable-m-<id>` chat. `App` (below) never calls this while that answer is
 * pending — it holds the board back until it settles, which keeps the
 * chrome's presence and key decided BEFORE the board's first paint.
 * `RoomShell.test.ts` pins the fallback.
 */
export function roomIdFor(route: ReturnType<typeof useRoute>, matchRoom: string | null): string | null {
  switch (route.kind) {
    case 'draft':
    case 'deck':
      return route.draftId;
    case 'match':
      return matchRoom ?? route.matchId;
    case 'room':
      return route.roomId;
    default:
      return null;
  }
}

/** Standalone, the stylesheet's tokens resolve on the document's root. */
const documentRoot = (): HTMLElement => document.documentElement;

export function App({ transport }: AppProps) {
  const route = useRoute();
  useUiScale(documentRoot);
  useTrim(documentRoot);
  useSoundPrefs();
  const { roomId: matchRoom, pending: matchPending } = useMatchRoomId(route.kind === 'match' ? route.matchId : null);
  // `pending` is only ever true for a `match` route (see the hook's own
  // comment); read here as a single flag because it gates TWO things below
  // together — the board itself, and the room id handed to `RoomShell` —
  // rather than letting each reach its own, possibly different, conclusion
  // about whether the room is known yet.

  // The lobby's music everywhere a player is, silence on the tools. A match
  // swaps in its own (`LiveBoard` → `setMatchMusic`).
  const silent = route.kind === 'sounds' || route.kind === 'sounds-sandbox' || route.kind === 'sounds-music' || route.kind === 'rally-embed';
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
      // A real `<a href="#/">` (`RouteLink`), not an onClick on a heading: an anchor is
      // keyboard-reachable, announces itself as a link, and middle-clicks.
      // `AppHeader`'s `title` takes a NODE for exactly this — its own docs call
      // it "a node for custom markup (e.g. a clickable title button)" — and the
      // <h1> stays INSIDE the link, which is the shape the fleet's audit
      // documents (`check-header-fleet.mjs`, `appHeaderTitle`: "an <h1> nested
      // in a <button>"). The name is still `__HADOKU_APP_NAME__`, so the audit's
      // `header-name` rule still reads it as derived rather than hard-coded.
      title={
        <RouteLink className="cardtable-chrome__home" to={{ kind: 'lobby' }} data-testid="chrome-home">
          <h1 className="cardtable-chrome__home-name">{__HADOKU_APP_NAME__}</h1>
        </RouteLink>
      }
      // NO name in `status`. The viewer's name used to render here, and that was a
      // deliberate break with the fleet's convention — identity lives in the
      // gear's popout and nowhere else. The justification was that the
      // operator had reported seeing `anon` where their name belongs, but the
      // fix for a WRONG name was to make the name right (the edge now injects
      // `X-User-Name`, wave 22), not to move it somewhere the fleet does not
      // put it. Operator, 2026-09-27: *"name 'Bella' should not show at the
      // top, that shows in the settings menu. why'd you break protocol with
      // this? this is not the standard header."* Do not reinstate it.
      //
      // The slot holds the Discord and GitHub links instead, until the header's `links`
      // slot ships — see `chrome/HeaderLinks.tsx`.
      status={<HeaderLinks />}
      // Identity the page already knows, so the popout does not re-resolve it.
      // `ConnectedSettings` otherwise calls its own `whoami()` against
      // `/session/whoami`, which is a second identity path to the same fact.
      settingsProps={viewer === null ? undefined : { userType: viewer.tier, name: viewer.name }}
      // The game's settings as the popout's own tabs, after the site's (the operator, 2026-10-30):
      // the one gear at the top of every screen, a match included. `settings/Settings.tsx`.
      appTabs={CARDTABLE_SETTINGS_TABS}
    />
  );

  // ONE chrome for the page. Their store and socket are module singletons, so
  // a second RoomChrome would share and then tear down the first's connection
  // — which is why this wraps the switch rather than living in a screen.
  //
  // `AppChrome` is the hadoku frame (theme root + the header's slot) and goes
  // OUTSIDE the room: the header belongs to the app, the room is one thing the
  // app renders. It mounts no room of its own.
  //
  // `matchPending` holds BOTH the room id (forced to `null` rather than
  // `roomIdFor`'s usual fallback — see `useMatchRoomId`'s comment) AND the
  // screen itself back until the room is known. Rendering `Screen` early
  // with no chrome decided yet is exactly the wave 71 §G regression this
  // wave fixes (wave 72 §R): the board would draw once at its un-chromed
  // width and again at its chromed one once `matchRoom` settles.
  const place = matchPending ? null : roomIdFor(route, matchRoom);
  // A `room` route's chat does not mount until THIS TAB has actually joined that room — the
  // operator, after a password room showed its chat beside the password form: *"this one exposed
  // a bug in the site, the chat shouldn't load if the room hasn't been joined yet."* `roomIdFor`
  // itself stays the pure, two-argument function `RoomShell.test.ts` already pins (it answers "what
  // room does this ROUTE name", not "is the viewer in it"); the gate lives here, where the route and
  // the membership mark are both in scope, so a `match` route (never gated — a board's own chat is
  // joined server-side the moment the match exists) and every other kind keep `roomIdFor`'s answer
  // untouched. `ConstructedScreen` is what marks `joined.ts`'s store, on a successful join OR a table
  // read that already proves membership; ANY room route — draft pod or table — is a `room` route
  // (`route.ts`), so gating here covers every one of them in the one place they all pass through.
  const joinedRoom = useJoined(route.kind === 'room' ? route.roomId : null);
  const gatedPlace = route.kind === 'room' && !joinedRoom ? null : place;
  // One live tab per player per room (`room/session.ts`): claimed as soon as the route names its room,
  // joined or not (a watcher's claim holds nothing). While it asks, or after another tab took the room,
  // the screen is not drawn — none of its sockets join — and the page behind the question is inert.
  const session = useRoomSession(route.kind === 'rally-embed' ? null : place, route.kind);
  const blocked = sessionBlocks(session.state);
  // A Rally pick option, in Rally's frame (cardtable#24): the theme root and the page, with no
  // header and no room. `rally/RallyEmbed.tsx` says why.
  if (route.kind === 'rally-embed') {
    return (
      <AppChrome header={null}>
        <Screen transport={transport} />
      </AppChrome>
    );
  }
  return (
    <AppChrome header={header}>
      {/* The operator, 2026-10-10: *"theres really no reason to close the chat
          in the lobby screen"*. A room's lobby keeps it open; the draft, deck
          and match screens still let a viewer hide it. */}
      <HostDrawsSettingsProvider value>
        <RoomShell roomId={gatedPlace} collapsible={route.kind !== 'room'} inert={blocked}>
          {matchPending || blocked ? null : <Screen transport={transport} />}
        </RoomShell>
      </HostDrawsSettingsProvider>
      <SessionPrompt state={session.state} take={session.take} />
    </AppChrome>
  );
}

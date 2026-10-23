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
import { DiscordLink } from './chrome/DiscordLink.tsx';
import { RoomShell } from './room/RoomShell.tsx';
import { useWhoami } from './room/whoami.ts';
import { roomsClient } from './rooms/api.ts';
import { useUiScale } from './settings/Settings.tsx';
import { useTrim } from './settings/siteTrim.ts';

export type AppProps = ScreenProps;

/**
 * A game's own chat: its room AND its table, so the lobby's conversation and
 * the game's are two rooms (the operator, 2026-10-19: *"can we make sure the
 * game-chat is separate from the lobby chat?"*), while the games of one series
 * — one table — keep one chat between them. A match no table names (it has
 * since been let go) is its own.
 */
export function tableChatId(room: { id: string; tables: readonly { id: string; matchId: string | null; series: { games: readonly { matchId: string }[] } }[] }, matchId: string): string {
  const table = room.tables.find((t) => t.matchId === matchId || t.series.games.some((g) => g.matchId === matchId));
  return `${room.id}-${table?.id ?? matchId}`;
}

/** Where a route's viewer is: the room they are a member of, and the chat they talk in. */
export interface RoomPlace {
  /** The room the viewer's identity (their avatar) is asserted to — a room id, or a match id the server resolves to its room. */
  roomId: string;
  /** The watchparty chat the chrome joins: the room's own, or a game's table chat (`tableChatId`). */
  chatId: string;
}

/**
 * The room a live match belongs to, resolved once per match id — the same
 * call `MatchScreen.tsx` already makes for its own "back to the room" link
 * (`roomOfMatch`), asked again here because the chat has to know it BEFORE
 * `MatchScreen` ever mounts.
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
function useMatchRoomId(matchId: string | null): { room: RoomPlace | null; pending: boolean } {
  const [state, setState] = useState<{ room: RoomPlace | null; everAnswered: boolean }>({ room: null, everAnswered: false });
  useEffect(() => {
    if (matchId === null) return;
    let live = true;
    roomsClient()
      .roomOfMatch(matchId)
      .then(
        (room) => {
          if (live) setState({ room: room === null ? null : { roomId: room.id, chatId: tableChatId(room, matchId) }, everAnswered: true });
        },
        () => {
          if (live) setState({ room: null, everAnswered: true });
        },
      );
    return () => {
      live = false;
    };
  }, [matchId]);
  return { room: state.room, pending: matchId !== null && !state.everAnswered };
}

/**
 * The room and chat this route belongs in, or null for the routes that are
 * not a shared place: the lobby and the format picker.
 *
 * A draft room and its deck screen share one watchparty room on purpose — it is
 * the same people either side of the draft finishing, and making them rejoin a
 * new room to build a deck would drop the conversation they were having about
 * it. The legacy `draft` route maps to the same id the `room` route does, so
 * redirecting one to the other does not tear down and rebuild the chrome.
 *
 * **A `match` route has two answers** (`RoomPlace`): its TABLE's chat
 * (`tableChatId`, above) — separate from the room's own lobby chat, the same
 * across the games of one series — and the ROOM itself, which is where the
 * viewer is a member and so where their avatar is asserted. The table chat id
 * names no room the server knows, so an avatar asserted to it is refused and a
 * pick made mid-match never reaches either board (Q6). `matchRoom` is the
 * answer this function returns for a `match` route, but **falls back to the
 * match's own id for both when `matchRoom` is `null`** (wave 72 §R) — a
 * SETTLED answer: the
 * fetch came back with no room for this match (a scenario, a direct vs-AI
 * game), which before wave 71 §G kept its own `cardtable-m-<id>` chat and
 * without this fallback had none. `App` (below) never calls this with
 * `'pending'` — it holds the board back until `useMatchRoomId` settles one
 * way or the other, which is what keeps the chrome's presence (and, for a
 * roomless match, which key it joins) decided BEFORE the board's first
 * paint rather than flipped after it. `RoomShell.test.ts` pins the fallback.
 */
export function roomIdFor(route: ReturnType<typeof useRoute>, matchRoom: RoomPlace | null): RoomPlace | null {
  const same = (id: string): RoomPlace => ({ roomId: id, chatId: id });
  switch (route.kind) {
    case 'draft':
    case 'deck':
      return same(route.draftId);
    case 'match':
      return matchRoom ?? same(route.matchId);
    case 'room':
      return same(route.roomId);
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
  const { room: matchRoom, pending: matchPending } = useMatchRoomId(route.kind === 'match' ? route.matchId : null);
  // `pending` is only ever true for a `match` route (see the hook's own
  // comment); read here as a single flag because it gates TWO things below
  // together — the board itself, and the room id handed to `RoomShell` —
  // rather than letting each reach its own, possibly different, conclusion
  // about whether the room is known yet.

  // The lobby's music everywhere a player is, silence on the tools. A match
  // swaps in its own (`LiveBoard` → `setMatchMusic`).
  const silent = route.kind === 'sounds' || route.kind === 'sounds-sandbox' || route.kind === 'sounds-music';
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
      // The slot holds the Discord link instead, until the header's `links`
      // slot ships — see `chrome/DiscordLink.tsx`.
      status={<DiscordLink />}
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
  //
  // `matchPending` holds BOTH the room id (forced to `null` rather than
  // `roomIdFor`'s usual fallback — see `useMatchRoomId`'s comment) AND the
  // screen itself back until the room is known. Rendering `Screen` early
  // with no chrome decided yet is exactly the wave 71 §G regression this
  // wave fixes (wave 72 §R): the board would draw once at its un-chromed
  // width and again at its chromed one once `matchRoom` settles.
  const place = matchPending ? null : roomIdFor(route, matchRoom);
  return (
    <AppChrome header={header}>
      {/* The operator, 2026-10-10: *"theres really no reason to close the chat
          in the lobby screen"*. A room's lobby keeps it open; the draft, deck
          and match screens still let a viewer hide it. */}
      <RoomShell roomId={place?.roomId ?? null} chatId={place?.chatId ?? null} collapsible={route.kind !== 'room'}>
        {matchPending ? null : <Screen transport={transport} />}
      </RoomShell>
    </AppChrome>
  );
}

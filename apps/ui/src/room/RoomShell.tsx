/*
 * Watchparty's room around our table.
 *
 * The operator asked for this three times — *"we gotta connect this to my room
 * and network system"* — and it was blocked, not ignored: until
 * `@wolffm/watchparty-ui@0.39.0` the package exported only a whole-app
 * `mount()` that brought its own React root, its own router, 6.76 MB of bundle
 * and 34 inlined PNGs, and had no slot to put a table in (D17). `RoomChrome`
 * is the export we asked them for, and it lands at **152 KB with zero inlined
 * images**, importing nothing from their chunk graph.
 *
 * ## One chrome per page
 *
 * Their store and socket are module singletons, so a second `RoomChrome` on
 * the same page would share — and then tear down — the first one's connection.
 * That is why this mounts once, in `App`, and never per screen.
 *
 * ## The room is ours; only the art is theirs
 *
 * `roomOrigin` points the chrome's whole room socket — join, roster, identity,
 * chat — at `cardtableOrigin()`: this app's own `/room` namespace
 * (`apps/server/src/room/serve.ts`), behind cardtable's member gate, with the
 * roster read from the same presence tracker our seats use. Watchparty never
 * hears of a cardtable room, so it neither counts one nor holds a deploy for
 * it. `serverOrigin` is still watchparty's, for the characters' names and art.
 * Name, picture and character are the account's, resolved by our server.
 *
 * ## Identity comes from the fleet, not from us
 *
 * This used to call cardtable's own `/api/whoami`, which returns `{ userId,
 * tier }` and no display name — so the app rendered `anon`, which is literally
 * `ANON_USER_ID` from `@wolffm/prefs-client`, beside a chat column that knew
 * the operator's real name. That is the same gap that left this app with no
 * theme picker: it was hydrated from `tunnel-loopback-ui`, which scaffolds no
 * UI, and the hydrator's chrome warning only fires for proxy apps
 * (`docs/requests/HADOKU_SITE_GAME_TEMPLATE.md`).
 *
 * `whoami()` from `@wolffm/prefs-client` is the fleet's own, returns `name`,
 * and shares one in-flight promise per page (`globalThis.__hadokuWhoami`) so
 * several apps on a page do not each re-fetch it.
 *
 * We still do NOT invent an identity: if it fails the chrome is not mounted
 * and the table renders alone, because a room that cannot say who you are is
 * worse than no room.
 */

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { RoomChrome } from '@wolffm/watchparty-ui/room-chrome';
import '@wolffm/watchparty-ui/room-chrome.css';
import { useHadokuTheme, type Theme } from '@wolffm/themes';
import { ROOM_ID_RE } from '@hadoku/platform-wire/room-feed';
import { appId } from '@hadoku/ui-shell/app-id';
import { useRoomFrame } from '@hadoku/ui-shell/chrome/shell';

// The watchparty seam's two data answers — which origin serves their sprites,
// and which character this viewer picked — live in one module with the bundle
// evidence beside them. `watchpartyOrigin` used to be a private function here;
// it moved because `avatarSquareUrl` needs the same string and two derivations
// of one origin is how the chrome and the faces come to disagree about it.
import { watchpartyOrigin } from './avatar.ts';
import { useWhoami } from './whoami.ts';

/**
 * The page's resolved theme, handed to the chrome as-is.
 *
 * ## Why the two disagreed, diagnosed rather than assumed (w20 §E)
 *
 * `RoomChrome` takes an optional `theme` prop. Left unset — which is what this
 * file did until w20 — it resolves its OWN default from ITS OWN internal
 * store, entirely independent of `HadokuThemeRoot` (quoted in full below).
 * Measured live (a stub-`whoami` build served
 * locally, `#/match/…`, no saved theme in either storage): the page resolved
 * `data-theme="light"` on `.cardtable-chrome` while `.wp-room-chrome` sat at
 * `data-theme="dark"` — two independent defaults, not a shared one that drifted.
 * Passing our theme through removes the second default entirely; they cannot
 * disagree once there is only one source.
 *
 * ## Why this casts instead of validating (w22 §G, found by hadoku_site)
 *
 * This used to filter through `THEMES` and answer `undefined` for a name it did
 * not recognise. `undefined` is not a neutral value here — it is precisely what
 * sends the chrome back to that second default, so the filter reintroduced the
 * split-theme bug in the one case it was written to protect against.
 *
 * That case is unreachable today: one `@wolffm/themes` install (5.8.6), and
 * `room-chrome.d.ts:3` imports `Theme` from it, so there is a single union. But
 * watchparty-ui takes themes as a regular **dependency** (`^5.8.5`), not a peer,
 * so a host outside that range resolves a second nested copy and two distinct
 * unions exist. There, passing an unrecognised name through is strictly better
 * than dropping it, and the shipped code is why — read out of the installed
 * bundle, its fallback is:
 *
 *     function Do(e) { if (e) return e; const t = ze().theme;
 *                      return t && tn.includes(t) ? t : "dark"; }
 *
 * The prop is honoured VERBATIM, unvalidated, and lands on `data-theme` of the
 * chrome's own `aside.wp-room-chrome` — never on the host document. Only a
 * FALSY prop makes the chrome consult its own store and then hard-code `dark`.
 * So an unknown name resolves against whichever `[data-theme=…]` palettes are
 * loaded and otherwise falls to a neutral light base; `undefined` resolves to
 * an actively wrong `dark`. `undefined` is the only value that cannot be
 * ignored.
 *
 * Corrected against the installed bundle rather than taken on trust: the §G brief said
 * `room-chrome.css` "styles only its own light/dark internals". It does not —
 * it ships all 18 `[data-theme=…]` blocks under `@scope (.wp-room-chrome)`,
 * with `:scope,:scope[data-theme=light]` as the fallback rule, the same 18 the
 * host's `@wolffm/themes/src/style.css` carries unscoped. That changes the
 * reason, not the fix: what makes the pass-through work is `if (e) return e`,
 * not a gap in the chrome's own palettes.
 *
 * ## The trap, for whoever edits this next
 *
 * The cast is load-bearing twice, and only one half announces itself.
 * `theme={theme}` fails typecheck — TS2322, because `useHadokuTheme()` types
 * `theme` as `string` (the picker's families are data-driven) — which is what
 * sends people looking for a validator in the first place. But
 * `theme={filtered ?? undefined}` compiles cleanly and IS the defect. Only the
 * type error is loud; the wrong fix is silent. The `Theme` return type below,
 * with no `| undefined`, is what makes the silent half loud too: a re-added
 * `?? undefined` stops compiling here instead of shipping a chrome that resolves
 * its own theme.
 */
export function watchpartyTheme(theme: string): Theme {
  // Total by construction — every name reaches the chrome, including one this
  // install's union does not know. Never narrow this to `Theme | undefined`.
  return theme as Theme;
}

/**
 * A room key for one of our pods or matches, or null when the id is not a
 * shape watchparty will accept.
 *
 * Null means "render the table with no room" — never a guessed or coerced key,
 * because two ids that collapse to the same key would put two unrelated groups
 * in one room, and they would each see the other's chat.
 */
export function roomKeyFor(id: string): string | null {
  return ROOM_ID_RE.test(id) ? `${appId()}-${id}` : null;
}

/**
 * This app's own origin, on whatever host serves this page — never
 * hardcoded, so PPE (built with `CARDTABLE_BASE_PREFIX=/cardtable-ppe`) gets
 * PPE's own origin rather than prod's. The same derivation
 * `room/socket-options.ts`'s `defaultSocketPath` uses for the draft socket's
 * path, here producing an ORIGIN string: `RoomChrome` derives its socket
 * path, `/cardtable[-ppe]/socket.io/`, from its pathname, so passing the
 * bare base is enough — no `roomSocketPath` override needed.
 */
export function cardtableOrigin(): string {
  const base = import.meta.env?.BASE_URL;
  const prefix = typeof base === 'string' && base !== '' ? base : '/';
  return `${globalThis.location.origin}${prefix}`.replace(/\/$/, '');
}

/**
 * Wraps `children` in watchparty's room when there is a room to be in.
 *
 * Renders the children alone when there is no room id or when whoami failed. A
 * table without chat is a degraded room; a table that will not draw because
 * chat is down is an outage.
 *
 * The children mount ONCE, whatever the chrome does around them. Remounted, they
 * lose everything they hold and open their sockets again: a match opened from a
 * link joined on two sockets and hung up the first, and when the hang-up beat the
 * second join the server saw the seat leave (`e2e/w69-name-card.spec.ts`, "nobody
 * disconnected"); a joiner's room screen, drawn before its join and wrapped once
 * the join let the chat in (`App.tsx`'s `useJoined`), dropped an open Room
 * settings and connected its draft socket twice (`e2e/w83b-draft-rope.spec.ts`).
 * So they are rendered through a portal from one place in this component's tree,
 * into a node that moves into the chrome when it draws and out when it goes. That
 * node and the slot holding it are both `.chrome-slot` (`display: contents`), and
 * the chrome's rules for its content's own child reach through exactly those two
 * (`@hadoku/ui-shell`'s `chrome.css`). While whoami is in flight on a room's route, before they have
 * first mounted, they wait for it: their first frame is already inside.
 */
export function RoomShell({
  roomId,
  collapsible = true,
  inert = false,
  children,
}: {
  /** The room this viewer is in: the chat and roster the chrome joins, and where their avatar is asserted. */
  roomId: string | null;
  /** `false` keeps the chat open with no Hide chat button — the room's lobby,
   *  where the chat is the point. A viewer's saved collapse is ignored there,
   *  not cleared, so the match still opens the way they left it. */
  collapsible?: boolean;
  /** Behind a question the page must answer first (`./SessionPrompt.tsx`): the chat cannot be reached. */
  inert?: boolean;
  children: ReactNode;
}) {
  const who = useWhoami();
  // Always inside `AppChrome`'s `HadokuThemeRoot` — see chrome/AppChrome.tsx,
  // which mounts this component. `useHadokuTheme()` throws with no provider
  // on purpose (a silent fallback is the bug this removes), so a caller that
  // ever renders `RoomShell` outside the theme root takes that throw here.
  const { theme } = useHadokuTheme();
  const key = roomId === null ? null : roomKeyFor(roomId);
  const roomFrameRef = useRoomFrame();
  const [host] = useState(createHost);
  const mounted = useRef(false);
  const waiting = key !== null && who === 'pending';
  if (!waiting) mounted.current = true;
  // One keyed element in every branch below, so React keeps the children; last, so the slot has
  // taken the host in before their layout effects run.
  const content = mounted.current ? createPortal(children, host, 'content') : null;

  if (waiting) return <>{content}</>;
  if (key === null || who === null || who === 'pending')
    return (
      <>
        <Slot key="bare" host={host} />
        {content}
      </>
    );

  return (
    /*
     * Wave 89 §B: `data-collapsible` is this element's own, not a prop
     * `RoomChrome` takes — `RoomChromeProps` (the installed `room-chrome.d.ts`)
     * has nothing for a host to read or set the chat column's open state from
     * outside. `live.css`'s portrait rules key the chat-sheet behaviour off
     * this attribute rather than off `collapsible` turning the chrome's own
     * "Hide chat" button on or off, because `collapsible` is a prop value, not
     * a selector a stylesheet in another file can see — and only present at
     * all when `collapsible` is true, i.e. a match route (`App.tsx`'s
     * `route.kind !== 'room'`), never the room lobby (Settled 10: "the room
     * lobby is unchanged").
     */
    <>
      <div key="chrome" className="room-shell" data-testid="room-shell" data-collapsible={collapsible ? '' : undefined} inert={inert || undefined}>
        <RoomChrome
          roomKey={key}
          serverOrigin={watchpartyOrigin()}
          roomOrigin={cardtableOrigin()}
          userType={who.tier}
          userId={who.userId}
          theme={watchpartyTheme(theme)}
          collapsible={collapsible}
        >
          <Slot host={host} />
          {/* The frame says it is drawn, to the page around it (`chrome/shell.ts`): RoomChrome takes no ref of ours. */}
          <span hidden ref={roomFrameRef} />
        </RoomChrome>
      </div>
      {content}
    </>
  );
}

/** The node {@link RoomShell}'s children are drawn into: it takes no box of its own, so they lay out as its parent's. */
function createHost(): HTMLDivElement {
  const host = document.createElement('div');
  host.className = 'chrome-slot';
  return host;
}

/** Where the children stand now: the host is moved in when this mounts. */
function Slot({ host }: { host: HTMLDivElement }) {
  const place = useCallback(
    (slot: HTMLDivElement | null) => {
      slot?.appendChild(host);
    },
    [host],
  );
  return <div ref={place} className="chrome-slot" />;
}

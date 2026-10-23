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
 * ## Their server, not ours
 *
 * `serverOrigin` points at watchparty. The chrome's socket is watchparty's;
 * our draft and match sockets stay ours and are untouched. Two connections on
 * purpose: the room is their product, the table is ours.
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

import type { ReactNode } from 'react';
import { RoomChrome } from '@wolffm/watchparty-ui/room-chrome';
import '@wolffm/watchparty-ui/room-chrome.css';
import { useHadokuTheme, type Theme } from '@wolffm/themes';
import { ROOM_ID_RE } from '@hadoku/shared';

// The watchparty seam's two data answers — which origin serves their sprites,
// and which character this viewer picked — live in one module with the bundle
// evidence beside them. `watchpartyOrigin` used to be a private function here;
// it moved because `avatarSquareUrl` needs the same string and two derivations
// of one origin is how the chrome and the faces come to disagree about it.
import { watchpartyOrigin } from './avatar.ts';
import { useAvatarAssert } from './avatarAssert.ts';
import { useWhoami } from './whoami.ts';
import { roomsClient } from '../rooms/api.ts';
import { useRoomFrame } from '../chrome/shell.ts';

/**
 * The page's resolved theme, handed to the chrome as-is.
 *
 * ## Why the two disagreed, diagnosed rather than assumed (w20 §E)
 *
 * `RoomChrome` takes an optional `theme` prop (shipped in
 * `@wolffm/watchparty-ui@0.39.4`; verified in the installed 0.39.5 at
 * `node_modules/.../dist/room-chrome.d.ts:37`). Left unset — which is what this
 * file did until w20 — it resolves its OWN default from ITS OWN internal store,
 * entirely independent of `HadokuThemeRoot` (`Do()` in `dist/room-chrome.js`,
 * quoted in full below). Measured live (a stub-`whoami` build served
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
 * than dropping it, and the shipped code is why — `Do()` in
 * `dist/room-chrome.js` (0.39.5, read out of the installed bundle) is:
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
 * Corrected against 0.39.5 rather than taken on trust: the §G brief said
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
  return ROOM_ID_RE.test(id) ? `cardtable-${id}` : null;
}

/** One client per mount; the assert effect must not re-fire on every render. */
const rooms = roomsClient();

/**
 * Wraps `children` in watchparty's room when there is a room to be in.
 *
 * Renders the children alone when there is no room id or when whoami failed. A
 * table without chat is a degraded room; a table that will not draw because
 * chat is down is an outage.
 *
 * While whoami is in flight on a room's route it renders NOTHING, so the
 * children mount once, already inside the chrome. Drawn alone first, they were
 * unmounted and mounted again when the chrome wrapped them: a match opened from
 * a link joined on two sockets and hung up the first, and when the hang-up beat
 * the second join the server saw the seat leave (`e2e/w69-name-card.spec.ts`,
 * "nobody disconnected").
 */
export function RoomShell({
  roomId,
  chatId = roomId,
  collapsible = true,
  children,
}: {
  /** The room this viewer is a member of; their avatar is asserted to it. */
  roomId: string | null;
  /** The chat the chrome joins — a game's table chat, or (by default) the room's own. */
  chatId?: string | null;
  /** `false` keeps the chat open with no Hide chat button — the room's lobby,
   *  where the chat is the point. A viewer's saved collapse is ignored there,
   *  not cleared, so the match still opens the way they left it. */
  collapsible?: boolean;
  children: ReactNode;
}) {
  const who = useWhoami();
  // Always inside `AppChrome`'s `HadokuThemeRoot` — see chrome/AppChrome.tsx,
  // which mounts this component. `useHadokuTheme()` throws with no provider
  // on purpose (a silent fallback is the bug this removes), so a caller that
  // ever renders `RoomShell` outside the theme root takes that throw here.
  const { theme } = useHadokuTheme();
  const key = chatId === null ? null : roomKeyFor(chatId);
  // Before the early returns, because hooks cannot be called conditionally. It
  // no-ops on its own until whoami has answered. The ROOM, not the chat: a
  // game's table chat names no room the server knows, and an avatar asserted
  // to it is refused.
  useAvatarAssert(key === null ? null : roomId, who === 'pending' || who === null ? null : who.userId, rooms);
  const roomFrameRef = useRoomFrame();

  if (key !== null && who === 'pending') return null;
  if (key === null || who === 'pending' || who === null) return <>{children}</>;

  return (
    <RoomChrome
      roomKey={key}
      serverOrigin={watchpartyOrigin()}
      userType={who.tier}
      userId={who.userId}
      theme={watchpartyTheme(theme)}
      collapsible={collapsible}
    >
      {children}
      {/* The frame says it is drawn, to the page around it (`chrome/shell.ts`): RoomChrome takes no ref of ours. */}
      <span hidden ref={roomFrameRef} />
    </RoomChrome>
  );
}

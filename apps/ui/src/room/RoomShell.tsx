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

import { useEffect, useState, type ReactNode } from 'react';
import { RoomChrome } from '@wolffm/watchparty-ui/room-chrome';
import '@wolffm/watchparty-ui/room-chrome.css';
import { whoami as hadokuWhoami } from '@wolffm/prefs-client';
import { useHadokuTheme, type Theme } from '@wolffm/themes';

// The watchparty seam's two data answers — which origin serves their sprites,
// and which character this viewer picked — live in one module with the bundle
// evidence beside them. `watchpartyOrigin` used to be a private function here;
// it moved because `avatarSquareUrl` needs the same string and two derivations
// of one origin is how the chrome and the faces come to disagree about it.
import { accountAvatarId, watchpartyOrigin } from './avatar.ts';
import { roomsClient, type RoomIdentityClient } from '../rooms/api.ts';

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

/** Their contract: `cardtable-<[a-z0-9-]{1,40}>` needs no provisioning. */
const ROOM_ID = /^[a-z0-9-]{1,40}$/;

export interface Who {
  userId: string;
  tier: 'admin' | 'wife' | 'service' | 'friend' | 'public';
  /** The viewer's display name. Null when the fleet has none for them. */
  name: string | null;
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
  return ROOM_ID.test(id) ? `cardtable-${id}` : null;
}

export function useWhoami(): Who | null | 'pending' {
  const [who, setWho] = useState<Who | null | 'pending'>('pending');
  useEffect(() => {
    let live = true;
    // Same-origin on purpose. `whoami()` defaults to the edge-router origin,
    // which in production IS this page's origin — but hard-coding it makes the
    // app reach `https://hadoku.me` from wherever it happens to be served,
    // which the e2e correctly flags as an off-host request and which would be
    // wrong for any future preview host. Same-origin gives the identical
    // answer in production and stays local everywhere else.
    hadokuWhoami({ whoamiUrl: `${globalThis.location.origin}/session/whoami` })
      .then((r) => {
        if (!live) return;
        setWho({ userId: r.userId, tier: r.userType, name: r.name ?? null });
      })
      .catch(() => {
        if (live) setWho(null);
      });
    return () => {
      live = false;
    };
  }, []);
  return who;
}

/**
 * Wraps `children` in watchparty's room when there is a room to be in.
 *
 * Renders the children alone — never a blank page — when there is no room id,
 * while whoami is in flight, or when whoami failed. A table without chat is a
 * degraded room; a table that will not draw because chat is down is an outage.
 */
/**
 * Tell our own room which avatar this viewer is wearing, once per room.
 *
 * This is the hop the operator's *"why not?"* was about. The id is watchparty's,
 * read from their prefs cache (`avatar.ts` says why there is no accessor to ask);
 * the row it lands on is decided by the server from the edge's headers, so this
 * can only ever set the caller's own.
 *
 * **A refusal is ignored, deliberately.** `roomId` here is whatever the route
 * carries, which for `#/match/<id>` is a MATCH id. The server resolves that to
 * the lobby room that started the match (`roomOfMatch`); it used to answer 404
 * for both players at every match start (wave 31 P3b). A viewer with no avatar sends nothing at all; the server's "clear it"
 * case exists for a viewer who HAD one and dropped it, which only the chrome can
 * tell us about, and it cannot yet.
 */
function useAvatarAssert(roomId: string | null, userId: string | null, client: RoomIdentityClient): void {
  useEffect(() => {
    if (roomId === null || userId === null) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (avatarId: string, n: number): void => {
      // A refusal is the server saying this viewer is not in that room YET: a
      // joiner's first screen asserts before the room screen has joined them,
      // and an avatar that never lands is a seat with no face when the match
      // starts. Try again a few times, then give up; it is a cosmetic.
      const retry = (): void => {
        const delay = AVATAR_RETRY_MS[n];
        if (live && delay !== undefined) timer = setTimeout(() => attempt(avatarId, n + 1), delay);
      };
      // `setAvatar` resolves an outcome rather than rejecting on a refusal.
      client.setAvatar(roomId, avatarId).then((outcome) => {
        if (!outcome.ok) retry();
      }, retry);
    };
    void accountAvatarId(userId).then((avatarId) => {
      if (live && avatarId !== null) attempt(avatarId, 0);
    });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [roomId, userId, client]);
}

/** Waits between re-asserts after a refusal: the joiner's first screen can beat their own join. */
const AVATAR_RETRY_MS = [1500, 3000, 6000, 12000] as const;

/** One client per mount; the assert effect must not re-fire on every render. */
const rooms = roomsClient();

export function RoomShell({ roomId, children }: { roomId: string | null; children: ReactNode }) {
  const who = useWhoami();
  // Always inside `AppChrome`'s `HadokuThemeRoot` — see chrome/AppChrome.tsx,
  // which mounts this component. `useHadokuTheme()` throws with no provider
  // on purpose (a silent fallback is the bug this removes), so a caller that
  // ever renders `RoomShell` outside the theme root takes that throw here.
  const { theme } = useHadokuTheme();
  const key = roomId === null ? null : roomKeyFor(roomId);
  // Before the early returns, because hooks cannot be called conditionally. It
  // no-ops on its own until whoami has answered.
  useAvatarAssert(key === null ? null : roomId, who === 'pending' || who === null ? null : who.userId, rooms);

  if (key === null || who === 'pending' || who === null) return <>{children}</>;

  return (
    <RoomChrome
      roomKey={key}
      serverOrigin={watchpartyOrigin()}
      userType={who.tier}
      userId={who.userId}
      theme={watchpartyTheme(theme)}
    >
      {children}
    </RoomChrome>
  );
}

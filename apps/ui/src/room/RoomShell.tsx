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
import { THEMES, useHadokuTheme, type Theme } from '@wolffm/themes';

/**
 * The two themes disagreeing, diagnosed rather than assumed (w20 §E).
 *
 * `RoomChrome` takes an optional `theme` prop (shipped in
 * `@wolffm/watchparty-ui@0.39.4`, verified against
 * `node_modules/.../dist/room-chrome.d.ts`). Left unset — which is what this
 * file did until now — it resolves its OWN default from ITS OWN internal
 * store, entirely independent of `HadokuThemeRoot`: `Do()` in
 * `dist/room-chrome.js` returns the store's cached theme if one has loaded,
 * else hard-codes `'dark'`. Measured live (a stub-`whoami` build served
 * locally, `#/match/…`, no saved theme in either storage): the page resolved
 * `data-theme="light"` on `.cardtable-chrome` while `.wp-room-chrome` sat at
 * `data-theme="dark"` — two independent defaults, not a shared one that drifted.
 * Passing our resolved theme through removes the second default entirely;
 * they cannot disagree once there is only one source.
 */
function asWatchpartyTheme(theme: string): Theme | undefined {
  return (THEMES as readonly string[]).includes(theme) ? (theme as Theme) : undefined;
}

/**
 * Watchparty's server, on whatever origin serves this page. In production that
 * is `https://hadoku.me/watchparty` — both apps sit behind the same edge — and
 * their chrome talks to their server. It is derived rather than hardcoded so a
 * page served from anywhere else never reaches production: the draft e2e runs
 * against a local server, and the hardcoded origin sent its browsers to
 * hadoku.me for sprites, whoami and client-log (8d71303, caught by that spec's
 * off-host guard).
 */
function watchpartyOrigin(): string {
  return `${window.location.origin}/watchparty`;
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
export function RoomShell({ roomId, children }: { roomId: string | null; children: ReactNode }) {
  const who = useWhoami();
  // Always inside `AppChrome`'s `HadokuThemeRoot` — see chrome/AppChrome.tsx,
  // which mounts this component. `useHadokuTheme()` throws with no provider
  // on purpose (a silent fallback is the bug this removes), so a caller that
  // ever renders `RoomShell` outside the theme root takes that throw here.
  const { theme } = useHadokuTheme();
  const key = roomId === null ? null : roomKeyFor(roomId);

  if (key === null || who === 'pending' || who === null) return <>{children}</>;

  return (
    <RoomChrome
      roomKey={key}
      serverOrigin={watchpartyOrigin()}
      userType={who.tier}
      userId={who.userId}
      theme={asWatchpartyTheme(theme)}
    >
      {children}
    </RoomChrome>
  );
}

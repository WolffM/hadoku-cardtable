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
 * ## Identity
 *
 * From `/api/whoami`, which the edge stamps and the server hands straight
 * through. We do NOT invent an identity: if whoami fails the chrome is not
 * mounted and the table renders alone, because a room that cannot say who you
 * are is worse than no room.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { RoomChrome } from '@wolffm/watchparty-ui/room-chrome';
import '@wolffm/watchparty-ui/room-chrome.css';

import { apiBase } from '../screens/tables.ts';

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
    const base = import.meta.env?.BASE_URL;
    fetch(`${apiBase(typeof base === 'string' ? base : '/')}whoami`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: unknown) => {
        if (!live) return;
        const b = body as Partial<Who> | null;
        setWho(b !== null && typeof b.userId === 'string' && typeof b.tier === 'string' ? (b as Who) : null);
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
  const key = roomId === null ? null : roomKeyFor(roomId);

  if (key === null || who === 'pending' || who === null) return <>{children}</>;

  return (
    <RoomChrome roomKey={key} serverOrigin={watchpartyOrigin()} userType={who.tier} userId={who.userId}>
      {children}
    </RoomChrome>
  );
}

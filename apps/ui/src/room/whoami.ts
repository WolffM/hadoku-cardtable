/*
 * Who this viewer is, from the fleet.
 *
 * `whoami()` from `@wolffm/prefs-client` is the fleet's own, returns `name`,
 * and shares one in-flight promise per page (`globalThis.__hadokuWhoami`) so
 * several apps on a page do not each re-fetch it. Read the same way by the
 * standalone app (`RoomShell`) and by the watchparty embed (`EmbedApp`): the
 * edge path, never the host's `ctx.identity` (D21's identity rule).
 *
 * Nothing here invents an identity: a failed answer is `null`, and the caller
 * decides what a table with nobody known at it looks like.
 */

import { useEffect, useState } from 'react';
import { whoami as hadokuWhoami } from '@wolffm/prefs-client';

export interface Who {
  userId: string;
  tier: 'admin' | 'wife' | 'service' | 'friend' | 'public';
  /** The viewer's display name. Null when the fleet has none for them. */
  name: string | null;
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

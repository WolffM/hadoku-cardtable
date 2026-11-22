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

import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from 'react';
import { whoami as hadokuWhoami } from '@wolffm/prefs-client';

// The kernel's own ladder, by a relative path: one tier order for the server's gates and this one.
// `auth/index.ts` imports only types at runtime, so nothing of the server reaches the page.
import { rankOf } from '../../../service-kernel/src/auth/index.ts';
import { registered } from '../registered.ts';

export interface Who {
  userId: string;
  /** The fleet's own tier list, so a tier it adds (`member`) is not a type error here. As the game treats it ({@link registerWhoamiTier}). */
  tier: WhoamiAnswer['userType'];
  /**
   * The tier exactly as the fleet named it: `member` stays `member`. A gate that means the fleet's
   * own tier (a friends-only room, {@link atLeastFriend}) reads this, never `tier`. So does the fleet's
   * account panel: it labels the hadoku account, and only a guest or member may delete their own.
   */
  edgeTier: WhoamiAnswer['userType'];
  /** The viewer's display name. Null when the fleet has none for them. */
  name: string | null;
}

type WhoamiAnswer = Awaited<ReturnType<typeof hadokuWhoami>>;

/** The viewer, `null` when the fleet could not say, `'pending'` while it is asked. */
export type WhoState = Who | null | 'pending';

/**
 * How a game reads the fleet's tier for the viewer. Default: as the fleet answered it. Cardtable's
 * composition root registers {@link tierOfWhoami}.
 */
const whoamiTier = registered<(r: Pick<WhoamiAnswer, 'userType'>) => Who['tier']>('whoami tier', () => (r) => r.userType);
export const registerWhoamiTier = whoamiTier.set;

/**
 * The viewer's tier as cardtable treats it: a member (a guest the operator has verified) IS a friend
 * here (the operator, 2026-11-05: *"for cardtable they will be equivalent"*); a guest is never
 * promoted. Read from the tier alone, never the fleet's `verified` flag. The server's `tierOf` makes
 * the same call for every gate. The fleet's account panel is handed `Who.edgeTier` instead.
 */
export function tierOfWhoami(r: Pick<WhoamiAnswer, 'userType'>): Who['tier'] {
  return r.userType === 'member' ? 'friend' : r.userType;
}

/** Whether the fleet names this viewer friend or above — the server's own friends-only floor (`packages/game-server/src/room/tier-floor.ts`). */
export function atLeastFriend(who: WhoState): boolean {
  return who !== null && who !== 'pending' && rankOf(who.edgeTier) >= rankOf('friend');
}

/** The page's one resolution, when an app shell above has made it (`../app/GameAppShell.tsx`). */
const WhoContext = createContext<WhoState | undefined>(undefined);

/** Hands `who` to every `useWhoami` below, which then asks nothing of its own. */
export function WhoProvider({ who, children }: { who: WhoState; children: ReactNode }) {
  return createElement(WhoContext.Provider, { value: who }, children);
}

/** The viewer: the app shell's answer when there is one above, else this hook's own. */
export function useWhoami(): WhoState {
  const given = useContext(WhoContext);
  const own = useResolvedWhoami(given === undefined);
  return given ?? own;
}

/** Asks the fleet once, while `enabled`. */
export function useResolvedWhoami(enabled = true): WhoState {
  const [who, setWho] = useState<WhoState>('pending');
  useEffect(() => {
    if (!enabled) return;
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
        setWho({ userId: r.userId, tier: whoamiTier.get()(r), edgeTier: r.userType, name: r.name ?? null });
      })
      .catch(() => {
        if (live) setWho(null);
      });
    return () => {
      live = false;
    };
  }, [enabled]);
  return who;
}

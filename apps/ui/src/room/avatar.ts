/*
 * The viewer's watchparty avatar: where the id comes from, and what draws it.
 *
 * The operator: *"i noticed you're still not pulling in the watchparty selected
 * avatars. why not?"* Because the last hop was never wired. `avatarId` is on
 * `@wolffm/rooms-protocol`'s `RosterIdentity` and `LocalIdentity`, and
 * `packages/room-store`'s `SerializedMember` has persisted it through our own
 * room snapshot since it was written — but nothing in `apps/server/src` or
 * `apps/ui/src` had ever read it, so it reached our room store and was dropped
 * before it reached a seat.
 *
 * This file is the client half: it answers "which character did this viewer
 * pick" and "what URL draws it", and it is the ONLY place either answer is
 * spelled. `room/RoomShell.tsx` asserts the id to our own room API; the server
 * carries it to the table view (`apps/server/src/http/routes.ts`).
 *
 * ## Where the viewer's own id comes from (wave 92, D)
 *
 * This used to read watchparty's write-through `localStorage` cache row as a
 * fallback when the account could not be reached — a derivation quoted out of
 * their shipped, minified bundle, with no typed accessor on either side
 * (`docs/requests/WATCHPARTY_AVATAR_ACCESSOR.md` is the standing ask). That
 * fallback is gone: `accountAvatarId` reads the one place avatars are resolved
 * by userId everywhere else in this app (`@wolffm/prefs-client/avatar`, the
 * same `resolveAvatars` our own server uses, `apps/server/src/people.ts`), and
 * answers null rather than guess from a cache row that may be stale, shared
 * anonymously, or simply absent on a browser that has never opened watchparty's
 * chrome. A viewer whose account has nothing picked wears whatever the room
 * handed them on joining (`room/lobby.ts`'s `AVATAR_POOL`), exactly as before.
 */

import { createAvatarClient } from '@wolffm/prefs-client/avatar';
import { AVATAR_ID_MAX } from '@hadoku/shared';

/**
 * Watchparty's server, on whatever origin serves this page. In production that
 * is `https://hadoku.me/watchparty` — both apps sit behind the same edge — and
 * their chrome talks to their server. It is derived rather than hardcoded so a
 * page served from anywhere else never reaches production: the draft e2e runs
 * against a local server, and the hardcoded origin sent its browsers to
 * hadoku.me for sprites, whoami and client-log (8d71303, caught by that spec's
 * off-host guard).
 */
export function watchpartyOrigin(): string {
  return `${globalThis.location.origin}/watchparty`;
}

/**
 * The image that draws one avatar, or null when there is nothing to draw.
 *
 * `square_<id>.png` under the chrome's own `serverOrigin` is watchparty's own
 * media convention, not ours: every id in `room/lobby.ts`'s `AVATAR_POOL` has
 * one (checked 2026-11-01), and `@wolffm/prefs-client/avatar`'s `ResolvedAvatar`
 * carries no URL for a `sprite` source by design — "the app that owns the art
 * … owns its URL and revision" (its own `.d.ts`). So this stays the one place
 * that builds the path, same-origin by construction (no host written down,
 * so a local e2e stays local).
 *
 * Null for an absent, blank or over-long id rather than a URL ending
 * `square_.png`, which is a 404 drawn as a broken image where the caller wanted
 * a fallback. That is the client half of the rule the server states in
 * `room/lobby.ts`'s `avatarIdOf`: an empty string must never become a request.
 * The origin is read only when there is an id, so a face with none renders
 * where there is no `location` (`react-dom/server`).
 */
export function avatarSquareUrl(avatarId: string | null | undefined, origin?: string): string | null {
  const id = normalizeAvatarId(avatarId);
  if (id === null) return null;
  return `${(origin ?? watchpartyOrigin()).replace(/\/$/, '')}/media/sprites/square_${encodeURIComponent(id)}.png`;
}

/** The same two-state reading the server does, so a client cannot send what it would refuse. */
export function normalizeAvatarId(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const id = v.trim();
  return id === '' || id.length > AVATAR_ID_MAX ? null : id;
}

/**
 * This viewer's chosen avatar from their account (`@wolffm/prefs-client/avatar`,
 * which resolves it server-side the same way `apps/server/src/people.ts` does
 * for everybody else's). Null when the read fails (offline, signed out, a host
 * without the prefs route) or the viewer has never picked one: either way, the
 * room keeps the character it handed them on joining (`room/lobby.ts`'s
 * `AVATAR_POOL`).
 *
 * A fresh client every call, not a cached singleton: `watchAvatar` (`avatarWatch.ts`)
 * calls this every poll, and `createAvatarClient` is a cheap object with no
 * connection to hold open, so there is nothing a cache would save.
 *
 * `baseUrl` is this page's origin for the reason `watchpartyOrigin` gives: the
 * SDK's default is a hardcoded `https://hadoku.me/prefs`, which a local e2e
 * would reach off-host.
 */
export async function accountAvatarId(): Promise<string | null> {
  try {
    const client = createAvatarClient({ baseUrl: `${globalThis.location.origin}/prefs` });
    return normalizeAvatarId((await client.get()).sprite);
  } catch {
    // Unreadable account is not an error to show anybody.
    return null;
  }
}

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
 * This file is the client half: "what URL draws it", the ONLY place that is
 * spelled. Which character a member wears is their account's, resolved by the
 * server (`apps/server/src/people.ts`'s `applyPerson`); prefs-api draws and
 * keeps one for an account that never picked, so it is the same in every app.
 */

import { AVATAR_ID_MAX } from '@hadoku/platform-wire/look';

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
 * media convention, not ours: every id in `@wolffm/rooms-protocol`'s `AVATAR_POOL` has
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

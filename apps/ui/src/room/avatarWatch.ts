/*
 * Watch the viewer's saved avatar and say so whenever it changes (wave 32 Q6).
 *
 * The operator: *"watchparty chat and the game are desynced when i change
 * avatars."* `RoomShell` used to read the avatar ONCE per room and assert it, so
 * a viewer who picked a new character in watchparty's chrome while the match was
 * open changed the chat and nothing else. The match is told an avatar at its
 * start and again only when the room hears a change (`attachTables`'s relay).
 *
 * Read once at the start (`accountAvatarId`, `avatar.ts`), then watched by
 * EVENT rather than polled (manager's word, wave 92 D: a 2 s poll of the
 * account would have cost prefs-api one GET per open room tab every 2 s —
 * 30/min). `@wolffm/task-ui-components`'s `AVATAR_EVENT` fires on `window`
 * after every avatar change made in the fleet's own settings popout
 * (AvatarPicker), carrying the new `AvatarSettings` (`@wolffm/prefs-client/avatar`)
 * as `detail` — so a pick reaches here the moment it is made, with no poll at all.
 *
 * A server that has the viewer back after a reconnect is told the same id again:
 * a deploy restarts it, and a saved room keeps no faces (R12), so it came back
 * wearing a handed-out character on this viewer's seat (`room/lobby.ts`'s restore).
 *
 * A viewer with no readable avatar asserts nothing: the room handed them a
 * character on joining (`room/lobby.ts`'s `AVATAR_POOL`), and that stands.
 */

import { AVATAR_EVENT } from '@wolffm/task-ui-components';

import { normalizeAvatarId } from './avatar.ts';

/** Just enough of `window` to listen for `AVATAR_EVENT`, so a test can hand in a plain `EventTarget`. */
export interface AvatarEventSource {
  addEventListener(type: typeof AVATAR_EVENT, listener: (event: Event) => void): void;
  removeEventListener(type: typeof AVATAR_EVENT, listener: (event: Event) => void): void;
}

export interface AvatarWatchDeps {
  /** This viewer's avatar, read once at the start. */
  readAvatar: () => Promise<string | null>;
  /** Called with each new id, once per change, and again with the same one when the server has the viewer back. */
  assert: (avatarId: string) => void;
  /**
   * Subscribes to "the server has this viewer back" (a reconnect: a deploy restarts it). A saved room
   * keeps no faces (R12), so a restarted server has forgotten the pick it was told. Returns the stop.
   */
  rejoined: (listener: () => void) => () => void;
  /** Where `AVATAR_EVENT` is heard. Defaults to `window`; a test hands in its own. */
  events?: AvatarEventSource;
}

/** The `sprite` (character) field of an `AVATAR_EVENT`'s `detail`, or null for anything else. */
function spriteOf(detail: unknown): string | null {
  if (typeof detail !== 'object' || detail === null) return null;
  return normalizeAvatarId((detail as { sprite?: unknown }).sprite);
}

/** Starts watching; returns the stop function. */
export function watchAvatar(deps: AvatarWatchDeps): () => void {
  let live = true;
  let last: string | null = null;

  const see = (id: string | null): void => {
    if (!live || id === null || id === last) return;
    last = id;
    deps.assert(id);
  };

  const onAvatarEvent = (event: Event): void => {
    see(spriteOf((event as CustomEvent<unknown>).detail));
  };

  const target = deps.events ?? (typeof window === 'undefined' ? undefined : window);
  target?.addEventListener(AVATAR_EVENT, onAvatarEvent);

  const stopRejoined = deps.rejoined(() => {
    if (live && last !== null) deps.assert(last);
  });

  // The start read is slower than an event: an AVATAR_EVENT heard while it is still in
  // flight has already spoken, and the read's own (by then stale) answer must not
  // overwrite it. Only counts while nothing newer has been seen.
  void deps.readAvatar().then((id) => {
    if (last === null) see(id);
  }, () => undefined);

  return () => {
    live = false;
    target?.removeEventListener(AVATAR_EVENT, onAvatarEvent);
    stopRejoined();
  };
}

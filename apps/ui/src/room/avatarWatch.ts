/*
 * Watch the viewer's saved avatar and say so whenever it changes (wave 32 Q6).
 *
 * The operator: *"watchparty chat and the game are desynced when i change
 * avatars."* `RoomShell` used to read the avatar ONCE per room and assert it, so
 * a viewer who picked a new character in watchparty's chrome while the match was
 * open changed the chat and nothing else. The match is told an avatar at its
 * start and again only when the room hears a change (`attachTables`'s relay).
 *
 * ## Where a change is visible from
 *
 * Watchparty's picker saves through the prefs SDK, which write-throughs to
 * `localStorage` (`avatar.ts`'s `selectedAvatarId`). That is the same tab, so the
 * `storage` event, which only fires in OTHER tabs, cannot be the signal; the
 * cache row is polled instead. It is one synchronous `localStorage` read, cheap
 * enough for a couple of seconds' cadence. The account copy is read once at the
 * start, for a fresh browser whose cache is empty (w31 P3b); after that the cache
 * is the newer of the two, because the picker writes it on every save.
 *
 * The unset case is still watchparty's (`WATCHPARTY_ROSTER_FOR_HOST.md`): a
 * viewer with no readable avatar asserts nothing and this does not invent one.
 * A viewer who CLEARS theirs is not noticed either, for the same reason the
 * assert never sent `null` before: the cache holds no avatar either way.
 */

export interface AvatarWatchDeps {
  /** The account's copy, read once at the start. */
  readAccount: () => Promise<string | null>;
  /** This browser's cache, read every tick. */
  readCache: () => string | null;
  /** Called with each new id, once per change. */
  assert: (avatarId: string) => void;
  intervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/** How often the cache row is looked at. A pick should reach the board within a couple of seconds. */
export const AVATAR_POLL_MS = 2000;

/** Starts watching; returns the stop function. */
export function watchAvatar(deps: AvatarWatchDeps): () => void {
  const every = deps.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
  const stopEvery = deps.clearInterval ?? ((h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>));
  let live = true;
  let last: string | null = null;

  const see = (id: string | null): void => {
    if (!live || id === null || id === last) return;
    last = id;
    deps.assert(id);
  };

  const handle = every(() => {
    see(deps.readCache());
  }, deps.intervalMs ?? AVATAR_POLL_MS);

  void deps.readAccount().then(
    (id) => {
      // The cache wins once it has spoken: it is the write-through of the latest save.
      if (last === null) see(id);
    },
    () => undefined,
  );
  // The cache may already hold one; do not wait a whole interval for it.
  see(deps.readCache());

  return () => {
    live = false;
    stopEvery(handle);
  };
}

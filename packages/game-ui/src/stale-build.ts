/*
 * A page left open across a release, talking to the newer server.
 *
 * The server tells every socket its build on connect (`forge:build`). A release that adds a field to
 * the wire makes an older page's strict schemas refuse what the newer server sends: match
 * m-13e598202544 (2026-11-07), a v0.56.0 tab under a v0.57.0 server, refused every frame that held
 * a card face, resynced into the same refusal three times and stopped drawing a game that went on.
 * A reload fetches the bundle the server is serving now, and the seat rejoins on the same tab id.
 *
 * Builds are `vX.Y.Z+<sha>` or `CARDTABLE_VERSION` as it stands (`scripts/release/build-version.ts`).
 * Only a newer RELEASE reloads on sight: main past a release (PPE, a dev server, e2e) builds as the
 * same release with another sha, and a stale `dist/version.txt` under a dev server is common, so a
 * sha alone is no reason to reload a page that reads everything. A page that cannot read what the
 * server sent is a different matter, and reloads for any build other than its own.
 */

const RELEASE = /^v(\d+)\.(\d+)\.(\d+)(?:\+.*)?$/;

/** `[major, minor, patch]` of a build, or null for a build that is not a release's (`unknown`, a named CI build). */
export function releaseOf(build: string): [number, number, number] | null {
  const m = RELEASE.exec(build);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** The server runs a later release than this page was built from. */
export function serverReleaseIsNewer(page: string, server: string): boolean {
  const ours = releaseOf(page);
  const theirs = releaseOf(server);
  if (ours === null || theirs === null) return false;
  for (let i = 0; i < 3; i++) if (theirs[i] !== ours[i]) return theirs[i]! > ours[i]!;
  return false;
}

/**
 * What the server sent did not parse here: is a reload a fix? Yes unless the server is known to run
 * this very build, when the failure is a bug a reload would only repeat. `null` is a server that
 * never said (one older than `forge:build`).
 */
export function unreadableMeansStale(page: string, server: string | null): boolean {
  return server === null || server === 'unknown' || server !== page;
}

const RELOADED_FOR = 'cardtable:reloaded-for-build';

/**
 * Claims this tab's one reload for `target`, the server build it reloads to meet. False when this
 * tab already reloaded for that build (the new bundle still could not read it, so a second reload
 * would loop) or there is no session storage to remember the reload in.
 */
export function claimReload(target: string, storage: () => Storage = () => sessionStorage): boolean {
  try {
    const store = storage();
    if (store.getItem(RELOADED_FOR) === target) return false;
    store.setItem(RELOADED_FOR, target);
    return true;
  } catch (err) {
    console.warn('[cardtable] no session storage to guard a reload for a new build with', err);
    return false;
  }
}

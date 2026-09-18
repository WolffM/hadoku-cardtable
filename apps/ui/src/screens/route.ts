/*
 * Hash routing, and the two pure functions the lobby is built out of.
 *
 * ## Why the hash and not the path
 *
 * The app is served under `hadoku.me/cardtable/` behind the friend gate, by a
 * server that SPA-falls-back every path (`apps/server/src/index.ts`). Either
 * scheme would therefore *work*. The hash wins because it needs no server
 * change at all, no base-prefix arithmetic in the client, and no router
 * dependency: a `hashchange` listener plus a switch is the whole mechanism, and
 * every route is the same document, so an invite link is just this page.
 *
 * ## The routes
 *
 *   `#/`                 the lobby — start a pod, or join one
 *   `#/draft/<draftId>`  a pod: the invite link, who is seated, and the draft
 *   `#/deck/<draftId>`   the deck built out of that draft's pool
 *   `#/play`             constructed: pick a format and a deck, start a match
 *   `#/match/<matchId>`  a match: the invite link for the other seat, and the board
 *   `#/debug`            the developer harness that used to be the front door
 *
 * An unrecognised hash is the lobby. That is deliberate: a mistyped invite link
 * lands somewhere that explains itself and offers a join box, rather than on an
 * error page that offers nothing.
 *
 * ## Everything here that can be pure, is
 *
 * `parseRoute`, `routeHash`, `inviteUrl`, `draftIdFromInput` and `mintDraftId`
 * take their inputs as arguments and touch no globals, so the interesting
 * behaviour — what a pasted link means, what an invite URL looks like under the
 * `/cardtable/` prefix — is testable without a DOM. Only `navigate`,
 * `subscribeToHash` and `currentHash` know `window` exists.
 */

import { useMemo, useSyncExternalStore } from 'react';

/** Where the app is. The single source of truth for what gets rendered. */
export type Route =
  | { kind: 'lobby' }
  | { kind: 'draft'; draftId: string }
  | { kind: 'deck'; draftId: string }
  | { kind: 'play' }
  | { kind: 'match'; matchId: string }
  | { kind: 'debug' };

/**
 * `#/draft/friday-cube` → `{ kind: 'draft', draftId: 'friday-cube' }`.
 *
 * Tolerant on the way in — a missing `#`, a missing leading `/`, a trailing
 * `/`, and percent-encoding are all accepted — because this parses a string a
 * person may have typed or an app may have mangled. Strict about the result:
 * an empty draft id is not a draft route, it is the lobby.
 */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (path === '') return { kind: 'lobby' };
  if (path === 'debug') return { kind: 'debug' };
  if (path === 'play') return { kind: 'play' };

  const parts = path.split('/');
  if (parts.length !== 2) return { kind: 'lobby' };
  const [head, raw] = parts;
  const id = decodeSegment(raw);
  if (id === '') return { kind: 'lobby' };
  switch (head) {
    case 'draft':
      return { kind: 'draft', draftId: id };
    case 'deck':
      return { kind: 'deck', draftId: id };
    case 'match':
      return { kind: 'match', matchId: id };
    default:
      return { kind: 'lobby' };
  }
}

/**
 * A malformed percent-escape throws out of `decodeURIComponent`. A pasted link
 * is exactly where one comes from, so the raw segment is the answer rather than
 * a crash.
 */
function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}

/** The inverse of `parseRoute`. Round-trips, and that is asserted. */
export function routeHash(route: Route): string {
  switch (route.kind) {
    case 'lobby':
      return '#/';
    case 'debug':
      return '#/debug';
    case 'draft':
      return `#/draft/${encodeURIComponent(route.draftId)}`;
    case 'deck':
      return `#/deck/${encodeURIComponent(route.draftId)}`;
    case 'play':
      return '#/play';
    case 'match':
      return `#/match/${encodeURIComponent(route.matchId)}`;
  }
}

/**
 * The link you send a friend.
 *
 * Built from `origin` + `pathname` rather than from `href`, because `href`
 * carries whatever hash is already on it and the result would compound —
 * `…/cardtable/#/#/draft/x`. Takes the location as an argument so the
 * `/cardtable/` prefix case is a test and not a deployment surprise.
 */
export function inviteUrl(draftId: string, location: { origin: string; pathname: string }): string {
  return routeUrl({ kind: 'draft', draftId }, location);
}

/** The same, for any route — a match's invite link is `routeUrl({ kind: 'match', … })`. */
export function routeUrl(route: Route, location: { origin: string; pathname: string }): string {
  return `${location.origin}${location.pathname}${routeHash(route)}`;
}

/**
 * What someone pasted into the join box, as a draft id.
 *
 * Accepts a whole invite URL, a bare `#/draft/x`, or just the id, because all
 * three are things a person will paste and only one of them is what we asked
 * for. Returns null when there is no id in it — the caller shows that as "that
 * does not look like a pod link" rather than joining something arbitrary.
 */
export function draftIdFromInput(input: string): string | null {
  const text = input.trim();
  if (text === '') return null;

  const hashAt = text.indexOf('#');
  if (hashAt !== -1) {
    const route = parseRoute(text.slice(hashAt));
    return route.kind === 'draft' || route.kind === 'deck' ? route.draftId : null;
  }

  // A bare id. Anything with whitespace or a slash in it is a mangled link, not
  // an id, and joining it would silently open an empty pod nobody else is in.
  if (/[\s/?#]/.test(text)) return null;
  return decodeSegment(text) || null;
}

/**
 * The shape the match server mints (`apps/server/src/play/match.ts`,
 * `newMatchId`): `m-` and twelve hex digits. Only consulted for a BARE id; a
 * pasted link says what it is by its path. No pod id can take this shape —
 * `mintDraftId` writes adjective-noun-suffix.
 */
const BARE_MATCH_ID = /^m-[0-9a-f]{12}$/;

/**
 * What someone pasted into the lobby's join box, as the place to go: a pod or
 * a match. The same box joins both, because a person with a link should not
 * have to know which kind it is.
 */
export function joinRouteFromInput(input: string): Route | null {
  const text = input.trim();
  const hashAt = text.indexOf('#');
  if (hashAt !== -1) {
    const route = parseRoute(text.slice(hashAt));
    if (route.kind === 'match') return route;
  } else if (BARE_MATCH_ID.test(text)) {
    return { kind: 'match', matchId: text };
  }
  const draftId = draftIdFromInput(text);
  return draftId === null ? null : { kind: 'draft', draftId };
}

/* ── minting a pod id ────────────────────────────────────────────────── */

/**
 * The id is the seed AND the room key (`draftRooms.ts` — "the id IS the seed"),
 * so two pods minting the same id would deal the same cards *and* sit in the
 * same room. Hence real entropy rather than a counter, and hence words: the
 * thing gets read aloud and typed into the join box.
 */
const ADJECTIVES = [
  'amber',
  'brisk',
  'copper',
  'dusty',
  'eager',
  'frosty',
  'golden',
  'hollow',
  'iron',
  'jolly',
  'kindly',
  'lucky',
  'misty',
  'noble',
  'olive',
  'plucky',
  'quiet',
  'rusty',
  'silver',
  'tidy',
  'umber',
  'velvet',
  'wily',
  'zesty',
];

const NOUNS = [
  'anvil',
  'badger',
  'comet',
  'delta',
  'ember',
  'falcon',
  'grotto',
  'harbor',
  'island',
  'jetty',
  'kettle',
  'lantern',
  'meadow',
  'nettle',
  'orchard',
  'pebble',
  'quarry',
  'ribbon',
  'summit',
  'thicket',
  'urchin',
  'valley',
  'willow',
  'zephyr',
];

/** No vowels and no look-alikes: this gets read off a screen and retyped. */
const SUFFIX = [...'bcdfghjkmnpqrstvwxz23456789'];

/**
 * A uniform [0,1) from `crypto`, never `Math.random`.
 *
 * Not because a pod id is a secret — it is not — but because `Math.random` is
 * banned in the draft engine for determinism, and the id *is* the engine's
 * seed. One rule, one place, no exception to remember.
 */
function secureRandom(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] / 2 ** 32;
}

/**
 * `amber-lantern-k7q4`. Readable, sayable, and ~10^7 wide before the words
 * even count, which is plenty for a friend group and cheap to widen.
 *
 * `rand` is injectable so the shape can be asserted against a pinned source
 * instead of being sampled and hoped about.
 */
export function mintDraftId(rand: () => number = secureRandom): string {
  const pick = <T>(xs: readonly T[]): T =>
    xs[Math.min(xs.length - 1, Math.floor(rand() * xs.length))];
  const suffix = Array.from({ length: 4 }, () => pick(SUFFIX)).join('');
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${suffix}`;
}

/* ── the browser half ────────────────────────────────────────────────── */

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function subscribeToHash(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) globalThis.addEventListener('hashchange', notify);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) globalThis.removeEventListener('hashchange', notify);
  };
}

function currentHash(): string {
  return globalThis.location?.hash ?? '';
}

/**
 * Go somewhere.
 *
 * Assigning to `location.hash` is what puts the URL in the address bar and in
 * the back/forward history. The browser's own `hashchange` for it is queued as
 * a task rather than dispatched synchronously, so this tells the subscribers
 * itself; the event that arrives a moment later finds the same hash and is a
 * no-op, because `useSyncExternalStore` compares the snapshot by value.
 */
export function navigate(route: Route): void {
  const next = routeHash(route);
  if (currentHash() !== next) globalThis.location.hash = next;
  notify();
}

/** The current route, re-rendering the caller when it changes. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(
    subscribeToHash,
    currentHash,
    () => '',
  );
  return useMemo(() => parseRoute(hash), [hash]);
}

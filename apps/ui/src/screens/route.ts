/*
 * Hash routing, and the two pure functions the app's links are built out of.
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
 *   `#/`                 the lobby — the list of rooms, and the only front door
 *   `#/room/<roomId>`    a room: who is here, readiness, and the game it is for
 *   `#/draft/<draftId>`  LEGACY — redirects to `#/room/<draftId>`. See below.
 *   `#/deck/<draftId>`   the deck built out of that draft's pool
 *   `#/play`             constructed: pick a format and a deck, start a match
 *   `#/match/<matchId>`  a match: the invite link for the other seat, and the board
 *   `#/debug`            the developer harness that used to be the front door
 *   `#/sounds`           the sound builder (wave 50) — friend tier and above; editing is admin-only
 *   `#/sounds/sandbox`   the sound sandbox — scenarios played through the mixer, friend tier and above
 *   `#/sounds/music`     the match-music review — compare, pick and submit, friend tier and above
 *   `#/stats`            the lobby, with the stats popout over it: your record, history, decks, the boards
 *   `#/stats/<name>`     the same popout for another player, by registry name
 *   `#/tournaments`      the same popout on its Tournaments tab: every past pod's standings
 *   `#/decks`            your decks: every draft you finished
 *   `#/decks/<draftId>`  that deck in the editor, outside any game
 *
 * An unrecognised hash is the lobby. That is deliberate: a mistyped invite link
 * lands on the room list, which offers a way in, rather than on an error page
 * that offers nothing.
 *
 * ## `#/draft/<id>` is a legacy alias, and that is all it is
 *
 * Wave 23 made a draft a room: the room list is the one front door, the server
 * mints the id, and `#/room/<id>` is what an invite link says. The client used
 * to mint `adjective-noun-suffix` pod ids here and hand them out in links, so
 * those links exist in people's chat windows. `parseRoute` and `routeHash` keep
 * the draft route so `App.tsx` can redirect it to `#/room/<draftId>` — the draft
 * id and the room id are now one id, so the redirect is the whole translation.
 * A link to a pod id that was never a room lands on the room screen's own "no
 * such room", which is the honest answer. `DeckScreen`'s "back to the pod" goes
 * through the same alias for the same reason.
 *
 * Nothing mints an id here any more, and nothing parses a pasted link: the join
 * box those served is gone with the pod section (`LobbyScreen.tsx`).
 *
 * ## Everything here that can be pure, is
 *
 * `parseRoute`, `routeHash` and `routeUrl` take their inputs as arguments and
 * touch no globals, so the interesting behaviour — what a mangled hash means,
 * what an invite URL looks like under the `/cardtable/` prefix — is testable
 * without a DOM. Only `navigate`, `subscribeToHash`, `currentHash` and
 * `appLocation` know `window` exists — and `routeInMemory` is how the embed
 * (D21) tells them the address bar is not the app's.
 */

import { useMemo, useSyncExternalStore } from 'react';

/** Where the app is. The single source of truth for what gets rendered. */
export type Route =
  | { kind: 'lobby' }
  /** LEGACY. `App.tsx` redirects it to `room`; nothing renders it. See the header. */
  | { kind: 'draft'; draftId: string }
  | { kind: 'deck'; draftId: string }
  | { kind: 'play' }
  | { kind: 'match'; matchId: string }
  | { kind: 'room'; roomId: string }
  | { kind: 'debug' }
  /** Friend tier and above: each screen renders nothing until the server's `/api/sounds` answers (`canView`). */
  | { kind: 'sounds' }
  | { kind: 'sounds-sandbox' }
  | { kind: 'sounds-music' }
  /** `player` is a registry name; absent is the viewer. `tournaments` is the past-pods tab. */
  | { kind: 'stats'; player?: string; tournaments?: true }
  /** `draftId` opens that deck in the editor; absent is the list. */
  | { kind: 'decks'; draftId?: string };

/**
 * `#/room/r-1a2b3c` → `{ kind: 'room', roomId: 'r-1a2b3c' }`.
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
  if (path === 'sounds') return { kind: 'sounds' };
  if (path === 'sounds/sandbox') return { kind: 'sounds-sandbox' };
  if (path === 'sounds/music') return { kind: 'sounds-music' };
  if (path === 'stats') return { kind: 'stats' };
  if (path === 'tournaments') return { kind: 'stats', tournaments: true };
  if (path === 'decks') return { kind: 'decks' };

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
    case 'room':
      return { kind: 'room', roomId: id };
    case 'stats':
      return { kind: 'stats', player: id };
    case 'decks':
      return { kind: 'decks', draftId: id };
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
    case 'sounds':
      return '#/sounds';
    case 'sounds-sandbox':
      return '#/sounds/sandbox';
    case 'sounds-music':
      return '#/sounds/music';
    case 'draft':
      return `#/draft/${encodeURIComponent(route.draftId)}`;
    case 'deck':
      return `#/deck/${encodeURIComponent(route.draftId)}`;
    case 'play':
      return '#/play';
    case 'match':
      return `#/match/${encodeURIComponent(route.matchId)}`;
    case 'room':
      return `#/room/${encodeURIComponent(route.roomId)}`;
    case 'stats':
      if (route.tournaments === true) return '#/tournaments';
      return route.player === undefined ? '#/stats' : `#/stats/${encodeURIComponent(route.player)}`;
    case 'decks':
      return route.draftId === undefined ? '#/decks' : `#/decks/${encodeURIComponent(route.draftId)}`;
  }
}

/**
 * The link you send a friend.
 *
 * Built from `origin` + `pathname` rather than from `href`, because `href`
 * carries whatever hash is already on it and the result would compound —
 * `…/cardtable/#/#/room/x`. Takes the location as an argument so the
 * `/cardtable/` prefix case is a test and not a deployment surprise.
 *
 * Any route: a room's invite link is `routeUrl({ kind: 'room', roomId }, …)`
 * and a match's is the same call with `{ kind: 'match', matchId }`. There is no
 * `inviteUrl` any more — one function, and the caller says what it is linking to.
 */
export function routeUrl(route: Route, location: { origin: string; pathname: string }): string {
  return `${location.origin}${location.pathname}${routeHash(route)}`;
}

/* ── the browser half ────────────────────────────────────────────────── */

const listeners = new Set<() => void>();

/**
 * The route when the app does not own the address bar, or null when it does.
 *
 * Embedded in a watchparty room (D21) the URL is watchparty's: a hash written
 * there would rewrite THEIR page's route and land in their history. So the
 * embed holds its route here instead, and `navigate` / `useRoute` read and
 * write this rather than `location.hash`. One per page, like everything else
 * the chrome owns ("exactly one chrome per page", `chrome/AppChrome.tsx`).
 */
let inMemory: { hash: string } | null = null;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Whether `hashchange` is subscribed — only ever while the address bar is ours. */
let listening = false;

function syncHashListener(): void {
  const want = inMemory === null && listeners.size > 0;
  if (want === listening) return;
  listening = want;
  if (want) globalThis.addEventListener('hashchange', notify);
  else globalThis.removeEventListener('hashchange', notify);
}

function subscribeToHash(listener: () => void): () => void {
  listeners.add(listener);
  syncHashListener();
  return () => {
    listeners.delete(listener);
    syncHashListener();
  };
}

function currentHash(): string {
  if (inMemory !== null) return inMemory.hash;
  return globalThis.location?.hash ?? '';
}

/**
 * Route in memory from here on, starting at `start`; the returned function
 * gives the address bar back. The embed calls this before it renders.
 */
export function routeInMemory(start: Route): () => void {
  const mine = { hash: routeHash(start) };
  inMemory = mine;
  syncHashListener();
  notify();
  return () => {
    if (inMemory !== mine) return;
    inMemory = null;
    syncHashListener();
  };
}

/**
 * The page an invite link is built on: this one standalone, and the
 * standalone app's own page when embedded — watchparty's URL plus a cardtable
 * hash would open watchparty, not the room.
 */
export function appLocation(): { origin: string; pathname: string } {
  const origin = globalThis.location?.origin ?? '';
  if (inMemory !== null) return { origin, pathname: import.meta.env?.BASE_URL ?? '/' };
  return { origin, pathname: globalThis.location?.pathname ?? '' };
}

/**
 * Go somewhere.
 *
 * Assigning to `location.hash` is what puts the URL in the address bar and in
 * the back/forward history. The browser's own `hashchange` for it is queued as
 * a task rather than dispatched synchronously, so this tells the subscribers
 * itself; the event that arrives a moment later finds the same hash and is a
 * no-op, because `useSyncExternalStore` compares the snapshot by value.
 *
 * `replace` swaps the current history entry instead of adding one, for a
 * screen that forwards on its own: Back from where it forwarded to must not
 * land on it again and be forwarded straight back.
 */
export function navigate(route: Route, { replace = false }: { replace?: boolean } = {}): void {
  const next = routeHash(route);
  if (inMemory !== null) inMemory.hash = next;
  else if (currentHash() !== next) {
    if (replace) globalThis.location.replace(next);
    else globalThis.location.hash = next;
  }
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

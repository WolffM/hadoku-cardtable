/*
 * Hash routing, and the two pure functions the app's links are built out of.
 *
 * ## Why the hash and not the path, except for a room
 *
 * The app is served under `hadoku.me/cardtable/` behind the member gate, by a
 * server that SPA-falls-back every path (`apps/server/src/index.ts`). Either
 * scheme would therefore *work*. The hash wins because it needs no server
 * change at all, no base-prefix arithmetic in the client, and no router
 * dependency: a `hashchange` listener plus a switch is the whole mechanism, and
 * every route is the same document.
 *
 * A room's own page is the exception: its address is the PATH
 * `/cardtable/room/<roomId>`. A link pasted into Discord unfurls from what the
 * edge can see, and a browser never sends the hash (the operator, 2026-11-08:
 * the address bar is the invite link). So the edge reads the room from the path
 * and shows its preview (`games/magic/server/src/http/preview.ts`). `#/room/<id>` still
 * opens it, and is moved to the path (`canonicalAddress`). Its tables, and every
 * other route, stay in the hash.
 *
 * ## The routes
 *
 *   `#/`                 the lobby — the list of rooms, and the only front door
 *   `room/<roomId>`      a room, at that PATH: who is here, readiness, and the game it is for; once rounds start, the hub
 *   `#/room/<roomId>/table/<tableId>`  one match of a room's rounds: its deck pick, Ready, sideboard and game
 *   `#/draft/<draftId>`  LEGACY — redirects to `#/room/<draftId>`. See below.
 *   `#/deck/<draftId>`   the deck built out of that draft's pool
 *   `#/play`             constructed: pick a format and a deck, start a match
 *   `#/match/<matchId>`  a match: the invite link for the other seat, and the board
 *   `#/replay/<matchId>` a recorded match, through the transport bar (wave 77 §B) — no invite, nothing to join
 *   `#/sounds`           the sound builder (wave 50) — friend tier and above; editing is admin-only
 *   `#/sounds/sandbox`   the sound sandbox — scenarios played through the mixer, friend tier and above
 *   `#/sounds/music`     the match-music review — compare, pick and submit, friend tier and above
 *   `#/ui`               the trim composer (`settings/TrimScreen.tsx`) — admin only, linked from nowhere
 *   `#/stats`            the stats page's Leaderboard: the rankings, winning decks, colours, everyone's matches
 *   `#/profile`          the stats page's Your profile: your rating, unfinished games, matches, decks, colours
 *   `#/stats/<name>`     another player's profile, by registry name
 *   `#/tournaments`      the stats page's Tournaments tab: every past pod's standings
 *   `#/decks`            your decks: every draft you finished
 *   `#/decks/<draftId>`  that deck in the editor, outside any game
 *   `#/inventory`        imported cubes: refresh, delete, import (AF305 §B) — shortlist cubes aren't managed here
 *   `#/embed/<catalogue>/<id>/<view>`  one Rally pick option's page, chromeless, for Rally's frame (`rally/RallyEmbed.tsx`, cardtable#24)
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
 * `parseRoute`, `routeHash`, `routeAddress`, `routeUrl` and `canonicalAddress`
 * take their inputs as arguments and touch no globals, so the interesting behaviour — what a mangled hash means,
 * what an invite URL looks like under the `/cardtable/` prefix — is testable
 * without a DOM. Only `navigate`, `subscribeToHash`, `currentHash` and
 * `appLocation` know `window` exists — and `routeInMemory` is how the embed
 * (D21) tells them the address bar is not the app's.
 */

import { useMemo, useSyncExternalStore } from 'react';

import { registered } from '../registered.ts';

/** Whether `#/embed/<catalogue>/<id>/<view>` is one of the game's pages; any other is the lobby. */
const embedAddress = registered<(catalogue: string, view: string) => boolean>('embed address');
export const registerEmbedAddress = embedAddress.set;

/** Where the app is. The single source of truth for what gets rendered. */
export type Route =
  | { kind: 'lobby' }
  /** LEGACY. `App.tsx` redirects it to `room`; nothing renders it. See the header. */
  | { kind: 'draft'; draftId: string }
  | { kind: 'deck'; draftId: string }
  | { kind: 'play' }
  | { kind: 'match'; matchId: string }
  /** A recorded match, played back through the transport bar (wave 77 §B). */
  | { kind: 'replay'; matchId: string }
  /** `tableId` is one table of the room's rounds (`screens/room/TablePage.tsx`); absent is the room itself. */
  | { kind: 'room'; roomId: string; tableId?: string }
  /** Friend tier and above: each screen renders nothing until the server's `/api/sounds` answers (`canView`). */
  | { kind: 'sounds' }
  | { kind: 'sounds-sandbox' }
  | { kind: 'sounds-music' }
  | { kind: 'ui' }
  /** The stats page (`stats/StatsPage.tsx`): no `tab` is its Leaderboard; `player`, a registry name, is that player's profile. */
  | { kind: 'stats'; tab?: 'profile' | 'tournaments'; player?: never }
  | { kind: 'stats'; player: string; tab?: never }
  /** `draftId` opens that deck in the editor; absent is the list. */
  | { kind: 'decks'; draftId?: string }
  | { kind: 'inventory' }
  /** A Rally pick option's page in Rally's frame: no header, no room (cardtable#24). */
  | { kind: 'rally-embed'; catalogue: string; id: string; view: string };

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
  if (path === 'play') return { kind: 'play' };
  if (path === 'sounds') return { kind: 'sounds' };
  if (path === 'sounds/sandbox') return { kind: 'sounds-sandbox' };
  if (path === 'sounds/music') return { kind: 'sounds-music' };
  if (path === 'ui') return { kind: 'ui' };
  if (path === 'stats') return { kind: 'stats' };
  if (path === 'profile') return { kind: 'stats', tab: 'profile' };
  if (path === 'tournaments') return { kind: 'stats', tab: 'tournaments' };
  if (path === 'decks') return { kind: 'decks' };
  if (path === 'inventory') return { kind: 'inventory' };

  const parts = path.split('/');
  if (parts.length === 4 && parts[0] === 'embed') {
    const [catalogue, view] = [parts[1]!, parts[3]!];
    const id = decodeSegment(parts[2]!);
    return embedAddress.get()(catalogue, view) && id !== '' ? { kind: 'rally-embed', catalogue, id, view } : { kind: 'lobby' };
  }
  if (parts.length === 4 && parts[0] === 'room' && parts[2] === 'table') {
    const [roomId, tableId] = [decodeSegment(parts[1]!), decodeSegment(parts[3]!)];
    return roomId === '' ? { kind: 'lobby' } : tableId === '' ? { kind: 'room', roomId } : { kind: 'room', roomId, tableId };
  }
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
    case 'replay':
      return { kind: 'replay', matchId: id };
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
    case 'sounds':
      return '#/sounds';
    case 'sounds-sandbox':
      return '#/sounds/sandbox';
    case 'sounds-music':
      return '#/sounds/music';
    case 'ui':
      return '#/ui';
    case 'draft':
      return `#/draft/${encodeURIComponent(route.draftId)}`;
    case 'deck':
      return `#/deck/${encodeURIComponent(route.draftId)}`;
    case 'play':
      return '#/play';
    case 'match':
      return `#/match/${encodeURIComponent(route.matchId)}`;
    case 'replay':
      return `#/replay/${encodeURIComponent(route.matchId)}`;
    case 'room':
      return `#/room/${encodeURIComponent(route.roomId)}${route.tableId === undefined ? '' : `/table/${encodeURIComponent(route.tableId)}`}`;
    case 'stats':
      if (route.player !== undefined) return `#/stats/${encodeURIComponent(route.player)}`;
      return route.tab === undefined ? '#/stats' : `#/${route.tab}`;
    case 'decks':
      return route.draftId === undefined ? '#/decks' : `#/decks/${encodeURIComponent(route.draftId)}`;
    case 'inventory':
      return '#/inventory';
    case 'rally-embed':
      return `#/embed/${route.catalogue}/${encodeURIComponent(route.id)}/${route.view}`;
  }
}

/** A room's own page, not one of its tables: the one route whose address is a path. */
function roomPage(route: Route): string | null {
  return route.kind === 'room' && route.tableId === undefined ? route.roomId : null;
}

/** Whether a hash names anything: `#` and `#/` are the same as none. */
function hasHash(hash: string): boolean {
  return hash.replace(/^#\/?/, '') !== '';
}

/**
 * Where a route lives under `base`, as `{ path, hash }`: a room's page at the path `room/<id>`,
 * everything else at `base` with its hash, the lobby with none.
 */
export function routeAddress(route: Route, base: string): { path: string; hash: string } {
  const room = roomPage(route);
  if (room !== null) return { path: `${base}room/${encodeURIComponent(room)}`, hash: '' };
  return { path: base, hash: route.kind === 'lobby' ? '' : routeHash(route) };
}

/**
 * The link you send a friend: the route's own address, on the app's base.
 *
 * Built from `origin` + `base` rather than from `href`, because `href` carries
 * whatever path and hash it is already on. Takes both as arguments so the
 * `/cardtable/` prefix case is a test and not a deployment surprise.
 */
export function routeUrl(route: Route, location: { origin: string; pathname: string }): string {
  const { path, hash } = routeAddress(route, location.pathname);
  return `${location.origin}${path}${hash}`;
}

/** The route the address bar names under `base`: its hash when it has one, else its path. */
export function locationRoute(location: { pathname: string; hash: string }, base: string): Route {
  if (hasHash(location.hash)) return parseRoute(location.hash);
  return parseRoute(location.pathname.startsWith(base) ? location.pathname.slice(base.length) : '');
}

/**
 * The address this page should be on, or null when it already is.
 *
 * The server answers any path under the prefix with the app, so a page can be on a path that
 * is not its route's (`/cardtable/sounds/music`), and a hash navigation keeps that stray path.
 * A route named by the hash keeps its hash verbatim (a `#cam=` knob included) on the base, unless
 * it is a room's page, which moves to its path. A route named only by the path moves to its own
 * address. The query stays.
 */
export function canonicalAddress(
  location: { pathname: string; search: string; hash: string },
  base: string,
): string | null {
  const route = locationRoute(location, base);
  const want = roomPage(route) !== null || !hasHash(location.hash) ? routeAddress(route, base) : { path: base, hash: location.hash };
  const next = `${want.path}${location.search}${want.hash}`;
  return next === `${location.pathname}${location.search}${location.hash}` ? null : next;
}

/** Puts this page on its route's own address, before anything reads the route and after each move. */
export function canonicalizeAddress(): void {
  const next = canonicalAddress(globalThis.location, import.meta.env.BASE_URL);
  if (next !== null) globalThis.history.replaceState(globalThis.history.state, '', next);
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

/** The address bar moved on its own (Back, Forward, a `#` link): put it on its route's address, then re-read it. */
function moved(): void {
  canonicalizeAddress();
  notify();
}

/** Whether `hashchange` and `popstate` are subscribed — only ever while the address bar is ours. */
let listening = false;

function syncHashListener(): void {
  const want = inMemory === null && listeners.size > 0;
  if (want === listening) return;
  listening = want;
  for (const event of ['hashchange', 'popstate'] as const) {
    if (want) globalThis.addEventListener(event, moved);
    else globalThis.removeEventListener(event, moved);
  }
}

function subscribeToHash(listener: () => void): () => void {
  listeners.add(listener);
  syncHashListener();
  return () => {
    listeners.delete(listener);
    syncHashListener();
  };
}

/** The current route as its hash: one string, so the snapshot compares by value. */
function currentHash(): string {
  if (inMemory !== null) return inMemory.hash;
  const location = globalThis.location;
  if (location === undefined) return '';
  return routeHash(locationRoute(location, import.meta.env.BASE_URL));
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

/** The page an invite link is built on: the app's own base, standalone or embedded (`routeUrl`). */
export function appLocation(): { origin: string; pathname: string } {
  return { origin: globalThis.location?.origin ?? '', pathname: import.meta.env?.BASE_URL ?? '/' };
}

/**
 * Go somewhere.
 *
 * Writing the route's address with `history.pushState` is what puts it in the address bar and in
 * the back/forward history; the browser dispatches nothing for that, so this tells the subscribers
 * itself. Back and Forward arrive as `popstate` (and `hashchange`), which `moved` handles.
 *
 * `replace` swaps the current history entry instead of adding one, for a
 * screen that forwards on its own: Back from where it forwarded to must not
 * land on it again and be forwarded straight back. Arriving at the route this page already
 * shows only corrects its address, and adds no entry.
 */
export function navigate(route: Route, { replace = false }: { replace?: boolean } = {}): void {
  if (inMemory !== null) inMemory.hash = routeHash(route);
  else {
    const location = globalThis.location;
    const { path, hash } = routeAddress(route, import.meta.env.BASE_URL);
    const next = `${path}${location.search}${hash}`;
    if (next !== `${location.pathname}${location.search}${location.hash}`) {
      const same = currentHash() === routeHash(route);
      if (replace || same) globalThis.history.replaceState(globalThis.history.state, '', next);
      else globalThis.history.pushState(null, '', next);
    }
  }
  notify();
}

/** The route this page is on now, read once: what `useRoute` renders, for a caller outside React. */
export function currentRoute(): Route {
  return parseRoute(currentHash());
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

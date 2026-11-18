/*
 * A game's router: a route type `R` the game defines, and the one mechanism every game shares for
 * where that route lives.
 *
 * The game hands over two pure functions — `parse(hash) → R` and `toHash(R) → '#/…'`, a round trip —
 * and gets back `useRoute`, `navigate` and the rest. Standalone the route IS the page's address; inside
 * a host's page (the embed, watchparty's game slot) the address bar is the host's, and nothing here may
 * write to it: `routeInMemory` moves the route into this router for the life of the mount, and
 * `useRoute` / `navigate` read and write that instead.
 *
 * ## The hash, unless the game says a route lives at a path
 *
 * By default every route lives in the hash, on whatever path the page is on. A game whose links must
 * be visible to the server (cardtable's room page, whose address is a path so a pasted link unfurls)
 * passes `paths`: where a route lives under the app's base, which route an address names, and the
 * address a page should be moved to (`canonical`). The router then writes with `history.pushState`
 * and puts a stray address right on every move.
 *
 * ## One owner of the route at a time
 *
 * A router is a module singleton, and the embed mounts once per page. A second `routeInMemory` while
 * one is active throws, because two embeds sharing one route would navigate each other.
 */

import { useMemo, useSyncExternalStore } from 'react';

/** The page's address, as much of it as a route is read from. */
export interface RouteLocation {
  pathname: string;
  search: string;
  hash: string;
}

/** Where a route lives when some routes are paths, not hashes. */
export interface RoutePaths<R> {
  /** Where `route` lives under `base`: its path, and its hash (`''` for none). */
  toAddress(route: R, base: string): { path: string; hash: string };
  /** The route an address names under `base`. */
  fromLocation(location: Pick<RouteLocation, 'pathname' | 'hash'>, base: string): R;
  /** The address this page should be moved to, or null when it is already there. */
  canonical?(location: RouteLocation, base: string): string | null;
}

export interface HashRouterOptions<R> {
  /** A hash (`#/room/x`, tolerant of mangling) → its route. Unknown is the game's front door. */
  parse(hash: string): R;
  /** The inverse of `parse`: `parse(toHash(r))` is `r`. */
  toHash(route: R): string;
  /** Only for a game with path-addressed routes; see the header. */
  paths?: RoutePaths<R>;
  /** The app's base (`/bomberman/`). Default: the bundler's `BASE_URL`. */
  base?: () => string;
}

export interface HashRouter<R> {
  /** The current route, re-rendering the caller when it changes. */
  useRoute(): R;
  /** The route now, read once, for a caller outside React. */
  currentRoute(): R;
  /**
   * Go somewhere. Standalone this adds a history entry, so Back works; `replace` swaps the current
   * one instead, for a screen that forwards on its own. Arriving where the page already is adds none.
   */
  navigate(route: R, options?: { replace?: boolean }): void;
  /** Route in memory from here on, starting at `start`. The returned function gives the address bar back. */
  routeInMemory(start: R): () => void;
  /** Puts the page on its route's own address (`paths.canonical`); a no-op for a hash-only router. */
  canonicalize(): void;
  /** Whether the route is in memory now (an embed is mounted). */
  inMemory(): boolean;
  /** Subscribes to route changes; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  parse(hash: string): R;
  toHash(route: R): string;
}

function bundlerBase(): string {
  const base = import.meta.env?.BASE_URL;
  return typeof base === 'string' && base !== '' ? base : '/';
}

/** A router for `R`. Call once per app, at module level, and export what it returns. */
export function createHashRouter<R>({ parse, toHash, paths, base = bundlerBase }: HashRouterOptions<R>): HashRouter<R> {
  const listeners = new Set<() => void>();
  let memory: { hash: string } | null = null;
  let listening = false;

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const canonicalize = (): void => {
    const location = globalThis.location;
    if (paths?.canonical === undefined || location === undefined) return;
    const next = paths.canonical(location, base());
    if (next !== null) globalThis.history.replaceState(globalThis.history.state, '', next);
  };

  /** The address bar moved on its own (Back, Forward, a `#` link): correct it, then re-read it. */
  const moved = (): void => {
    canonicalize();
    notify();
  };

  // Subscribed to the window only while the address bar is ours and somebody is listening.
  const syncWindow = (): void => {
    const want = memory === null && listeners.size > 0;
    if (want === listening) return;
    listening = want;
    for (const event of ['hashchange', 'popstate'] as const) {
      if (want) globalThis.addEventListener(event, moved);
      else globalThis.removeEventListener(event, moved);
    }
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    syncWindow();
    return () => {
      listeners.delete(listener);
      syncWindow();
    };
  };

  /** The current route as its hash: one string, so the snapshot compares by value. */
  const currentHash = (): string => {
    if (memory !== null) return memory.hash;
    const location = globalThis.location;
    if (location === undefined) return '';
    return toHash(paths === undefined ? parse(location.hash) : paths.fromLocation(location, base()));
  };

  const addressOf = (route: R, location: Location): string => {
    if (paths === undefined) return `${location.pathname}${location.search}${toHash(route)}`;
    const { path, hash } = paths.toAddress(route, base());
    return `${path}${location.search}${hash}`;
  };

  const navigate = (route: R, { replace = false }: { replace?: boolean } = {}): void => {
    if (memory !== null) memory.hash = toHash(route);
    else {
      const location = globalThis.location;
      const next = addressOf(route, location);
      if (next !== `${location.pathname}${location.search}${location.hash}`) {
        const same = currentHash() === toHash(route);
        if (replace || same) globalThis.history.replaceState(globalThis.history.state, '', next);
        else globalThis.history.pushState(null, '', next);
      }
    }
    notify();
  };

  const routeInMemory = (start: R): (() => void) => {
    if (memory !== null) throw new Error('route: already routing in memory — one embed per page');
    const mine = { hash: toHash(start) };
    memory = mine;
    syncWindow();
    notify();
    return () => {
      if (memory !== mine) return;
      memory = null;
      syncWindow();
      notify();
    };
  };

  const useRoute = (): R => {
    const hash = useSyncExternalStore(subscribe, currentHash, () => '');
    return useMemo(() => parse(hash), [hash]);
  };

  return {
    useRoute,
    currentRoute: () => parse(currentHash()),
    navigate,
    routeInMemory,
    canonicalize,
    inMemory: () => memory !== null,
    subscribe,
    parse,
    toHash,
  };
}

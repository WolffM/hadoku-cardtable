/*
 * Code the first screen does not need, loaded when it is first drawn, or earlier on purpose.
 *
 * The page's entry is the lobby and the chrome around every screen; each other screen, and the
 * lobby's featured board, is a chunk of its own (`screens/Screen.tsx`, `front/LiveSlot.tsx`), with
 * the big data tables in long-lived chunks beside them (`vite.config.ts`). A chunk loads the first
 * time its component draws, or before, from `preload()`: the screens a player opens next are warmed
 * once the page is idle (`main.tsx`), so a press rarely waits on the network.
 *
 * `lazyComponent` is `React.lazy` with two differences:
 *
 *   - **A module already loaded draws in the same render.** `React.lazy` suspends once on its first
 *     render even when `preload()` landed long ago, and a route change is a synchronous update: the
 *     screen would blank for a frame. Here, once the load has settled, the component is drawn
 *     directly and nothing suspends.
 *   - **A failed load reloads the page, once.** The server serves only the current build, so after a
 *     deploy the open page's chunk names are gone and every load of one fails. A reload fetches the
 *     new `index.html` (served `no-store`) and lands on the same route. A second failure within
 *     {@link RELOAD_GUARD_MS} is not a deploy: it is thrown, rather than reloading in a loop.
 */

import { createElement, use, type ComponentType, type ReactNode } from 'react';

/** A component whose module loads on first draw. `preload()` starts it early and never rejects. */
export interface LazyComponent<P> {
  (props: P): ReactNode;
  preload(): Promise<void>;
}

const RELOADED_AT = 'cardtable:reloaded-for-chunk';
/** How soon after a reload another failed chunk is a real failure rather than a deploy. */
export const RELOAD_GUARD_MS = 60_000;

/** Reloads the page for a new build, unless it just did. Whether it reloaded. */
function reloadForNewBuild(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOADED_AT));
    if (Date.now() - last < RELOAD_GUARD_MS) return false;
    sessionStorage.setItem(RELOADED_AT, String(Date.now()));
  } catch (err) {
    // No storage to remember the reload in, so no way to stop a loop: fail instead.
    console.warn('[cardtable] a chunk did not load and there is no session storage to guard a reload with', err);
    return false;
  }
  location.reload();
  return true;
}

export function lazyComponent<P extends object>(load: () => Promise<ComponentType<P>>): LazyComponent<P> {
  let loaded: ComponentType<P> | null = null;
  let loading: Promise<ComponentType<P>> | null = null;
  /**
   * The load a draw waits on, kept once it fails: React's retry reads the same promise and throws its
   * error, where a fresh one would suspend again, and load again, forever. Only a draw reloads: a
   * preload that fails says so and leaves the load to the draw.
   */
  let drawing: Promise<ComponentType<P>> | null = null;
  // A failed preload is not kept: the draw loads again.
  const start = (): Promise<ComponentType<P>> =>
    (loading ??= load().then(
      (component) => (loaded = component),
      (err: unknown) => {
        loading = null;
        throw err;
      },
    ));
  const draw = (): Promise<ComponentType<P>> =>
    (drawing ??= start().catch((err: unknown) => {
      if (reloadForNewBuild()) return new Promise<never>(() => undefined);
      throw err;
    }));
  const Lazy = (props: P): ReactNode => createElement(loaded ?? use(draw()), props);
  Lazy.preload = (): Promise<void> =>
    start().then(
      () => undefined,
      (err: unknown) => console.warn('[cardtable] a chunk did not preload; it loads again when drawn', err),
    );
  return Lazy;
}

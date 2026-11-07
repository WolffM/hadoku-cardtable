/*
 * `window.matchMedia`, for the environments that do not have it.
 *
 * WHY THIS EXISTS
 * ---------------
 * `@wolffm/themes@5.8.5` treats `matchMedia` as optional in one place and
 * mandatory in another. Its `prefersDark()` guards the call
 * (`window.matchMedia ? … : false`), but the effect that follows the OS
 * light/dark switch does not — `dist/useTheme.js:216` is a bare
 * `window.matchMedia('(prefers-color-scheme: dark)')` inside a `useEffect`.
 *
 * jsdom has never implemented `matchMedia` (verified against the pinned
 * jsdom 30.0.1: `typeof window.matchMedia === 'undefined'`), so the moment
 * `AppChrome` mounted, every existing test that renders the real `App` —
 * `screens/lobby.test.ts` and `components/DraftScreen.test.ts`, 26 cases —
 * threw `window.matchMedia is not a function` in the passive-effect commit.
 *
 * This is an upstream oversight, not a test-only concern: any embedder without
 * the API takes the same throw in the browser. Feature-detected and idempotent,
 * so in every real browser it costs one `typeof` at module load and does
 * nothing else. The fallback reports "no match", which is what a host with no
 * media-query support can honestly say, and carries the listener surface the
 * effect subscribes and unsubscribes on so the cleanup does not throw either.
 *
 * It is deliberately NOT a test fixture. Putting it in a vitest setup file
 * would have made the specs pass while leaving the production path one
 * un-polyfilled embedder away from the same crash, and would have needed the
 * root `vitest.config.ts`, which this lane does not own.
 *
 * Remove it when @wolffm/themes guards that effect the way it guards
 * `prefersDark`.
 */

interface MediaQueryListLike {
  matches: boolean;
  media: string;
  onchange: null;
  addEventListener: () => void;
  removeEventListener: () => void;
  addListener: () => void;
  removeListener: () => void;
  dispatchEvent: () => boolean;
}

type WithMatchMedia = typeof globalThis & {
  matchMedia?: (query: string) => MediaQueryListLike;
};

/** Install the fallback if and only if the host has none. Safe to call twice. */
export function ensureMatchMedia(): void {
  const host = globalThis as WithMatchMedia;
  if (typeof host.matchMedia === 'function') return;
  host.matchMedia = (media: string): MediaQueryListLike => ({
    matches: false,
    media,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    // The deprecated pair as well: a consumer that feature-detects the modern
    // one is fine, but one that falls back to `addListener` would find a
    // half-built object and throw on the fallback path instead of the main one.
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
}

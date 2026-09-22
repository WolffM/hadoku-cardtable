/*
 * The hadoku chrome this app never got.
 *
 * cardtable was hydrated from `templates/tunnel-loopback-ui`, which scaffolds
 * no UI at all, and the hydrator's "NO HADOKU CHROME" warning is gated on
 * `isProxy && !isContained` — so a loopback-ui app never sees it. Nothing in
 * the pipeline ever handed this app `HadokuThemeRoot` or `AppHeader`, and the
 * operator found the two symptoms in one viewport: no theme selector anywhere,
 * beside a watchparty chat column that WAS themed because `RoomChrome` reads
 * `@wolffm/themes` itself. `docs/requests/HADOKU_SITE_GAME_TEMPLATE.md` is the
 * ask that the next loopback-ui app not repeat it.
 *
 * This file is the fix, and it is deliberately thin: everything it renders
 * belongs to the platform.
 *
 * ## Theming is NOT ours
 *
 * `<HadokuThemeRoot>` owns the theme, its three persistence layers
 * (sessionStorage for the pre-paint script, localStorage for the next cold
 * load, the prefs row for cross-device) and the picker. There is no local
 * `useTheme`, `themePrefs` or `themeConfig` in this repo and there must never
 * be one — eight apps each carried a hand-copied `useTheme.ts` and they drifted
 * on real behaviour (only one wrote localStorage, so the rest lost the theme on
 * a browser restart). That is the entire reason the shared one exists.
 *
 * `<AppHeader>` renders the theme picker and the settings gear ITSELF. Neither
 * is a prop, and there is no slot to substitute one — which is the point.
 *
 * ## The header is not rendered here
 *
 * The shared `<AppHeader>` element is authored at the `App` root and passed in
 * as the `header` slot — the fleet's convention is that the app root mounts
 * the header, and its audit reads it there (the name it titles with comes from
 * the catalogue; see `app-name.ts`). This file slots it in at the one place it
 * is themeable: INSIDE `HadokuThemeRoot`, which is why it is a slot rather
 * than an import.
 *
 * ## One chrome per page, still
 *
 * This wraps `RoomShell`, it does not replace or duplicate it. Watchparty's
 * store and socket are module singletons; a second `RoomChrome` would share and
 * then tear down the first one's connection. See `App.tsx`.
 */

import { useRef, type ReactNode, type RefObject } from 'react';
import { HadokuThemeRoot, useHadokuTheme } from '@wolffm/themes';
import { ensureMatchMedia } from './matchMedia.ts';
import './chrome.css';

// Before anything from @wolffm/themes runs an effect: one of them calls
// `window.matchMedia` unguarded. See `matchMedia.ts` for why that is ours to
// absorb and what removes this again.
ensureMatchMedia();

export interface AppChromeProps {
  /** The shared header, as `App` authored it. Rendered inside the theme root. */
  header: ReactNode;
  children: ReactNode;
}

export function AppChrome({ header, children }: AppChromeProps) {
  // The provider mirrors `data-theme` onto this container as well as <html>,
  // which is what lets the chrome be themed even when something above it owns
  // the document.
  const containerRef = useRef<HTMLElement>(null);
  return (
    <HadokuThemeRoot containerRef={containerRef}>
      <ChromeInner containerRef={containerRef} header={header}>
        {children}
      </ChromeInner>
    </HadokuThemeRoot>
  );
}

function ChromeInner({
  containerRef,
  header,
  children,
}: AppChromeProps & { containerRef: RefObject<HTMLElement | null> }) {
  // From the provider above. There is one implementation of this in the fleet
  // and this app is now a consumer of it rather than a fork of it.
  const { isDarkTheme } = useHadokuTheme();

  return (
    <main
      ref={containerRef}
      className="cardtable-chrome"
      data-dark-theme={isDarkTheme ? 'true' : 'false'}
    >
      {header}
      <div className="cardtable-chrome__content">{children}</div>
    </main>
  );
}

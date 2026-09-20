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
 * ## Identity is NOT ours either
 *
 * `who` is threaded in from `App`, which reads the fleet's `whoami()` through
 * `useWhoami` — the SAME hook `RoomShell` already uses, and the same shared
 * in-flight promise underneath it (`globalThis.__hadokuWhoami`), so the page
 * still makes exactly one whoami call no matter how many consumers read it.
 * Passing it to `settingsProps` also stops `ConnectedSettings` resolving its
 * own identity, which would have been a second path to the same fact.
 *
 * ## One chrome per page, still
 *
 * This wraps `RoomShell`, it does not replace or duplicate it. Watchparty's
 * store and socket are module singletons; a second `RoomChrome` would share and
 * then tear down the first one's connection. See `App.tsx`.
 */

import { useRef, type ReactNode, type RefObject } from 'react';
import { AppHeader } from '@wolffm/task-ui-components';
import { HadokuThemeRoot, useHadokuTheme } from '@wolffm/themes';
import type { Who } from '../room/RoomShell.tsx';
import { ensureMatchMedia } from './matchMedia.ts';
import './chrome.css';

// Before anything from @wolffm/themes runs an effect: one of them calls
// `window.matchMedia` unguarded. See `matchMedia.ts` for why that is ours to
// absorb and what removes this again.
ensureMatchMedia();

export interface AppChromeProps {
  /** The viewer, as `App` already resolved them. `'pending'` while in flight. */
  who: Who | null | 'pending';
  children: ReactNode;
}

export function AppChrome({ who, children }: AppChromeProps) {
  // The provider mirrors `data-theme` onto this container as well as <html>,
  // which is what lets the chrome be themed even when something above it owns
  // the document.
  const containerRef = useRef<HTMLElement>(null);
  return (
    <HadokuThemeRoot containerRef={containerRef}>
      <ChromeInner containerRef={containerRef} who={who}>
        {children}
      </ChromeInner>
    </HadokuThemeRoot>
  );
}

function ChromeInner({
  containerRef,
  who,
  children,
}: AppChromeProps & { containerRef: RefObject<HTMLElement | null> }) {
  // From the provider above. There is one implementation of this in the fleet
  // and this app is now a consumer of it rather than a fork of it.
  const { isDarkTheme } = useHadokuTheme();

  const viewer = who === 'pending' || who === null ? null : who;

  return (
    <main
      ref={containerRef}
      className="cardtable-chrome"
      data-dark-theme={isDarkTheme ? 'true' : 'false'}
    >
      <AppHeader
        title="cardtable"
        // The viewer's real name, in the bar. The fleet's usual answer is that
        // identity lives inside the gear's popout and nowhere else — but the
        // thing the operator actually reported was `anon` where their name goes,
        // so it is shown in the one slot `AppHeader` leaves open for the app.
        // It renders only when the fleet HAS a name for them: a blank is honest,
        // a sentinel is what we are removing.
        status={
          viewer?.name == null ? undefined : (
            <span className="cardtable-chrome__who" data-testid="chrome-who">
              {viewer.name}
            </span>
          )
        }
        // Identity the page already knows, so the popout does not re-resolve it.
        // `ConnectedSettings` otherwise calls its own `whoami()` against
        // `/session/whoami`, which is a second identity path to the same fact.
        settingsProps={viewer === null ? undefined : { userType: viewer.tier, name: viewer.name }}
      />
      <div className="cardtable-chrome__content">{children}</div>
    </main>
  );
}

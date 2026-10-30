/*
 * The app's chrome: everything above the screens, and the boundary anything
 * that replaces it has to honour.
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
 * =====================================================================
 * THE CONTRACT — read this before swapping this file for the template
 * =====================================================================
 *
 * hadoku_site's `templates/game` is meant to replace this hand-written
 * wrapper. That swap is the whole reason this section exists: the boundary
 * it has to land on is written down here, so the replacement is a diff
 * against a stated contract rather than archaeology over six files. Wave 18
 * §D is where it was written; the audit behind "known gaps" below was run
 * then, and the line numbers are from that reading.
 *
 * ## The swap, done: it was a LAYOUT diff, not a migration (wave 21 §A)
 *
 * The operator, 2026-09-25: *"would be much better to use the child frontend
 * header that is minted with the proper standard child app header that
 * hadoku_site uses"*. Read against the reference before anything was designed
 * — `~/srv/hadoku_site/templates/game/apps/ui/src/`, `templates/ui-app` and
 * `templates/tunnel-contained` — and the answer was that we ALREADY mount the
 * fleet's header: the same `AppHeader` from `@wolffm/task-ui-components`, with
 * the same `@wolffm/task-ui-components/app-header.css` import, inside the same
 * `HadokuThemeRoot`. There is no other header in the fleet to migrate to.
 *
 * What differed was where the header SITS. The fleet's header stylesheet sets
 * no left/right/top spacing on purpose; in `templates/ui-app` and
 * `templates/tunnel-contained` the buffer comes from the content wrapper the
 * header is rendered inside (`padding: 2rem`). `templates/game` is the one
 * template that renders `<AppHeader>` OUTSIDE that wrapper, and this app was
 * written against `templates/game` — which is exactly why the bar had no edge
 * buffer. `chrome.css` now carries that one rule, with the provenance of its
 * value; see its `.cardtable-chrome > .app-header` block.
 *
 * ## The division
 *
 * `main.tsx` mounts and nothing else. `App.tsx` routes and authors the
 * header. `chrome/` frames — it owns everything ABOVE the screens and
 * nothing below them, and it knows what a pod, a room or a match is only in
 * the sense that `chrome.css` has to name their dark roots (see the island
 * seam below). Screens own themselves.
 *
 * ## What `chrome/` guarantees to whatever it wraps
 *
 * 1. **The theme tokens are defined and resolved.** `--color-*` and
 *    `--hdk-*` exist by the time a child paints, and `data-theme` is on
 *    <html> AND mirrored onto `.cardtable-chrome`, so a descendant resolves
 *    light/dark from either. `screens/screens.css` paints entirely from
 *    these. This is the designed channel between chrome and screens and the
 *    only one — there is no theme value on any prop today.
 * 1. **`color-scheme` matches the theme**, via `data-dark-theme` on the
 *    container, so native controls and scrollbars are not the wrong half.
 * 2. **One content region, and it grows.** `.cardtable-chrome__content` is a
 *    column flex item with `min-height: 0`, and its DIRECT CHILD is given
 *    `flex: 1 1 auto; min-height: 0`. A screen may assume it has the
 *    viewport minus the header and may scroll inside it; `screens.css`
 *    dropped its own `min-height: 100vh` on the strength of this.
 * 3. **`window.matchMedia` exists** before any child effect runs
 *    (`ensureMatchMedia()`, at module load — `matchMedia.ts` has the
 *    upstream bug it absorbs). A wrapper that drops it takes the throw in
 *    every jsdom test that renders `App`, and in any embedder without the
 *    API.
 * 4. **Exactly one chrome per page.** Watchparty's store and socket are
 *    module singletons; a second `RoomChrome` shares and then tears down the
 *    first one's connection. This wraps `RoomShell`, outside it, once.
 *
 * ## What a screen may assume
 *
 * Its own props, and the CSS tokens above. Nothing else. There is no chrome
 * context, no chrome export a screen imports, and no global this file sets.
 * `grep -r "from '../chrome" apps/ui/src/screens/` is empty and is meant to
 * stay empty — that grep is the cheap half of this contract.
 *
 * ## What `chrome/` will pass down when a screen needs something
 *
 * A prop from `App.tsx`, or a context exported from this directory. Never a
 * global, never a module singleton. Both candidates are already resolved
 * above the screens and neither is asked for today:
 *
 * - **Identity.** `App.tsx` reads `useWhoami()` once and spends it on the
 *   header's `status` and `settingsProps`. `RoomShell` reads the same hook,
 *   and `whoami()` shares one in-flight promise per page
 *   (`globalThis.__hadokuWhoami`), so that is one identity path with two
 *   consumers rather than two paths. A screen that needs the viewer takes it
 *   as a prop; it does not call `whoami()` itself.
 * - **Theme state.** `useHadokuTheme()` is read in `ChromeInner` and nowhere
 *   else in this repo. A screen that has to branch on light/dark takes
 *   `isDarkTheme` as a prop or reads `data-theme` in CSS.
 *
 * ## What a replacement wrapper must provide
 *
 * The five guarantees, plus the two seams this file carries that do not look
 * like chrome at first glance:
 *
 * - **The island rules in `chrome.css`** (its last three blocks). The draft
 *   table and its neighbours paint from the TABLE's palette — `--bg`,
 *   `--ink` — which is dark on purpose, and they inherit their text colour.
 *   Letting `--color-text` reach them puts a light theme's dark ink on a
 *   permanently dark tile. Those rules are the seam between the themed frame
 *   and the table; a wrapper that drops them breaks the table in light mode,
 *   and the breakage is the chrome's.
 * - **The header is a SLOT, not an import.** `App.tsx` authors `<AppHeader>`
 *   at the app root — the fleet's convention, and where its audit reads it —
 *   and this file slots it in INSIDE `HadokuThemeRoot`, the one place it is
 *   themeable. `<AppHeader>` renders the theme picker and the settings gear
 *   itself; neither is a prop and there is no slot to substitute one, which
 *   is the point. Its `title` is a NODE — a link home, with the <h1> inside
 *   it — and `chrome.css` owns the two rules that make that node stop
 *   looking like a link, plus the header's edge buffer. A wrapper that slots
 *   a different header in has to bring both.
 *
 * ## The game's settings ARE in the header's gear, through its slot
 *
 * Out of it from 2026-10-10 (a host's menu is not ours to fill, and embedded
 * there is no header), back in on 2026-10-30 when the operator made the fleet's
 * popout the one place for settings. `App.tsx` passes `CardtableSettings` as
 * `<AppHeader>`'s `children`, the slot the fleet made for exactly this: drawn
 * under "App preferences", never reaching into the header's own markup.
 * Embedded, `../settings/Settings.tsx`'s own gear stands in until watchparty
 * draws the popout.
 *
 * ## Theming is NOT ours, and must not become ours
 *
 * `<HadokuThemeRoot>` owns the theme, its three persistence layers
 * (sessionStorage for the pre-paint script, localStorage for the next cold
 * load, the prefs row for cross-device) and the picker. There is no local
 * `useTheme`, `themePrefs` or `themeConfig` in this repo and there must never
 * be one — eight apps each carried a hand-copied `useTheme.ts` and they drifted
 * on real behaviour (only one wrote localStorage, so the rest lost the theme on
 * a browser restart). That is the entire reason the shared one exists.
 *
 * ## Known gaps — where the boundary is NOT clean
 *
 * Audited at wave 18. Lane D owned only `chrome/**`, `App.tsx`, `main.tsx`
 * and `index.html`, so every one of these is reported here rather than
 * fixed: each fix lives in a file the lane did not own. They are listed
 * because a wrapper swap meets them, not because they are acceptable.
 *
 * 2. **`screens/route.ts` is a global-reading module singleton** — the hash
 *    router reads `globalThis.location.hash` (:290, :304), subscribes to
 *    `hashchange` on the global (:282, :285) and mints ids from
 *    `globalThis.crypto` (:254). Every screen imports `navigate` from it,
 *    and so does `App.tsx` (`useRoute`). It is deliberate and documented
 *    there, but it means a screen's navigation is not a prop, and a wrapper
 *    that owns routing has to meet it. The watchparty embed (D21) meets it
 *    with `routeInMemory`, which takes the router off the address bar.
 * 3. **`rooms/RoomList.tsx` subscribes to `document.visibilitychange`** in
 *    the effect that drives its poll, to stop polling on a hidden tab.
 *    Page-visibility is the shell's fact, not a list's. (No line numbers:
 *    lane C is rewriting that file in this same wave.)
 * 4. **`screens/tables.ts` (:127) and `screens/LobbyScreen.tsx` read
 *    `import.meta.env`** — `BASE_URL` for the api base, `DEV` for a
 *    dev-only affordance. Build-time, not runtime, and both optional-chain.
 *    Named so a wrapper that changes the base path knows where it is read.
 * 5. **`chrome.css` reaches DOWN**, at its last blocks, naming
 *    `.app`, `.draft`, `.board`, `.deck`, `.deckrow`, `.rooms`, `.spectate`,
 *    `.conn`, `.prompt` and `.confirm`. That is this lane's
 *    own file and it is the island seam above — deliberate, but it is a
 *    coupling in the other direction and it is the thing to delete when
 *    those sheets move onto semantic tokens.
 *
 * What is NOT here, and must not move here: routing rules, the api base,
 * room/match/draft state, and anything that knows a card. This file renders
 * a frame.
 */

import { useRef, type ReactNode, type RefObject } from 'react';
import { HadokuThemeRoot, useHadokuTheme } from '@wolffm/themes';
import { ensureMatchMedia } from './matchMedia.ts';
import './chrome.css';
import './trim.css';

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

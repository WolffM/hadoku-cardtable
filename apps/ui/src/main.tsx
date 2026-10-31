/*
 * The mount, the stylesheet order, and nothing else.
 *
 * No app logic lives here on purpose (the two exceptions are putting a stray
 * path back into the hash before the first render reads the route, and taking
 * Rally's return trip off the query, `rooms/event-forms.ts`): `App.tsx` routes and
 * `chrome/AppChrome.tsx` frames, and that file's header states the boundary a
 * replacement wrapper lands on. The one app-specific value on this path is the
 * catalogue token, and it is not read here — vite's `define` substitutes
 * `__HADOKU_APP_NAME__` into the bundle and its `transformIndexHtml` into
 * `index.html`'s <title> (see ../app-name.ts and ../vite.config.ts), so the tab
 * and the header stay one name without this file knowing it.
 *
 * The import ORDER below is load-bearing; a wrapper swap keeps tier 1 first.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

/*
 * CSS import ORDER is load-bearing, and there are now three tiers of it. ESM
 * evaluates imports in source order, and the cascade follows.
 *
 *   1. the fleet's stylesheets, which DEFINE the `--color-*` / `--hdk-*` tokens
 *      and style the shared header and picker;
 *   2. `styles.css`, the draft table's own palette on `:root` — its `--bg` /
 *      `--ink` names do not collide with the fleet's, so this adds rather than
 *      overwrites;
 *   3. the app's own sheets (`chrome/chrome.css`, `screens/screens.css`, both
 *      imported by `App.tsx`), which CONSUME the tokens above and redefine
 *      none of them.
 *
 * All six fleet imports are required, and the reasons are not interchangeable:
 * `style.css` is the token set itself, `icons.css` is icon sizing and the
 * accent tiles, `theme-picker.css` is the picker AppHeader renders,
 * `app-header.css` is the header plus the settings popout — without that one
 * the header comes out unstyled, a serif title with the controls stacked
 * down the left — and `tooltip.css` is the bubble the picker's buttons portal
 * into <body> on hover — without it the label is plain text at the end of the
 * page and pushes the room's chat up. `scrollbar.css` is the fleet's
 * scrollbar, on every scroller under `index.html`'s `<html class="hdk-scroll">` — without it each one is
 * the browser's own bar, which on Chrome swells and darkens when the pointer reaches it (the operator,
 * 2026-10-28: "why does the scrollbar change in color and style when hovered? that's pretty ugly"). Bundling them is also what keeps this page self-contained
 * instead of depending on `/mf/*` being reachable.
 */
// REQUIRED: @wolffm/themes CSS — DO NOT REMOVE
import '@wolffm/themes/style.css';
import '@wolffm/themes/icons.css';
import '@wolffm/task-ui-components/theme-picker.css';
import '@wolffm/task-ui-components/app-header.css';
import '@wolffm/task-ui-components/tooltip.css';
import '@wolffm/task-ui-components/scrollbar.css';
import './styles.css';
import { App } from './App.tsx';
import { finishRallyReturn } from './rooms/event-forms.ts';
import { canonicalizeAddress } from './screens/route.ts';

canonicalizeAddress();
void finishRallyReturn();

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

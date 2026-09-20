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
 * All four fleet imports are required, and the reasons are not interchangeable:
 * `style.css` is the token set itself, `icons.css` is icon sizing and the
 * accent tiles, `theme-picker.css` is the picker AppHeader renders, and
 * `app-header.css` is the header plus the settings popout — without that last
 * one the header comes out unstyled, a serif title with the controls stacked
 * down the left. Bundling them is also what keeps this page self-contained
 * instead of depending on `/mf/*` being reachable.
 */
// REQUIRED: @wolffm/themes CSS — DO NOT REMOVE
import '@wolffm/themes/style.css';
import '@wolffm/themes/icons.css';
import '@wolffm/task-ui-components/theme-picker.css';
import '@wolffm/task-ui-components/app-header.css';
import './styles.css';
import { App } from './App.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

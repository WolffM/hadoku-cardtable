import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { sharedVendor } from '@wolffm/shared-vendor/vite';

import { APP_BASE } from './app-base.ts';
import { APP_NAME } from './app-name.ts';
import { BUILD_DEFINES } from './build-defines.ts';
import { CHUNK_GROUPS, CHUNK_SIZE_WARNING_KB } from './chunks.ts';
import { stylesheetInSourceOrder } from './stylesheet.ts';
import { uiScaleCss } from '@hadoku/ui-shell/settings';
import { motionCss } from '@hadoku/ui-shell/motion';
import { themeInitScript } from '@hadoku/ui-shell/theme';

/**
 * The app is served under `hadoku.me/cardtable/` (PPE: `/cardtable-ppe/`) behind
 * the friend gate, so the base path is not `/`. See app-base.ts.
 */
export default defineConfig({
  base: APP_BASE,
  define: BUILD_DEFINES,
  plugins: [
    // react and the shared @wolffm packages come from the ONE copy every hadoku page loads, through
    // the import map edge-router puts in this page's <head>: a header or settings change reaches
    // cardtable (prod included) on the site's deploy, with no release here. The list is
    // @wolffm/shared-vendor's. The embed build (vite.embed.config.ts) keeps its own.
    sharedVendor(),
    react(),
    stylesheetInSourceOrder(),
    {
      // index.html is static and cannot import the catalogue; this keeps the
      // standalone TAB and the standalone HEADER the one name.
      name: 'hadoku-app-name',
      transformIndexHtml: (html: string) => html.split('__HADOKU_APP_NAME__').join(APP_NAME),
    },
    {
      // The theme on <html> before the stylesheet paints anything. See theme-init.ts.
      name: 'hadoku-theme-init',
      transformIndexHtml: () => [{ tag: 'script', attrs: { 'data-theme-init': '' }, children: themeInitScript(), injectTo: 'head-prepend' as const }],
    },
  ],
  // Every length our own sheets author, as a multiple of the UI scale (`src/settings/ui-scale.ts`); every
  // motion query and endless loop, answering to the player's motion switches (`@hadoku/ui-shell/motion`).
  css: { postcss: { plugins: [uiScaleCss, motionCss] } },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // One stylesheet, linked from index.html, in source order (`stylesheet.ts`). Every screen but
    // the lobby is a lazy chunk (`@hadoku/game-ui/lazy.ts`), and a split sheet would be linked as its chunk
    // loads: after the rest, in whatever order the player opened the screens.
    cssCodeSplit: false,
    chunkSizeWarningLimit: CHUNK_SIZE_WARNING_KB,
    rolldownOptions: { output: { codeSplitting: { groups: CHUNK_GROUPS } } },
  },
});

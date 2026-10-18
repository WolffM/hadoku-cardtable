import { readFileSync } from 'node:fs';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import { APP_NAME } from './app-name.ts';
import { themeInitScript } from './theme-init.ts';

/** The bundle's own version, from package.json at build time, so a match log names the build each seat ran. */
const UI_VERSION: string = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;

/**
 * The app is served under `hadoku.me/cardtable/` behind the friend gate, so the
 * base path is not `/`.
 */
export default defineConfig({
  base: '/cardtable/',
  define: {
    // The catalogue's name for this app. A define lands in the browser bundle,
    // so what goes into it must be PUBLIC data — the display name is; nothing
    // else uses this mechanism. See app-name.ts.
    __HADOKU_APP_NAME__: JSON.stringify(APP_NAME),
    // The version a seat's browser is running, reported in its `info` telemetry: the one fact that
    // tells a stale tab from a regression when a player reports an animation the deploy had replaced.
    __HADOKU_UI_VERSION__: JSON.stringify(UI_VERSION),
  },
  plugins: [
    react(),
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
  build: { outDir: 'dist', sourcemap: true },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import { APP_BASE } from './app-base.ts';
import { APP_NAME } from './app-name.ts';
import { BUILD_DEFINES } from './build-defines.ts';
import { uiScaleCss } from './src/settings/ui-scale.ts';
import { themeInitScript } from './theme-init.ts';

/**
 * The app is served under `hadoku.me/cardtable/` (PPE: `/cardtable-ppe/`) behind
 * the friend gate, so the base path is not `/`. See app-base.ts.
 */
export default defineConfig({
  base: APP_BASE,
  define: BUILD_DEFINES,
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
  // Every length our own sheets author, as a multiple of the UI scale (`src/settings/ui-scale.ts`).
  css: { postcss: { plugins: [uiScaleCss] } },
  build: { outDir: 'dist', sourcemap: true },
});

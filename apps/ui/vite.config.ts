import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import { APP_NAME } from './app-name.ts';

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
  },
  plugins: [
    react(),
    {
      // index.html is static and cannot import the catalogue; this keeps the
      // standalone TAB and the standalone HEADER the one name.
      name: 'hadoku-app-name',
      transformIndexHtml: (html: string) => html.split('__HADOKU_APP_NAME__').join(APP_NAME),
    },
  ],
  build: { outDir: 'dist', sourcemap: true },
});

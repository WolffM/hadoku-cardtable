import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { embedBuild } from '@hadoku/ui-shell/embed/vite';

import { APP_BASE } from './app-base.ts';
import { BUILD_DEFINES } from './build-defines.ts';
import { CHUNK_GROUPS, CHUNK_SIZE_WARNING_KB } from './chunks.ts';
import { stylesheetInSourceOrder } from './stylesheet.ts';
import { uiScaleCss } from '@hadoku/ui-shell/settings';
import { motionCss } from '@hadoku/ui-shell/motion';

/**
 * The second build: the game bundle a watchparty room imports (D21), `dist/embed/cardtable-embed.js`
 * and its one `dist/embed/cardtable-embed.css`. Every game's embed build is the same preset
 * (`@hadoku/ui-shell/embed/vite`, whose header says why each setting is what it is).
 *
 * Cardtable's own on top of it:
 * - **`hostTheme`.** Every theme also themes `:host`, and `mount` stamps the theme on the host.
 *   Without it the host painted `#f8fafc` under every theme, a white flash between the sheet's
 *   adoption and React's first commit.
 * - **The UI scale's and the motion switches' PostCSS passes**, the sheets in source order, and the page
 *   build's chunk groups.
 */
const preset = embedBuild({
  app: 'cardtable',
  base: APP_BASE,
  hostTheme: true,
  postcssPlugins: [uiScaleCss, motionCss],
  sourcemap: true,
  chunkSizeWarningLimit: CHUNK_SIZE_WARNING_KB,
  output: { codeSplitting: { groups: CHUNK_GROUPS } },
});

export default defineConfig({
  ...preset,
  define: BUILD_DEFINES,
  plugins: [react(), stylesheetInSourceOrder(), ...preset.plugins],
});

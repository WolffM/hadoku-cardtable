import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The app is served under `hadoku.me/cardtable/` behind the friend gate, so the
 * base path is not `/`. Nothing here talks to a server: this wave renders
 * committed fixtures only, so there is no proxy and no websocket config.
 */
export default defineConfig({
  base: '/cardtable/',
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true },
});

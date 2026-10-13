import { defineConfig, type Plugin as VitePlugin } from 'vite';
import react from '@vitejs/plugin-react';

import { APP_NAME } from './app-name.ts';

/**
 * The second build: the game bundle a watchparty room imports (D21).
 *
 * `dist/embed/cardtable-embed.js` is an ES module exporting `mount`; it and
 * `dist/embed/cardtable-embed.css` keep those names across builds (the
 * server serves both `no-cache`), and everything else lands content-hashed
 * under `dist/embed/assets/` (served immutable).
 *
 * - **`base` is the APP's, `/cardtable/`**, not `/cardtable/embed/`: the API
 *   and socket bases are read from `BASE_URL`, and they are the app's. The
 *   output paths carry the `embed/` themselves, so asset URLs come out as
 *   `/cardtable/embed/assets/…` — absolute, which is what lets the bundle run
 *   on watchparty's page and still reach our origin's paths.
 * - **Runs after the page build, into the same `dist/`, without emptying it.**
 * - **One stylesheet, `cssCodeSplit: false`.** A split sheet is loaded at
 *   runtime by a `<link>` Vite appends to `document.head` — the host's page,
 *   outside our shadow root, where it would style watchparty and not us. One
 *   file, fetched and adopted by the shadow root, is the whole mechanism
 *   (`src/embed/styles.ts`).
 * - **`:root`, `html` and `body` become `:host`.** None of them exists inside a
 *   shadow tree, and the fleet's tokens and the table's palette are declared
 *   on `:root`. Rewritten at build time so the shipped sheet is the sheet that
 *   applies.
 * - **Every theme also themes `:host`.** After the rewrite `:host` carries the
 *   fleet's DEFAULT (light) tokens and the `body` background, and no
 *   `[data-theme]` inside the shadow tree can reach the host element. So a bare
 *   `[data-theme=x]` also emits `:host([data-theme=x])`, and `mount` stamps the
 *   theme on the host. Without it the host painted `#f8fafc` under every theme,
 *   a white flash between the sheet's adoption and React's first commit.
 */

/** `:root` / `html` / `body` as a compound's type or pseudo-class → `:host`. */
export function toShadowSelector(selector: string): string {
  return selector.replace(/:root\b/g, ':host').replace(/(^|[\s,>+~(])(?:html|body)(?![\w-])/g, '$1:host');
}

const THEME_SELECTOR = /^\[data-theme(?:=[^\]]+)?\]$/;

/** A bare `[data-theme…]` selector also matches the host carrying it. Idempotent — postcss revisits a changed rule. */
export function withHostTheme(selectors: readonly string[]): string[] {
  const present = new Set(selectors.map((s) => s.trim()));
  return selectors.flatMap((s) => {
    const host = `:host(${s.trim()})`;
    return THEME_SELECTOR.test(s.trim()) && !present.has(host) ? [s, host] : [s];
  });
}

const shadowRootSelectors = {
  postcssPlugin: 'cardtable-shadow-root-selectors',
  Rule(rule: { selector: string; selectors: string[] }) {
    rule.selector = toShadowSelector(rule.selector);
    rule.selectors = withHostTheme(rule.selectors);
  },
};

/** Fixed names for the entry and its stylesheet; everything else hashed. */
const ENTRY = 'embed/cardtable-embed.js';
const STYLESHEET = 'embed/cardtable-embed.css';

/** Fails the build if the one stylesheet did not come out under its fixed name. */
const requireOneStylesheet: VitePlugin = {
  name: 'cardtable-embed-one-stylesheet',
  writeBundle(_options, bundle) {
    const sheets = Object.keys(bundle).filter((name) => name.endsWith('.css'));
    if (sheets.length !== 1 || sheets[0] !== STYLESHEET) {
      this.error(`the embed build must emit exactly ${STYLESHEET}; it emitted ${sheets.join(', ') || 'no stylesheet'}`);
    }
  },
};

export default defineConfig({
  base: '/cardtable/',
  define: {
    __HADOKU_APP_NAME__: JSON.stringify(APP_NAME),
  },
  plugins: [react(), requireOneStylesheet],
  css: { postcss: { plugins: [shadowRootSelectors] } },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    cssCodeSplit: false,
    assetsDir: 'embed/assets',
    rollupOptions: {
      input: 'src/embed/index.tsx',
      preserveEntrySignatures: 'exports-only',
      output: {
        entryFileNames: ENTRY,
        chunkFileNames: 'embed/assets/[name]-[hash].js',
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith('.css')) ? STYLESHEET : 'embed/assets/[name]-[hash][extname]',
      },
    },
  },
});

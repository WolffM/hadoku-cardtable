/*
 * The embed build: the game bundle a host page imports, as a Vite config preset. Typed structurally,
 * so this package needs no Vite of its own: a game spreads the result into its own `defineConfig`.
 *
 * `dist/embed/<app>-embed.js` is an ES module exporting `mount`; it and `dist/embed/<app>-embed.css`
 * keep those names across builds (the server serves both `no-cache`), and everything else lands
 * content-hashed under `dist/embed/assets/` (served immutable).
 *
 * - **`base` is the APP's, `/<app>/`**, not `/<app>/embed/`: the API and socket bases are read from
 *   `BASE_URL`, and they are the app's. The output paths carry the `embed/` themselves, so asset URLs
 *   come out as `/<app>/embed/assets/…` — absolute, which is what lets the bundle run on the host's
 *   page and still reach the app's paths.
 * - **Runs after the page build, into the same `dist/`, without emptying it.**
 * - **One stylesheet, `cssCodeSplit: false`.** A split sheet is loaded at runtime by a `<link>` Vite
 *   appends to `document.head` — the host's page, outside the shadow root, where it would style the
 *   host and not the game. One file, fetched and adopted by the shadow root, is the whole mechanism
 *   (`./styles.ts`). The build fails if it does not come out as exactly that one file.
 * - **`:root`, `html` and `body` become `:host`.** None of them exists inside a shadow tree, and the
 *   fleet's tokens are declared on `:root`. Rewritten at build time so the shipped sheet is the sheet
 *   that applies.
 * - **`hostTheme`: every theme also themes `:host`.** After the rewrite `:host` carries the fleet's
 *   DEFAULT (light) tokens and the `body` background, and no `[data-theme]` inside the shadow tree can
 *   reach the host element. So a bare `[data-theme=x]` also emits `:host([data-theme=x])`, and the
 *   mount stamps the theme on the host (`mountEmbed`'s `hostTheme`). Without it the host painted the
 *   light background under every theme, a white flash between the sheet's adoption and React's first
 *   commit. Cardtable's.
 * - **`manifest`: what the game says about itself to a host** (`@hadoku/platform-wire/external-game-manifest`:
 *   its name, its seat range, its seat hold), written as `dist/embed/manifest.json` beside the entry
 *   and served `no-cache` like it. Checked against the host's own schema here, so a manifest a host
 *   would refuse fails this build instead.
 */
import {
  EXTERNAL_GAME_MANIFEST_FILE,
  externalGameManifest,
  type ExternalGameManifestInput,
} from '@hadoku/platform-wire/external-game-manifest';

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

export interface ShadowRootSelectorsPlugin {
  postcssPlugin: string;
  Rule(rule: { selector: string; selectors: string[] }): void;
}

/** The PostCSS plugin that rewrites the document roots, and with `hostTheme` themes the host. */
export function shadowRootSelectors({ hostTheme = false }: { hostTheme?: boolean } = {}): ShadowRootSelectorsPlugin {
  return {
    postcssPlugin: 'embed-shadow-root-selectors',
    Rule(rule) {
      rule.selector = toShadowSelector(rule.selector);
      if (hostTheme) rule.selectors = withHostTheme(rule.selectors);
    },
  };
}

/** The fixed names the bundle is served under. */
export function embedFiles(app: string): { entry: string; stylesheet: string; manifest: string } {
  return { entry: `embed/${app}-embed.js`, stylesheet: `embed/${app}-embed.css`, manifest: `embed/${EXTERNAL_GAME_MANIFEST_FILE}` };
}

export interface EmbedManifestPlugin {
  name: string;
  generateBundle(this: { emitFile(file: { type: 'asset'; fileName: string; source: string }): string }): void;
}

/** Writes the game's manifest beside the entry, after checking it is one a host would read. */
export function emitManifest(fileName: string, manifest: ExternalGameManifestInput): EmbedManifestPlugin {
  const checked = externalGameManifest.safeParse(manifest);
  if (!checked.success) throw new Error(`the embed manifest is not one a host would read: ${checked.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  const source = `${JSON.stringify(checked.data, null, 2)}\n`;
  return {
    name: 'embed-manifest',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName, source });
    },
  };
}

export interface OneStylesheetPlugin {
  name: string;
  writeBundle(this: { error(message: string): never }, options: unknown, bundle: Record<string, unknown>): void;
}

/** Fails the build if the one stylesheet did not come out under its fixed name. */
export function requireOneStylesheet(stylesheet: string): OneStylesheetPlugin {
  return {
    name: 'embed-one-stylesheet',
    writeBundle(_options, bundle) {
      const sheets = Object.keys(bundle).filter((name) => name.endsWith('.css'));
      if (sheets.length !== 1 || sheets[0] !== stylesheet) {
        this.error(`the embed build must emit exactly ${stylesheet}; it emitted ${sheets.join(', ') || 'no stylesheet'}`);
      }
    },
  };
}

export interface EmbedBuildOptions<Warn, Output extends object, Post> {
  /** The app's id: `embed/<app>-embed.js` and `embed/<app>-embed.css`. */
  app: string;
  /** The APP's base, `/<app>/`. */
  base: string;
  /** Default `src/embed/index.tsx`. */
  input?: string;
  /** Theme `:host` from every bare `[data-theme]` rule; pair with `mountEmbed`'s `hostTheme`. */
  hostTheme?: boolean;
  /** More PostCSS plugins, after the shadow-root rewrite. */
  postcssPlugins?: readonly Post[];
  sourcemap?: boolean;
  target?: string;
  chunkSizeWarningLimit?: number;
  onwarn?: Warn;
  /** More of the bundler's output options (cardtable's chunk groups); the file names are the preset's. */
  output?: Output;
  /** What a host reads to make this game a room type; written as `embed/manifest.json`. Absent, no manifest is written. */
  manifest?: ExternalGameManifestInput;
}

/**
 * The embed build's config. Spread it into `defineConfig`, and put the game's own plugins (React)
 * before `preset.plugins`.
 */
export function embedBuild<Warn = never, Output extends object = Record<never, never>, Post = never>({
  app,
  base,
  input = 'src/embed/index.tsx',
  hostTheme = false,
  postcssPlugins = [],
  sourcemap = false,
  target,
  chunkSizeWarningLimit,
  onwarn,
  output,
  manifest,
}: EmbedBuildOptions<Warn, Output, Post>) {
  const files = embedFiles(app);
  const { entry, stylesheet } = files;
  return {
    base,
    plugins: [requireOneStylesheet(stylesheet), ...(manifest === undefined ? [] : [emitManifest(files.manifest, manifest)])],
    css: { postcss: { plugins: [shadowRootSelectors({ hostTheme }), ...postcssPlugins] } },
    build: {
      outDir: 'dist',
      emptyOutDir: false as const,
      sourcemap,
      cssCodeSplit: false as const,
      assetsDir: 'embed/assets',
      ...(target === undefined ? {} : { target }),
      ...(chunkSizeWarningLimit === undefined ? {} : { chunkSizeWarningLimit }),
      rollupOptions: {
        input,
        ...(onwarn === undefined ? {} : { onwarn }),
        preserveEntrySignatures: 'exports-only' as const,
        output: {
          ...(output ?? ({} as Output)),
          entryFileNames: entry,
          chunkFileNames: 'embed/assets/[name]-[hash].js',
          assetFileNames: (asset: { names: readonly string[] }) =>
            asset.names.some((name) => name.endsWith('.css')) ? stylesheet : 'embed/assets/[name]-[hash][extname]',
        },
      },
    },
  };
}

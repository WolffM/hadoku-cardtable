/**
 * The UI's fit pages (`games/magic/ui/src/fit/*.html`), served by the app's own Vite: the e2e package carries
 * no bundler of its own. And the check that a bundle is React's production build.
 *
 * Vite's dev server sets `process.env.NODE_ENV` to development in its whole process when it is unset,
 * and a build later in that process keeps it and bundles React's development build, whose render is
 * several times slower. Playwright runs every spec of a run in one worker (`playwright.config.ts`), so
 * a dev server one spec started decided what a later spec built: `wperf3-draft-open` timed a
 * development render on ci.yml (227.8 ms of CPU, 188 of it script) and a production one on forge.yml,
 * where it ran alone (~100 ms on the same claw). So a dev server here puts NODE_ENV back when it
 * closes, a build here is production whatever ran before it, and what is measured is checked to be.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const UI = resolve(import.meta.dirname, '..', 'apps/ui');

interface Server {
  close(): Promise<void>;
  resolvedUrls: { local: string[] } | null;
}

interface Vite {
  createServer(config: Record<string, unknown>): Promise<Server & { listen(): Promise<unknown> }>;
  build(config: Record<string, unknown>): Promise<unknown>;
  preview(config: Record<string, unknown>): Promise<Server>;
}

/** Fit pages being served: `base` is their origin, with a trailing slash. */
export interface FitPages {
  base: string;
  close(): Promise<void>;
}

const vite = async (): Promise<Vite> => (await import(pathToFileURL(resolve(UI, 'node_modules/vite/dist/node/index.js')).href)) as Vite;
const CONFIG = { configFile: resolve(UI, 'vite.config.ts'), root: UI, logLevel: 'error' };

/** Runs `f` with NODE_ENV set to `value` (or left alone when undefined), and puts the old value back after. */
async function withNodeEnv<T>(value: string | undefined, f: () => Promise<T>): Promise<{ result: T; restore: () => void }> {
  const was = process.env.NODE_ENV;
  if (value !== undefined) process.env.NODE_ENV = value;
  const restore = (): void => {
    if (was === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = was;
  };
  try {
    return { result: await f(), restore };
  } catch (e) {
    restore();
    throw e;
  }
}

function baseOf(server: Server): string {
  const base = server.resolvedUrls?.local[0] ?? '';
  if (base === '') throw new Error('the fit pages are not served');
  return base;
}

/** The fit pages from the dev server (no HMR), for specs that measure geometry, never time. */
export async function serveFitPages(): Promise<FitPages> {
  const v = await vite();
  const { result: server, restore } = await withNodeEnv(undefined, async () => {
    const s = await v.createServer({ ...CONFIG, server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
    await s.listen();
    return s;
  });
  return {
    base: baseOf(server),
    close: async () => {
      await server.close();
      restore();
    },
  };
}

/** Throws unless every script in `dir` (and its `assets/`) is free of React's development build. */
export function assertProductionBundle(dir: string): void {
  const scripts = [dir, join(dir, 'assets')].filter(existsSync).flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.js')).map((f) => join(d, f)));
  if (scripts.length === 0) throw new Error(`no scripts in ${dir}`);
  // React's development build carries its warnings; the production build carries none.
  const dev = scripts.filter((f) => readFileSync(f, 'utf8').includes('Each child in a list should have a unique'));
  if (dev.length > 0) throw new Error(`React's development build is bundled in ${dev.join(', ')}: NODE_ENV was not production when it was built`);
}

/** One fit page (`games/magic/ui/src/fit/<page>.html`) built for production with the app's config, checked, and previewed: for specs that time it. */
export async function buildFitPage(page: string): Promise<FitPages> {
  const v = await vite();
  const out = mkdtempSync(join(tmpdir(), `fit-${page}-`));
  const config = { ...CONFIG, base: '/' };
  const { restore } = await withNodeEnv('production', () =>
    v.build({ ...config, mode: 'production', build: { outDir: out, emptyOutDir: true, sourcemap: false, rollupOptions: { input: { fit: resolve(UI, `src/fit/${page}.html`) } } } }),
  );
  restore();
  try {
    assertProductionBundle(out);
    const server = await v.preview({ ...config, build: { outDir: out }, preview: { host: '127.0.0.1', port: 0, strictPort: false } });
    return {
      base: baseOf(server),
      close: async () => {
        await server.close();
        rmSync(out, { recursive: true, force: true });
      },
    };
  } catch (e) {
    rmSync(out, { recursive: true, force: true });
    throw e;
  }
}

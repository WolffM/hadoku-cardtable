/**
 * The draft opens without a frozen frame. Filmed on main (trailer clip "draft"), the pod's first frame
 * took 1,006 ms: `SeatBar` searched every seat's pile room (`pack-queue.ts`'s `pileRoom`, ~600 ms of
 * arithmetic for a pod of eight) inside the render that first draws the pod. The search now runs a
 * slice per task after that frame (`pileSearch`, `SeatBar`'s `usePiles`), and no frame from the swap
 * to the piles drawn may be long.
 *
 * Measured on the REAL screen (`apps/ui/src/fit/draft-load.html` mounts `DraftScreen` for a pod of
 * eight, with packs waiting), BUILT for production with the app's own Vite config — a dev server's
 * React is several times slower and would measure a frame no player draws — with Chromium's
 * long-animation-frame entries: every frame over 50 ms, its length and the script that ran in it.
 * More than 100 ms is red.
 *
 * Needs no server: it only reads the screen. No Forge, never skipped. `[wperf3]` lines are the evidence.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '..');
const UI = resolve(ROOT, 'apps/ui');
/** The longest frame allowed from the swap to the piles drawn. */
const LONGEST_MS = 100;

interface Preview {
  close(): Promise<void>;
  resolvedUrls: { local: string[] } | null;
}

declare global {
  interface Window {
    /** The fit page's swap from the skeleton to the draft (`fit/draft-load.tsx`). */
    load: () => void;
    longFrames: { ms: number; scripts: { invoker: string; ms: number }[] }[];
  }
}

test.use({ viewport: { width: 1280, height: 800 } });

let preview: Preview | null = null;
let base = '';
const out = mkdtempSync(join(tmpdir(), 'wperf3-fit-'));

test.beforeAll(async () => {
  test.setTimeout(120_000);
  // The app's own Vite: the e2e package carries no bundler of its own.
  const vite = (await import(pathToFileURL(resolve(UI, 'node_modules/vite/dist/node/index.js')).href)) as {
    build: (config: Record<string, unknown>) => Promise<unknown>;
    preview: (config: Record<string, unknown>) => Promise<Preview>;
  };
  const config = { configFile: resolve(UI, 'vite.config.ts'), root: UI, base: '/', logLevel: 'error' };
  await vite.build({ ...config, build: { outDir: out, emptyOutDir: true, sourcemap: false, rollupOptions: { input: { fit: resolve(UI, 'src/fit/draft-load.html') } } } });
  preview = await vite.preview({ ...config, build: { outDir: out }, preview: { host: '127.0.0.1', port: 0, strictPort: false } });
  base = preview.resolvedUrls?.local[0] ?? '';
  expect(base, 'the fit page is served').not.toBe('');
});

test.afterAll(async () => {
  await preview?.close();
  rmSync(out, { recursive: true, force: true });
});

test('the draft opens with no long frame: the pod is drawn first, its piles searched a slice at a time', async ({ page }) => {
  // Every seat with packs waiting, so every seat's pile is searched and drawn.
  const queue = [1, 2, 3, 1, 2, 3, 1, 2];
  await page.goto(`${base}src/fit/draft-load.html?q=${queue.join(',')}`);
  await expect(page.locator('[data-testid="pod-waiting"]')).toBeVisible();
  // Let the skeleton settle as it would on a slow socket.
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.longFrames = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & { scripts: (PerformanceEntry & { invoker: string })[] })[]) {
        window.longFrames.push({ ms: Math.round(e.duration), scripts: e.scripts.map((s) => ({ invoker: s.invoker, ms: Math.round(s.duration) })) });
      }
    }).observe({ type: 'long-animation-frame', buffered: false });
  });
  const swapped = Date.now();
  await page.evaluate(() => window.load());
  await expect(page.getByTestId('draft-screen')).toBeVisible();
  await expect(page.locator('.packq__pack[data-testid]'), 'every waiting pack is drawn').toHaveCount(queue.reduce((a, b) => a + b, 0), { timeout: 15_000 });
  const drawn = Date.now() - swapped;
  // The frame the last pile lands in is reported once it ends.
  await page.waitForTimeout(500);
  const frames = await page.evaluate(() => window.longFrames);
  const longest = Math.max(0, ...frames.map((f) => f.ms));
  console.log(`[wperf3] draft open: piles drawn ${drawn} ms after the swap; frames over 50 ms: ${JSON.stringify(frames)}`);
  expect(longest, `the longest frame from the swap to the piles drawn (${JSON.stringify(frames)})`).toBeLessThanOrEqual(LONGEST_MS);
});

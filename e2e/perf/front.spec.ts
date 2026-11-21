/**
 * The front page, as a player's browser meets it (the operator, 2026-11-20: *"some parts of the site feel
 * laggy including drafting, main page, and also during the game"*). Three windows, each on the screen prod's
 * telemetry says players have (1664×950 at a 1.5 device pixel ratio, the most common `env` and `scroll` rows):
 *
 *   cold   a first visit, nothing cached: navigation to the room list drawn and the page settled
 *   warm   the same page again, the browser's cache warm: what a returning player waits for
 *   idle   nobody touches it for a few seconds: what the page costs just being open
 *
 * Cold and warm print the page's own clocks (first paint, largest paint, DOM ready, the room list's
 * first row, load), what it downloaded by kind, and the longest main-thread tasks on the thread's CPU
 * clock. Every window prints each browser thread's CPU per second (`threads.ts`), and idle lists what is
 * animating while nothing happens. The art is real JPEGs (`real-art.ts`), not the flat stand-in the other
 * specs use, because decoding art is part of what a player waits for.
 *
 * Asserts only that each window measured something; the numbers are the evidence (`[front-perf]` lines and
 * `e2e/.run/perf/front-*.json`). A CI runner rasters in software on a shared CPU, so the milliseconds are
 * for comparing runs on one runner, before and after a change, not for gating.
 *
 * `[nightly]`: too slow for `ci.yml`'s check; `forge.yml` runs it nightly, and on a claw on purpose with
 * `-f only=e2e -f specs='perf/front.spec.ts'`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from '../identities.ts';
import { keepPrefsLocal } from '../prefsLocal.ts';
import { realArtKb, serveRealArt } from './real-art.ts';
import { logThreads, runningAnimations, traceThreads, type ThreadReport } from './threads.ts';

/** Prod's room count when its scroll telemetry was read (2026-11-20). */
const ROOMS = 24;
const SCREEN = { width: 1664, height: 950 };
const DPR = 1.5;
const IDLE_MS = 6_000;
/** How long after `load` the page counts as still loading: the lobby's late reads and their art. */
const SETTLE_MS = 3_000;

declare global {
  interface Window {
    frontPerf: { firstRow: number | null; lcp: number };
  }
}

/** In the page before its own code: when the first room row is drawn, and the largest paint. */
function watchFirstRow(): void {
  const rec = { firstRow: null as number | null, lcp: 0 };
  window.frontPerf = rec;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) rec.lcp = Math.max(rec.lcp, e.startTime);
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  const seen = (): boolean => {
    if (rec.firstRow !== null || document.querySelector('[data-testid="room-row"]') === null) return false;
    // The frame it is drawn in, not the mutation that added it.
    requestAnimationFrame(() => (rec.firstRow = performance.now()));
    return true;
  };
  const mo = new MutationObserver(() => {
    if (seen()) mo.disconnect();
  });
  document.addEventListener('DOMContentLoaded', () => mo.observe(document.body, { childList: true, subtree: true }));
}

interface Load {
  clocks: Record<string, number | null>;
  bytes: Record<string, { n: number; kb: number }>;
  heaviest: string[];
}

async function readLoad(page: Page): Promise<Load> {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
    const round = (n: number | null): number | null => (n === null ? null : Math.round(n));
    const bytes: Record<string, { n: number; kb: number }> = {};
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    for (const r of resources) {
      const kind = /\.js(\?|$)/.test(r.name) ? 'js' : /\.css(\?|$)/.test(r.name) ? 'css' : /\/api\/art\//.test(r.name) ? 'art' : r.initiatorType;
      const b = (bytes[kind] ??= { n: 0, kb: 0 });
      b.n += 1;
      // A fulfilled route reports no transfer; its body size is what the page took in.
      b.kb += Math.round((r.transferSize || r.encodedBodySize) / 1024);
    }
    const heaviest = resources
      .filter((r) => /\.js(\?|$)/.test(r.name))
      .sort((a, b) => (b.transferSize || b.encodedBodySize) - (a.transferSize || a.encodedBodySize))
      .slice(0, 6)
      .map((r) => `${r.name.split('/').pop()!.split('?')[0]} ${Math.round((r.transferSize || r.encodedBodySize) / 1024)}KB@${Math.round(r.responseEnd)}`);
    return {
      clocks: {
        ttfb: round(nav.responseStart),
        fcp: round(fcp),
        domReady: round(nav.domContentLoadedEventEnd),
        firstRow: round(window.frontPerf.firstRow),
        lcp: round(window.frontPerf.lcp),
        load: round(nav.loadEventEnd),
        requests: resources.length,
      },
      bytes,
      heaviest,
    };
  });
}

async function member(browser: Browser, name: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: SCREEN, deviceScaleFactor: DPR, colorScheme: 'dark' });
  await context.addCookies([{ name: SESSION_COOKIE, value: name, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  // Nothing leaves the machine; art is answered in the page (`serveRealArt`).
  await context.route('**/*', (route) => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort('blockedbyclient')));
  const page = await context.newPage();
  await page.addInitScript(watchFirstRow);
  await serveRealArt(page);
  return { context, page };
}

function save(name: string, data: unknown): void {
  const dir = resolve(import.meta.dirname, '../.run/perf');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${name}.json`), JSON.stringify(data, null, 1));
}

test('[nightly] perf: the front page, cold, warm and left alone', async ({ browser }) => {
  test.setTimeout(4 * 60_000);
  // Topped up to ROOMS: the harness's server keeps the rooms earlier specs opened.
  const seeder = await member(browser, 'bob');
  const open = (await (await seeder.context.request.get(`${EDGE_ORIGIN}${PREFIX}/api/rooms`)).json()) as { rooms: unknown[] };
  for (let i = open.rooms.length + 1; i <= ROOMS; i++) {
    const made = await seeder.context.request.post(`${EDGE_ORIGIN}${PREFIX}/api/rooms`, { data: { name: `perf ${i}`, gameType: i % 3 === 0 ? 'draft' : 'constructed-1v1' } });
    expect(made.status()).toBe(201);
  }
  await seeder.context.close();

  const { context, page } = await member(browser, 'alice');
  try {
    const reports: Record<string, { load?: Load; threads: ThreadReport; animating?: [string, number][] }> = {};
    for (const visit of ['cold', 'warm'] as const) {
      const trace = await traceThreads(browser, page);
      await page.goto(`${EDGE_ORIGIN}${PREFIX}/`, { waitUntil: 'load' });
      await expect(page.getByTestId('room-row').first()).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(SETTLE_MS);
      const threads = await trace.stop();
      const load = await readLoad(page);
      reports[visit] = { load, threads };
      console.log(`[front-perf] ${visit}: ${Object.entries(load.clocks).map(([k, v]) => `${k}=${v ?? '?'}`).join(' ')}`);
      console.log(`[front-perf] ${visit}: bytes ${Object.entries(load.bytes).map(([k, v]) => `${k}=${v.n}/${v.kb}KB`).join(' ')}; art is ${realArtKb()} KB a card`);
      console.log(`[front-perf] ${visit}: heaviest js ${load.heaviest.join(', ')}`);
      logThreads('front-perf', `${visit} load..+${SETTLE_MS}ms`, threads);
      expect(load.clocks.firstRow, `${visit}: the room list was drawn`).not.toBeNull();
    }

    const animating = await runningAnimations(page);
    const trace = await traceThreads(browser, page);
    await page.waitForTimeout(IDLE_MS);
    const idle = await trace.stop();
    reports.idle = { threads: idle, animating };
    logThreads('front-perf', 'idle', idle);
    console.log(`[front-perf] idle: animating ${animating.map(([n, c]) => `${n}×${c}`).join(', ') || 'nothing'}`);
    expect(idle.threads.length, 'the idle trace saw the page').toBeGreaterThan(0);
    save('front', reports);
  } finally {
    await context.close();
  }
});

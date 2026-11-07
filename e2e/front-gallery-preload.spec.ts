/**
 * The front page's wildcard gallery warms the art of its other pages after the page has shown itself,
 * so turning to the cube spotlight draws its art at once. The operator, 2026-11-01: *"when switching
 * the right front page gallery to show 'featured cube' it takes a few sec for the images to load.
 * please lets preload the images after the core sight as loaded with lazy load."*
 *
 *  - no art of a page that is not on screen is asked for before the page has shown itself: it never
 *    competes with the first paint;
 *  - after that, the cube page's art is asked for before anyone turns to it;
 *  - turned to, the cube page never draws a picture that is not decoded yet: its art boxes stand empty
 *    until the whole set can be drawn, and no box moves within the page when it is;
 *  - with Save-Data on, nothing is warmed: the art loads only when the page is turned to.
 *
 * Art is served by the test (an SVG drawn here, slowed down), never fetched from Scryfall.
 * `[gallery-preload]` lines are the evidence.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { keepPrefsLocal } from './prefsLocal.ts';
import { ART_ROUTE } from './art.ts';

/** How long each picture takes to arrive: long enough that a picture drawn before it is decoded is seen. */
const ART_DELAY_MS = 700;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="#468"/></svg>';

interface Run {
  page: Page;
  context: BrowserContext;
  /** Wall clock of every art request, as the test's route saw it. */
  asked: Array<{ url: string; at: number }>;
}

async function open(browser: Browser, saveData: boolean): Promise<Run> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: SESSION_COOKIE, value: 'carol', domain: '127.0.0.1', path: '/' }]);
  await keepPrefsLocal(context, EDGE_ORIGIN);
  const asked: Run['asked'] = [];
  await context.route(ART_ROUTE, async (route) => {
    asked.push({ url: route.request().url(), at: Date.now() });
    await new Promise((done) => setTimeout(done, ART_DELAY_MS));
    await route.fulfill({ contentType: 'image/svg+xml', body: SVG });
  });
  await context.addInitScript((saveData: boolean) => {
    // The wildcard opens on its last kind (the bare Discord invite here), so the cube page is one turn away.
    Math.random = () => 0.999;
    if (saveData) Object.defineProperty(navigator, 'connection', { value: { saveData: true, effectiveType: '4g' }, configurable: true });
    const w = window as unknown as { __shownAt: number | null };
    w.__shownAt = null;
    const watch = (): void => {
      const reveals = document.querySelectorAll('[data-reveal]');
      if (reveals.length > 0 && document.querySelectorAll('[data-reveal]:not([data-phase="shown"])').length === 0) {
        w.__shownAt = Date.now();
        return;
      }
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  }, saveData);
  const page = await context.newPage();
  await page.goto(`${EDGE_ORIGIN}${PREFIX}/`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __shownAt: number | null }).__shownAt), { timeout: 30_000 }).not.toBeNull();
  await expect(page.locator('[data-testid="front-wildcard-dot"][data-page="cube"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="front-wildcard-page"]')).not.toHaveAttribute('data-page', 'cube');
  return { page, context, asked };
}

/** Turn to the cube page and watch every frame until its art is drawn: how many frames drew a picture not yet decoded. */
async function turnToCube(page: Page): Promise<{ frames: number; ms: number; undecoded: number; arts: number; moved: string[] }> {
  return page.evaluate(
    () =>
      new Promise((done) => {
        const t0 = performance.now();
        (document.querySelector('[data-testid="front-wildcard-dot"][data-page="cube"]') as HTMLElement).click();
        let frames = 0;
        let undecoded = 0;
        let first: string | null = null;
        const moved: string[] = [];
        const tick = (): void => {
          frames += 1;
          const page = document.querySelector('[data-testid="front-wildcard-cube"]');
          const boxes = Array.from(page?.querySelectorAll('.front-card__wildcard-art') ?? []);
          const imgs = Array.from(page?.querySelectorAll('img') ?? []);
          // Within the page: the turn slides the page in (`gallery-page-in`), a picture landing must not move a box in it.
          const at = document.querySelector('[data-testid="front-wildcard-page"]')?.getBoundingClientRect();
          const shape = boxes
            .map((b) => b.getBoundingClientRect())
            .map((r) => `${Math.round(r.x - (at?.x ?? 0))},${Math.round(r.y - (at?.y ?? 0))},${Math.round(r.width)},${Math.round(r.height)}`)
            .join(' ');
          if (first === null && boxes.length > 0) first = shape;
          else if (first !== null && shape !== first) moved.push(`frame ${frames}: ${first} → ${shape}`);
          undecoded += imgs.filter((im) => !(im.complete && im.naturalWidth > 0)).length > 0 ? 1 : 0;
          const drawn = boxes.length > 0 && imgs.length === boxes.length && imgs.every((im) => im.complete && im.naturalWidth > 0);
          if (drawn || performance.now() - t0 > 10_000) done({ frames, ms: Math.round(performance.now() - t0), undecoded, arts: imgs.length, moved });
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

test('the wildcard warms its other pages’ art after the page shows, and the cube page draws decoded art at once', async ({ browser }) => {
  const { page, context, asked } = await open(browser, false);
  const shownAt = await page.evaluate(() => (window as unknown as { __shownAt: number }).__shownAt);
  // Before anyone turns a page: the cube's art is asked for, and only once the page has shown itself.
  await expect.poll(() => asked.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(ART_DELAY_MS + 500);
  const early = asked.filter((a) => a.at < shownAt);
  console.log(`[gallery-preload] ${asked.length} pictures asked for before any turn; ${early.length} of them before the page showed (${JSON.stringify(early.map((a) => `${a.at - shownAt}ms`))})`);
  expect(early, 'no off-screen art may compete with the first paint').toEqual([]);

  const turned = await turnToCube(page);
  console.log(`[gallery-preload] turned to the cube page: ${JSON.stringify(turned)}`);
  expect(turned.arts).toBeGreaterThan(0);
  expect(turned.undecoded, 'a frame drew a picture that was not decoded yet').toBe(0);
  expect(turned.moved).toEqual([]);
  expect(turned.frames, 'the warmed art is drawn on the first frames after the turn').toBeLessThanOrEqual(3);
  await context.close();
});

test('with Save-Data on, nothing is warmed; turned to, the cube page still never draws undecoded art', async ({ browser }) => {
  const { page, context, asked } = await open(browser, true);
  await page.waitForTimeout(3_000);
  console.log(`[gallery-preload] Save-Data: ${asked.length} pictures asked for before any turn`);
  expect(asked).toEqual([]);
  const turned = await turnToCube(page);
  console.log(`[gallery-preload] Save-Data, turned to the cube page: ${JSON.stringify(turned)}`);
  expect(turned.arts).toBeGreaterThan(0);
  expect(turned.undecoded, 'a frame drew a picture that was not decoded yet').toBe(0);
  expect(turned.moved).toEqual([]);
  await context.close();
});

/**
 * The draft's fan view (the operator, 2026-11-01): *"let's move the right side column with the draft
 * circle and the page info down, so it's in the row with the deckbuilder+sideboard. then we allow the fan
 * to take the entire horizontal space. also, let's try to respect the browser zoom. ideally if someone
 * tries to zoom in or out, we allow the fan row to take more or less space and let the cards get
 * bigger/smaller"*.
 *
 * Measured on the real screen (`apps/ui/src/fit/draft-load.html`), served by the app's own Vite config.
 * Browser zoom is emulated the way Chrome implements it: at zoom z a W×H window lays the page out in
 * W/z × H/z CSS px and draws each at z device pixels (`deviceScaleFactor`). Pinch zoom
 * (`Emulation.setPageScaleFactor`) is not browser zoom: it magnifies without laying anything out again.
 *
 * Needs no server: it only reads the screen. No Forge, never skipped. `[fan-fit]` lines are the evidence.
 */

import { expect, test, type Browser } from '@playwright/test';

import { serveFitPages, type FitPages } from './fit-pages.ts';

let fit: FitPages | null = null;
let base = '';

test.beforeAll(async () => {
  fit = await serveFitPages();
  base = fit.base;
});

test.afterAll(async () => {
  await fit?.close();
});

type Box = { x: number; y: number; w: number; h: number };

interface Measure {
  dpr: number;
  scrollW: number;
  innerW: number;
  body: Box;
  bodyContentW: number;
  pack: Box;
  card: Box;
  pool: Box;
  aside: Box;
  controls: Box;
}

/** The loaded draft in a W×H window at browser zoom `zoom`, in the page's CSS px. */
async function measure(browser: Browser, width: number, height: number, zoom: number): Promise<Measure> {
  const context = await browser.newContext({ viewport: { width: Math.round(width / zoom), height: Math.round(height / zoom) }, deviceScaleFactor: zoom });
  try {
    const page = await context.newPage();
    await page.goto(`${base}src/fit/draft-load.html`);
    await page.evaluate(() => window.load());
    await expect(page.locator('[data-testid="pack"].pack--fan .pack__slot[data-focused]')).toBeVisible();
    await page.waitForTimeout(300);
    return await page.evaluate(() => {
      const box = (s: string): Box => {
        const r = document.querySelector(s)!.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };
      const body = document.querySelector('.draft__body')!;
      const style = getComputedStyle(body);
      return {
        dpr: devicePixelRatio,
        scrollW: document.documentElement.scrollWidth,
        innerW: innerWidth,
        body: box('.draft__body'),
        bodyContentW: body.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        pack: box('[data-testid="pack"]'),
        card: box('[data-testid="pack"] .pack__slot[data-focused]'),
        pool: box('[data-testid="pool"]'),
        aside: box('.draft__aside'),
        controls: box('.draft__aside .draft__controls'),
      };
    });
  } finally {
    await context.close();
  }
}

declare global {
  interface Window {
    load: () => void;
  }
}

for (const [width, height] of [
  [1920, 1080],
  [1280, 800],
] as const) {
  test(`at ${width}×${height} the fan spans the whole width and the pod sits in the picks' row`, async ({ browser }) => {
    const m = await measure(browser, width, height, 1);
    console.log(`[fan-fit] ${width}x${height} ${JSON.stringify(m)}`);
    expect(m.pack.w, 'the fan row is as wide as the draft').toBeCloseTo(m.bodyContentW, 0);
    expect(m.aside.y, 'the pod column starts on the picks’ row').toBeCloseTo(m.pool.y, 0);
    expect(m.aside.y + m.aside.h, 'and ends on it').toBeCloseTo(m.pool.y + m.pool.h, 0);
    expect(m.aside.x, 'beside the picks').toBeGreaterThanOrEqual(m.pool.x + m.pool.w);
    expect(m.aside.y, 'below the fan').toBeGreaterThanOrEqual(m.pack.y + m.pack.h);
    expect(m.scrollW, 'nothing scrolls sideways').toBeLessThanOrEqual(m.innerW);
  });

  test(`at ${width}×${height} the fan row and its cards follow the browser zoom`, async ({ browser }) => {
    // Zooming further in on a laptop, the picks' row reaches its floor first and the fan gives way to it.
    const zooms = width >= 1920 ? [0.67, 0.8, 1, 1.25, 1.5] : [0.67, 0.8, 1, 1.25];
    const seen: { zoom: number; cardPx: number; rowPx: number }[] = [];
    for (const zoom of new Set([...zooms, 1.5])) {
      const m = await measure(browser, width, height, zoom);
      // What the player sees, in the screen's own pixels.
      if (zooms.includes(zoom)) seen.push({ zoom, cardPx: Math.round(m.card.w * m.dpr), rowPx: Math.round(m.pack.h * m.dpr) });
      console.log(`[fan-fit] ${width}x${height} zoom ${zoom} card ${m.card.w.toFixed(1)}css → ${(m.card.w * m.dpr).toFixed(1)}px, row ${m.pack.h.toFixed(1)}css → ${(m.pack.h * m.dpr).toFixed(1)}px, pool ${m.pool.h.toFixed(1)}css`);
      expect(m.scrollW, `nothing scrolls sideways at ${zoom * 100}%`).toBeLessThanOrEqual(m.innerW);
      expect(m.pack.w, `the fan spans the draft at ${zoom * 100}%`).toBeCloseTo(m.bodyContentW, 0);
      expect(m.controls.y + m.controls.h, `the pod's controls are whole at ${zoom * 100}%`).toBeLessThanOrEqual(m.aside.y + m.aside.h + 0.5);
    }
    for (let i = 1; i < seen.length; i++) {
      const [was, now] = [seen[i - 1]!, seen[i]!];
      expect(now.cardPx, `zoom ${was.zoom} → ${now.zoom}: the cards get bigger (${JSON.stringify(seen)})`).toBeGreaterThan(was.cardPx);
      expect(now.rowPx, `zoom ${was.zoom} → ${now.zoom}: the fan row takes more of the screen (${JSON.stringify(seen)})`).toBeGreaterThan(was.rowPx);
    }
  });
}

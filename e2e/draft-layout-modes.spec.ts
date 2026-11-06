/**
 * Fan and grid are one page layout (the operator, 2026-11-02): *"i notice that grid mode moves the room
 * title+draft circle back up. let's make sure fan and grid mode take up the same space on the screen. it
 * should be the same page layout, just that how cards in the pack are displayed is different."*
 *
 * Measured on the real screen (`apps/ui/src/fit/draft-load.html` mounts `DraftScreen` with the side
 * column `PodScreen` gives it), served by the app's own Vite config, at a desktop window, at 1366×768
 * and at phone width. The room's bar (`[data-fit-side]`, where `PodScreen` puts the room's title), the
 * pod circle, the layout control, the picks and the pack's own box are read in fan, then grid, then fan
 * again: every one must be where it was. Only what the pack draws inside its box may differ. Each of
 * those boxes is sized from the window, never from what is in it, so none of them may keep resizing
 * itself either: the page reports no error (a fit that chases its own content is a ResizeObserver
 * loop), and at phone width, where the page scrolls and the pod's column has nothing to fit, the
 * column draws at full size.
 *
 * The pod's column sits beside the picks, and the picks' row keeps what that column measures at its
 * smallest fit: a room's bar taller than the floor `POOL_MIN_H` was set for (a real room's name and
 * Close do not scale with the column, and a watcher adds a row) gives the pack row up, rather than
 * clip the layout control under the circle, which a press then scrolls into view, moving the title.
 *
 * Needs no server: it only reads the screen. No Forge, never skipped. `[layout-modes]` lines are the evidence.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';

import { serveFitPages, type FitPages } from './fit-pages.ts';
import { PHONE } from './play/phone.ts';

let fit: FitPages | null = null;
let base = '';

test.beforeAll(async () => {
  fit = await serveFitPages();
  base = fit.base;
});

test.afterAll(async () => {
  await fit?.close();
});

declare global {
  interface Window {
    load: () => void;
    pageErrors: string[];
  }
}

/** Everything around the pack, and the pack's own box: what a layout toggle must leave where it was. */
const PARTS = {
  title: '.draft__aside > [data-fit-side]',
  pod: '.draft__aside .podcircle',
  controls: '.draft__aside .draft__controls',
  picks: '[data-testid="pool"]',
  pack: '[data-testid="pack"]',
} as const;

type Part = keyof typeof PARTS;
type Boxes = Record<Part, string>;

/** Each part's box, rounded to the pixel, after the layout has settled. */
async function boxes(page: Page): Promise<Boxes> {
  // Let the fit (`fitToWindow`, `useFitScale`, the pack's measure) take its passes.
  await page.waitForTimeout(400);
  return page.evaluate((parts) => {
    const out: Record<string, string> = {};
    for (const [part, sel] of Object.entries(parts)) {
      const el = document.querySelector(sel);
      if (el === null) {
        out[part] = 'absent';
        continue;
      }
      const r = el.getBoundingClientRect();
      out[part] = `${Math.round(r.x)},${Math.round(r.y + scrollY)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    }
    return out as Boxes;
  }, PARTS);
}

async function choose(page: Page, layout: 'fan' | 'grid'): Promise<void> {
  const button = page.getByRole('group', { name: 'Pack layout' }).getByRole('button', { name: layout });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('pack')).toHaveAttribute('data-layout', layout);
}

const SIZES: { name: string; context: Parameters<Browser['newContext']>[0] }[] = [
  { name: 'desktop 1920×1080', context: { viewport: { width: 1920, height: 1080 } } },
  { name: 'laptop 1366×768', context: { viewport: { width: 1366, height: 768 } } },
  { name: 'phone 390×844', context: { ...PHONE } },
];

for (const size of SIZES) {
  test(`${size.name}: fan and grid put the room's title, the pod circle, the picks and the pack's box in the same places`, async ({ browser }) => {
    const context = await browser.newContext(size.context);
    try {
      const page = await context.newPage();
      // A ResizeObserver loop is reported on the window, not thrown: collect what the window reports.
      await page.addInitScript(() => {
        window.pageErrors = [];
        window.addEventListener('error', (event) => window.pageErrors.push(event.message));
      });
      await page.goto(`${base}src/fit/draft-load.html`);
      await page.evaluate(() => window.load());
      await expect(page.getByTestId('pack')).toHaveAttribute('data-layout', 'fan');
      const fan = await boxes(page);
      await choose(page, 'grid');
      const grid = await boxes(page);
      await choose(page, 'fan');
      const back = await boxes(page);
      console.log(`[layout-modes] ${size.name} fan ${JSON.stringify(fan)}`);
      console.log(`[layout-modes] ${size.name} grid ${JSON.stringify(grid)}`);
      for (const part of Object.keys(PARTS) as Part[]) expect(fan[part], `${part} is drawn`).not.toBe('absent');
      expect(grid, 'grid mode moves nothing but what the pack draws').toEqual(fan);
      expect(back, 'and back to the fan, nothing has moved').toEqual(fan);
      expect(await page.evaluate(() => window.pageErrors), 'no fit chases its own content').toEqual([]);
      if (size.context?.isMobile === true) {
        const fit = await page.locator('.draft__aside').evaluate((el) => getComputedStyle(el).getPropertyValue('--fit'));
        expect(fit === '' ? 1 : Number(fit), 'a column the page scrolls past draws at full size').toBe(1);
      }
    } finally {
      await context.close();
    }
  });
}

test("a room's bar taller than the picks' floor: the pod's column is whole, and pressing the toggle scrolls nothing", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  try {
    const page = await context.newPage();
    // 160 px of bar that never shrinks: the column at its smallest fit is taller than the picks' row would be.
    await page.goto(`${base}src/fit/draft-load.html?side=160`);
    await page.evaluate(() => window.load());
    await expect(page.getByTestId('pack')).toHaveAttribute('data-layout', 'fan');
    const whole = () =>
      page.locator('.draft__aside').evaluate((aside) => {
        const box = aside.getBoundingClientRect();
        const controls = aside.querySelector('.draft__controls')!.getBoundingClientRect();
        return { overflow: aside.scrollHeight - aside.clientHeight, scrolled: aside.scrollTop, controlsBelow: Math.round(controls.bottom - box.bottom) };
      });
    const fan = await boxes(page);
    console.log(`[layout-modes] tall bar fan ${JSON.stringify(fan)} ${JSON.stringify(await whole())}`);
    const before = await whole();
    expect(before.overflow, "the column's content fits it").toBeLessThanOrEqual(0);
    expect(before.controlsBelow, 'the layout control is inside the column').toBeLessThanOrEqual(0);
    await choose(page, 'grid');
    expect(await boxes(page), 'a press on the toggle moves nothing').toEqual(fan);
    expect((await whole()).scrolled, 'and scrolls nothing into view').toBe(0);
  } finally {
    await context.close();
  }
});

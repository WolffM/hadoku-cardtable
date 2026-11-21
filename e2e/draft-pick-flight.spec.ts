/**
 * A pick's flight from the pack to the pool (the operator, 2026-11-20): *"when picking cards the way
 * cards animate to their position is a bit wonky, it seems like their z-axis is too low and they land
 * behind many elements on the page"*.
 *
 * Two faults, both measured here: the card flew under the pack, the pool's head and the piles after it
 * (the pool and its row clipped it, and nothing raised it), and it set off from beside its slot rather
 * than from it (scaled from its centre, inverted from its corner).
 *
 * On the real screen (`apps/ui/src/fit/draft-load.html?picks=1`). The flight is a CSS transition, so the
 * spec pauses it and seeks it rather than sampling frames: what it reads does not depend on the host's
 * speed. Needs no server. `[pick-flight]` lines are the evidence.
 */

import { expect, test } from '@playwright/test';

import { serveFitPages, type FitPages } from './fit-pages.ts';

test.use({ viewport: { width: 1600, height: 1000 } });

let fit: FitPages | null = null;
let base = '';

test.beforeAll(async () => {
  fit = await serveFitPages();
  base = fit.base;
});

test.afterAll(async () => {
  await fit?.close();
});

interface Sample {
  at: number;
  x: number;
  y: number;
  w: number;
  /** Per probe point: true when the flying card is what is drawn on top there. */
  onTop: boolean[];
  /** What is drawn on top at each probe point, for the evidence line. */
  under: string[];
}

for (const layout of ['grid', 'fan'] as const) {
  test(`a pick flies from its slot over everything it crosses (${layout})`, async ({ page }) => {
    await page.goto(`${base}src/fit/draft-load.html?picks=1`);
    await page.evaluate(() => window.load());
    const button = page.getByRole('group', { name: 'Pack layout' }).getByRole('button', { name: layout });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');

    // The fan picks its open card; the grid any card.
    const card = page.locator(layout === 'fan' ? '[data-testid="pack"] .pack__slot[data-focused] [data-testid="card"]' : '[data-testid="pack"] [data-testid="card"]').first();
    await expect(card).toBeVisible();
    await page.waitForTimeout(300);
    const slot = (await card.boundingBox())!;

    // Listening before the click: on a loaded host the whole flight can be over before a later look.
    const flown = page.evaluate(
      () =>
        new Promise<Sample[]>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no flight started')), 5000);
          const onRun = (event: TransitionEvent): void => {
            const el = event.target;
            if (!(el instanceof HTMLElement) || !el.classList.contains('pool__tile--enter') || event.propertyName !== 'transform') return;
            const flight = el.getAnimations().find((a) => a instanceof CSSTransition && a.transitionProperty === 'transform');
            if (flight === undefined) return;
            document.removeEventListener('transitionrun', onRun, true);
            clearTimeout(timer);
            flight.pause();
            const total = Number(flight.effect!.getTiming().duration);
            const out: Sample[] = [];
            // The card lets clicks through while it flies; hit-testing needs it to take them for the read.
            el.style.pointerEvents = 'auto';
            for (const f of [0, 0.25, 0.5, 0.75]) {
              flight.currentTime = f * total;
              const r = el.getBoundingClientRect();
              const points = (
                [
                  [r.left + r.width / 2, r.top + 6],
                  [r.left + r.width / 2, r.top + r.height / 2],
                  [r.left + 6, r.bottom - 6],
                ] as [number, number][]
              ).filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight);
              const hits = points.map(([x, y]) => document.elementFromPoint(x, y));
              out.push({
                at: f,
                x: r.left,
                y: r.top,
                w: r.width,
                onTop: hits.map((h) => h !== null && el.contains(h)),
                under: hits.map((h) => (h === null ? '-' : String(h.className || h.tagName).split(' ')[0]!)),
              });
            }
            el.style.pointerEvents = '';
            flight.finish();
            resolve(out);
          };
          document.addEventListener('transitionrun', onRun, true);
        }),
    );
    await card.click();
    const samples = await flown;

    for (const s of samples) console.log(`[pick-flight] ${layout} t=${s.at} x=${s.x.toFixed(0)} y=${s.y.toFixed(0)} w=${s.w.toFixed(0)} top=${s.under.join(',')}`);
    console.log(`[pick-flight] ${layout} slot x=${slot.x.toFixed(0)} y=${slot.y.toFixed(0)} w=${slot.width.toFixed(0)}`);

    const first = samples[0]!;
    expect(Math.abs(first.x - slot.x), 'sets off from its slot (x)').toBeLessThan(2);
    expect(Math.abs(first.y - slot.y), 'sets off from its slot (y)').toBeLessThan(2);
    expect(Math.abs(first.w - slot.width), 'at its slot size').toBeLessThan(2);
    for (const s of samples) {
      expect(s.onTop.length, `probed on screen at t=${s.at}`).toBeGreaterThan(0);
      expect(s.onTop.every(Boolean), `drawn over everything at t=${s.at}: ${s.under.join(',')}`).toBe(true);
    }
  });
}

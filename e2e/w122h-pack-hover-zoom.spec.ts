/**
 * the operator, 2026-11-16: *"hovering the currently viewed draft card should
 * zoom it to the size cards normally reach on hover"* — reuse the board's one shared inspector
 * (`play/inspect/index.ts`, memory `one-expanded-card-view`), not the fan's own native card size.
 *
 * Measured first, on the base: the desktop fan's open card renders at its own fan geometry
 * (`PackView.tsx`'s `fanGeometry`, capped at `MAX_CARD_H` = 420 CSS px tall) and hovering it opened
 * nothing — `data-card-id` was withheld from every on-screen card of a PICKING fan (`PackView.tsx`'s
 * old comment: "the fan's open card is already full size, so an enlarged copy beside it is a
 * duplicate"). The fix gives the inspector's `w<n>` id to the OPEN card alone, so hovering it opens
 * the exact same `[data-testid="card-view"]` panel a board or hand card's hover does, at the
 * inspector's own size (`zoomWidth`'s `PREF_W` = 380 CSS px wide, scaled to the window as every
 * other inspector hover already is) — a real zoom past the fan's own cap on most windows, not a
 * same-size duplicate. A neighbour on screen (not the open card) still opens nothing: the operator's
 * 2026-10-19 "no duplicate beside the open card" holds for every card but the one being read.
 *
 * Needs no Forge: a draft never touches it (`e2e/w90c-touch.ts`'s own header says the same).
 */
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

import { soloDraftPack, withAlice } from './w90c-touch.ts';

const SHOT_DIR = fileURLToPath(new URL('../docs/handoff/w122-H', import.meta.url));

test.beforeAll(async () => {
  await mkdir(SHOT_DIR, { recursive: true });
});

test('the desktop fan: hovering the open card zooms it through the shared inspector, a neighbour stays unzoomed', async ({ browser }) => {
  await withAlice(browser, async (page) => {
    await soloDraftPack(page);
    const pack = page.getByTestId('pack');
    await expect(pack, 'wide enough for the desktop fan, not the grid').toHaveClass(/pack--fan/);

    const open = pack.locator('.pack__slot[data-focused] button[data-testid="card"]');
    const openSlot = pack.locator('.pack__slot[data-focused]');
    const before = await openSlot.boundingBox();
    if (before === null) throw new Error('no open-card box');

    await page.screenshot({ path: `${SHOT_DIR}/pack-open-card-before-hover.png` });

    await open.hover();
    const panel = page.getByTestId('card-view');
    await expect(panel, 'hovering the open card opens the shared inspector').toBeVisible();
    const zoomed = await panel.boundingBox();
    if (zoomed === null) throw new Error('no inspector box');

    await page.screenshot({ path: `${SHOT_DIR}/pack-open-card-after-hover.png` });

    console.log(`[w122h] open card ${JSON.stringify(before)} -> inspector ${JSON.stringify(zoomed)}`);
    // Not a same-size duplicate: the inspector is a real zoom past the fan's own open-card size — the
    // fan tops out at MAX_CARD_H (420 CSS px); the inspector's own size is independent of it.
    expect(zoomed.width, 'the inspector is not merely the same size as the fan’s own open card').not.toBeCloseTo(before.width, 0);
    expect(zoomed.height).toBeGreaterThan(before.height);

    // Move off the open card; the inspector follows the pointer away and closes.
    await page.mouse.move(0, 0);
    await expect(panel, 'moving off the open card closes the inspector').toBeHidden();

    // A neighbour on screen (not the open one) opens nothing — only the currently viewed card does.
    const neighbour = pack.locator('.pack__slot:not([data-focused]):not([data-off]) button[data-testid="card"]').first();
    await expect(neighbour, 'the fan has an on-screen neighbour to check').toHaveCount(1);
    await neighbour.hover();
    await expect(panel, 'hovering a neighbour, not the open card, opens nothing').toHaveCount(0);
  });
});

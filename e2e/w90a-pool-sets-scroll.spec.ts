/**
 * Item 2b, the mouse half — see `./w90a-pool-sets-scroll.phone.spec.ts` for the touch half and the
 * cause. Desktop has room enough that the row may not overflow at 1440px on its own, so this
 * narrows the viewport to phone width too (a plain resize, not the `phone` project — a mouse drag
 * needs no touch emulation) and picks the richest Standard era, same as the phone spec.
 */
import { expect, test, type Page } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { resizeWindow } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { submitCreateRoom } from './play/rooms.ts';
import { choosePool } from './play/pool.ts';

const UI_TIMEOUT = 20_000;

interface FormatRow {
  id: string;
  family: string;
  sets: string[];
}

async function richestStandardEra(page: Page): Promise<FormatRow> {
  const body = (await page.evaluate(async () => {
    const res = await fetch(`${window.location.pathname.replace(/(\/room\/[^/]+)?\/?$/, '/')}api/tables/formats`);
    return res.json();
  })) as { formats: FormatRow[] };
  const standard = body.formats.filter((f) => f.family === 'standard');
  return standard.reduce((best, f) => (f.sets.length > best.sets.length ? f : best), standard[0]!);
}

test('a mouse drag scrolls the era’s set symbols sideways too, and never fires a click on a glyph', async ({ browser }) => {
  test.setTimeout(60_000);
  const alice = await openFriend(browser, 'alice');
  try {
    await resizeWindow(alice.page, { width: 390, height: 844 });
    await alice.page.goto(`${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: `e2e w90a pool sets mouse ${Date.now()}` });
    await alice.page.waitForURL(/\/room\/[a-z0-9-]+$/, { timeout: UI_TIMEOUT });

    const richest = await richestStandardEra(alice.page);
    await choosePool(alice.page, richest.id);
    await expect(alice.page.getByTestId('pool-sets')).toBeVisible({ timeout: UI_TIMEOUT });

    const row = alice.page.getByTestId('pool-sets');
    await row.scrollIntoViewIfNeeded();
    const box = (await row.boundingBox())!;
    const before = await row.evaluate((el) => el.scrollLeft);
    const metrics = await row.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    console.log(`[w90a-pool-sets-scroll] ${richest.id} (${richest.sets.length} sets): box=${JSON.stringify(box)} scrollWidth=${metrics.scrollWidth} clientWidth=${metrics.clientWidth}`);
    expect(metrics.scrollWidth, `${richest.id} has ${richest.sets.length} sets; its row should overflow a 390px-wide box`).toBeGreaterThan(metrics.clientWidth);

    // Armed BEFORE the drag: a click that fires from the drag's own release is what this proves
    // did NOT happen, and a listener added after the fact could never have seen it.
    await alice.page.evaluate(() => {
      (window as unknown as { __w90aClicked: boolean }).__w90aClicked = false;
      document.querySelector('[data-testid="pool-sets"]')?.addEventListener('click', () => {
        (window as unknown as { __w90aClicked: boolean }).__w90aClicked = true;
      });
    });

    const midY = box.y + box.height / 2;
    const atStart = await alice.page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.outerHTML.slice(0, 120), { x: box.x + box.width - 10, y: midY });
    console.log(`[w90a-pool-sets-scroll] element at drag start point: ${atStart}`);
    await alice.page.mouse.move(box.x + box.width - 10, midY);
    await alice.page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await alice.page.mouse.move(box.x + box.width - 10 - ((box.width - 20) * i) / 10, midY);
    }
    await alice.page.mouse.up();

    const after = await row.evaluate((el) => el.scrollLeft);
    console.log(`[w90a-pool-sets-scroll] scrollLeft before=${before} after=${after}`);
    expect(after, 'the mouse drag moved the row').toBeGreaterThan(before);

    // A drag never fires a click on a glyph (or the row itself): nothing under this row is
    // clickable today, but the row still owns the clicks that would follow a drag on it.
    const clicked = await alice.page.evaluate(() => (window as unknown as { __w90aClicked: boolean }).__w90aClicked);
    expect(clicked, 'no click reached the row from the drag that just ended').toBe(false);
  } finally {
    await alice.context.close();
  }
});

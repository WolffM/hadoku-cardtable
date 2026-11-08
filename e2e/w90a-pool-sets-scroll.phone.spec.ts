/**
 * Item 2b: the era's set symbols, one row, scrolled sideways rather than wrapped off the page. The
 * operator: *"they go off the page entirely. maybe we make this horizontall scrollable? do not
 * display a scroll bar though, just allow it to be dragged."*
 *
 * Cause (`ConstructedScreen.tsx`'s `PoolSets`, `screens.css`'s `.lobby__sets`/`.lobby__block`): the
 * row wrapped its BLOCKS, but never set `overflow-x`, and a single block's own glyphs never wrap —
 * so one era whose block is wider than the viewport ran off the page regardless of the row's own
 * wrap setting. Picks the richest Standard era on offer (the most sets) so the row is guaranteed
 * to overflow 390px, rather than hoping the room's default era happens to.
 */
import { expect, test, type Page } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { openFriend } from './play/browser.ts';
import { PHONE } from './play/phone.ts';
import { noSideways, swipe } from './play/phone.ts';
import { submitCreateRoom } from './play/rooms.ts';
import { choosePool } from './play/pool.ts';

test.use(PHONE);

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
  const richest = standard.reduce((best, f) => (f.sets.length > best.sets.length ? f : best), standard[0]!);
  return richest;
}

async function rowMetrics(page: Page): Promise<{ scrollWidth: number; clientWidth: number; right: number; scrollbarWidth: number }> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="pool-sets"]');
    if (el === null) throw new Error('pool-sets row is not on the page');
    const rect = el.getBoundingClientRect();
    return {
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      right: rect.right,
      scrollbarWidth: el.offsetWidth - el.clientWidth,
    };
  });
}

test('the era’s set symbols scroll sideways, with no visible scrollbar, and the page itself never scrolls sideways', async ({ browser }) => {
  test.setTimeout(60_000);
  const alice = await openFriend(browser, 'alice');
  try {
    await alice.page.goto(`${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: `e2e w90a pool sets ${Date.now()}` });
    await alice.page.waitForURL(/\/room\/[a-z0-9-]+$/, { timeout: UI_TIMEOUT });

    const richest = await richestStandardEra(alice.page);
    await choosePool(alice.page, richest.id);
    await expect(alice.page.getByTestId('pool-sets'), 'the richest Standard era draws its sets row').toBeVisible({ timeout: UI_TIMEOUT });
    await expect(alice.page.getByTestId('pool-sets')).toHaveAttribute('data-sets', new RegExp(richest.sets[richest.sets.length - 1] ?? ''));

    const metrics = await rowMetrics(alice.page);
    expect(metrics.scrollWidth, `${richest.id} has ${richest.sets.length} sets; its row should be wider than it is tall enough to show at once`).toBeGreaterThan(metrics.clientWidth);
    expect(metrics.right, 'the row’s right edge never runs past the viewport').toBeLessThanOrEqual(390 + 1);
    expect(metrics.scrollbarWidth, 'no visible scrollbar (scrollbar-width: none)').toBe(0);
    await noSideways(alice.page);

    // A touch swipe moves scrollLeft. Scrolled into view first — off the bottom of a fresh
    // 390×844 room (the row sits low on the page) is exactly the coordinate bug that made the
    // mouse-drag half of this spec look broken too, before that fix.
    const row = alice.page.getByTestId('pool-sets');
    await row.scrollIntoViewIfNeeded();
    const box = (await row.boundingBox())!;
    const midY = box.y + box.height / 2;
    const before = await alice.page.evaluate(() => document.querySelector('[data-testid="pool-sets"]')!.scrollLeft);
    await swipe(alice.page, { x: box.x + box.width - 10, y: midY }, { x: box.x + 10, y: midY });
    const afterTouch = await alice.page.evaluate(() => document.querySelector('[data-testid="pool-sets"]')!.scrollLeft);
    console.log(`[w90a-pool-sets-scroll.phone] box=${JSON.stringify(box)} scrollLeft before=${before} after=${afterTouch}`);
    expect(afterTouch, 'a touch swipe moved the row').toBeGreaterThan(before);
    await noSideways(alice.page);
  } finally {
    await alice.context.close();
  }
});

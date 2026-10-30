/*
 * The UI scale slider by a mouse click (the operator, 2026-10-21: "i click 110, and then it changes
 * it to 90?"). Firefox, because it is the browser that showed it: a save on `pointerup` re-scaled
 * the page, and Firefox then sent one more `input`, read off the pointer against the re-scaled
 * slider (110% → 115%, 90% → 80%). Chromium sends none, and kept the click either way. A file of
 * its own because the browser is chosen per file, in `playwright.config.ts`.
 */
import { expect, test, type Page } from '@playwright/test';

import { openFriend } from './play/browser.ts';
import { makeTitled, offeredNamed } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { closeSettings, openSettings } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const scaleOf = (page: Page): Promise<string> => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim());

/**
 * Press the UI scale slider where it draws `wanted`, the way a hand does: held a moment, and the
 * pointer drifting a few px once let go, while the page re-scales under it.
 */
async function clickScale(page: Page, wanted: string): Promise<string> {
  const slider = page.getByTestId('settings-ui-scale');
  await expect(slider).toBeVisible();
  // A panel taller than its room scrolls inside (`Popover`'s max height), and a hand scrolls to the slider.
  await slider.scrollIntoViewIfNeeded();
  const at = await slider.evaluate((el: HTMLInputElement, value) => {
    const box = el.getBoundingClientRect();
    const thumb = 16;
    const t = (Number(value) - Number(el.min)) / (Number(el.max) - Number(el.min));
    return { x: box.left + thumb / 2 + t * (box.width - thumb), y: box.top + box.height / 2 };
  }, wanted);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
  for (let i = 1; i <= 4; i++) {
    await page.waitForTimeout(60);
    await page.mouse.move(at.x + i * 2, at.y + i);
  }
  await page.waitForTimeout(500);
  return slider.inputValue();
}

test(titled('the UI scale by a mouse click: the value clicked is the value kept, though the slider re-scales under the pointer'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const signIn = async (page: Page): Promise<void> => void (await page.route('**/session/whoami', (route) => route.fulfill({ json: { valid: true, userId: 'e2e-alice', userType: 'friend', name: 'alice' } })));
    const front = await openFriend(browser, 'alice');
    await signIn(front.page);
    await front.page.goto(`${stack.origin}/cardtable/`);
    for (const wanted of ['110', '90', '125', '100']) {
      await openSettings(front.page);
      const kept = await clickScale(front.page, wanted);
      console.log(`[bl] front page, clicked ${wanted}%: slider ${kept}, page ${await scaleOf(front.page)}`);
      expect(kept, `front page: the slider still shows the clicked ${wanted}%`).toBe(wanted);
      await expect.poll(() => scaleOf(front.page), { timeout: 5_000, message: `front page: drawn at the clicked ${wanted}%` }).toBe(String(Number(wanted) / 100));
      await front.page.keyboard.press('Escape');
    }
    await front.context.close();

    const { alice } = await startScenarioMatch(browser, stack, 'bl-ui-scale', { beforeAlice: signIn });
    const page = alice.page;
    await expect.poll(() => offeredNamed(page, 'Divination'), { timeout: 60_000, message: 'alice has priority at her main phase' }).not.toBeUndefined();
    for (const wanted of ['110', '90', '125', '100']) {
      await openSettings(page);
      const kept = await clickScale(page, wanted);
      console.log(`[bl] in a match, clicked ${wanted}%: slider ${kept}, page ${await scaleOf(page)}`);
      expect(kept, `in a match: the slider still shows the clicked ${wanted}%`).toBe(wanted);
      await expect.poll(() => scaleOf(page), { timeout: 5_000, message: `in a match: drawn at the clicked ${wanted}%` }).toBe(String(Number(wanted) / 100));
      await closeSettings(page);
    }
  } finally {
    await stack.stop();
  }
});

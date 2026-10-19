/**
 * The pod lobby's AI button, on every open seat: a draft deals only once no
 * seat is open (the operator, 2026-10-19: "drafts should not immediately start
 * with open seats"). Pressed from one page, once that page's player is seated.
 *
 * Done when the draft deals, not after a counted number of presses: another
 * player's Ready can take an open seat before this page has drawn it, and then
 * the last press this page planned has nothing left to fill.
 */

import { expect, type Page } from '@playwright/test';

export async function fillWithAi(page: Page, timeout = 15_000): Promise<void> {
  await expect(page.getByTestId('pod-seat-stand'), 'the presser holds a seat first').toBeVisible({ timeout });
  const ai = page.getByTestId('pod-seat-ai');
  const dealt = page.getByTestId('pod');
  const deadline = Date.now() + timeout * 4;
  while ((await dealt.count()) === 0) {
    if (Date.now() > deadline) throw new Error('the pod never dealt with every seat filled');
    const n = await ai.count();
    if (n === 0) {
      await page.waitForTimeout(100);
      continue;
    }
    // The button can go between finding it and pressing it: the seat taken, or the draft dealt.
    await ai.first().click({ timeout: 2_000 }).catch(() => undefined);
    await expect
      .poll(async () => ((await dealt.count()) > 0 ? 0 : await ai.count()), { timeout, message: 'the seat takes the AI' })
      .toBeLessThan(n);
  }
}

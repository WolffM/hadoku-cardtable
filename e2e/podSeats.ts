/**
 * The pod lobby's AI button, on every open seat: a draft deals only once no
 * seat is open (the operator, 2026-10-19: "drafts should not immediately start
 * with open seats"). Pressed from one page, once that page's player is seated
 * (Ready sits them — wait for it, or the count includes their own seat); the
 * last press deals, and the lobby goes with it.
 */

import { expect, type Page } from '@playwright/test';

export async function fillWithAi(page: Page, timeout = 15_000): Promise<void> {
  await expect(page.getByTestId('pod-seat-stand'), 'the presser holds a seat first').toBeVisible({ timeout });
  const ai = page.getByTestId('pod-seat-ai');
  for (let n = await ai.count(); n > 0; n = await ai.count()) {
    await expect(ai.first()).toBeEnabled({ timeout });
    await ai.first().click();
    await expect.poll(() => ai.count(), { timeout, message: 'the seat takes the AI' }).toBeLessThan(n);
  }
}

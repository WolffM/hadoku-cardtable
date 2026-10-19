/**
 * The pod lobby's AI button, on every open seat: a draft deals only once no
 * seat is open (the operator, 2026-10-19: "drafts should not immediately start
 * with open seats"). Pressed from one page; the last press deals.
 */

import { expect, type Page } from '@playwright/test';

export async function fillWithAi(page: Page, timeout = 15_000): Promise<void> {
  const ai = page.getByTestId('pod-seat-ai');
  await expect(ai.first(), 'the open seats offer the AI').toBeVisible({ timeout });
  for (let n = await ai.count(); n > 0; n -= 1) {
    await ai.first().click();
    await expect(ai, 'the seat takes the AI').toHaveCount(n - 1, { timeout });
  }
}

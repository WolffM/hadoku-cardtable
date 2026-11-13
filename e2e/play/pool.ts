/**
 * A Classic room's pool, from the leader's screen: the format tabs and the year slider
 * (`games/magic/ui/src/components/YearSlider.tsx`). Every spec that puts a room on an era goes through
 * `choosePool`, so the gesture lives in one place.
 */

import { expect, type Locator, type Page } from '@playwright/test';

type Family = 'standard' | 'modern' | 'legacy';

/** An era id's format: a Standard id is its bare `YYYY-MM-DD`, any other `<family>-YYYY-MM-DD`. */
export function familyOf(eraId: string): Family {
  const prefix = /^(modern|legacy)-\d{4}-\d{2}-\d{2}$/.exec(eraId)?.[1];
  return (prefix as Family | undefined) ?? 'standard';
}

/** The leader's year slider. */
export function poolSlider(page: Page): Locator {
  return page.getByTestId('format');
}

/** The open tab's eras, by id, as the slider lays them out: oldest on the left. */
export function poolEras(page: Page): Promise<string[]> {
  return poolSlider(page)
    .locator('[data-era]')
    .evaluateAll((ticks) => ticks.map((t) => (t as HTMLElement).dataset.era ?? ''));
}

/** The era the leader's slider has chosen ('' while none of the open tab's is). */
export async function poolValue(page: Page): Promise<string> {
  return (await poolSlider(page).getAttribute('data-value')) ?? '';
}

/** Waits until the room has answered: the slider is on `eraId` and asking for nothing. */
export async function expectPoolOn(page: Page, eraId: string, message?: string): Promise<void> {
  await expect(poolSlider(page), message ?? `the room is on ${eraId}`).toHaveAttribute('data-value', eraId, { timeout: 15_000 });
  await expect(poolSlider(page), message ?? `the room answered ${eraId}`).not.toHaveAttribute('aria-busy', 'true', { timeout: 15_000 });
}

/**
 * The leader puts the room on `eraId`: its format's tab, then that year on the slider. Resolves once
 * the room has answered. The slider is set as a key sets it, which chooses once it rests; the drag is
 * `e2e/wyear-year-slider.spec.ts`'s.
 */
export async function choosePool(page: Page, eraId: string): Promise<void> {
  const tab = page.getByTestId(`format-tab-${familyOf(eraId)}`);
  await expect(tab, 'the leader has the format tabs').toBeVisible({ timeout: 15_000 });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  const tick = poolSlider(page).locator(`[data-era="${eraId}"]`);
  await expect(tick, `${eraId} is a year on its tab`).toHaveCount(1, { timeout: 15_000 });
  if ((await poolValue(page)) !== eraId) await poolSlider(page).getByRole('slider').fill((await tick.getAttribute('data-at'))!);
  await expectPoolOn(page, eraId);
}

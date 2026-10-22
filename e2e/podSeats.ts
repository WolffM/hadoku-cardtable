/**
 * The pod lobby's AI button, on every open seat: a draft deals only once no
 * seat is open (the operator, 2026-10-19: "drafts should not immediately start
 * with open seats"). Pressed from one page, once that page's player is seated.
 *
 * Done when the draft deals, not after a counted number of presses: another
 * player's Ready can take an open seat before this page has drawn it, and then
 * the last press this page planned has nothing left to fill.
 *
 * ## `readyPod`: drivers press by state, not blindly (wave 73 §B follow-up)
 *
 * A new pod's plan checks itself in the background (`room/lobby.ts`'s
 * `#checkPlan`), and the server refuses `start` until that verdict is ok
 * (`plan-not-ready`). `ready-toggle` is disabled client-side until then too —
 * but a driver racing ahead of either (a blind `.click()` the instant the
 * lobby renders) can still lose: on a cold/busy claw the pool JVM has taken
 * 10+ s to report, past the suite's own 20 s `actionTimeout`
 * (`playwright.config.ts`), which turned a real product race into a false
 * red on main (`39715581903`: "Could not start the draft: the draft pool is
 * still being checked…"). `readyPod` waits on the pool-picker's own verdict
 * state — drawn for every draft pod, whether or not a spec ever touches the
 * picker — with a timeout generous enough for that cold JVM, before pressing.
 */

import { expect, type Page } from '@playwright/test';

/** Press Ready only once the pod's own plan verdict reads `ready` — never a blind press (see the header). */
export async function readyPod(page: Page, timeout = 60_000): Promise<void> {
  await expect(page.getByTestId('pool-picker-verdict'), 'the pod’s plan check settles before Ready').toHaveAttribute('data-state', 'ready', { timeout });
  await page.getByTestId('ready-toggle').click();
}

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

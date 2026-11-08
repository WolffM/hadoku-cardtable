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

/**
 * Selects a Custom pack slot (AF305 §B, "the draft room redesign, option
 * B"): the picker draws only the ACTIVE round's cube/set gallery, so a round
 * other than the default (round 0) must be picked here before any of that
 * round's own test ids (`pool-picker-custom-round-<n>-type-set`,
 * `…-cubes-<id>`, `…-sets-<code>`, `…-style-<style>`) resolve. Added in the
 * shared driver, not per spec (AF305's brief) — a spec that already named a
 * round's own id just needs this one call in front of it.
 */
export async function selectCustomRound(page: Page, round: 0 | 1 | 2): Promise<void> {
  await page.getByTestId(`pool-picker-custom-round-${round}`).click();
}

/** Press Ready only once the pod's own plan verdict reads `ready` — never a blind press (see the header). */
export async function readyPod(page: Page, timeout = 60_000): Promise<void> {
  await expect(page.getByTestId('pool-picker-verdict'), 'the pod’s plan check settles before Ready').toHaveAttribute('data-state', 'ready', { timeout });
  await page.getByTestId('ready-toggle').click();
}

/**
 * `page`'s player holds pod seat `seat`. Entering a room seats a newcomer at the first open seat
 * (`room/lobby.ts`'s `#autoSeat`), so they may be there already, or move to it from another
 * (an open seat sits a seated player there). Retried by state, not counted: the page can still be
 * drawing the seat it was given on entering when this is called.
 */
export async function sitPodAt(page: Page, seat: number, timeout = 30_000): Promise<void> {
  const mine = page.locator(`[data-testid="pod-seat-${seat}"][data-mine]`);
  await expect(async () => {
    if ((await mine.count()) === 0) await page.locator(`[data-testid="pod-seat-sit"][data-seat="${seat}"]`).click({ timeout: 2_000 });
    await expect(mine).toBeVisible({ timeout: 3_000 });
  }, `holds pod seat ${seat}`).toPass({ timeout });
}

/** The player gives their seat back by the spectators' open slot, and is drawn among the spectators. */
export async function spectate(page: Page, timeout = 30_000): Promise<void> {
  await page.getByTestId('seat-stand').click({ timeout });
  await expect(page.locator('[data-testid="room-spectator"][data-mine]'), 'a spectator now').toBeVisible({ timeout });
}

/**
 * Several players at chosen seats, whatever entering gave them: whoever is not at their own seat
 * gives theirs back first, so no one waits on a seat another is about to leave.
 */
export async function arrangePod(at: readonly (readonly [Page, number])[], timeout = 30_000): Promise<void> {
  for (const [page, seat] of at) {
    await expect(page.getByTestId('pod-seats')).toBeVisible({ timeout });
    // Settled first: seated somewhere, or among the spectators, as the room drew this page.
    await expect(page.locator('[data-testid^="pod-seat-"][data-mine], [data-testid="room-spectator"][data-mine]')).toHaveCount(1, { timeout });
    if ((await page.locator(`[data-testid="pod-seat-${seat}"][data-mine]`).count()) === 0 && (await page.getByTestId('seat-stand').count()) > 0) await spectate(page, timeout);
  }
  for (const [page, seat] of at) await sitPodAt(page, seat, timeout);
}

export async function fillWithAi(page: Page, timeout = 15_000): Promise<void> {
  await expect(page.getByTestId('seat-stand'), 'the presser holds a seat first').toBeVisible({ timeout });
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

/** Clicks the lowest-indexed enabled card over and over, until the finished draft lands in the deck builder. */
export async function draftUntilDone(page: Page): Promise<void> {
  // The grid, not the fan: the fan overlaps its cards on purpose (`draft.spec.ts`'s
  // own note), so a click at a card's centre can land outside the viewport
  // or on a neighbour.
  const grid = page.getByRole('group', { name: 'Pack layout' }).getByRole('button', { name: 'grid' });
  if ((await grid.getAttribute('aria-pressed')) !== 'true') await grid.click();
  for (;;) {
    const next = await page.waitForFunction(
      () => {
        if (window.location.hash.startsWith('#/deck/')) return 'done';
        return document.querySelector('[data-testid="pack"] button[data-testid="card"]:not([disabled])') !== null ? 'pick' : null;
      },
      null,
      { timeout: 90_000, polling: 50 },
    );
    if ((await next.jsonValue()) === 'done') return;
    await page.locator('[data-testid="pack"] button[data-testid="card"]:not([disabled])').first().click();
    // Paced under the server's own pick rate limit (15 burst, then one per
    // 250 ms — `PICK_RATE_LIMIT`).
    await page.waitForTimeout(400);
  }
}

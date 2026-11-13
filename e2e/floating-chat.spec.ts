/*
 * The operator, 2026-11-11: "let's get the floating chat display from watchparty for when people
 * have the chat hidden."
 *
 * With the chat column hidden, the room's latest lines fade over the table: watchparty's own
 * over-video overlay (`FloatingChat`), drawn by `RoomChrome` beside its collapsed rail. It must
 * never take a click from the board, and with the column open nothing floats, so a line is never
 * shown twice.
 *
 * Scenario `af141-mox-opal`, for nothing but a board both seats share: a match no room holds admits
 * both players to its chat (`games/magic/server/src/room/serve.ts`).
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const CHROME = '.wp-room-chrome';
const FLOATING = '[data-testid="floating-chat"]';
const chatBox = (page: Page) => page.getByPlaceholder('Send a message');

/** The composer refuses a send inside its one-second cooldown and keeps the text, so press until it takes it. */
async function say(page: Page, text: string): Promise<void> {
  await chatBox(page).fill(text);
  await expect(async () => {
    await chatBox(page).press('Enter');
    await expect(chatBox(page)).toHaveValue('', { timeout: 500 });
  }, `the composer sent “${text}”`).toPass({ timeout: 10_000 });
}

test(titled('chat hidden, the latest lines float over the table and never take a click; chat shown, nothing floats'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'af141-mox-opal');
    const a = alice.page;
    for (const page of [a, bob.page]) await expect(chatBox(page), 'the chat is open beside the board').toBeVisible({ timeout: 20_000 });

    const whileOpen = `while open ${Date.now()}`;
    await say(bob.page, whileOpen);
    await expect(a.locator(CHROME).getByText(whileOpen), 'alice reads it in the column').toBeVisible({ timeout: 20_000 });
    await expect(a.locator(FLOATING), 'and nowhere else').toHaveCount(0);

    await a.locator(`${CHROME} button[aria-label="Hide chat"]`).click();
    await expect(chatBox(a)).toHaveCount(0);
    const whileHidden = `while hidden ${Date.now()}`;
    await say(bob.page, whileHidden);
    const floating = a.locator(FLOATING);
    await expect(floating.getByText(whileHidden), 'bob’s line floats over alice’s table').toBeVisible({ timeout: 20_000 });

    const box = (await floating.boundingBox())!;
    const table = (await a.locator('.wp-room-chrome-frame__content').boundingBox())!;
    expect(box.x, 'inside the table, not over the rail').toBeGreaterThanOrEqual(table.x);
    expect(box.x + box.width).toBeLessThanOrEqual(table.x + table.width);
    expect(box.y).toBeGreaterThanOrEqual(table.y);
    expect(box.y + box.height).toBeLessThanOrEqual(table.y + table.height);
    const hit = await a.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return { overlay: !!el?.closest('[data-testid="floating-chat"]'), table: !!el?.closest('.wp-room-chrome-frame__content') };
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    expect(hit, 'a press over the lines lands on the table').toEqual({ overlay: false, table: true });

    await a.locator(`${CHROME} button[aria-label="Show chat"]`).click();
    await expect(chatBox(a)).toBeVisible();
    await expect(a.locator(FLOATING), 'shown again, nothing floats').toHaveCount(0);
    const reopened = `reopened ${Date.now()}`;
    await say(bob.page, reopened);
    await expect(a.locator(CHROME).getByText(reopened)).toBeVisible({ timeout: 20_000 });
    await expect(a.locator(FLOATING)).toHaveCount(0);
  } finally {
    await stack.stop();
  }
});

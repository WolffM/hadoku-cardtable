/**
 * A room at phone width keeps the same page edge on both sides. At ≤600px the chat drops below the
 * screen, and the room's screen kept its 16px left edge while its right one went to nothing: the
 * room's name, its Leave/Room settings/Reset/Close row and every panel ran to the glass on the right
 * (the pre-tournament tour, 390×844, a draft lobby).
 */
import { expect, test } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { openFriend } from './play/browser.ts';
import { evenGutters, noSideways, PHONE } from './play/phone.ts';
import { submitCreateRoom } from './play/rooms.ts';

test.use(PHONE);

for (const gameType of ['constructed-1v1', 'draft'] as const) {
  test(`a ${gameType} room's head and panels sit between equal page edges at 390px`, async ({ browser }) => {
    test.setTimeout(60_000);
    const alice = await openFriend(browser, 'alice');
    try {
      const page = alice.page;
      await page.goto(`${PREFIX}/`);
      await submitCreateRoom(page, { name: `gutters ${Date.now() % 1000}`, gameType });
      await page.waitForURL(/\/room\/[a-z0-9-]+$/, { timeout: 20_000 });
      // The room's own name, in its head: the front page's list names rooms too, and can still be on screen.
      await expect(page.locator('.shell__head').getByTestId('room-name')).toBeVisible({ timeout: 20_000 });
      await noSideways(page);
      await evenGutters(page, '.shell--fit > .shell__head, .shell--fit > main');
    } finally {
      await alice.context.close();
    }
  });
}

/**
 * Wave 89 polish 4 — the action bar stays on the screen's bottom edge in every state of a match (the
 * operator, 2026-11-03: "in some cases the bottom bar wasn't anchored to the bottom of the page"). One
 * real match against the AI, walked through each moment the bar has to hold: the mulligan, a quiet main
 * phase, the menu, the chat sheet with its input focused, the opponent's turn, a phone
 * with a bottom safe area, a shorter window (a mobile browser's URL bar showing), a narrower phone, and
 * the game result. Every docked decision's own modes (dock, full, pill) are checked in
 * `w89c-decision-dock.phone.spec.ts`, and the stack list open (a stack is needed for its chip) in
 * `w89a-portrait-board.phone.spec.ts`, with the same `expectBarAnchored`.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one each test SKIPS and
 * its title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled, resizeWindow } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { expectBarAnchored, inMore, PHONE, pressInMenu } from './play/phone.ts';
import { startScenarioVsAi } from './play/scenario.ts';

test.use(PHONE);

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The screen's own safe area, as a phone with a home indicator reports it to a page drawn edge to edge. */
async function withBottomSafeArea(page: Page, px: number): Promise<void> {
  await page.evaluate(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')!;
    if (!meta.content.includes('viewport-fit')) meta.content += ', viewport-fit=cover';
  });
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, right: 0, bottom: px } });
  await client.detach();
}

for (const size of [
  { width: 390, height: 844 },
  { width: 360, height: 800 },
]) {
  test(titled(`at ${size.width}×${size.height} the action bar stays on the bottom edge through a whole match`), async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(4 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice } = await startScenarioVsAi(browser, stack, 'bolt-player', {
        // Paced, so the AI's turn lasts long enough to be looked at.
        fastMode: false,
        beforeKeep: async (f) => {
          await resizeWindow(f.page, size);
          await expectBarAnchored(f.page, 'the mulligan');
        },
      });
      const page = alice.page;
      await expectBarAnchored(page, 'a quiet main phase');

      await page.getByTestId('action-more').tap();
      await expect(page.getByTestId('action-more')).toHaveAttribute('aria-expanded', 'true');
      await expectBarAnchored(page, 'the ⋯ sheet open');
      await (await inMore(page, 'action-menu')).tap();
      await expect(page.getByTestId('action-menu')).toHaveAttribute('aria-expanded', 'true');
      await expectBarAnchored(page, 'the menu open');
      await page.keyboard.press('Escape');

      await (await inMore(page, 'action-chat')).tap();
      await expect(page.getByTestId('action-chat')).toHaveAttribute('aria-expanded', 'true');
      await expectBarAnchored(page, 'the chat sheet open');
      const input = page.locator('.wp-room-chrome textarea, .wp-room-chrome input[type="text"]').first();
      if ((await input.count()) > 0) {
        await input.tap();
        await expectBarAnchored(page, 'the chat input focused');
      }
      await (await inMore(page, 'action-chat')).tap();
      await expect(page.getByTestId('action-chat')).toHaveAttribute('aria-expanded', 'false');

      await resizeWindow(page, { width: size.width, height: size.height - 84 });
      await expectBarAnchored(page, 'a shorter window (the URL bar showing)');
      await resizeWindow(page, size);
      await expectBarAnchored(page, 'the full window again (the URL bar gone)');

      await withBottomSafeArea(page, 34);
      await expectBarAnchored(page, 'a 34px bottom safe area');
      const barH = await page.getByTestId('action-bar').evaluate((bar) => bar.getBoundingClientRect().height);
      expect.soft(barH, 'the bar’s band grows by the safe area').toBeGreaterThan(52 + 33);
      await withBottomSafeArea(page, 0);

      // The opponent's turn: End Turn is the yield toggle then (`data-yield`, `LiveBoard.tsx`'s `yieldMode`).
      const theirTurn = page.locator('[data-testid="live-button-end-turn"][data-yield]');
      if ((await theirTurn.count()) === 0) await pressInMenu(page, 'live-button-end-turn');
      await expect(theirTurn, 'the opponent’s turn comes').toHaveCount(1, { timeout: 60_000 });
      await expectBarAnchored(page, 'the opponent’s turn');

      await pressInMenu(page, 'live-concede');
      await page.getByTestId('live-concede-yes').tap();
      await page.getByTestId('game-result').waitFor({ timeout: 30_000 });
      await expectBarAnchored(page, 'the game result');
    } finally {
      await stack.stop();
    }
  });
}

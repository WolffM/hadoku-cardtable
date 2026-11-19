/**
 * A card played from the graveyard that its own ability returns to the hand lets go of the board.
 * The operator, 2026-11-19, on Gutterbones (m-1a55915960fd): *"gutterbones stays stuck on the screen
 * when activating its graveyard ability. i see it go to my hand but the card with orange outline is
 * still hovering on the board"*. That match's own `park` event says how long: 106 s, ended only by
 * the next card played.
 *
 * `gy-return-hand.state`: alice has Sanitarium Skeleton in her graveyard and three Swamps. She plays
 * it from the graveyard as she would cast it; its {2}{B} ability resolves and the card is in her
 * hand, with nothing of it left lifted or standing over the board.
 */
import { expect, test, type Page } from '@playwright/test';

import { castLiftOf, handCardNamed, makeTitled, offered, passOverStack, pressPaymentAuto } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const inGraveyard = (page: Page) =>
  page
    .locator('[data-zone="graveyard"][data-owner="you"] [data-board-card]')
    .evaluateAll((els) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === 'Sanitarium Skeleton').map((e) => Number(e.getAttribute('data-board-card'))));

test(titled('Sanitarium Skeleton returned from the graveyard to the hand leaves nothing lifted over the board'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'gy-return-hand');
    const page = seated.alice.page;
    await expect.poll(() => inGraveyard(page), { timeout: 30_000, message: 'the Skeleton is in alice’s graveyard' }).toHaveLength(1);
    const skeleton = (await inGraveyard(page))[0]!;
    await expect.poll(() => offered(page), { timeout: 45_000, message: 'the Skeleton is offered from the graveyard' }).toContain(skeleton);

    // Pressed and released by hand, never `liftAndParkOutsideHand`: that helper ends by reading the park,
    // and here the server pays and passes for her, so the ability can resolve (and the park end) first.
    const button = await page.locator(`[data-board-card="${skeleton}"] button`).first().boundingBox();
    expect(button, 'the Skeleton is drawn in her graveyard').not.toBeNull();
    await page.mouse.click(button!.x + button!.width / 2, button!.y + button!.height / 2);
    await expect.poll(() => castLiftOf(page, skeleton), { timeout: 5_000, message: 'the press lifts it' }).toBe('lifted');
    const table = (await page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    await page.mouse.click(table.x + table.width / 2, table.y + table.height / 2);
    // The server pays an unambiguous cost itself; a payment it leaves to her is paid with Auto.
    await expect
      .poll(
        async () => {
          await pressPaymentAuto(page);
          await passOverStack(page);
          return handCardNamed(page, 'Sanitarium Skeleton');
        },
        { timeout: 45_000, message: 'the ability resolved: the Skeleton is in her hand' },
      )
      .toBe(skeleton);

    await expect(page.locator('[data-cast-ghost], [data-cast-lift], [data-cast-landing]'), 'nothing of it is left over the board').toHaveCount(0, { timeout: 5_000 });
    const inHand = page.locator(`.seat[data-viewer] [data-zone="hand"] [data-board-card="${skeleton}"]`);
    await expect(inHand, 'and the hand draws it').toBeVisible();
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

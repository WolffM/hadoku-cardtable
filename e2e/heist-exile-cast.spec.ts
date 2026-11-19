/**
 * A card Forge lets a seat cast from the opponent's exile is offered there and can be cast. The
 * operator, 2026-11-19 (m-4040eb536bf4): *"Cruelclaw's Heist gifted effect not working, it should let
 * me play the exiled card but it doesn't seem to be selectable at all."* In that match the gift was
 * promised, Forge listed the exiled Scrapshooter among the cards the seat may play from outside its
 * hand, and no offer ever named it; the seat's two clicks on it were refused as not offered.
 *
 * Two boards, the same play: alice casts Cruelclaw's Heist with the gift promised, takes bob's one
 * card, and casts it from his exile. `heist-exile-cast.state` takes Scrapshooter ({1}{G}{G}), which
 * her Swamps pay for only as "mana of any type"; `heist-exile-cast-on-colour.state` takes Walking
 * Corpse ({1}{B}), which they pay for as written.
 */
import { expect, test, type Page } from '@playwright/test';

import { castCard, makeTitled, offered, offeredCard, ownNamed, passOverStack, pressPaymentAuto, serverLog, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The cards of the other seat's exile named `name`, as this page draws them. */
const inTheirExile = (page: Page, name: string): Promise<number[]> =>
  page
    .locator('[data-zone="exile"][data-owner="them"] [data-board-card]')
    .evaluateAll((els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))), name);

/** The cards the server last recorded Forge offering alice at a priority window. */
const lastOffer = (stack: { serverLogFile: string }): unknown =>
  serverLog(stack)
    .filter((r) => r.evt === 'offered' && r.seat === 0 && r.kind === 'priority')
    .at(-1)?.cards ?? [];

const BOARDS = [
  { scenario: 'heist-exile-cast', taken: 'Scrapshooter', paid: 'with mana of any type' },
  { scenario: 'heist-exile-cast-on-colour', taken: 'Walking Corpse', paid: 'with her own colour' },
] as const;

for (const { scenario, taken, paid } of BOARDS) {
  test(titled(`Cruelclaw's Heist, gift promised: ${taken} is offered from the opponent's exile and cast ${paid}`), async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(4 * 60_000);
    const stack = await startPlayStack(forge);
    let seated: ScenarioMatch | null = null;
    try {
      seated = await startScenarioMatch(browser, stack, scenario);
      const page = seated.alice.page;
      const other = seated.bob.page;

      // The cast answers its own asks with their first option: the gift is promised.
      await castCard(page, await offeredCard(page, "Cruelclaw's Heist", { zone: 'hand' }));
      await expect
        .poll(
          async () => {
            await passOverStack(page);
            await passOverStack(other);
            await answerPrompt(page);
            return [(await inTheirExile(page, taken)).length, await stackCount(page)];
          },
          { timeout: 60_000, message: `the Heist resolved: ${taken} is in bob's exile` },
        )
        .toEqual([1, 0]);
      const card = (await inTheirExile(page, taken))[0]!;

      await expect.poll(() => lastOffer(stack), { timeout: 30_000, message: `Forge offers alice ${taken} (card ${card}) from bob's exile` }).toContain(card);
      await expect.poll(() => offered(page), { timeout: 15_000, message: 'and her board draws it as offered' }).toContain(card);

      const button = await page.locator(`[data-zone="exile"][data-owner="them"] [data-board-card="${card}"] button`).first().boundingBox();
      expect(button, `${taken} is drawn in bob's exile`).not.toBeNull();
      await page.mouse.click(button!.x + button!.width / 2, button!.y + button!.height / 2);
      await expect
        .poll(
          async () => {
            await answerPrompt(page);
            await pressPaymentAuto(page);
            await passOverStack(page);
            await passOverStack(other);
            return ownNamed(page, taken);
          },
          { timeout: 60_000, message: `${taken} is cast from bob's exile and enters under alice` },
        )
        .toEqual([card]);
    } finally {
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  });
}

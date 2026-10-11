/**
 * A cost another player's spell puts on yours is yours to pay or decline. The operator, 2026-10-11:
 * *"i just had an izzet charm played against me and it auto-payed for it. i never said it should auto
 * pay for it, that decision should have been surfaced to me. … costs like that should not be autopayed.
 * it's especially relevant here because i had other cards i wanted to play with that mana and not pay
 * for the izzet charm"*.
 *
 * `unless-cost.state`: bob casts Divination off three of five Islands (his own cast — the server still
 * pays that for him, the control), alice answers with Izzet Charm's "counter target noncreature spell
 * unless its controller pays {2}". Bob must then be SHOWN that {2}, with Forge's own pay and decline:
 * declining leaves his two Islands untapped and Divination countered; paying resolves it.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, clickOnce, handCardNamed, makeTitled, offered, pressPaymentAuto, says, serverLog, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';
import { answerLoneAbility } from './play/prompts.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const BOB_SEAT = 1;

const paymentShown = (page: Page): Promise<boolean> => page.getByTestId('live-payment').isVisible().catch(() => false);
const zoneCount = (page: Page, zone: string): Promise<number> =>
  page.locator(`[data-zone="${zone}"][data-owner="you"]`).evaluate((el) => Number(el.getAttribute('data-count') ?? '0'));
const untappedIslands = (page: Page): Promise<number> =>
  page
    .locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]')
    .evaluateAll((els) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === 'Island' && e.getAttribute('data-tapped') !== 'true').length);
const autoPaid = (stack: PlayStack): string =>
  serverLog(stack)
    .filter((r) => r.evt === 'auto-paid' && r.seat === BOB_SEAT)
    .map((r) => String(r.cost))
    .join(', ');

/**
 * Bob casts Divination with the board's own gesture and is never shown its payment (he chose to cast
 * it: the server presses Auto for him). Returns once it is on the stack.
 */
async function castOwnDivination(page: Page): Promise<void> {
  const id = await handCardNamed(page, 'Divination');
  if (id === undefined) throw new Error('no Divination in bob’s hand');
  await expect.poll(() => offered(page), { timeout: 45_000, message: 'Divination is offered to bob' }).toContain(id);
  let shown = false;
  for (let attempt = 0; attempt < 3 && (await stackCount(page)) === 0; attempt++) {
    if (!(await clickHandCard(page, id))) continue;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (await stackCount(page)) === 0) {
      if (await paymentShown(page)) shown = true;
      await answerLoneAbility(page);
      await page.waitForTimeout(50);
    }
  }
  console.log(`[unless-cost] bob's own Divination: payment shown=${shown}, stack=${await stackCount(page)}`);
  expect(shown, 'bob’s own Divination is paid for him — he chose to cast it').toBe(false);
  expect(await stackCount(page), 'bob’s Divination reached the stack').toBe(1);
}

/** Alice casts Izzet Charm, picking its counter mode; its lone target is Divination. */
async function castCharmCounterMode(page: Page): Promise<void> {
  const id = await handCardNamed(page, 'Izzet Charm');
  if (id === undefined) throw new Error('no Izzet Charm in alice’s hand');
  await expect.poll(() => offered(page), { timeout: 20_000, message: 'Izzet Charm is offered to alice' }).toContain(id);
  expect(await clickHandCard(page, id), 'Izzet Charm lifted out of alice’s hand').toBe(true);
  const mode = page.locator('[data-testid="live-prompt"] label').filter({ hasText: /Counter target noncreature spell/ });
  await expect
    .poll(
      async () => {
        if ((await mode.count()) > 0) {
          const box = mode.first().locator('input[data-testid="prompt-choice"]');
          if (!(await box.isChecked())) await box.click({ force: true });
          await page.locator('[data-testid="live-prompt"] [data-testid="prompt-submit"]:enabled').first().click({ timeout: 1_000 }).catch(() => undefined);
        }
        await answerLoneAbility(page);
        await pressPaymentAuto(page);
        return stackCount(page);
      },
      { timeout: 20_000, intervals: [50], message: `Izzet Charm reached the stack — says: "${await says(page)}"` },
    )
    .toBe(2);
}

/** From the scenario start to Izzet Charm resolving against bob's Divination. */
async function toTheUnlessCost(seated: ScenarioMatch, stack: PlayStack): Promise<void> {
  const { alice, bob } = seated;
  await castOwnDivination(bob.page);
  await expect.poll(() => stackCount(alice.page), { timeout: 15_000, message: 'alice sees Divination on the stack' }).toBe(1);
  await castCharmCounterMode(alice.page);
  // Bob passes on the Charm (by hand when the server leaves the stop to him); it resolves and asks him for {2}.
  let shown = false;
  let gone = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !shown && !gone) {
    shown = await paymentShown(bob.page);
    if (shown) break;
    const text = await says(bob.page);
    if (/^Priority:/.test(text) && /Stack: 2 to Resolve/.test(text)) await clickOnce(bob.page, text, 'ok');
    gone = (await stackCount(bob.page)) === 0;
    await bob.page.waitForTimeout(50);
  }
  console.log(`[unless-cost] Izzet Charm resolved: bob shown the payment=${shown}, says="${(await says(bob.page)).replace(/\n/g, ' | ')}", server auto-paid for bob=[${autoPaid(stack)}]`);
  expect(shown, `bob is shown the {2} Izzet Charm asks of his Divination, to pay or decline — the server auto-paid [${autoPaid(stack)}]`).toBe(true);
  await expect(bob.page.getByTestId('live-payment-cancel'), 'bob can decline the {2}').toBeEnabled();
}

test.describe('an unless-cost on your spell is yours to pay or decline', () => {
  test(titled('bob declines Izzet Charm’s {2}: Divination is countered and his two Islands stay untapped'), async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    let seated: ScenarioMatch | null = null;
    try {
      seated = await startScenarioMatch(browser, stack, 'unless-cost');
      const { bob } = seated;
      await toTheUnlessCost(seated, stack);
      await bob.page.getByTestId('live-payment-cancel').click();
      await expect.poll(() => stackCount(bob.page), { timeout: 15_000, message: 'the stack empties' }).toBe(0);
      await expect.poll(() => zoneCount(bob.page, 'graveyard'), { timeout: 10_000, message: 'Divination is countered into bob’s graveyard' }).toBe(1);
      await expect.poll(() => untappedIslands(bob.page), { timeout: 10_000, message: 'bob’s two spare Islands are still untapped' }).toBe(2);
      expect(await zoneCount(bob.page, 'hand'), 'Divination drew nothing').toBe(0);
      console.log(`[unless-cost] declined: graveyard=${await zoneCount(bob.page, 'graveyard')} untapped Islands=${await untappedIslands(bob.page)} hand=${await zoneCount(bob.page, 'hand')}`);
    } finally {
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  });

  test(titled('bob pays Izzet Charm’s {2}: Divination resolves and draws him two'), async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    let seated: ScenarioMatch | null = null;
    try {
      seated = await startScenarioMatch(browser, stack, 'unless-cost');
      const { bob } = seated;
      await toTheUnlessCost(seated, stack);
      await bob.page.getByTestId('live-payment-ok').click();
      await expect.poll(() => stackCount(bob.page), { timeout: 15_000, message: 'the stack empties' }).toBe(0);
      await expect.poll(() => zoneCount(bob.page, 'hand'), { timeout: 10_000, message: 'Divination resolved and drew bob two' }).toBe(2);
      await expect.poll(() => untappedIslands(bob.page), { timeout: 10_000, message: 'all five of bob’s Islands paid' }).toBe(0);
      console.log(`[unless-cost] paid: hand=${await zoneCount(bob.page, 'hand')} untapped Islands=${await untappedIslands(bob.page)}`);
    } finally {
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  });
});

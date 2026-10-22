/**
 * Floating mana pays a payment from the pool by a press on its symbol, whenever the payment is
 * shown, not only when the pool pays it more than one way. The operator, 2026-10-22: *"i just tried
 * to play doomsday and had BBB in the pool. all i could do was click auto to make payment. i should
 * have been able to click on my black mana to pay for the spell there."*
 *
 * `dd-pool-exact.state`: alice taps the Swamp, casts Dark Ritual and floats {B}{B}{B}, then casts
 * Doomsday ({B}{B}{B}) in full control, so the one-way payment is shown rather than paid for her
 * (her game kept it for her; the default pays it). `[dd-pool]` lines are the evidence.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, clickPermanent, handCardNamed, makeTitled, manaPool, offered, ownNamed, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const pool = (page: Page) => page.locator('.seat[data-viewer] [data-mana-pool]');

test(titled('{B}{B}{B} floating pays Doomsday by presses on the pool'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'dd-pool-exact');
    const page = seated.alice.page;
    const payment = page.getByTestId('live-payment');

    await expect.poll(() => ownNamed(page, 'Swamp'), { timeout: 30_000, message: 'alice’s Swamp is out' }).toHaveLength(1);
    const [swamp] = await ownNamed(page, 'Swamp');
    expect(await clickPermanent(page, swamp!), 'the Swamp took the click').toBe(true);
    await expect.poll(async () => (await manaPool(page)).B, { timeout: 15_000, message: '{B} floats' }).toBe(1);

    const ritual = (await handCardNamed(page, 'Dark Ritual'))!;
    await expect.poll(() => offered(page), { timeout: 20_000, message: 'Dark Ritual is offered' }).toContain(ritual);
    expect(await clickHandCard(page, ritual), 'Dark Ritual lifted out of alice’s hand').toBe(true);
    await expect.poll(async () => (await manaPool(page)).B, { timeout: 20_000, message: `{B}{B}{B} floats — says: "${await says(page)}"` }).toBe(3);
    await expect.poll(() => stackCount(page), { timeout: 15_000 }).toBe(0);

    await page.getByTestId('live-full-control').click();
    await expect(page.getByTestId('live-full-control'), 'full control is on').toHaveAttribute('aria-pressed', 'true');
    const doomsday = (await handCardNamed(page, 'Doomsday'))!;
    await expect.poll(() => offered(page), { timeout: 20_000, message: 'Doomsday is offered' }).toContain(doomsday);
    expect(await clickHandCard(page, doomsday), 'Doomsday lifted out of alice’s hand').toBe(true);
    const held = await expect(payment)
      .toBeVisible({ timeout: 15_000 })
      .then(
        () => true,
        () => false,
      );
    const pips = pool(page).locator('[data-pool-pay]');
    console.log(
      `[dd-pool] doomsday: window=${held} pool=${JSON.stringify(await manaPool(page))} pressable=${JSON.stringify(await pips.evaluateAll((els) => els.map((e) => e.getAttribute('data-mana'))))} says="${await says(page)}"`,
    );
    expect(held, 'the payment window is shown').toBe(true);
    expect(await pips.evaluateAll((els) => els.map((e) => e.getAttribute('data-mana'))), 'the {B} in the pool is pressable').toEqual(['B']);
    await expect(pool(page), 'one way to pay is not highlighted as a choice').not.toHaveAttribute('data-pool-pays', '');

    for (let left = 3; left > 0; left--) {
      await expect.poll(async () => (await manaPool(page)).B, { timeout: 15_000 }).toBe(left);
      await pool(page).locator('[data-pool-pay][data-mana="B"]').click();
    }
    await expect.poll(async () => (await manaPool(page)).B ?? 0, { timeout: 20_000, message: `the pool paid it — says: "${await says(page)}"` }).toBe(0);
    console.log(`[dd-pool] paid: pool=${JSON.stringify(await manaPool(page))} stack=${await stackCount(page)} says="${await says(page)}"`);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

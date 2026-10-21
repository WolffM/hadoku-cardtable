/**
 * Floating mana that can pay a cost more than one way is spent by the player, from the pool. The
 * operator, 2026-10-21: *"when playing a spell, if there is more mana in the pool than is needed,
 * we should require the player to click on the mana symbols in their pool to pay for the spell
 * rather than auto-pay. lets highlight the mana pool area when this happens"*.
 *
 * `ch-pool-choice.state`: alice taps a Mountain and the Forest ({R}{G} floating) and casts Sol Ring
 * ({1}). Either colour pays it, so nothing is paid for her: the payment window opens, her pool is
 * highlighted with both pips pressable, and a press on {G} pays it, leaving {R}. She then taps the
 * other Mountain ({R}{R} floating), and Goblin Guide's {R} has one way to be paid from the pool,
 * so it is paid for her with nothing highlighted. `[ch-pool]` lines are the evidence.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, clickPermanent, handCardNamed, makeTitled, manaPool, offered, ownNamed, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const pool = (page: Page) => page.locator('.seat[data-viewer] [data-mana-pool]');

test(titled('a pool that pays a cost two ways is spent by a press on its symbol, highlighted; one way is paid for her'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'ch-pool-choice');
    const page = seated.alice.page;
    const payment = page.getByTestId('live-payment');

    /* ── Float {R}{G} ── */
    await expect.poll(() => ownNamed(page, 'Forest'), { timeout: 30_000, message: 'alice’s lands are out' }).toHaveLength(1);
    const [mountain, otherMountain] = await ownNamed(page, 'Mountain');
    const [forest] = await ownNamed(page, 'Forest');
    expect(await clickPermanent(page, mountain!), 'the Mountain took the click').toBe(true);
    await expect.poll(async () => (await manaPool(page)).R, { timeout: 15_000, message: '{R} floats' }).toBe(1);
    expect(await clickPermanent(page, forest!), 'the Forest took the click').toBe(true);
    await expect.poll(async () => (await manaPool(page)).G, { timeout: 15_000, message: '{G} floats' }).toBe(1);

    /* ── Sol Ring's {1}: two ways, so the pool is hers to spend ── */
    const solRing = (await handCardNamed(page, 'Sol Ring'))!;
    expect(solRing, 'alice holds Sol Ring').not.toBeUndefined();
    await expect.poll(() => offered(page), { timeout: 20_000, message: 'Sol Ring is offered' }).toContain(solRing);
    expect(await clickHandCard(page, solRing), 'Sol Ring lifted out of alice’s hand').toBe(true);
    const held = await expect(payment)
      .toBeVisible({ timeout: 15_000 })
      .then(
        () => true,
        () => false,
      );
    console.log(
      `[ch-pool] sol ring: window=${held} pool=${JSON.stringify(await manaPool(page))} highlighted=${(await pool(page).getAttribute('data-pool-pays')) !== null} solRing=${(await ownNamed(page, 'Sol Ring')).length} says="${await says(page)}"`,
    );
    expect(held, 'the payment window waits for her').toBe(true);
    await expect(pool(page), 'her pool is highlighted').toHaveAttribute('data-pool-pays', '');
    const pips = pool(page).locator('[data-pool-pay]');
    expect((await pips.evaluateAll((els) => els.map((e) => e.getAttribute('data-mana')))).sort(), 'both floating colours are pressable').toEqual(['G', 'R']);
    expect(await manaPool(page), 'nothing was spent for her').toMatchObject({ R: 1, G: 1 });

    await pool(page).locator('[data-pool-pay][data-mana="G"]').click();
    await expect.poll(() => ownNamed(page, 'Sol Ring'), { timeout: 20_000, message: `Sol Ring resolved — says: "${await says(page)}"` }).toHaveLength(1);
    await expect.poll(() => stackCount(page), { timeout: 15_000 }).toBe(0);
    console.log(`[ch-pool] paid with G: pool=${JSON.stringify(await manaPool(page))} highlighted=${(await pool(page).getAttribute('data-pool-pays')) !== null}`);
    expect(await manaPool(page), 'the {G} paid, the {R} still floats').toMatchObject({ R: 1, G: 0 });
    await expect(pool(page), 'the highlight is gone with the payment').not.toHaveAttribute('data-pool-pays', '');

    /* ── Goblin Guide's {R} out of {R}{R}: one way, paid for her ── */
    expect(await clickPermanent(page, otherMountain!), 'the other Mountain took the click').toBe(true);
    await expect.poll(async () => (await manaPool(page)).R, { timeout: 15_000, message: '{R}{R} floats' }).toBe(2);
    const guide = (await handCardNamed(page, 'Goblin Guide'))!;
    await expect.poll(() => offered(page), { timeout: 20_000, message: 'Goblin Guide is offered' }).toContain(guide);
    let sawWindow = false;
    let sawHighlight = false;
    expect(await clickHandCard(page, guide), 'Goblin Guide lifted out of alice’s hand').toBe(true);
    await expect
      .poll(
        async () => {
          if ((await payment.count()) > 0) sawWindow = true;
          if ((await pool(page).getAttribute('data-pool-pays')) !== null) sawHighlight = true;
          return (await ownNamed(page, 'Goblin Guide')).length;
        },
        { timeout: 20_000, intervals: [100], message: `Goblin Guide resolved — says: "${await says(page)}"` },
      )
      .toBe(1);
    console.log(`[ch-pool] goblin guide: window=${sawWindow} highlighted=${sawHighlight} pool=${JSON.stringify(await manaPool(page))}`);
    expect(sawHighlight, 'one way to pay highlights nothing').toBe(false);
    expect(await manaPool(page), 'one {R} paid it').toMatchObject({ R: 1 });
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

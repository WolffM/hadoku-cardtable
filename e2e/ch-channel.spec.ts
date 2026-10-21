/**
 * Channel's life pays a spell the way Phyrexian mana does. The operator, 2026-10-21: *"the card
 * "Channel" my opponent played it, then tried to play emrakul but couldn't."* and the ruling:
 * *"have channel work like phyrexian mana"*.
 *
 * Channel leaves an effect card in its caster's Command zone whose mana ability is "Pay 1 life:
 * Add {C}". No card on the table carries it, so the payment window's life button is the way to
 * use it, one {C} per press, as it pays one Phyrexian shard per press.
 *
 * `ch-channel.state`: alice holds Channel and Emrakul, the Aeons Torn with two Forests out. She
 * casts Channel off the Forests; Emrakul ({15}) is then offered, its payment window offers life,
 * and fifteen presses pay it: 20 → 5, Emrakul on her battlefield. `[ch]` lines are the evidence.
 */
import { expect, test } from '@playwright/test';

import { clickHandCard, handCardNamed, makeTitled, offered, ownNamed, pressPaymentAuto, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('after Channel, Emrakul is offered and the payment window’s life button pays it one {C} per life'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'ch-channel');
    const page = seated.alice.page;
    const ownLife = page.locator('.seat[data-viewer] [data-testid="life"]');
    const graveyard = page.locator('[data-zone="graveyard"][data-owner="you"]');

    /* ── Channel, off the two Forests ── */
    await expect.poll(() => handCardNamed(page, 'Channel'), { timeout: 30_000, message: 'alice holds Channel' }).not.toBeUndefined();
    const channel = (await handCardNamed(page, 'Channel'))!;
    await expect.poll(() => offered(page), { timeout: 45_000, message: 'Channel is offered' }).toContain(channel);
    expect(await clickHandCard(page, channel), 'Channel lifted out of alice’s hand').toBe(true);
    await expect
      .poll(
        async () => {
          if ((await graveyard.getAttribute('data-count')) === '1' && (await stackCount(page)) === 0) return true;
          await pressPaymentAuto(page);
          return false;
        },
        { timeout: 30_000, intervals: [250], message: `Channel resolved — says: "${await says(page)}"` },
      )
      .toBe(true);
    console.log(`[ch] channel resolved: life=${await ownLife.textContent()} offered=${JSON.stringify(await offered(page))}`);

    /* ── Emrakul is offered: fifteen life is enough ── */
    const emrakul = (await handCardNamed(page, 'Emrakul, the Aeons Torn'))!;
    expect(emrakul, 'Emrakul is in alice’s hand').not.toBeUndefined();
    const emrakulOffered = await expect
      .poll(() => offered(page), { timeout: 20_000 })
      .toContain(emrakul)
      .then(
        () => true,
        () => false,
      );
    console.log(`[ch] emrakul offered=${emrakulOffered} offered=${JSON.stringify(await offered(page))} says="${await says(page)}"`);
    expect(emrakulOffered, 'Emrakul is offered while Channel can pay for it').toBe(true);
    expect(await clickHandCard(page, emrakul), 'Emrakul lifted out of alice’s hand').toBe(true);

    /* ── The payment window offers life, and each press pays one ── */
    const payment = page.getByTestId('live-payment');
    await expect(payment, 'the payment window opened').toBeVisible({ timeout: 20_000 });
    const pay = page.getByTestId('live-payment-life');
    console.log(`[ch] payment window: ${JSON.stringify(await payment.textContent())} lifeButton=${await pay.count()}`);
    await expect(pay, 'the payment window offers life').toBeEnabled({ timeout: 10_000 });
    for (let paid = 1; paid <= 15; paid++) {
      await expect(pay, `press ${paid}: the life button is live`).toBeEnabled({ timeout: 10_000 });
      await pay.click();
      await expect.poll(() => ownLife.textContent(), { timeout: 10_000, message: `press ${paid} paid one life` }).toBe(String(20 - paid));
    }
    await expect.poll(() => ownNamed(page, 'Emrakul, the Aeons Torn'), { timeout: 30_000, message: `Emrakul resolved — says: "${await says(page)}"` }).toHaveLength(1);
    console.log(`[ch] emrakul resolved: life=${await ownLife.textContent()} payment=${await payment.count()}`);
    expect(await ownLife.textContent(), 'Emrakul cost fifteen life').toBe('5');
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

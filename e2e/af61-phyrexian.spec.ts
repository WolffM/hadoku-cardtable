/**
 * A Phyrexian cost is paid with life from a button on the payment window. The operator, 2026-10-15:
 * *"clicking on life total is super strange. why not just show a button on the card decision modal
 * for paying with phyrexian mana?"* The button sends what the life-total click sent — Forge's
 * `InputPayManaOfCostPayment.onPlayerSelected` on the payer, 2 life per Phyrexian shard — and the
 * life total is no longer a payment target, nor does the window repeat Forge's "click on your life
 * total" sentence.
 *
 * `af61-phyrexian.state`: alice holds Gitaxian Probe ({U/P}) and no land. She casts it at bob, and
 * the payment window opens with life as the only way to pay; a real press of the life button pays
 * it: 20 → 18, Probe resolves (graveyard) and draws her a card.
 */
import { expect, test } from '@playwright/test';

import { clickHandCard, handCardNamed, makeTitled, offered, pressOffered, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('the payment window’s life button pays a Phyrexian cost with 2 life'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'af61-phyrexian');
    const page = seated.alice.page;
    const ownLife = page.locator('.seat[data-viewer] [data-testid="life"]');
    const graveyard = page.locator('[data-zone="graveyard"][data-owner="you"]');

    await expect.poll(() => handCardNamed(page, 'Gitaxian Probe'), { timeout: 30_000, message: 'alice holds Gitaxian Probe' }).not.toBeUndefined();
    const probe = (await handCardNamed(page, 'Gitaxian Probe'))!;
    await expect.poll(() => offered(page), { timeout: 45_000, message: 'Gitaxian Probe is offered with no land out' }).toContain(probe);
    expect(await clickHandCard(page, probe), 'Gitaxian Probe lifted out of alice’s hand').toBe(true);

    // Its target is bob; then the payment window opens.
    const bobFace = page.locator('[data-player-face]:not([data-viewer])');
    const payment = page.getByTestId('live-payment');
    await expect
      .poll(
        async () => {
          if ((await payment.count()) > 0) return true;
          await answerPrompt(page);
          await pressOffered(bobFace);
          return false;
        },
        { timeout: 20_000, intervals: [50], message: `the payment window opened — says: "${await says(page)}"` },
      )
      .toBe(true);
    const asked = (await payment.textContent()) ?? '';
    console.log(`[af61] payment window: ${JSON.stringify(asked)}`);
    expect(asked, 'the window keeps Forge’s cost line').toMatch(/Pay Mana Cost/);
    expect(asked, 'the window does not tell the player to click their life total').not.toMatch(/life total/i);

    // The life total is not a payment target any more; the button is.
    const own = page.locator('[data-player-face][data-viewer]');
    const selectable = await own.getAttribute('data-selectable');
    console.log(`[af61] own face while paying: selectable=${String(selectable)}`);
    expect(selectable, 'alice’s own life total is not clickable during the payment').not.toBe('true');
    const pay = page.getByTestId('live-payment-life');
    await expect(pay, 'the payment window offers life').toBeEnabled({ timeout: 10_000 });
    console.log(`[af61] life button: ${JSON.stringify(await pay.textContent())}`);
    await pay.click();
    await expect
      .poll(() => ownLife.textContent(), { timeout: 15_000, message: `alice paid 2 life — payment window ${(await payment.count()) > 0 ? 'still open' : 'gone'}, settings ${(await page.getByRole('dialog', { name: /settings/i }).count()) > 0 ? 'opened' : 'closed'}` })
      .toBe('18');
    await expect.poll(() => stackCount(page), { timeout: 15_000, message: 'Probe resolved' }).toBe(0);
    await expect.poll(() => graveyard.getAttribute('data-count'), { timeout: 15_000, message: 'Probe is in alice’s graveyard' }).toBe('1');
    console.log(`[af61] paid: life=${await ownLife.textContent()} graveyard=${await graveyard.getAttribute('data-count')}`);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

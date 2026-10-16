/**
 * The payment window's life button pays a cost with two Phyrexian shards AND a generic part. The
 * operator, 2026-10-15: *"is this button clickable multiple times? what if i play dismember"*.
 * `af61-phyrexian.spec.ts` proves one shard and nothing else; this is the multi-shard case.
 *
 * `dp-dismember.state`: alice holds Dismember ({1}{B/P}{B/P}) and one untapped Plains, which cannot
 * make black, so each shard can only be paid with life. She casts it at bob's Grizzly Bears. One
 * press of the life button pays one shard (2 life); it is spent until Forge's next frame and then
 * pressable again; a second press pays the other shard (4 life in all). Forge takes that life once,
 * when the whole cost is paid. The {1} is left, with one Plains to pay it, and the server pays it
 * (one source, one payment). Dismember resolves: the Bears die, alice is at 16, Dismember is in her
 * graveyard.
 */
import { expect, test } from '@playwright/test';

import { boardCard, clickHandCard, handCardNamed, isOffered, isTapped, makeTitled, offered, ownNamed, says, serverLog, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('Dismember: the life button pays both Phyrexian shards, one press each, and a land pays the {1}'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'dp-dismember');
    const page = seated.alice.page;
    const ownLife = page.locator('.seat[data-viewer] [data-testid="life"]');
    const graveyard = page.locator('[data-zone="graveyard"][data-owner="you"]');
    const payment = page.getByTestId('live-payment');
    const pay = page.getByTestId('live-payment-life');
    const bears = () =>
      page
        .locator('.seat:not([data-viewer]) [data-zone="battlefield"] [data-board-card]')
        .evaluateAll((els) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === 'Grizzly Bears').map((e) => Number(e.getAttribute('data-board-card'))));
    const lifeButton = () =>
      page.evaluate(() => {
        const b = document.querySelector<HTMLButtonElement>('[data-testid="live-payment-life"]');
        return b === null ? 'absent' : b.disabled ? 'disabled' : 'enabled';
      });
    const paymentText = () => page.evaluate(() => document.querySelector('[data-testid="live-payment"]')?.textContent ?? null);
    const evidence = async (step: string) => console.log(`[dp] ${step}: life=${await ownLife.textContent()} button=${await lifeButton()} prompt=${JSON.stringify(await paymentText())}`);

    await expect.poll(() => handCardNamed(page, 'Dismember'), { timeout: 30_000, message: 'alice holds Dismember' }).not.toBeUndefined();
    const dismember = (await handCardNamed(page, 'Dismember'))!;
    await expect.poll(bears, { timeout: 30_000, message: 'bob has Grizzly Bears out' }).toHaveLength(1);
    const bear = (await bears())[0]!;
    await expect.poll(() => offered(page), { timeout: 45_000, message: 'Dismember is offered with one Plains out' }).toContain(dismember);
    expect(await clickHandCard(page, dismember), 'Dismember lifted out of alice’s hand').toBe(true);

    // Its target is the Bears; then the payment window opens.
    await expect
      .poll(
        async () => {
          if ((await payment.count()) > 0) return true;
          await answerPrompt(page);
          if (await isOffered(page, bear).catch(() => false)) await boardCard(page, bear).locator('button').first().click({ timeout: 1_000 }).catch(() => undefined);
          return false;
        },
        { timeout: 20_000, intervals: [50], message: `the payment window opened — says: "${await says(page)}"` },
      )
      .toBe(true);
    await evidence('payment opened');
    expect(await payment.textContent(), 'the window keeps Forge’s cost line').toMatch(/Pay Mana Cost/);
    await expect(pay, 'the payment window offers life').toBeEnabled({ timeout: 10_000 });

    // Forge counts each press toward the cost and takes the life once, when the whole cost is paid
    // (`InputPayManaOfCostPayment.onPlayerSelected` adds 2 to `phyLifeToLose`; `done()` pays it), so a
    // press shows as its "(N life paid for phyrexian mana)" line while the total still reads 20.
    const lifePaid = async () => /\((\d+) life paid for phyrexian mana\)/.exec((await paymentText()) ?? '')?.[1] ?? '0';

    // First shard.
    await pay.click();
    await evidence('first press sent');
    await expect.poll(lifePaid, { timeout: 15_000, message: 'Forge took the first press: 2 life toward the cost' }).toBe('2');
    await expect(pay, 'Forge’s next frame makes the button pressable again for the second shard').toBeEnabled({ timeout: 15_000 });
    expect(await ownLife.textContent(), 'no life is lost before the cost is paid').toBe('20');
    await evidence('first shard paid');

    // Second shard. It leaves only the {1}, which one Plains pays one way, so the server presses
    // Forge's Auto for alice (`auto.ts`'s `decidePay`, the default `unambiguousPayment: 'auto'`) and
    // that frame is never drawn: the server's `auto-paid` row is where the {1}-only cost shows.
    await pay.click();
    await evidence('second press sent');
    const autoPaid = () => serverLog(stack).filter((r) => r.evt === 'auto-paid' && r.seat === 0).map((r) => String(r.cost));
    await expect.poll(autoPaid, { timeout: 15_000, message: 'Forge took the second press, and the server paid the {1} that was left' }).toEqual(['{1} (4 life paid for phyrexian mana)']);
    console.log(`[dp] server auto-paid: ${JSON.stringify(autoPaid())}`);
    const [plains] = await ownNamed(page, 'Plains');
    expect(plains, 'alice has her Plains').not.toBeUndefined();
    await expect.poll(() => isTapped(page, plains!), { timeout: 15_000, message: 'the Plains paid the {1}' }).toBe(true);
    await expect(payment, 'the payment window is gone').toHaveCount(0);

    await expect.poll(() => stackCount(page), { timeout: 15_000, message: 'Dismember resolved' }).toBe(0);
    await expect.poll(bears, { timeout: 15_000, message: 'the Bears died' }).toHaveLength(0);
    await expect.poll(() => graveyard.getAttribute('data-count'), { timeout: 15_000, message: 'Dismember is in alice’s graveyard' }).toBe('1');
    expect(await ownLife.textContent(), 'alice paid exactly 4 life').toBe('16');
    console.log(`[dp] resolved: life=${await ownLife.textContent()} graveyard=${await graveyard.getAttribute('data-count')} bears=${(await bears()).length} plainsTapped=${await isTapped(page, plains!)} payment=${await payment.count()}`);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

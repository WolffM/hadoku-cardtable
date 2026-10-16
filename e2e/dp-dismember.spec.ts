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
 *
 * The operator, 2026-10-15: *"it would be nice to see the life go down as you click the button. and
 * if you click cancel, it gives the life back."* So each press shows on both screens' life totals as
 * Forge counts it (20 → 18 → 16), the total never climbs back while Forge takes the 4 at the end,
 * and a cancelled payment shows 20 again with Dismember back in hand.
 */
import { expect, test, type Page } from '@playwright/test';

import { boardCard, clickHandCard, handCardNamed, isOffered, isTapped, makeTitled, offered, ownNamed, says, serverLog, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const OWN_LIFE = '.seat[data-viewer] [data-testid="life"]';
const OPPONENT_LIFE = '.seat:not([data-viewer]) [data-testid="life"]';

/** Every value alice's life badge shows from now on, on her screen and on bob's, in order. */
async function recordLife(seated: ScenarioMatch): Promise<() => Promise<{ own: string[]; seen: string[] }>> {
  const watch = (page: Page, selector: string) =>
    page.evaluate((sel) => {
      const w = window as unknown as { __lifeSeen?: string[] };
      const seen: string[] = [];
      w.__lifeSeen = seen;
      const note = () => {
        const text = document.querySelector(sel)?.textContent ?? '';
        if (seen[seen.length - 1] !== text) seen.push(text);
      };
      note();
      new MutationObserver(note).observe(document.body, { subtree: true, childList: true, characterData: true });
    }, selector);
  await watch(seated.alice.page, OWN_LIFE);
  await watch(seated.bob.page, OPPONENT_LIFE);
  const read = (page: Page) => page.evaluate(() => (window as unknown as { __lifeSeen?: string[] }).__lifeSeen ?? []);
  return async () => ({ own: await read(seated.alice.page), seen: await read(seated.bob.page) });
}

/** Whether a run of life values never goes back up. */
const neverClimbs = (values: readonly string[]) => values.every((v, i) => i === 0 || Number(v) <= Number(values[i - 1]));

/** Alice casts Dismember at bob's Bears and the payment window opens. */
async function openPayment(seated: ScenarioMatch): Promise<{ bears: () => Promise<number[]> }> {
  const page = seated.alice.page;
  const payment = page.getByTestId('live-payment');
  const bears = () =>
    page
      .locator('.seat:not([data-viewer]) [data-zone="battlefield"] [data-board-card]')
      .evaluateAll((els) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === 'Grizzly Bears').map((e) => Number(e.getAttribute('data-board-card'))));
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
  expect(await payment.textContent(), 'the window keeps Forge’s cost line').toMatch(/Pay Mana Cost/);
  await expect(page.getByTestId('live-payment-life'), 'the payment window offers life').toBeEnabled({ timeout: 10_000 });
  return { bears };
}

function evidenceOf(seated: ScenarioMatch) {
  const page = seated.alice.page;
  const lifeButton = () =>
    page.evaluate(() => {
      const b = document.querySelector<HTMLButtonElement>('[data-testid="live-payment-life"]');
      return b === null ? 'absent' : b.disabled ? 'disabled' : 'enabled';
    });
  const paymentText = () => page.evaluate(() => document.querySelector('[data-testid="live-payment"]')?.textContent ?? null);
  return {
    paymentText,
    evidence: async (step: string) =>
      console.log(
        `[dp] ${step}: life=${await page.locator(OWN_LIFE).textContent()} bobSees=${await seated.bob.page.locator(OPPONENT_LIFE).textContent()} button=${await lifeButton()} prompt=${JSON.stringify(await paymentText())}`,
      ),
  };
}

test(titled('Dismember: the life button pays both Phyrexian shards, one press each, the life shows as it is paid, and a land pays the {1}'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'dp-dismember');
    const page = seated.alice.page;
    const ownLife = page.locator(OWN_LIFE);
    const bobSees = seated.bob.page.locator(OPPONENT_LIFE);
    const graveyard = page.locator('[data-zone="graveyard"][data-owner="you"]');
    const payment = page.getByTestId('live-payment');
    const pay = page.getByTestId('live-payment-life');
    const { bears } = await openPayment(seated);
    const { paymentText, evidence } = evidenceOf(seated);
    await evidence('payment opened');
    const lifeSeen = await recordLife(seated);

    // Forge counts each press toward the cost and takes the life once, when the whole cost is paid
    // (`InputPayManaOfCostPayment.onPlayerSelected` adds 2 to `phyLifeToLose`; `done()` pays it). The
    // life committed so far shows on both screens as Forge counts it.
    const lifePaid = async () => /\((\d+) life paid for phyrexian mana\)/.exec((await paymentText()) ?? '')?.[1] ?? '0';

    // First shard.
    await pay.click();
    await evidence('first press sent');
    await expect.poll(lifePaid, { timeout: 15_000, message: 'Forge took the first press: 2 life toward the cost' }).toBe('2');
    await expect(pay, 'Forge’s next frame makes the button pressable again for the second shard').toBeEnabled({ timeout: 15_000 });
    await expect(ownLife, 'alice sees the 2 life she committed come off').toHaveText('18', { timeout: 10_000 });
    await expect(bobSees, 'bob sees alice’s 2 life come off').toHaveText('18', { timeout: 10_000 });
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
    expect(await bobSees.textContent(), 'bob sees alice at 16').toBe('16');
    const seen = await lifeSeen();
    console.log(`[dp] life shown from the first press: alice=${JSON.stringify(seen.own)} bob=${JSON.stringify(seen.seen)}`);
    expect(neverClimbs(seen.own), `alice’s life never climbed back while Forge took the 4: ${JSON.stringify(seen.own)}`).toBe(true);
    expect(neverClimbs(seen.seen), `bob never saw alice’s life climb back: ${JSON.stringify(seen.seen)}`).toBe(true);
    expect(seen.own.filter((v) => Number(v) < 16), 'alice’s life never went below 16').toEqual([]);
    console.log(`[dp] resolved: life=${await ownLife.textContent()} graveyard=${await graveyard.getAttribute('data-count')} bears=${(await bears()).length} plainsTapped=${await isTapped(page, plains!)} payment=${await payment.count()}`);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

test(titled('Dismember: a payment cancelled after one life press gives the life back and Dismember back to the hand'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'dp-dismember');
    const page = seated.alice.page;
    const ownLife = page.locator(OWN_LIFE);
    const bobSees = seated.bob.page.locator(OPPONENT_LIFE);
    const payment = page.getByTestId('live-payment');
    const { bears } = await openPayment(seated);
    const { evidence } = evidenceOf(seated);

    await page.getByTestId('live-payment-life').click();
    await expect(ownLife, 'alice sees the 2 life she committed come off').toHaveText('18', { timeout: 15_000 });
    await expect(bobSees, 'bob sees alice’s 2 life come off').toHaveText('18', { timeout: 10_000 });
    await evidence('one shard paid');

    const cancel = page.getByTestId('live-payment-cancel');
    await expect(cancel, 'the payment can be cancelled').toBeEnabled({ timeout: 10_000 });
    await cancel.click();
    await expect(payment, 'the payment window is gone').toHaveCount(0, { timeout: 15_000 });
    await expect(ownLife, 'Forge took nothing: alice is back at 20').toHaveText('20', { timeout: 10_000 });
    await expect(bobSees, 'bob sees alice back at 20').toHaveText('20', { timeout: 10_000 });
    await expect.poll(() => handCardNamed(page, 'Dismember'), { timeout: 15_000, message: 'Dismember is back in alice’s hand' }).not.toBeUndefined();
    expect(await stackCount(page), 'nothing was cast').toBe(0);
    expect(await bears(), 'the Bears live').toHaveLength(1);
    await evidence('cancelled');
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

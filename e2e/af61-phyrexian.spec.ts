/**
 * A Phyrexian cost is paid with life from the payment window. The operator, 2026-10-14: *"phyrexian
 * mana doesn't work, cannot click life total."* Forge's payment input says how —
 * `(Click on your life total to pay life for phyrexian mana.)` — and takes it as a click on the
 * paying player (`InputPayManaOfCostPayment.onPlayerSelected`: 2 life per Phyrexian shard).
 *
 * `af61-phyrexian.state`: alice holds Gitaxian Probe ({U/P}) and no land. She casts it at bob, and
 * the payment window opens with life as the only way to pay; a real click on her own life total
 * pays it: 20 → 18, Probe resolves (graveyard) and draws her a card.
 */
import { expect, test } from '@playwright/test';

import { clickHandCard, handCardNamed, makeTitled, offered, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('a click on your own life total pays a Phyrexian cost with 2 life'), async ({ browser }) => {
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
          if ((await bobFace.getAttribute('data-selectable')) === 'true') await bobFace.locator('.face__hit').click({ timeout: 1_000 }).catch(() => undefined);
          return false;
        },
        { timeout: 20_000, intervals: [50], message: `the payment window opened — says: "${await says(page)}"` },
      )
      .toBe(true);
    const asked = (await payment.textContent()) ?? '';
    console.log(`[af61] payment window: ${JSON.stringify(asked)}`);
    expect(asked, 'Forge asks for {U/P} and says the life total pays it').toMatch(/life total/i);

    // The operator's gesture: a real click on the number itself.
    const own = page.locator('[data-player-face][data-viewer]');
    console.log(`[af61] own face while paying: selectable=${String(await own.getAttribute('data-selectable'))}`);
    await ownLife.click();
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

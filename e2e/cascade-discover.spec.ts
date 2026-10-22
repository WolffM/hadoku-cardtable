/**
 * Cascade and discover offer a card from exile, and the decision window draws that card whole. The
 * operator, 2026-10-22: *"effects like discover/cascade must [show] the full card that they are
 * casting. at the moment it just shows text."*
 *
 * `cascade-discover.state`: alice casts Bloodbraid Elf (cascade finds Lightning Bolt) and answers No,
 * then Geological Appraiser (discover 3 finds Opt) and takes it into her hand. Each offer's window
 * draws the offered card (`confirm-card`). `[cd]` lines are the evidence.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, handCardNamed, makeTitled, offered, passOverStack, says } from './play/board.ts';
import { answerConfirm, confirmOpen } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Cast `name` and run the stack until a decision window opens, then read the card it draws. */
async function castUntilOffer(page: Page, name: string): Promise<{ message: string; card: string[] }> {
  const id = (await handCardNamed(page, name))!;
  expect(id, `alice holds ${name}`).toBeDefined();
  await expect.poll(() => offered(page), { timeout: 20_000, message: `${name} is offered` }).toContain(id);
  expect(await clickHandCard(page, id), `${name} lifted out of alice’s hand`).toBe(true);
  await expect
    .poll(
      async () => {
        if (await confirmOpen(page)) return true;
        await passOverStack(page);
        return false;
      },
      { timeout: 45_000, intervals: [250], message: `${name}'s offer opens — says: "${await says(page)}"` },
    )
    .toBe(true);
  const confirm = page.getByTestId('live-confirm');
  const message = ((await confirm.locator('.confirm__message').textContent()) ?? '').trim();
  const card = (await confirm.getByTestId('confirm-card').locator('.card__name').allTextContents()).map((s) => s.trim());
  return { message, card };
}

test(titled('cascade and discover draw the card they offer in the decision window'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'cascade-discover');
    const page = seated.alice.page;

    const cascade = await castUntilOffer(page, 'Bloodbraid Elf');
    console.log(`[cd] cascade: "${cascade.message}" card [${cascade.card.join(', ')}]`);
    expect(cascade.card, 'the cascade offer draws Lightning Bolt').toEqual(['Lightning Bolt']);
    await answerConfirm(page, 'no');
    await expect.poll(() => confirmOpen(page), { timeout: 15_000 }).toBe(false);

    const discover = await castUntilOffer(page, 'Geological Appraiser');
    console.log(`[cd] discover: "${discover.message}" card [${discover.card.join(', ')}]`);
    expect(discover.card, 'the discover offer draws Opt').toEqual(['Opt']);
    await answerConfirm(page, 'no');
    await expect.poll(async () => (await handCardNamed(page, 'Opt')) !== undefined, { timeout: 20_000, message: 'Opt went to alice’s hand' }).toBe(true);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

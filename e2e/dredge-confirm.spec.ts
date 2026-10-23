/**
 * An optional replacement's yes/no draws its question and its card. The operator, 2026-10-23, on a
 * Yes/No at their draw whose only words were the turn's status lines: *"is this a dredge trigger? that
 * looks like a bug"*, *"why isn't it showing the dredge card and telling me the effect?"*.
 *
 * `dredge-confirm.state`: bob's turn 2 passes into alice's, Stinkweed Imp (Dredge 5) in her graveyard. Her draw
 * asks whether to dredge it instead; the window says so and draws the Imp (`confirm-card`), and Yes
 * returns it to her hand. `[dc]` lines are the evidence.
 */
import { expect, test } from '@playwright/test';

import { handCardNamed, makeTitled, passOverStack, says } from './play/board.ts';
import { answerConfirm, confirmOpen } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('a dredge’s yes/no says what it is and draws the card it would return'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'dredge-confirm');
    const page = seated.alice.page;
    const bob = seated.bob.page;
    await expect
      .poll(
        async () => {
          if (await confirmOpen(page)) return true;
          for (const p of [bob, page]) await passOverStack(p);
          return false;
        },
        { timeout: 60_000, intervals: [250], message: `the dredge is asked — says: "${await says(page)}"` },
      )
      .toBe(true);
    const confirm = page.getByTestId('live-confirm');
    const message = ((await confirm.locator('.confirm__message').textContent()) ?? '').trim();
    const card = (await confirm.getByTestId('confirm-card').locator('.card__name').allTextContents()).map((s) => s.trim());
    console.log(`[dc] dredge: "${message}" card [${card.join(', ')}]`);
    expect(message, 'the window asks the dredge’s own question').toMatch(/Stinkweed Imp/);
    expect(message, 'and names the effect').toMatch(/Dredge 5/);
    expect(message, 'never the turn’s status lines').not.toMatch(/Priority:|Stack: Empty/);
    expect(card, 'the window draws the Imp').toEqual(['Stinkweed Imp']);

    await answerConfirm(page, 'yes');
    await expect.poll(async () => (await handCardNamed(page, 'Stinkweed Imp')) !== undefined, { timeout: 20_000, message: 'the Imp came back to alice’s hand' }).toBe(true);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

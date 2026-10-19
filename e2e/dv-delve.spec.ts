/**
 * Delve is one pick of graveyard cards. The operator, 2026-10-19: *"if i delve 6 i should be picking 6
 * cards not 1 card 6 times."* Forge's own `chooseCardsToDelve` asks how many, then which card once per
 * card; the bridge's `SeatController` asks once, through the list prompt every multi-pick uses.
 *
 * `dv-delve.state`: alice holds Treasure Cruise ({7}{U}) with eight Islands and eight graveyard cards.
 * She casts it: ONE prompt shows the eight graveyard cards (each opens the inspector on hover) counted
 * against seven, and Done works from none picked. She picks six and presses Done; no other question
 * follows, the six are in her exile, and the Cruise cost {1}{U}: two Islands tap.
 */
import { expect, test } from '@playwright/test';

import { clickHandCard, clickOnce, handCardNamed, makeTitled, offered, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('delve asks once: pick six graveyard cards, six exiled, the cost six less'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'dv-delve');
    const page = seated.alice.page;
    const graveyard = page.locator('[data-zone="graveyard"][data-owner="you"]');
    const exiled = page.locator('.seat[data-viewer] [data-zone="exile"] [data-board-card]');
    const tappedLands = page.locator('[data-zone="battlefield"][data-owner="you"] [data-board-card][data-tapped]');
    const prompt = page.getByTestId('live-prompt');

    await expect.poll(() => handCardNamed(page, 'Treasure Cruise'), { timeout: 30_000, message: 'alice holds Treasure Cruise' }).not.toBeUndefined();
    const cruise = (await handCardNamed(page, 'Treasure Cruise'))!;
    await expect.poll(() => offered(page), { timeout: 45_000, message: 'Treasure Cruise is offered' }).toContain(cruise);
    await expect(graveyard, 'eight cards in alice’s graveyard').toHaveAttribute('data-count', '8');
    expect(await clickHandCard(page, cruise), 'Treasure Cruise lifted out of alice’s hand').toBe(true);

    // The delve question: the first prompt the cast opens.
    await expect(prompt, `a prompt opened — says: "${await says(page)}"`).toHaveCount(1, { timeout: 20_000 });
    const first = { method: await prompt.getAttribute('data-method'), callId: await prompt.getAttribute('data-call-id'), text: await prompt.textContent() };
    console.log(`[dv] first prompt: ${JSON.stringify(first)}`);
    expect(first.method, 'the delve question is a list prompt').toBe('getChoices');
    const boxes = prompt.locator('input[data-testid="prompt-choice"]');
    await expect(boxes, 'one prompt naming every graveyard card').toHaveCount(8);
    const bounds = prompt.getByTestId('prompt-bounds');
    await expect(bounds, 'none picked, of seven at most').toHaveText('0 / 7');
    const done = prompt.getByTestId('prompt-submit');
    await expect(done, 'Done with none picked').toBeEnabled();

    await prompt.locator('li[data-card-id]').first().hover();
    await expect(page.locator('[data-inspect]'), 'a graveyard card opens the inspector').toHaveCount(1, { timeout: 5_000 });

    const picked: number[] = [];
    for (let i = 0; i < 6; i++) {
      await boxes.nth(i).click({ force: true });
      picked.push(Number(await prompt.locator('li[data-card-id]').nth(i).getAttribute('data-card-id')));
    }
    await expect(bounds, 'six picked, of seven').toHaveText('6 / 7');
    await expect(done, 'Done with six picked').toBeEnabled();
    await done.click();

    // No second question: only the mana payment is left, and the spell resolves.
    const later: string[] = [];
    await expect
      .poll(
        async () => {
          const open = await page.evaluate(() => {
            const p = document.querySelector('[data-testid="live-prompt"]');
            return p === null ? null : `${p.getAttribute('data-method')}:${p.getAttribute('data-call-id')}`;
          });
          if (open !== null && !open.endsWith(`:${first.callId}`) && !later.includes(open)) later.push(open);
          const text = await says(page);
          if (/Pay Mana Cost/i.test(text)) await clickOnce(page, text, 'ok');
          return (await stackCount(page)) === 0 && (await graveyard.getAttribute('data-count')) === '3';
        },
        { timeout: 30_000, intervals: [100], message: `Treasure Cruise resolved — says: "${await says(page)}"` },
      )
      .toBe(true);
    const inExile = await exiled.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))));
    console.log(`[dv] picked ${JSON.stringify(picked)} exile ${JSON.stringify(inExile)} later prompts ${JSON.stringify(later)} tapped ${await tappedLands.count()}`);
    expect(later, 'no other question after the delve pick').toEqual([]);
    expect([...inExile].sort(), 'the six picked are in exile').toEqual([...picked].sort());
    await expect(tappedLands, 'the cost was six less: {1}{U} taps two Islands').toHaveCount(2);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

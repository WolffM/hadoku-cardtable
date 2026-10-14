/**
 * The operator, 2026-10-13: *"double click to confirm without needing to click ok"*.
 *
 * Against real Forge, on `tt-cryptic.state`: bob casts Memnite, alice casts
 * Cryptic Command at it with full control on, so every question is hers to
 * answer. OK is never pressed:
 *  - the mode prompt picks two: a double click on "Counter target spell"
 *    picks it and leaves the prompt open (one mode is not an answer yet); a
 *    double click on "Draw a card" picks it and answers;
 *  - the target prompt picks one: a double click on Memnite answers it.
 * Cryptic Command reaching the stack is Forge accepting both answers.
 *
 * `[af30]` lines are the evidence: what each prompt held after each double click.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { castCard, clickOnce, dragHandCard, handCardNamed, makeTitled, offered, says, stackCount } from './play/board.ts';
import { answerLoneAbility } from './play/prompts.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const modePrompt = (page: Page): Locator =>
  page.locator('section[data-prompt="getChoices"]').filter({ has: page.locator('li', { hasText: /Counter target spell|Draw a card/ }) });
const targetPrompt = (page: Page): Locator =>
  page.locator('section[data-prompt="getChoices"]').filter({ has: page.locator('li', { hasText: 'Memnite' }) });
const checkedLabels = (prompt: Locator): Promise<string[]> =>
  prompt.locator('li:has(input:checked)').allTextContents();

test(titled('double-clicking a choice picks it and confirms: a two-mode prompt answers on the second mode, a one-target prompt at once — OK never pressed'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'tt-cryptic');
    const { alice, bob } = seated;
    const page = alice.page;
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.getByTestId('live-full-control').click();
    await expect(page.getByTestId('live-full-control'), 'full control is on for alice').toHaveAttribute('aria-pressed', 'true');

    const memnite = await handCardNamed(bob.page, 'Memnite');
    expect(memnite, 'Memnite is in bob’s hand').not.toBeUndefined();
    await expect.poll(() => offered(bob.page), { timeout: 15_000, message: 'bob is offered Memnite' }).toContain(memnite!);
    await castCard(bob.page, memnite!);
    await expect.poll(() => stackCount(page), { timeout: 15_000, message: 'bob’s Memnite reached the stack' }).toBe(1);

    const cryptic = await handCardNamed(page, 'Cryptic Command');
    expect(cryptic, 'Cryptic Command is in alice’s hand').not.toBeUndefined();
    const id = cryptic!;
    await expect.poll(() => offered(page), { timeout: 15_000, message: 'alice is offered Cryptic Command' }).toContain(id);
    const bf = await page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox();
    expect(bf, 'alice’s battlefield has a box').not.toBeNull();
    const releaseAt = { x: bf!.x + bf!.width / 2, y: bf!.y + bf!.height / 2 };
    const lift = () => page.locator(`[data-board-card="${id}"]`).getAttribute('data-cast-lift').catch(() => null);
    for (let i = 0; i < 4 && (await lift()) !== 'parked'; i++) {
      if (i > 0) await page.waitForTimeout(250);
      await dragHandCard(page, id, releaseAt);
    }
    expect(await lift(), 'Cryptic Command is parked — the cast went out').toBe('parked');

    const submits: string[] = [];
    await page.exposeBinding('__af30Submit', (_src, what: string) => {
      submits.push(what);
    });
    await page.evaluate(() => {
      document.addEventListener(
        'click',
        (e) => {
          const t = e.target as Element | null;
          if (t?.closest('[data-testid="prompt-submit"]')) (window as unknown as { __af30Submit: (w: string) => void }).__af30Submit('prompt-submit');
        },
        true,
      );
    });

    let modesDone = false;
    let targetDone = false;
    await expect
      .poll(
        async () => {
          if (await answerLoneAbility(page)) return stackCount(page);
          const mode = modePrompt(page);
          if (!modesDone && (await mode.count()) > 0) {
            await page.waitForTimeout(500);
            await mode.locator('li', { hasText: 'Counter target spell' }).first().locator('label').dblclick();
            await page.waitForTimeout(1_000);
            const open = await mode.count();
            const held = open > 0 ? await checkedLabels(mode) : [];
            console.log(`[af30] mode prompt after double-clicking "Counter target spell": open=${open} checked=${JSON.stringify(held)}`);
            expect(open, 'one of two modes is not an answer: the prompt stays open').toBe(1);
            expect(held.some((t) => t.includes('Counter target spell')), 'the double-clicked mode is picked').toBe(true);
            await mode.locator('li', { hasText: 'Draw a card' }).first().locator('label').dblclick();
            await expect(mode, 'the second mode makes it an answer: the prompt is answered').toHaveCount(0, { timeout: 5_000 });
            console.log('[af30] mode prompt answered by double-clicking "Draw a card"');
            modesDone = true;
            return stackCount(page);
          }
          const target = targetPrompt(page);
          if (!targetDone && (await target.count()) > 0) {
            await page.waitForTimeout(500);
            await target.locator('li', { hasText: 'Memnite' }).first().locator('label').dblclick();
            await expect(target, 'a one-pick prompt is answered by one double click').toHaveCount(0, { timeout: 5_000 });
            console.log('[af30] target prompt answered by double-clicking Memnite');
            targetDone = true;
            return stackCount(page);
          }
          const text = await says(page);
          if (/Pay Mana Cost/i.test(text)) await clickOnce(page, text, 'ok');
          return stackCount(page);
        },
        { timeout: 60_000, message: 'Cryptic Command reached the stack' },
      )
      .toBe(2);
    console.log(`[af30] modes=${modesDone} target=${targetDone} OK presses=${submits.length}`);
    expect(modesDone, 'the mode prompt was shown and answered by double clicks').toBe(true);
    expect(targetDone, 'the target prompt was shown and answered by a double click').toBe(true);
    expect(submits, 'OK was never pressed').toEqual([]);
    await expect(page.locator('[data-stack-id][aria-label*="Cryptic Command"]'), 'Forge took both answers: Cryptic Command is on the stack').toHaveCount(1, { timeout: 10_000 });
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

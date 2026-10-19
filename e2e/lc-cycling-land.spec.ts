/**
 * A land card's one ability is asked unless it plays the land. The operator, 2026-10-19:
 *
 *   "sometimes you might try to play a land without realizing it's gonna get cycled. make it so you
 *   still have to select the cycling ability when playing lands"
 *
 * Two browsers, a real Forge match (`scenarios/lc-cycling-land.state`): alice plays her Forest with
 * one click (no picker), which uses her land drop. She then clicks Tranquil Thicket, which Forge
 * now offers only its Cycling. The picker shows it and nothing is cycled. Choosing it cycles the
 * Thicket. Every prompt alice's page draws is recorded from the DOM; `[lc]` lines are the evidence.
 */

import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, handCardNamed, livePrompt, makeTitled, offered, ownNamed, pressPaymentAuto, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Record the method of every prompt the page draws, from now on. */
async function recordPrompts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __lcSeen: string[] }).__lcSeen = seen;
    const look = () => {
      for (const el of document.querySelectorAll('[data-testid="live-prompt"]')) {
        const method = el.getAttribute('data-method') ?? '?';
        if (seen.at(-1) !== method) seen.push(method);
      }
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true });
    look();
  });
}

const seenOn = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __lcSeen: string[] }).__lcSeen);

test(titled('a cycling land whose land drop is used asks for Cycling; a basic land still plays with one click'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'lc-cycling-land');
    const page = seated.alice.page;
    const graveyard = page.locator('[data-zone="graveyard"][data-owner="you"]');
    await recordPrompts(page);

    /* ── The Forest: one click plays it, and no picker is drawn ── */
    await expect.poll(() => handCardNamed(page, 'Forest'), { timeout: 30_000, message: 'alice holds a Forest' }).not.toBeUndefined();
    const forest = (await handCardNamed(page, 'Forest'))!;
    await expect.poll(() => offered(page), { timeout: 45_000, message: 'the Forest is offered' }).toContain(forest);
    expect(await clickHandCard(page, forest), 'the Forest lifted out of alice’s hand').toBe(true);
    await expect.poll(async () => (await ownNamed(page, 'Forest')).length, { timeout: 15_000, message: `the Forest was played — says: "${await says(page)}"` }).toBe(2);
    console.log(`[lc] forest played: seen=${JSON.stringify(await seenOn(page))}`);
    expect(await seenOn(page), 'playing a basic land draws no picker').not.toContain('getAbilityToPlay');

    /* ── Tranquil Thicket: only Cycling is left, and it is asked ── */
    const thicket = (await handCardNamed(page, 'Tranquil Thicket'))!;
    expect(thicket, 'Tranquil Thicket is in alice’s hand').not.toBeUndefined();
    await expect.poll(() => offered(page), { timeout: 15_000, message: 'the Thicket is offered for its Cycling' }).toContain(thicket);
    expect(await clickHandCard(page, thicket), 'the Thicket lifted out of alice’s hand').toBe(true);
    const picker = livePrompt(page).and(page.locator('[data-method="getAbilityToPlay"]'));
    const shown = await picker.waitFor({ timeout: 10_000 }).then(
      () => true,
      () => false,
    );
    console.log(
      `[lc] thicket clicked: picker=${shown} seen=${JSON.stringify(await seenOn(page))} inHand=${(await handCardNamed(page, 'Tranquil Thicket')) !== undefined} graveyard=${await graveyard.getAttribute('data-count')} says="${await says(page)}"`,
    );
    expect(shown, 'the click drew the ability picker').toBe(true);
    const choices = picker.getByTestId('prompt-choice');
    await expect(choices, 'the picker offers the one ability').toHaveCount(1);
    console.log(`[lc] picker offers: ${JSON.stringify(await choices.allTextContents())}`);
    await expect(choices.first(), 'the one ability is Cycling').toContainText(/Cycling|Discard this card/);
    expect(await handCardNamed(page, 'Tranquil Thicket'), 'nothing is cycled before it is chosen').toBe(thicket);
    expect(await graveyard.getAttribute('data-count')).toBe('0');

    /* ── Choosing Cycling cycles it ── */
    await choices.first().click();
    await expect
      .poll(
        async () => {
          if ((await graveyard.getAttribute('data-count')) === '1') return true;
          await pressPaymentAuto(page);
          return false;
        },
        { timeout: 20_000, intervals: [250], message: `the Thicket was cycled — says: "${await says(page)}"` },
      )
      .toBe(true);
    console.log(`[lc] cycled: hand=${JSON.stringify(await page.locator('[data-zone="hand"][data-owner="you"] .card__name').allTextContents())}`);
    expect(await handCardNamed(page, 'Tranquil Thicket'), 'the Thicket left alice’s hand').toBeUndefined();
    await expect.poll(() => handCardNamed(page, 'Island'), { timeout: 10_000, message: 'cycling drew an Island' }).not.toBeUndefined();
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

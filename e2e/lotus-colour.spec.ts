/**
 * Black Lotus's colour is the player's to choose. The operator, 2026-10-19:
 *
 *   "black lotus immediately created white mana when tapped. that was not intended. still want to
 *   select the mana color, just not the extra question about wanting to sacrifice"
 *
 * Two browsers, a real Forge match (`scenarios/lotus-colour.state`: Mind Stone in hand, an Island
 * and Black Lotus in play — a hand Forge's priority scan prices through the Lotus). Alice taps the
 * Lotus, in the default mode and in full control: no sacrifice confirm is drawn, the colour picker
 * offers all five colours, and picking Blue floats {U}{U}{U}. Every prompt alice's page draws is
 * recorded from the DOM, so a red run names what was asked and what floated.
 *
 * Serves the prebuilt dist (`e2e/play/harness.ts`); skips, with a title that says why, when Forge is
 * absent.
 */

import { expect, test, type Page } from '@playwright/test';

import { clickPermanent, makeTitled, manaPool, ownNamed, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Record every prompt and decision pop-up the page draws, from now on: `method` or `decision:<text>`. */
async function recordPrompts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __lotusSeen: string[] }).__lotusSeen = seen;
    const note = (entry: string) => {
      if (seen.at(-1) !== entry) seen.push(entry);
    };
    const look = () => {
      for (const el of document.querySelectorAll('[data-testid="live-prompt"]')) note(el.getAttribute('data-method') ?? '?');
      for (const el of document.querySelectorAll('[data-testid="live-decision-host"]')) note(`decision:${(el.textContent ?? '').trim().slice(0, 80)}`);
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    look();
  });
}

const seenOn = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __lotusSeen: string[] }).__lotusSeen);

for (const mode of ['default', 'full control'] as const) {
  test(titled(`${mode}: tapping Black Lotus asks its colour of five, never the sacrifice, and Blue floats three`), async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice } = await startScenarioMatch(browser, stack, 'lotus-colour');
      const page = alice.page;
      if (mode === 'full control') {
        await page.getByTestId('live-full-control').click();
        await expect(page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
      }
      await recordPrompts(page);

      const [lotus] = await ownNamed(page, 'Black Lotus');
      expect(lotus, 'Black Lotus is on alice’s battlefield').not.toBeUndefined();
      expect(await clickPermanent(page, lotus!), 'the Lotus took the click').toBe(true);

      // The colour picker, or — the bug — the Lotus gone and its mana already floating.
      const colourPrompt = page.locator('[data-testid="live-prompt"][data-method="getChoices"]');
      await expect
        .poll(
          async () => {
            if ((await colourPrompt.count()) > 0) return 'asked';
            const floating = await manaPool(page);
            return floating.total > 0 ? `floated without asking: ${JSON.stringify(floating)} seen=${JSON.stringify(await seenOn(page))}` : 'waiting';
          },
          { timeout: 30_000, intervals: [250], message: 'the colour picker opens' },
        )
        .toBe('asked');

      const colours = await colourPrompt.locator('label:has(input[data-testid="prompt-choice"]) [data-token]').evaluateAll((els) => els.map((e) => e.getAttribute('data-token')));
      console.log(`[lotus-colour] ${mode}: colours=${JSON.stringify(colours)} seen=${JSON.stringify(await seenOn(page))}`);
      expect([...colours].sort(), 'all five colours are offered').toEqual(['B', 'G', 'R', 'U', 'W']);

      await colourPrompt.locator('label', { has: page.locator('[data-token="U"]') }).locator('input[data-testid="prompt-choice"]').click({ force: true });
      const submit = colourPrompt.getByTestId('prompt-submit');
      if ((await submit.count()) > 0) await submit.click();

      await expect.poll(async () => (await manaPool(page)).U, { timeout: 15_000, message: 'Blue floats three' }).toBe(3);
      expect(await ownNamed(page, 'Black Lotus'), 'the Lotus was sacrificed').toEqual([]);

      const seen = await seenOn(page);
      const confirmed = serverLog(stack).filter((r) => r.evt === 'auto-confirmed' && r.seat === 0);
      console.log(`[lotus-colour] ${mode}: seen=${JSON.stringify(seen)} autoConfirmed=${JSON.stringify(confirmed.map((r) => r.why))} pool=${JSON.stringify(await manaPool(page))}`);
      expect(seen.filter((s) => /Sacrifice/i.test(s)), 'no sacrifice confirm was drawn').toEqual([]);
      expect(seen.filter((s) => s === 'getAbilityToPlay'), 'no ability picker was drawn').toEqual([]);
      expect(confirmed.map((r) => r.why), 'the server answered the sacrifice for her').toContain('the seat chose this ability just before');
    } finally {
      await stack.stop();
    }
  });
}

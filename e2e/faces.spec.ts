/**
 * The operator, 2026-10-17:
 *
 *  - "flip cards should show both art and let you pick left/right";
 *  - "show transformed cards with mousewheel (Fable of the Mirror-Breaker) mousewheel up/down lets you
 *    cycle between other relevant cards."
 *
 * Scenario `faces`: alice holds Fable of the Mirror-Breaker and Shatterskull Smashing, among others.
 * Hovering Fable enlarges it, and the wheel turns the enlargement to Reflection of Kiki-Jiki and back.
 * Selecting Shatterskull offers its two faces side by side, each with its own art; the land face
 * clicked is the land that enters.
 *
 * Every step prints one `[faces]` line. Needs a Forge build (`CARDTABLE_FORGE_JAR` +
 * `CARDTABLE_FORGE_RES`); without one this SKIPS and the title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */
import { expect, test } from '@playwright/test';

import { clickHandCard, handCardNamed, makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[faces] ${JSON.stringify({ step, data })}`);

test(titled('the wheel turns an enlarged card to its other face, and a card’s faces are picked side by side'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'faces');
    const page = alice.page;
    const shown = () => page.locator('[data-inspect] .card__name').textContent();

    // The wheel, over Fable in her hand.
    const fable = await handCardNamed(page, 'Fable of the Mirror-Breaker');
    expect(fable, 'Fable is in alice’s hand').not.toBeUndefined();
    await page.locator(`[data-board-card="${fable}"]`).hover();
    await expect(page.locator('[data-inspect]')).toBeVisible();
    const seen = [await shown()];
    await page.mouse.wheel(0, 120);
    seen.push(await shown());
    await page.mouse.wheel(0, -120);
    seen.push(await shown());
    log('wheel', seen);
    expect(seen).toEqual(['Fable of the Mirror-Breaker', 'Reflection of Kiki-Jiki', 'Fable of the Mirror-Breaker']);
    await page.mouse.move(5, 5);

    // The faces, side by side.
    const skull = await handCardNamed(page, 'Shatterskull Smashing');
    expect(skull, 'Shatterskull is in alice’s hand').not.toBeUndefined();
    await clickHandCard(page, skull!);
    const faces = page.getByTestId('prompt-face');
    await expect(faces).toHaveCount(2, { timeout: 20_000 });
    const drawn = await faces.evaluateAll((els) => els.map((e) => ({ face: e.getAttribute('data-face'), art: e.querySelector('img')?.getAttribute('src') ?? null, x: Math.round(e.getBoundingClientRect().x) })));
    log('faces', drawn);
    expect(drawn.map((d) => d.face)).toEqual(['Shatterskull Smashing', 'Shatterskull, the Hammer Pass']);
    expect(drawn[0]!.x, 'side by side, the first on the left').toBeLessThan(drawn[1]!.x);
    expect(drawn.every((d) => d.art !== null), 'each with art').toBe(true);
    expect(drawn[0]!.art, 'its own art, front and back').not.toBe(drawn[1]!.art);

    await faces.nth(1).click();
    const land = page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card', { has: page.locator('.card__name', { hasText: 'Shatterskull, the Hammer Pass' }) });
    await expect
      .poll(
        async () => {
          // Its own question as it enters: pay 3 life, or enter tapped.
          const no = page.getByRole('dialog').filter({ hasText: 'pay 3 life' }).getByRole('button', { name: 'No' });
          if ((await no.count()) > 0) await no.click().catch(() => undefined);
          return land.count();
        },
        { timeout: 20_000, message: 'the land face is the one that enters' },
      )
      .toBe(1);
    log('entered', { land: await land.count() });
  } finally {
    await stack.stop();
  }
});

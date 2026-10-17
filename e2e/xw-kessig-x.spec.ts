/**
 * The operator, 2026-10-15: *"kessig wolf run should allow going up to 20, and it should also attempt
 * to indicate how much mana you can maximally pay"*.
 *
 * Forge asks a mana X with `getInteger(title, min, Integer.MAX_VALUE, min + 9)`
 * (`PlayerControllerHuman.announceRequirements`): its own list is 0..9 and an "Other…" entry, and the
 * slider draws the numbers only, so X stopped at 9.
 *
 * `xw-kessig.state`: Kessig Wolf Run, seven Mountains, seven Forests and Grizzly Bears. {R}{G} leaves
 * twelve lands, so the most X alice can pay is 12. The slider reaches at least 20, marks 12, and an X
 * of 12 resolves: the Bears have 14 power.
 */
import { expect, test, type Page } from '@playwright/test';

import { boardCard, clickPermanent, makeTitled, ownNamed, pressOffered, pressPaymentAuto, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const AFFORDABLE = 12;
const PUMP = /\+X\/\+0/;

/** The open "which ability?" pop-up's options, by their words; [] when none is open. */
async function abilityChoices(page: Page): Promise<string[]> {
  const options = page.getByTestId('live-prompt').locator('[data-testid="prompt-choice"]');
  if (!(await options.first().isVisible({ timeout: 300 }).catch(() => false))) return [];
  return options.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent ?? ''));
}

/** The Bears' power as their P/T badge draws it (a buff draws a mark beside the number). */
const powerOf = (page: Page, id: number): Promise<number | null> =>
  page.evaluate((cardId) => {
    const text = document.querySelector(`[data-card-id="${cardId}"] > .board-card__pt [data-pt-of="power"]`)?.textContent ?? '';
    const n = /-?\d+/.exec(text);
    return n === null ? null : Number(n[0]);
  }, id);

test(titled('Kessig Wolf Run: the X slider reaches 20, marks the most mana alice can pay, and an X above 9 pumps'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'xw-kessig');
    const page = seated.alice.page;
    await expect.poll(async () => (await ownNamed(page, 'Grizzly Bears')).length, { timeout: 45_000, message: 'alice has Grizzly Bears out' }).toBe(1);
    const bears = (await ownNamed(page, 'Grizzly Bears'))[0]!;
    const kessig = (await ownNamed(page, 'Kessig Wolf Run'))[0]!;
    expect(kessig, 'alice has Kessig Wolf Run out').toBeDefined();

    expect(await clickPermanent(page, kessig), 'Kessig Wolf Run is offered with a live window').toBe(true);
    await expect.poll(() => abilityChoices(page), { timeout: 15_000, message: 'a click on Kessig Wolf Run asks which ability' }).toContainEqual(expect.stringMatching(PUMP));
    const choices = await abilityChoices(page);
    await page.getByTestId('live-prompt').locator('[data-testid="prompt-choice"]').nth(choices.findIndex((l) => PUMP.test(l))).click();

    const slider = page.getByTestId('prompt-slider');
    await expect(slider, 'the X ask reaches alice as the slider').toBeVisible({ timeout: 15_000 });
    const mark = page.getByTestId('prompt-slider-afford');
    const read = async () => ({
      min: await slider.getAttribute('min'),
      max: await slider.getAttribute('max'),
      value: await slider.inputValue(),
      afford: (await mark.count()) > 0 ? await mark.getAttribute('data-value') : null,
    });
    console.log(`[xw] slider ${JSON.stringify(await read())}`);
    expect(Number(await slider.getAttribute('max')), 'the slider reaches at least 20').toBeGreaterThanOrEqual(20);
    await expect(mark, 'the slider marks the most X alice can pay').toHaveAttribute('data-value', String(AFFORDABLE));
    expect(await slider.inputValue(), 'the slider still starts at its minimum').toBe('0');

    await slider.evaluate((el: HTMLInputElement, x) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, String(x));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, AFFORDABLE);
    await expect(page.getByTestId('prompt-slider-value')).toHaveText(String(AFFORDABLE));
    await page.getByTestId('live-prompt').getByTestId('prompt-submit').click();

    // Then the target (the Bears), then the payment, which Auto pays.
    let targeted = false;
    await expect
      .poll(
        async () => {
          if (!targeted && (await pressOffered(boardCard(page, bears)))) targeted = true;
          await pressPaymentAuto(page);
          return powerOf(page, bears);
        },
        { timeout: 45_000, intervals: [100], message: `Kessig resolved with X=${AFFORDABLE} — says: "${await says(page)}"` },
      )
      .toBe(2 + AFFORDABLE);
    console.log(`[xw] resolved: bears power ${await powerOf(page, bears)} stack ${await stackCount(page)}`);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

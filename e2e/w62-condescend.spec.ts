/**
 * Wave 62 §D, AE9 — the operator, on Condescend: *"i cast 'condescend' which
 * lets me scry as part of the resolution of the spell, but also asks the
 * opponent about paying the cost. lets be careful and resolve these things
 * one at at time, i dont think it should be showing simultaneously."*
 *
 * `apps/server/src/play/w62-condescend.jvm.test.ts` already measured the
 * SERVER side of this against the real jar directly: Forge resolves
 * Condescend's two sub-effects strictly in sequence — bob's own "pay {X} or
 * be countered" is resolved before alice's scry `order` ask is even
 * computed, every time. That test's own header has the full finding (both
 * ask shapes the wave file guessed, `confirm`/`manipulateCardList`, are
 * wrong — see it for what each actually is).
 *
 * This is the CLIENT half: two real browsers, polled every 50 ms through
 * the window Condescend resolves, for the one thing a sequential wire still
 * cannot promise on its own — that the UI renders what it is told in the
 * same order, with no stale frame drawing two decisions together. Full
 * control is ON for bob only (`live-full-control`), so his own payment
 * window is a real, visible stop instead of the instant, invisible auto-pay
 * the default policy gives an affordable cost (the jvm test's own finding);
 * alice stays on the ordinary policy, so her single-legal-target choice
 * still auto-resolves without a picker of its own.
 */

import { expect, test, type Page } from '@playwright/test';

import { castCard, clickOnce, makeTitled, says, stackCount } from './play/board.ts';
import { answerPrompt } from './play/prompts.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The hand card named `name`, Forge-offered or not — by its own `.card__name` text. */
async function handCardNamed(page: Page, name: string): Promise<number | undefined> {
  const ids = await page
    .locator('[data-zone="hand"][data-owner="you"] [data-board-card]')
    .evaluateAll(
      (els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))),
      name,
    );
  return ids[0];
}

/**
 * Cast Condescend: lift and release it on the viewer's own battlefield (the
 * one gesture every targeted or no-target cast goes through, `board.ts`'s
 * own header), then drain whatever Forge asks next — `getAbilityToPlay`
 * (the spell's own one ability), the X announce (a `getChoices` slider,
 * `GetChoicesPrompt`'s own shape once `numericChoiceRange` sees it — set to
 * `x`, not `answerPrompt`'s generic default of the minimum), and "Pay Mana
 * Cost". Alice's own single-legal-target choice is never drawn here at all:
 * she is not on full control, so the server's own `onlyAnswer` shortcut
 * answers it before it ever reaches her wire (`match.ts`'s `openAsk`).
 */
async function castCondescend(page: Page, cardId: number, x: number): Promise<void> {
  const stackBefore = await stackCount(page);
  const box = await page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox();
  if (box === null) throw new Error('no battlefield box to release Condescend on');
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.locator(`[data-board-card="${cardId}"] button`).first().click();
  await page.mouse.click(centre.x, centre.y);

  await expect
    .poll(
      async () => {
        const slider = page.getByTestId('prompt-slider');
        if ((await slider.count()) > 0) {
          await slider.evaluate((el: HTMLInputElement, m) => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
            setter.call(el, String(m));
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, x);
          await page.getByTestId('prompt-submit').click();
        } else {
          await answerPrompt(page);
        }
        const text = await says(page);
        if (/Pay Mana Cost/i.test(text)) await clickOnce(page, text, 'ok');
        return stackCount(page);
      },
      { timeout: 5_000, intervals: [50] },
    )
    .not.toBe(stackBefore);
}

test(titled('bob’s pay-or-decline and alice’s scry never draw at once, across two real browsers'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    const { alice, bob } = (seated = await startScenarioMatch(browser, stack, 'w62-condescend'));

    // Full control for bob only — see the file header. Not pressed until
    // after the match has settled; the toggle is always in the control
    // cluster, independent of anything Forge is currently asking.
    await bob.page.getByTestId('live-full-control').click();
    await expect(bob.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');

    const bearsId = await handCardNamed(bob.page, 'Grizzly Bears');
    if (bearsId === undefined) throw new Error('no Grizzly Bears in bob’s hand');
    await castCard(bob.page, bearsId);

    // Full control: bob does not auto-pass once Bears is paid for — an
    // explicit press is what lets alice see it.
    await expect
      .poll(async () => (/^Priority:/.test(await says(bob.page)) ? clickOnce(bob.page, await says(bob.page), 'ok') : false), {
        timeout: 15_000,
        intervals: [50],
      })
      .toBe(true);

    await expect.poll(() => stackCount(alice.page), { timeout: 15_000, message: 'alice sees Grizzly Bears on the stack' }).toBe(1);

    const condescendId = await handCardNamed(alice.page, 'Condescend');
    if (condescendId === undefined) throw new Error('no Condescend in alice’s hand');
    await castCondescend(alice.page, condescendId, 1);

    // Both seats pass priority so Condescend resolves. Alice (not on full
    // control, and with nothing else to do) auto-passes on the server's own
    // say — her own "Stack: 2 to Resolve" window is never actually offered
    // to this test to click (measured: it is gone, replaced by "Waiting for
    // Bob…", by the next poll tick). Bob, on full control, needs the
    // explicit press.
    await expect
      .poll(
        async () => {
          const text = await says(bob.page);
          return /^Priority:/.test(text) && /Stack: 2 to Resolve/.test(text) ? clickOnce(bob.page, text, 'ok') : false;
        },
        { timeout: 15_000, intervals: [50] },
      )
      .toBe(true);

    // The measurement: poll both pages every 50 ms, from the moment
    // Condescend starts resolving to the moment both its own windows are
    // answered, recording every tick whether bob's real payment window and
    // alice's scry sheet are open — and, on alice's own single page,
    // whether her waiting pop-out (naming bob) and her own scry sheet are
    // ever BOTH drawn.
    const bobPayLive = () => bob.page.getByTestId('live-payment').isVisible().catch(() => false);
    const aliceScryLive = () =>
      alice.page
        .locator('[data-testid="live-prompt"][data-method="order"]')
        .first()
        .isVisible()
        .catch(() => false);
    const aliceWaitingLive = () => alice.page.getByTestId('live-waiting-pop').isVisible().catch(() => false);

    // `bobDeclinedAt`: before this test clicks bob's own Cancel, his payment
    // window being visible is a genuine, unanswered decision; after, the
    // SAME element can keep rendering for a tick or two while his own click
    // round-trips to the server — that lag is not what AE9 is about, so a
    // tick is only counted against the "never both open" rule while bob's
    // decision is still actually pending (the index his decline landed on,
    // recorded BEFORE that tick's own read, never after).
    const ticks: { t: number; bobPay: boolean; aliceScry: boolean; aliceWaiting: boolean; bobPending: boolean }[] = [];
    const t0 = Date.now();
    let bobPaySeen = false;
    let bobDeclined = false;
    let aliceAnswered = false;
    for (let i = 0; i < 400 && !(bobDeclined && aliceAnswered); i++) {
      const bobPendingThisTick = !bobDeclined;
      const [bobPay, aliceScry, aliceWaiting] = await Promise.all([bobPayLive(), aliceScryLive(), aliceWaitingLive()]);
      ticks.push({ t: Date.now() - t0, bobPay, aliceScry, aliceWaiting, bobPending: bobPendingThisTick });
      if (bobPay) bobPaySeen = true;

      // Resolve each exactly once, deterministically: bob declines (the
      // spell still counters Grizzly Bears and still scries either way —
      // `w62-condescend.jvm.test.ts`'s own note); alice's scry is answered
      // through the ordinary prompt driver.
      if (bobPay && !bobDeclined) {
        const cancel = bob.page.getByTestId('live-payment-cancel');
        if ((await cancel.count()) > 0 && (await cancel.isEnabled())) {
          await cancel.click();
          bobDeclined = true;
        }
      } else if (bobPaySeen && !bobPay) {
        bobDeclined = true; // it opened, and is gone now — Forge moved on
      }
      if (aliceScry && !aliceAnswered) {
        const answered = await answerPrompt(alice.page);
        if (answered?.method === 'order') aliceAnswered = true;
      }

      await alice.page.waitForTimeout(50);
    }

    expect(ticks.some((t) => t.bobPay), 'bob’s own payment window was observed at least once').toBe(true);
    expect(ticks.some((t) => t.aliceScry), 'alice’s own scry sheet was observed at least once').toBe(true);

    const bothOpenAcrossSeats = ticks.filter((t) => t.bobPay && t.bobPending && t.aliceScry);
    const bothOpenOnAlice = ticks.filter((t) => t.aliceWaiting && t.aliceScry);
    if (bothOpenAcrossSeats.length > 0 || bothOpenOnAlice.length > 0) {
      console.log(
        `[w62-condescend-e2e] ticks:\n${ticks.map((t) => `+${t.t}ms bobPay=${t.bobPay}(pending=${t.bobPending}) aliceScry=${t.aliceScry} aliceWaiting=${t.aliceWaiting}`).join('\n')}`,
      );
    }
    expect(bothOpenAcrossSeats, 'alice’s scry sheet never draws while bob’s payment is still a genuinely pending, unanswered decision').toEqual([]);
    expect(bothOpenOnAlice, 'alice’s own waiting pop-out and her own scry sheet are never both drawn at once').toEqual([]);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

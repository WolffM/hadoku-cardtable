/**
 * The operator, on Condescend: *"i cast 'condescend' which
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
 * This is the CLIENT half: two real browsers, every change to their screens
 * recorded through the window Condescend resolves, for the one thing a sequential wire still
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
import { overlaps, recordSurface, spans } from './play/surface.ts';

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
    await castCard(alice.page, condescendId, { x: 1 });

    // Everything both screens draw from here until both of Condescend's windows are
    // answered: bob's real payment window, alice's scry sheet, and alice's waiting pop-out
    // (naming bob) — recorded on every DOM change, so a window shorter than a poll is in it.
    const SCRY = '[data-testid="live-prompt"][data-method="order"]';
    const bobPayRec = await recordSurface(bob.page, '[data-testid="live-payment"]');
    const aliceScryRec = await recordSurface(alice.page, SCRY);
    const aliceWaitingRec = await recordSurface(alice.page, '[data-testid="live-waiting-pop"]');

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

    // Driving, not measuring: bob declines his payment once it is up and alice answers her
    // scry. What was on screen is the record above, not what these reads happened to see.
    const bobPayLive = () => bob.page.getByTestId('live-payment').isVisible().catch(() => false);
    const aliceScryLive = () => alice.page.locator(SCRY).first().isVisible().catch(() => false);
    // Bob's payment counts against "never both open" only while his decision is still pending:
    // after his Cancel the same element can render a moment longer while the click round-trips.
    let bobDeclinedAt = Infinity;
    let bobPaySeen = false;
    let aliceAnswered = false;
    for (let i = 0; i < 400 && !(bobDeclinedAt !== Infinity && aliceAnswered); i++) {
      const [bobPay, aliceScry] = await Promise.all([bobPayLive(), aliceScryLive()]);
      if (bobPay) bobPaySeen = true;

      // Resolve each exactly once, deterministically: bob declines (the
      // spell still counters Grizzly Bears and still scries either way —
      // `w62-condescend.jvm.test.ts`'s own note); alice's scry is answered
      // through the ordinary prompt driver.
      if (bobPay && bobDeclinedAt === Infinity) {
        const cancel = bob.page.getByTestId('live-payment-cancel');
        if ((await cancel.count()) > 0 && (await cancel.isEnabled())) {
          bobDeclinedAt = Date.now();
          await cancel.click();
        }
      } else if (bobPaySeen && !bobPay && bobDeclinedAt === Infinity) {
        bobDeclinedAt = Date.now(); // it opened, and is gone now — Forge moved on
      }
      if (aliceScry && !aliceAnswered) {
        const answered = await answerPrompt(alice.page);
        if (answered?.method === 'order') aliceAnswered = true;
      }

      await alice.page.waitForTimeout(50);
    }

    const bobPay = spans(await bobPayRec.rows());
    const aliceScry = spans(await aliceScryRec.rows());
    const aliceWaiting = spans(await aliceWaitingRec.rows());
    expect(bobPay.length, 'bob’s own payment window was drawn at least once').toBeGreaterThan(0);
    expect(aliceScry.length, 'alice’s own scry sheet was drawn at least once').toBeGreaterThan(0);

    const bobPending = bobPay.map((p) => ({ from: p.from, to: Math.min(p.to, bobDeclinedAt) })).filter((p) => p.from < p.to);
    const bothOpenAcrossSeats = overlaps(bobPending, aliceScry);
    const bothOpenOnAlice = overlaps(aliceWaiting, aliceScry);
    if (bothOpenAcrossSeats.length > 0 || bothOpenOnAlice.length > 0) {
      console.log(`[w62-condescend-e2e] shown (wall ms): bobPay ${JSON.stringify(bobPay)} declined ${bobDeclinedAt}; aliceScry ${JSON.stringify(aliceScry)}; aliceWaiting ${JSON.stringify(aliceWaiting)}`);
    }
    expect(bothOpenAcrossSeats, 'alice’s scry sheet never draws while bob’s payment is still a genuinely pending, unanswered decision').toEqual([]);
    expect(bothOpenOnAlice, 'alice’s own waiting pop-out and her own scry sheet are never both drawn at once').toEqual([]);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

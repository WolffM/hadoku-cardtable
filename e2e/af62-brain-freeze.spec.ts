/**
 * A storm spell's copies take one target for all, against real Forge.
 *
 * The operator, 2026-10-14: *"brain freeze choose the sae"*. Production, m-98e9ea85d1bf: thyeggman's
 * Brain Freeze went off with seventeen copies, and Forge asked a target for every copy — seventeen
 * clicks on the same player, ~0.55 s apart (`openZones` asks s1-118…s1-134). Each copy is asked through
 * `CopySpellAbilityEffect` → `orderAndPlaySimultaneousSa` → `setupNewTargets`, the same per-instance
 * question a batch of identical triggers asks, and the "Same target for all" box (`w70-valakut.spec.ts`)
 * was offered for triggers only.
 *
 * `af62-brain-freeze.state`: alice casts three Ornithopters, then Brain Freeze on bob — storm 3. At the
 * first copy's target question she is offered "Same target for all"; she ticks it and clicks bob once,
 * and that covers every copy: two target clicks in all (the spell's own, the first copy's), and bob
 * mills 4 × 3 = 12.
 *
 * `[af62]` lines are the evidence.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, grindPriority, makeTitled, offeredNamed, ownNamed, passOverStack, pressPaymentAuto, says, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const STORM = 3;
const LIBRARY = 20;
/** Brain Freeze's target question (`InputSelectTargets.showMessage` opens with the card's name) — not its payment, not a priority line. */
const asksTarget = (text: string): boolean => /Brain Freeze/.test(text) && !/Pay Mana Cost/i.test(text) && !/^Priority/.test(text);

const libraryOf = async (page: Page): Promise<number> =>
  Number(((await page.locator('.seat:not([data-viewer]) [data-testid="library-count"]').first().getAttribute('aria-label')) ?? '').replace(/\D/g, '') || NaN);

test(titled("Brain Freeze's storm copies: one pick with \"Same target for all\" covers every copy"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'af62-brain-freeze');
    const { alice, bob } = seated;
    const bobFace = alice.page.locator('[data-player-face]:not([data-viewer])');
    await expect.poll(() => libraryOf(alice.page), { timeout: 60_000, message: "alice sees bob's library" }).toBe(LIBRARY);

    // Storm: three Ornithopters, each cast and resolved.
    for (let n = 1; n <= STORM; n++) {
      let thopter: number | undefined;
      await expect.poll(async () => (thopter = await offeredNamed(alice.page, 'Ornithopter')), { timeout: 60_000, message: `Ornithopter ${n} is offered` }).not.toBeUndefined();
      await clickHandCard(alice.page, thopter!);
      // Pass only over the stack: an OK over an empty stack would end alice's main phase.
      await grindPriority([alice.page, bob.page], async () => (await ownNamed(alice.page, 'Ornithopter')).length >= n, {
        timeoutMs: 45_000,
        press: async (page) => {
          await passOverStack(page);
        },
      });
    }

    let freeze: number | undefined;
    await expect.poll(async () => (freeze = await offeredNamed(alice.page, 'Brain Freeze')), { timeout: 60_000, message: 'Brain Freeze is offered' }).not.toBeUndefined();
    const fromCast = serverLog(stack).length;
    await clickHandCard(alice.page, freeze!);

    // Every target question on alice's screen: was the box offered, and one click on bob.
    const questions: { says: string; offered: boolean }[] = [];
    let lastSays = '';
    let ticked = false;
    const wiredTargets = (): number =>
      serverLog(stack)
        .slice(fromCast)
        .filter((r) => r.evt === 'wire-frame' && r.seat === 0 && r.method === 'showPromptMessage' && asksTarget(String(r.message ?? ''))).length;
    await expect
      .poll(
        async () => {
          await pressPaymentAuto(alice.page);
          await answerPrompt(alice.page);
          const text = await says(alice.page);
          if (text !== lastSays) console.log(`[af62] alice says "${(lastSays = text).trim().slice(0, 140)}"`);
          if (asksTarget(text) && wiredTargets() > questions.length) {
            const same = alice.page.getByTestId('live-same-target');
            const offered = (await same.count()) > 0;
            questions.push({ says: text.trim().slice(0, 120), offered });
            console.log(`[af62] target question ${questions.length}: offered same-target ${offered}`);
            if (offered && !ticked) {
              await same.check();
              ticked = true;
            }
            await bobFace.click({ timeout: 1_000 }).catch(() => undefined);
          } else {
            for (const page of [alice.page, bob.page]) {
              const ok = page.locator('[data-testid="live-decision-ok"]:enabled');
              if ((await ok.count()) > 0) await ok.click({ timeout: 1_000 }).catch(() => undefined);
            }
          }
          return libraryOf(alice.page);
        },
        { timeout: 120_000, intervals: [250], message: 'Brain Freeze and every copy milled bob' },
      )
      .toBe(LIBRARY - 3 * (STORM + 1));

    const log = serverLog(stack).slice(fromCast);
    const answered = log.filter((r) => r.evt === 'same-target' && r.seat === 0);
    console.log(`[af62] target questions drawn ${questions.length} ${JSON.stringify(questions)}; wired ${wiredTargets()}; answered by same-target ${answered.length}`);
    expect.soft(questions.some((q) => q.offered), 'a copy\'s target question offers "Same target for all"').toBe(true);
    expect.soft(questions.length, "two clicks in all: the spell's own target and the first copy's").toBe(2);
    expect.soft(answered.length, 'the other copies took the same target').toBe(STORM - 1);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

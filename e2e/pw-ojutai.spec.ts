/**
 * A trigger's question reads as the card and its words, nothing of Forge's bookkeeping.
 *
 * The operator, 2026-10-16, over Dragonlord Ojutai's "Choose card(s) to put into hand": *"'[Damage
 * Source: Dragonlord Ojutai, Damaged: Bella, Amount: 6]' this text seems useless. the formatting of
 * this block also looks a bit ugly because the little card is a bit too small. if this box was
 * slightly wider it would look better"*.
 *
 * `pw-ojutai.state`: alice's Dragonlord Ojutai attacks bob, who has nothing to block with. Its
 * combat damage triggers, and when the trigger resolves Forge asks alice which of her top three
 * cards to keep. At 1280×800 the question:
 * - says the trigger's own words, and none of the objects Forge appends to a trigger's stack
 *   description (`WrappedAbility.getStackDescription`'s closing " […]");
 * - draws Ojutai big enough to recognise (the head's thumb at least 44px wide);
 * - stands in a column wider than the 24.1% of the table it had.
 *
 * `[pw]` lines are the evidence: the head as measured.
 */
import { expect, test } from '@playwright/test';

import { clickOnce, makeTitled, says } from './play/board.ts';
import { passDeclareAttackers } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled("Dragonlord Ojutai's combat-damage question: the trigger's words without Forge's [Damage Source …], a recognisable card, a wider window"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'pw-ojutai');
    const { alice, bob } = seated;
    await alice.page.setViewportSize({ width: 1280, height: 800 });
    await passDeclareAttackers(alice.page);

    // Each seat passes whatever priority it is held at (the trigger on the stack) until alice is asked.
    const sheet = alice.page.locator('[data-testid="live-prompt"]').filter({ has: alice.page.getByTestId('prompt-source') });
    for (let i = 0; i < 200 && !(await sheet.isVisible()); i++) {
      for (const page of [alice.page, bob.page]) {
        const text = await says(page);
        if (/^Priority/i.test(text)) await clickOnce(page, text, 'ok');
      }
      await sheet.waitFor({ state: 'visible', timeout: 250 }).catch(() => undefined);
    }
    await expect(sheet, `Ojutai's trigger asks alice — says: "${await says(alice.page)}"`).toBeVisible({ timeout: 30_000 });

    const m = await alice.page.evaluate(() => {
      const host = document.querySelector<HTMLElement>('[data-testid="live-prompt"]')!;
      const live = host.closest<HTMLElement>('.live')!;
      const thumb = host.querySelector<HTMLElement>('[data-testid="prompt-source"]')!.getBoundingClientRect();
      const section = host.querySelector<HTMLElement>('section.prompt')!.getBoundingClientRect();
      return {
        source: host.querySelector('[data-testid="prompt-source-text"]')?.textContent ?? null,
        title: host.querySelector('.prompt__title')?.textContent ?? '',
        thumb: { w: Math.round(thumb.width), h: Math.round(thumb.height) },
        sheet: Math.round(section.width),
        live: Math.round(live.getBoundingClientRect().width),
      };
    });
    console.log(`[pw] head ${JSON.stringify(m)}`);
    expect(m.source, "the trigger's own words").toMatch(/look at the top three cards of your library/i);
    expect(m.source, "none of Forge's appended trigger objects").not.toMatch(/Damage Source|Damaged:|Amount:/);
    expect(m.source, 'no trailing bracket').not.toMatch(/\[[^\]]*\]\s*$/);
    expect(m.thumb.w, 'the source card is big enough to recognise').toBeGreaterThanOrEqual(44);
    expect(m.sheet / m.live, 'the window is wider than the 24.1% column it was').toBeGreaterThanOrEqual(0.26);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

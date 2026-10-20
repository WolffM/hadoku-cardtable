/**
 * A trigger's question reads as the card and the decision, nothing of Forge's bookkeeping.
 *
 * The operator, 2026-10-16, over Dragonlord Ojutai's "Choose card(s) to put into hand": *"'[Damage
 * Source: Dragonlord Ojutai, Damaged: Bella, Amount: 6]' this text seems useless. the formatting of
 * this block also looks a bit ugly because the little card is a bit too small. if this box was
 * slightly wider it would look better"*.
 *
 * `pw-ojutai.state`: alice's Dragonlord Ojutai attacks bob, who has nothing to block with. Its
 * combat damage triggers, and when the trigger resolves Forge asks alice which of her top three
 * cards to keep. At 1280×800 the question:
 * - says none of the objects Forge appends to a trigger's stack description
 *   (`WrappedAbility.getStackDescription`'s closing " […]");
 * - asks the decision as the zones the cards go to, Hand and Bottom: a card-moving question is
 *   one sheet of named zones (the operator, 2026-10-19, AF179: *"way too many similar UIs for this
 *   type of card selection and movement question … unify"*), and a sheet says the decision, the
 *   ability's text only where the decision cannot be read without it (AF193: *"ideally the text
 *   here is just for the decision that has to be made"*);
 * - leads with the action alice takes, the dig's own words after its look clause, as its question
 *   (the operator, 2026-10-20: *"ideally we just keep the action the player has to take. "Put one
 *   of them into your hand and the rest on the bottom of your library in any order.""*): no "Look
 *   at the top three cards" lead-in, and no "Your library" in its place;
 * - draws Ojutai big enough to recognise (the head's thumb at least 44px wide);
 * - stands in a column wider than the 24.1% of the table it had.
 *
 * `[pw]` lines are the evidence: the head as measured.
 */
import { expect, test } from '@playwright/test';

import { clickOnce, makeTitled, resizeWindow, says } from './play/board.ts';
import { passDeclareAttackers } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled("Dragonlord Ojutai's combat-damage question: the decision without Forge's [Damage Source …], a recognisable card, a wider window"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'pw-ojutai');
    const { alice, bob } = seated;
    await resizeWindow(alice.page, { width: 1280, height: 800 });
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
        text: host.textContent ?? '',
        zones: [...host.querySelectorAll<HTMLElement>('[data-testid^="zone-"][data-zone]')].map((z) => z.dataset.zone),
        title: host.querySelector('.prompt__title')?.textContent ?? '',
        thumb: { w: Math.round(thumb.width), h: Math.round(thumb.height) },
        sheet: Math.round(section.width),
        live: Math.round(live.getBoundingClientRect().width),
      };
    });
    console.log(`[pw] head ${JSON.stringify(m)}`);
    expect(m.zones, 'the decision: which card goes to the hand, the rest to the bottom').toEqual(expect.arrayContaining(['hand', 'bottom']));
    expect(m.text, "none of Forge's appended trigger objects").not.toMatch(/Damage Source|Damaged:|Amount:/);
    expect(m.title, 'the question is the action alice takes').toBe('Put one of them into your hand and the rest on the bottom of your library in any order.');
    expect(m.text, 'no look clause anywhere on the sheet').not.toContain('Look at the top');
    expect(m.thumb.w, 'the source card is big enough to recognise').toBeGreaterThanOrEqual(44);
    expect(m.sheet / m.live, 'the window is wider than the 24.1% column it was').toBeGreaterThanOrEqual(0.26);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

/**
 * A card whose condition is on glows, in the hand and on the battlefield, as the count reaches it.
 * The operator, 2026-10-15: *"i would like it if the game told you when things like 'metalcraft' are
 * active. other things like threshold, delirium, etc. … in hearthstone the card turns orange when
 * its conditional effect is 'active'. how can we indicate it?"*
 *
 * `ca-condition.state`: alice controls two Ornithopters and holds a third beside Galvanic Blast
 * (metalcraft); Carapace Forger (metalcraft) is on her battlefield, and Anurid Barkripper
 * (threshold) with six cards in her graveyard. Nothing glows. She casts the Ornithopter: three
 * artifacts, and Galvanic Blast in her hand and the Forger on the table glow — on bob's screen too
 * for the Forger — while the Barkripper does not. She casts the Blast at bob's Grizzly Bears: it
 * goes to her graveyard, the seventh card, and the Barkripper glows.
 *
 * Every step prints one `[ca]` line. Needs a Forge build; without one this SKIPS and the title
 * says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { boardCard, castCard, clickHandCard, handCardNamed, makeTitled, offered, ownNamed, pressOffered, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Whether the card `id` is drawn glowing on `page`: its own tile wears `data-condition-met`. */
const lit = (page: Page, id: number): Promise<boolean> =>
  boardCard(page, id)
    .locator('.card')
    .first()
    .evaluate((e) => e.hasAttribute('data-condition-met'))
    .catch(() => false);

/** The glowing cards `page` draws, by name, for the evidence line. */
const litNames = (page: Page): Promise<string[]> =>
  page
    .locator('[data-board-card]')
    .evaluateAll((els) =>
      els.filter((e) => e.querySelector('.card')?.hasAttribute('data-condition-met') === true).map((e) => e.querySelector('.card__name')?.textContent?.trim() ?? '?'),
    );

test(titled('metalcraft lights Galvanic Blast in hand and Carapace Forger on the table at the third artifact; threshold lights Anurid Barkripper at the seventh card'), async ({ browser }, testInfo) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'ca-condition');
    const a = seated.alice.page;
    const b = seated.bob.page;
    const graveyard = a.locator('[data-zone="graveyard"][data-owner="you"]');
    const evidence = async (step: string) =>
      console.log(`[ca] ${step}: alice sees lit=${JSON.stringify(await litNames(a))} bob sees lit=${JSON.stringify(await litNames(b))} graveyard=${await graveyard.getAttribute('data-count')} says=${JSON.stringify(await says(a))}`);

    await expect.poll(() => handCardNamed(a, 'Galvanic Blast'), { timeout: 30_000, message: 'alice holds Galvanic Blast' }).not.toBeUndefined();
    const blast = (await handCardNamed(a, 'Galvanic Blast'))!;
    const thopter = (await handCardNamed(a, 'Ornithopter'))!;
    await expect.poll(() => ownNamed(a, 'Ornithopter'), { timeout: 30_000, message: 'alice has two Ornithopters out' }).toHaveLength(2);
    const [forger] = await ownNamed(a, 'Carapace Forger');
    const [barkripper] = await ownNamed(a, 'Anurid Barkripper');
    expect(forger, 'Carapace Forger is out').not.toBeUndefined();
    expect(barkripper, 'Anurid Barkripper is out').not.toBeUndefined();
    await expect(graveyard, 'six cards in alice’s graveyard').toHaveAttribute('data-count', '6', { timeout: 15_000 });
    await expect.poll(() => offered(a), { timeout: 45_000, message: 'the Ornithopter is offered' }).toContain(thopter);
    await evidence('two artifacts, six cards');
    for (const [name, id] of [['Galvanic Blast', blast], ['Carapace Forger', forger!], ['Anurid Barkripper', barkripper!]] as const) {
      expect(await lit(a, id), `${name} is not lit before its count is reached`).toBe(false);
    }

    // The third artifact.
    // The first act after a scenario starts can be dropped (`castUntilOnStack`'s note): cast again
    // while the Ornithopter is still offered in the hand, until the third one is on the table.
    await expect
      .poll(
        async () => {
          const out = (await ownNamed(a, 'Ornithopter')).length;
          if (out < 3 && (await offered(a)).includes(thopter)) await castCard(a, thopter).catch(() => undefined);
          return (await ownNamed(a, 'Ornithopter')).length;
        },
        { timeout: 30_000, intervals: [250], message: `the third Ornithopter resolved — says: "${await says(a)}"` },
      )
      .toBe(3);
    await expect.poll(() => lit(a, blast), { timeout: 15_000, message: 'metalcraft lights Galvanic Blast in alice’s hand' }).toBe(true);
    await expect.poll(() => lit(a, forger!), { timeout: 15_000, message: 'metalcraft lights Carapace Forger on alice’s table' }).toBe(true);
    await expect.poll(() => lit(b, forger!), { timeout: 15_000, message: 'and on bob’s screen' }).toBe(true);
    expect(await lit(a, barkripper!), 'threshold is still one card short').toBe(false);
    await evidence('three artifacts');
    await a.screenshot({ path: testInfo.outputPath('ca-metalcraft-alice.png') });

    // The seventh card: Galvanic Blast, at the Bears.
    const bears = async () =>
      b.locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]').evaluateAll((els) =>
        els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === 'Grizzly Bears').map((e) => Number(e.getAttribute('data-board-card'))),
      );
    const [bear] = await bears();
    expect(bear, 'bob has Grizzly Bears out').not.toBeUndefined();
    await expect.poll(() => offered(a), { timeout: 30_000, message: 'Galvanic Blast is offered' }).toContain(blast);
    expect(await clickHandCard(a, blast), 'Galvanic Blast lifted out of alice’s hand').toBe(true);
    await expect
      .poll(
        async () => {
          if ((await graveyard.getAttribute('data-count')) === '7' || (await stackCount(a)) > 0) return true;
          await answerPrompt(a);
          await pressOffered(boardCard(a, bear!));
          return false;
        },
        { timeout: 20_000, intervals: [50], message: `Galvanic Blast was cast at the Bears — says: "${await says(a)}"` },
      )
      .toBe(true);
    await expect(graveyard, 'Galvanic Blast resolved into alice’s graveyard: the seventh card').toHaveAttribute('data-count', '7', { timeout: 20_000 });
    await expect.poll(() => lit(a, barkripper!), { timeout: 15_000, message: 'threshold lights Anurid Barkripper on alice’s table' }).toBe(true);
    await expect.poll(() => lit(b, barkripper!), { timeout: 15_000, message: 'and on bob’s screen' }).toBe(true);
    expect(await lit(a, forger!), 'metalcraft is still on').toBe(true);
    await evidence('seven cards');
    await a.screenshot({ path: testInfo.outputPath('ca-threshold-alice.png') });
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

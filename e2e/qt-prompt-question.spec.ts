/**
 * The operator, 2026-10-19: *"the text for bone shards is a bit confusing: 'Destroy target creature or
 * planeswalker. (Additional cost: Sacrifice a creature) Select creature to sacrifice (1 left)' at first
 * i read this and i think my decision is 'destroy a creature' but the question is really sacrifice a
 * creature. is there a way to split this out for all cards? ideally the text here is just for the
 * decision that has to be made."*
 *
 * Real Forge, scenario `qt-bone-shards`: alice casts Bone Shards, choosing one of her two creatures to
 * sacrifice (asked first) and bob's Hill Giant as the target. Each sheet's question line is the decision
 * alone: the sacrifice sheet asks for the sacrifice and does not repeat the spell's text at all, and the
 * target sheet asks for a target, with what the spell does under it as its own line.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why.
 */
import { expect, test, type Page } from '@playwright/test';

import { messages, type Friend } from './play/browser.ts';
import { boardCard, clickHandCard, handCardNamed, makeTitled, offered, ownNamed, pressOffered, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface Sheet {
  question: string;
  context: string | null;
  cards: number[];
}

/** The selection sheet on screen: its question line, the line under it, and the cards it offers. */
const sheet = (page: Page): Promise<Sheet | null> =>
  page.evaluate(() => {
    const host = document.querySelector('[data-testid="live-selection-host"]');
    if (host === null) return null;
    return {
      question: host.querySelector('.prompt__title')?.textContent ?? '',
      context: host.querySelector('[data-testid="prompt-source-text"]')?.textContent ?? null,
      cards: [...host.querySelectorAll('[data-testid="prompt-cards"] li[data-card-id]')].map((li) => Number(li.getAttribute('data-card-id'))),
    };
  });

/** Every `showPromptMessage` Forge sent this seat, as the wire carried it. */
const promptFrames = (f: Friend): unknown[] =>
  messages(f)
    .filter((m) => m.dir === 'in')
    .flatMap((m) => {
      const msg = m.msg as { frame?: { method?: string }; frames?: { method?: string }[] } | null;
      return [...(msg?.frames ?? []), ...(msg?.frame === undefined ? [] : [msg.frame])];
    })
    .filter((frame) => frame.method === 'showPromptMessage');

test(titled('Bone Shards: the sacrifice sheet asks for the sacrifice and the target sheet asks for a target, neither run together with the spell’s text'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'qt-bone-shards');
    const page = alice.page;
    const giants = () =>
      page
        .locator('.seat:not([data-viewer]) [data-zone="battlefield"] [data-board-card]')
        .evaluateAll((els) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === 'Hill Giant').map((e) => Number(e.getAttribute('data-board-card'))));
    await expect.poll(() => handCardNamed(page, 'Bone Shards'), { timeout: 30_000, message: 'alice holds Bone Shards' }).not.toBeUndefined();
    const shards = (await handCardNamed(page, 'Bone Shards'))!;
    await expect.poll(giants, { timeout: 30_000, message: 'bob has Hill Giant out' }).toHaveLength(1);
    const giant = (await giants())[0]!;
    await expect.poll(() => ownNamed(page, 'Llanowar Elves'), { timeout: 30_000, message: 'alice has Llanowar Elves out' }).toHaveLength(1);
    const elves = (await ownNamed(page, 'Llanowar Elves'))[0]!;
    await expect.poll(() => offered(page), { timeout: 45_000, message: 'Bone Shards is offered' }).toContain(shards);
    expect(await clickHandCard(page, shards), 'Bone Shards lifted out of alice’s hand').toBe(true);

    // The sacrifice is asked first, then the target. Every sheet the cast shows is kept as it was drawn.
    let target: Sheet | null = null;
    let sacrifice: Sheet | null = null;
    await expect
      .poll(
        async () => {
          const now = await sheet(page);
          // Forge's sacrifice input says "to sacrifice"; its cards can reach the sheet a frame before its words.
          if (now !== null && now.cards.includes(elves) && !now.cards.includes(giant) && /to sacrifice/.test(now.question)) {
            sacrifice = now;
            return true;
          }
          if (now !== null && now.cards.includes(giant)) target = now;
          await answerPrompt(page);
          return false;
        },
        { timeout: 30_000, intervals: [100], message: `the sacrifice sheet opened — says: "${await says(page)}"` },
      )
      .toBe(true);
    expect(target, 'the sacrifice is asked before the target').toBeNull();
    await page.locator(`[data-testid="live-selection-host"] li[data-card-id="${elves}"] label`).click();
    await expect
      .poll(
        async () => {
          const now = await sheet(page);
          if (now !== null && now.cards.includes(giant)) {
            target = now;
            return true;
          }
          await answerPrompt(page);
          return false;
        },
        { timeout: 30_000, intervals: [100], message: `the target sheet opened after the sacrifice — says: "${await says(page)}"` },
      )
      .toBe(true);
    console.log(`[qt] wire: ${JSON.stringify(promptFrames(alice).map((f) => (f as { message?: string; question?: string; context?: string }).message))}`);
    console.log(`[qt] sacrifice sheet: ${JSON.stringify(sacrifice)}`);
    console.log(`[qt] target sheet: ${JSON.stringify(target)}`);
    const sac = sacrifice as Sheet | null;
    expect(sac?.question, 'the sacrifice sheet’s question is the sacrifice').toMatch(/^Select creature to sacrifice/);
    expect(sac?.question, 'and the spell’s text is not in it').not.toMatch(/Destroy|Additional cost/);
    expect(sac?.context ?? null, 'nor under it').toBeNull();
    const tgt = target as Sheet | null;
    expect(tgt?.question, 'the target sheet’s question is the target').toMatch(/^Select target creature or planeswalker/);
    expect(tgt?.context, 'what the spell does is its own line under the question').toMatch(/^Destroy target creature or planeswalker/);

    // The target is chosen, the sacrifice paid, and Bone Shards does what it says.
    expect(await pressOffered(boardCard(page, giant)), 'alice picks the Giant').toBe(true);
    await expect
      .poll(
        async () => {
          if ((await giants()).length === 0) return true;
          await answerPrompt(page);
          return false;
        },
        { timeout: 30_000, intervals: [100], message: `Bone Shards destroyed Hill Giant — says: "${await says(page)}"` },
      )
      .toBe(true);
    expect(await ownNamed(page, 'Llanowar Elves'), 'the Elves were sacrificed').toHaveLength(0);
  } finally {
    await stack.stop();
  }
});

/**
 * The operator, 2026-10-19: *"returned a card to hand with Jace, why is it not showing as revealed?"*
 *
 * A creature everyone watched on the battlefield is still known once it is bounced to its owner's
 * hand. Real Forge, scenario `kh-unsummon`: alice's Unsummon returns bob's Grizzly Bears. Alice's
 * screen then draws the Bears face up in bob's hand and his Mountain as a back; bob's own screen wears
 * the eye on the Bears and on nothing else. Both still hold on bob's turn, after he has drawn.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why.
 */
import { expect, test, type Page } from '@playwright/test';

import { messages } from './play/browser.ts';
import { boardCard, clickHandCard, grindPriority, handCardNamed, makeTitled, offered, pressOffered, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { unseenNamed } from './play/isolation.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The names alice's screen draws face up in bob's hand, and how many cards it says he holds. */
const theirHand = (page: Page): Promise<{ names: string[]; count: number }> =>
  page.evaluate(() => {
    const hand = document.querySelector('.seat:not([data-viewer]) [data-zone="hand"]');
    const names = [...(hand?.querySelectorAll('.card__name') ?? [])].map((e) => e.textContent?.trim() ?? '').sort();
    return { names, count: Number(hand?.getAttribute('data-count') ?? -1) };
  });

/** The cards of bob's own hand that wear the eye on his screen. */
const eyed = (page: Page): Promise<string[]> =>
  page
    .locator('.seat[data-viewer] [data-zone="hand"] li.board-card')
    .evaluateAll((els) => els.filter((e) => e.querySelector(':scope > .board-card__tags > [data-seen]') !== null).map((e) => e.querySelector('.card__name')?.textContent?.trim() ?? '').sort());

test(titled("Unsummon: bob's bounced Grizzly Bears stays face up in his hand on alice's screen, with the eye on bob's, through his next turn"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'kh-unsummon');
    const page = alice.page;
    const bears = () =>
      page
        .locator('.seat:not([data-viewer]) [data-zone="battlefield"] [data-board-card]')
        .evaluateAll((els) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === 'Grizzly Bears').map((e) => Number(e.getAttribute('data-board-card'))));
    await expect.poll(() => handCardNamed(page, 'Unsummon'), { timeout: 30_000, message: 'alice holds Unsummon' }).not.toBeUndefined();
    const unsummon = (await handCardNamed(page, 'Unsummon'))!;
    await expect.poll(bears, { timeout: 30_000, message: 'bob has Grizzly Bears out' }).toHaveLength(1);
    const bear = (await bears())[0]!;
    await expect.poll(() => offered(page), { timeout: 45_000, message: 'Unsummon is offered' }).toContain(unsummon);
    expect(await theirHand(page), 'before Unsummon alice sees none of bob\'s hand').toEqual({ names: [], count: 1 });
    expect(await clickHandCard(page, unsummon), 'Unsummon lifted out of alice’s hand').toBe(true);

    // Its target is the Bears; it resolves, and the Bears are back in bob's hand.
    await expect
      .poll(
        async () => {
          if ((await theirHand(page)).count === 2) return true;
          await answerPrompt(page);
          await answerPrompt(bob.page);
          if ((await boardCard(page, bear).count()) > 0) await pressOffered(boardCard(page, bear));
          return false;
        },
        { timeout: 30_000, intervals: [50], message: `the Bears are back in bob's hand — alice says: "${await says(page)}"` },
      )
      .toBe(true);
    await expect.poll(() => eyed(bob.page), { timeout: 10_000, message: "bob's screen wears the eye on the Bears" }).toEqual(['Grizzly Bears']);
    const bounced = await theirHand(page);
    console.log(`[kh] after Unsummon: alice's screen draws bob's hand ${JSON.stringify(bounced)}; bob's eye on ${JSON.stringify(await eyed(bob.page))}`);
    expect(bounced, "alice's screen draws the Bears face up in bob's hand, the Mountain as a back").toEqual({ names: ['Grizzly Bears'], count: 2 });

    // Bob's turn: he draws, and the Bears are still known.
    await grindPriority([page, bob.page], async () => (await theirHand(page)).count === 3, { timeoutMs: 90_000 });
    const drawn = await theirHand(page);
    const eye = await eyed(bob.page);
    const hidden = unseenNamed(messages(alice), ['Mountain']);
    console.log(`[kh] after bob's draw: alice's screen draws bob's hand ${JSON.stringify(drawn)}; bob's eye on ${JSON.stringify(eye)}; bob's Mountains sent to alice ${JSON.stringify(hidden)}`);
    expect({ drawn, eye }, 'still known on bob’s turn, and nothing else is').toEqual({ drawn: { names: ['Grizzly Bears'], count: 3 }, eye: ['Grizzly Bears'] });
    expect(hidden.closedCards, 'the check looked at bob\'s hidden cards').toBeGreaterThan(0);
    expect(hidden.violations, 'what alice never saw is never sent').toEqual([]);
  } finally {
    await stack.stop();
  }
});

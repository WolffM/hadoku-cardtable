/**
 * The click-click hand reorder, against real Forge and two real browsers. The
 * operator: *"click to drag the order of cards in hand. so click to pick up a
 * card, and click to put the card back down"*.
 *
 * A click on a hand card picks it up with no button held; moving the pointer
 * over the hand previews the slot; a second click puts it down there. Nothing
 * reaches Forge, the other seat sees a back glide, and a second click on the
 * card's own slot changes nothing. Run twice: at alice's own main-phase
 * priority, where every card in her hand is offered, and on bob's turn, where
 * none is.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one the test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { makeTitled, offered, offeredNamed, resizeWindow, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const HAND = '[data-zone="hand"][data-owner="you"]';

function handIds(page: Page): Promise<number[]> {
  return page.locator(`${HAND} [data-board-card]`).evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))));
}

function battlefieldCount(page: Page): Promise<number> {
  return page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]').count();
}

async function centreOf(page: Page, id: number): Promise<{ x: number; y: number }> {
  const box = await page.locator(`[data-board-card="${id}"]`).boundingBox();
  if (box === null) throw new Error(`no box for hand card ${id}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Installed on bob's page before alice moves anything: whether a back in her hand glided (`presence.ts`'s `glideHandMove`). */
async function watchHandGlide(page: Page): Promise<void> {
  await page.evaluate(() => {
    const overlay = document.querySelector('[data-board-overlay]')!;
    const w = window as unknown as { __sawHandBack: boolean };
    w.__sawHandBack = false;
    new MutationObserver(() => {
      if (overlay.querySelector('.presence__back[data-gliding]') !== null) w.__sawHandBack = true;
    }).observe(overlay, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-gliding'] });
  });
}

const sawHandGlide = (page: Page): Promise<boolean> => page.evaluate(() => (window as unknown as { __sawHandBack: boolean }).__sawHandBack);

for (const situation of [
  { scenario: 'hc-hand-click-own', when: 'at her own main-phase priority, every card offered' },
  { scenario: 'hc-hand-click-theirs', when: 'on the other seat’s turn, nothing of hers offered' },
] as const) {
  test(titled(`click a hand card, click between two others: it lands there, nothing is cast, bob sees a back glide — ${situation.when}`), async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    const log: string[] = [];
    try {
      const { alice, bob } = await startScenarioMatch(browser, stack, situation.scenario);
      for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });
      const page = alice.page;

      const before = await handIds(page);
      expect(before.length, 'the scenario’s five-card hand').toBe(5);
      if (situation.scenario === 'hc-hand-click-own') {
        await expect.poll(async () => (await offered(page)).filter((id) => before.includes(id)).length, { timeout: 30_000, message: 'Forge offers every card in her hand' }).toBe(5);
      } else {
        await expect.poll(() => offeredNamed(bob.page, 'Memnite'), { timeout: 30_000, message: 'bob holds priority in his own main phase' }).toBeDefined();
        expect((await offered(page)).filter((id) => before.includes(id)), 'nothing in alice’s hand is offered').toEqual([]);
      }
      const stackBefore = await stackCount(page);
      const fieldBefore = await battlefieldCount(page);
      await watchHandGlide(bob.page);

      // Pick up the first card with a plain click: no button stays held.
      const [a, b, c, d, e] = before as [number, number, number, number, number];
      const from = await centreOf(page, a);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.up();
      await expect(page.locator(`[data-board-card="${a}"]`), 'picked up, following the pointer').toHaveAttribute('data-cast-lift', 'lifted');

      // Carry it, no button held, to the gap between the third and fourth cards.
      const cBox = (await page.locator(`[data-board-card="${c}"]`).boundingBox())!;
      const dBox = (await page.locator(`[data-board-card="${d}"]`).boundingBox())!;
      const gap = { x: (cBox.x + cBox.width + dBox.x) / 2, y: cBox.y + cBox.height / 2 };
      log.push(`hand ${JSON.stringify(before)}, gap ${JSON.stringify(gap)}`);
      await page.mouse.move(gap.x, gap.y, { steps: 10 });
      await expect(page.locator(`[data-board-card="${a}"]`), 'still picked up mid-carry').toHaveAttribute('data-cast-lift', 'lifted');
      await expect(page.locator('[data-arrange-indicator][data-arrange-slot="hand"]'), 'the drop slot is previewed').toBeVisible();
      await expect(page.locator(`[data-board-card="${d}"]`), 'in front of the fourth card').toHaveAttribute('data-arrange-target', 'before');

      // Put it down with a second click.
      await page.mouse.down();
      await page.mouse.up();
      await expect.poll(() => handIds(page), { timeout: 5_000, message: 'it lands between the third and fourth cards' }).toEqual([b, c, a, d, e]);
      await expect(page.locator(`[data-board-card="${a}"]`), 'put down, not mid-cast').not.toHaveAttribute('data-cast-lift', /.*/, { timeout: 2_000 });
      await expect(page.locator('[data-arrange-indicator][data-arrange-slot="hand"]:not([hidden])'), 'the preview is gone').toHaveCount(0);
      expect(await stackCount(page), 'nothing was cast').toBe(stackBefore);
      expect(await battlefieldCount(page), 'nothing was played').toBe(fieldBefore);
      await expect.poll(() => sawHandGlide(bob.page), { timeout: 5_000, message: 'bob saw a card back glide in her hand' }).toBe(true);

      // A click, then a click back on its own slot, changes nothing. A card still gliding into
      // its slot is not picked up (`hand.css`), so the next click waits for the glide to end.
      await expect(page.locator(`${HAND} [data-hand-flip]`), 'the glide has ended').toHaveCount(0);
      const own = await centreOf(page, a);
      await page.mouse.move(own.x, own.y);
      await page.mouse.down();
      await page.mouse.up();
      await expect(page.locator(`[data-board-card="${a}"]`), 'picked up again').toHaveAttribute('data-cast-lift', 'lifted');
      await page.mouse.move(own.x + 3, own.y, { steps: 3 });
      await page.mouse.down();
      await page.mouse.up();
      await expect(page.locator(`[data-board-card="${a}"]`), 'put down again').not.toHaveAttribute('data-cast-lift', /.*/, { timeout: 2_000 });
      expect(await handIds(page), 'the same order').toEqual([b, c, a, d, e]);
      expect(await stackCount(page), 'still nothing cast').toBe(stackBefore);
      expect(await battlefieldCount(page), 'still nothing played').toBe(fieldBefore);
    } finally {
      console.log(`[hand-click] ${log.join('\n[hand-click] ')}`);
      await stack.stop();
    }
  });
}

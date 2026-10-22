/**
 * A box over several attackers is AIMED, against a real Forge match.
 *
 * The operator, 2026-10-19: *"when i draw a box to select a number of
 * creatures, i still want to select where the arrow goes rather than having
 * them auto-select a target. this can be annoying because if i have 10
 * creatures and i draw a box, they might all get auto-targeted to a
 * planeswalker on board."* `InputAttack` declares each clicked creature
 * against whichever defender is CURRENT, so a box that sent its clicks at the
 * release attacked whatever Forge had current. Now, while Forge offers more
 * than one defender, the box holds its creatures (`data-attack-pending`), an
 * arrow leaves them, and the next press on a defender sends the defender's
 * click first and then every creature's (`gestures/commit.ts`'s `attackWith`).
 * `gestures.test.ts` pins the wire order under jsdom; this is the real-Forge
 * proof that Forge declares every creature against the defender pressed.
 *
 * Which defender Forge declared is read the way `w46-attack.spec.ts` reads it:
 * by the lasting attack arrow (`combat:<id>`, drawn off Forge's own
 * `CombatView`), whose tip lies on the defender's own element.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one every test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { boxAround, clickOnce, enabledOk, makeTitled, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface Point {
  x: number;
  y: number;
}

/** Press OK at the attacker's own Main Phase 1 until Forge's live `InputAttack` opens. */
async function passToDeclareAttackers(page: Page): Promise<void> {
  const deadline = Date.now() + 20_000;
  let pressed = false;
  while (!/^Select creatures to attack/i.test(await says(page)) && Date.now() < deadline) {
    const text = await says(page);
    if (!pressed && /^Priority:/.test(text) && /Main phase, precombat/i.test(text) && (await enabledOk(page).count()) > 0) {
      pressed = true;
      await clickOnce(page, text, 'ok');
    }
    await page.waitForTimeout(40);
  }
  await expect.poll(() => says(page), { timeout: 5_000, message: 'the live declare-attackers window opened' }).toMatch(/^Select creatures to attack/i);
}

/** Alice's own three creatures, by id. */
async function ownCreatures(page: Page): Promise<number[]> {
  const ids = await page
    .locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card')
    .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))));
  expect(ids, 'alice has her three creatures').toHaveLength(3);
  return ids;
}

/** Press the centre of `selector`'s element. */
async function pressOn(page: Page, selector: string): Promise<void> {
  const box = (await page.locator(selector).first().boundingBox())!;
  const at: Point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(at.x, at.y, { steps: 8 });
  await page.mouse.click(at.x, at.y);
}

/**
 * Whether the lasting attack arrow of every attacker in `ids` ends on the element
 * `selector` names — Forge's own `CombatView` defender for each, read in one
 * layout pass. The tip is on the defender's edge (a card) or its centre (a face).
 */
async function allAttack(page: Page, ids: readonly number[], selector: string): Promise<boolean> {
  return page.evaluate(
    ([cards, sel]) => {
      const target = document.querySelector(sel);
      if (target === null) return false;
      const t = target.getBoundingClientRect();
      return cards.every((id) => {
        const arrow = document.querySelector(`[data-testid="stack-target-arrow"][data-key="combat:${id}"]`);
        const nums = (arrow?.querySelector('path')?.getAttribute('d') ?? '').replace(/[MQ]/g, ' ').trim().split(/\s+/).map(Number);
        if (arrow === null || nums.length < 6) return false;
        const a = arrow.getBoundingClientRect();
        const tip = { x: nums[4]! + a.left, y: nums[5]! + a.top };
        return tip.x >= t.left - 1 && tip.x <= t.right + 1 && tip.y >= t.top - 1 && tip.y <= t.bottom + 1;
      });
    },
    [ids, selector] as [readonly number[], string],
  );
}

const pendingCount = (page: Page): Promise<number> => page.locator('[data-attack-pending]').count();
const attackingCount = (page: Page, ids: readonly number[]): Promise<number> =>
  page.evaluate((cards) => cards.filter((id) => document.querySelector(`[data-board-card="${id}"]`)?.getAttribute('data-attacking') === 'true').length, ids);

test.describe.configure({ mode: 'serial' });

test(
  titled('with a planeswalker out, a box of three attackers waits for its defender: aimed at the player all three attack the player, aimed at Jace all three attack Jace'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
    try {
      seated = await startScenarioMatch(browser, stack, 'box-aim-pw');
      const page = seated.alice.page;
      const creatures = await ownCreatures(page);
      const jace = Number(await page.locator('.seat:not([data-viewer]) [data-zone="battlefield"] li.board-card').first().getAttribute('data-board-card'));
      const face = '[data-player-face]:not([data-viewer])';
      const jaceSel = `[data-board-card="${jace}"]`;

      await passToDeclareAttackers(page);
      for (const id of creatures) {
        await expect(page.locator(`[data-board-card="${id}"]`), `creature ${id} is offered to attack`).toHaveAttribute('data-selectable', 'true', { timeout: 10_000 });
      }
      await expect(page.locator(jaceSel), 'Jace is offered as a defender').toHaveAttribute('data-selectable', 'true', { timeout: 10_000 });

      // 1. The box holds the three, sends nothing, and an arrow leaves them.
      await boxAround(page, creatures);
      await expect.poll(() => pendingCount(page), { message: 'the three are held, marked' }).toBe(3);
      await expect(page.locator('[data-gesture-canvas][data-aiming]'), 'the board is aiming').toHaveCount(1);
      await page.waitForTimeout(750);
      expect(await attackingCount(page, creatures), 'Forge declared nothing: nothing was sent').toBe(0);
      const faceBox = (await page.locator(face).first().boundingBox())!;
      await page.mouse.move(faceBox.x + faceBox.width / 2, faceBox.y + faceBox.height / 2, { steps: 8 });
      await expect(page.getByTestId('targeter'), 'the arrow snaps to the face').toHaveAttribute('data-target', /^player:/);

      // 2. Aimed at the player: all three attack the player.
      await pressOn(page, face);
      await expect.poll(() => attackingCount(page, creatures), { timeout: 10_000, message: 'all three declared' }).toBe(3);
      expect(await pendingCount(page), 'the hold is let go').toBe(0);
      await expect.poll(() => allAttack(page, creatures, face), { timeout: 10_000, message: 'every one of them attacks the player' }).toBe(true);

      // 3. A box over only attackers pulls them back at once (wave 32 Q14), aiming nothing.
      await boxAround(page, creatures);
      expect(await pendingCount(page), 'a pull-back is never held').toBe(0);
      await expect.poll(() => attackingCount(page, creatures), { timeout: 10_000, message: 'all three pulled back' }).toBe(0);

      // 4. Aimed at Jace: all three attack Jace.
      for (const id of creatures) {
        await expect(page.locator(`[data-board-card="${id}"]`), `creature ${id} is offered again`).toHaveAttribute('data-selectable', 'true', { timeout: 10_000 });
      }
      await boxAround(page, creatures);
      await expect.poll(() => pendingCount(page), { message: 'the three are held again' }).toBe(3);
      await pressOn(page, jaceSel);
      await expect.poll(() => attackingCount(page, creatures), { timeout: 10_000, message: 'all three declared' }).toBe(3);
      await expect.poll(() => allAttack(page, creatures, jaceSel), { timeout: 10_000, message: 'every one of them attacks Jace' }).toBe(true);
    } finally {
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  },
);

test(titled('with the player the only defender, a box of three attackers declares all three at once'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'box-aim-face');
    const page = seated.alice.page;
    const creatures = await ownCreatures(page);
    await passToDeclareAttackers(page);
    for (const id of creatures) {
      await expect(page.locator(`[data-board-card="${id}"]`), `creature ${id} is offered to attack`).toHaveAttribute('data-selectable', 'true', { timeout: 10_000 });
    }
    await boxAround(page, creatures);
    expect(await pendingCount(page), 'nothing is held').toBe(0);
    await expect(page.locator('[data-gesture-canvas][data-aiming]'), 'and nothing is aimed').toHaveCount(0);
    await expect.poll(() => attackingCount(page, creatures), { timeout: 10_000, message: 'all three declared from the box alone' }).toBe(3);
    await expect.poll(() => allAttack(page, creatures, '[data-player-face]:not([data-viewer])'), { timeout: 10_000, message: 'every one attacks the player' }).toBe(true);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

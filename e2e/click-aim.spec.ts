/**
 * An attacker and a blocker are aimed by two clicks, against a real Forge match.
 *
 * The operator, 2026-10-17: *"can we make attacker/blocker asigning be click to 'enter drag state'
 * and click to 'assign attacker/blocker'"*. A click on this seat's own attacker or blocker sends
 * nothing: it takes the creature up, the same arrow a drag draws follows the pointer, and the next
 * click is where the drag would have let go (`gestures/install.ts`'s `aim`, `gestures/commit.ts`'s
 * `commitAim`). `gestures.test.ts` pins the wire order under jsdom; this is the real-Forge proof that
 * Forge declares and blocks what the second click names.
 *
 * Scenario `click-aim`: alice clicks Memnite, then Jace (it attacks Jace), and the Bears, then bob's
 * face (they attack bob); bob clicks his Wall of Stone, then the Bears (it blocks them). Memnite,
 * unblocked, takes Jace from 3 loyalty to 2, and bob's life stays 20. Which defender Forge declared
 * is read off the lasting attack arrow (`attacksAt`), as `box-aim.spec.ts` reads it.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { boardCard, clickOnce, enabledOk, lifeOf, makeTitled, pressOffered, resizeWindow, says } from './play/board.ts';
import { attacksAt, blockArrow, clickCombat, passToDeclareAttackers } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[click-aim] ${JSON.stringify({ step, data })}`);

/** The id of the creature named `name` on `whose` battlefield, as `page` draws it. */
async function idOf(page: Page, whose: 'mine' | 'theirs', name: string): Promise<number> {
  const seat = whose === 'mine' ? '.seat[data-viewer]' : '.seat:not([data-viewer])';
  const li = page.locator(`${seat} [data-zone="battlefield"] li.board-card`).filter({ hasText: name }).first();
  await expect(li, `${name} is drawn`).toBeVisible({ timeout: 30_000 });
  return Number(await li.getAttribute('data-board-card'));
}

/** Move the pointer to the centre of `selector`'s element, in steps, as a hand does. */
async function hoverOver(page: Page, selector: string): Promise<void> {
  const box = (await page.locator(selector).first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
}

const attacking = (page: Page, id: number): Promise<boolean> =>
  page.locator(`[data-board-card="${id}"]`).first().evaluate((el) => el.getAttribute('data-attacking') === 'true');

test(titled('a click takes an attacker or a blocker up and a second click assigns it: Memnite attacks Jace, the Bears attack bob, the Wall blocks the Bears'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'click-aim');
    const a = seated.alice.page;
    const b = seated.bob.page;
    await resizeWindow(a, { width: 1280, height: 800 });
    await resizeWindow(b, { width: 1280, height: 800 });

    const memnite = await idOf(a, 'mine', 'Memnite');
    const bears = await idOf(a, 'mine', 'Grizzly Bears');
    const jace = await idOf(a, 'theirs', 'Jace Beleren');
    const wall = await idOf(b, 'mine', 'Wall of Stone');
    const jaceSel = `[data-board-card="${jace}"]`;
    const face = '[data-player-face]:not([data-viewer])';
    log('start', { memnite, bears, jace, wall });

    await passToDeclareAttackers(a);
    await expect(a.locator(jaceSel), 'Jace is offered as a defender').toHaveAttribute('data-selectable', 'true', { timeout: 10_000 });

    // 1. A click on Memnite takes it up: nothing sent, and the drag's own arrow follows the pointer onto Jace.
    expect(await pressOffered(a.locator(`[data-board-card="${memnite}"]`)), 'Memnite pressed').toBe(true);
    await expect(a.locator('[data-gesture-canvas][data-aiming]'), 'the board is aiming').toHaveCount(1);
    await hoverOver(a, jaceSel);
    const targeter = a.getByTestId('targeter');
    await expect(targeter, 'the arrow leaves Memnite').toHaveAttribute('data-source', String(memnite));
    await expect(targeter, 'and snaps to Jace').toHaveAttribute('data-target', `card:${jace}`);
    await a.waitForTimeout(750);
    expect(await attacking(a, memnite), 'Forge declared nothing: nothing was sent').toBe(false);

    // 2. The second click, on Jace: Memnite attacks Jace.
    expect(await pressOffered(a.locator(jaceSel)), 'Jace pressed').toBe(true);
    await expect.poll(() => attacking(a, memnite), { timeout: 10_000, message: 'Memnite is declared' }).toBe(true);
    await expect(a.locator('[data-gesture-canvas][data-aiming]'), 'the aim is let go').toHaveCount(0);
    await expect.poll(() => attacksAt(a, [memnite], jaceSel), { timeout: 10_000, message: 'Memnite attacks Jace' }).toBe(true);

    // 3. The Bears by the shared driver, at bob's face: they attack bob, and Memnite still attacks Jace.
    expect(await clickCombat(boardCard(a, bears), a.locator(face)), 'the Bears are aimed at bob').toBe(true);
    await expect.poll(() => attacking(a, bears), { timeout: 10_000, message: 'the Bears are declared' }).toBe(true);
    await expect.poll(() => attacksAt(a, [bears], face), { timeout: 10_000, message: 'the Bears attack bob' }).toBe(true);
    expect(await attacksAt(a, [memnite], jaceSel), 'Memnite still attacks Jace').toBe(true);
    log('declared', { says: await says(a) });
    await enabledOk(a).first().click();

    // 4. Bob blocks: a click on the Wall takes it up, the arrow snaps to the Bears, the second click blocks them.
    await expect.poll(() => says(b), { timeout: 30_000, message: 'bob’s block window opens' }).toMatch(/select creatures to block/i);
    expect(await pressOffered(b.locator(`[data-board-card="${wall}"]`)), 'the Wall pressed').toBe(true);
    await expect(b.locator('[data-gesture-canvas][data-aiming]'), 'bob’s board is aiming').toHaveCount(1);
    await hoverOver(b, `[data-board-card="${bears}"]`);
    await expect(b.getByTestId('targeter'), 'the arrow snaps to the Bears').toHaveAttribute('data-target', `card:${bears}`);
    await b.waitForTimeout(750);
    await expect(b.locator(`[data-board-card="${wall}"]`), 'nothing blocked yet').not.toHaveAttribute('data-blocking', 'true');
    expect(await pressOffered(b.locator(`[data-board-card="${bears}"]`)), 'the Bears pressed').toBe(true);
    await expect(b.locator(`[data-board-card="${wall}"]`), 'the Wall blocks').toHaveAttribute('data-blocking', 'true', { timeout: 10_000 });
    await expect(blockArrow(b, wall, bears), 'its arrow runs to the Bears').toHaveCount(1, { timeout: 10_000 });
    await enabledOk(b).first().click();

    // 5. Damage: Memnite, unblocked, takes Jace to 2; the Bears hit the Wall, so bob's life stays 20.
    const loyalty = a.locator(`${jaceSel} > .board-card__face .card__stat`);
    const deadline = Date.now() + 60_000;
    while ((await loyalty.textContent().catch(() => null))?.trim() !== '2' && Date.now() < deadline) {
      for (const page of [a, b]) {
        const text = await says(page);
        if (/^Priority:/.test(text) && (await enabledOk(page).count()) > 0) await clickOnce(page, text, 'ok');
      }
      await a.waitForTimeout(100);
    }
    log('damage', { loyalty: (await loyalty.textContent())?.trim(), bobLife: await lifeOf(a, 'opp').textContent() });
    await expect(loyalty, 'Memnite dealt Jace its damage').toHaveText('2');
    await expect(lifeOf(a, 'opp'), 'the Wall took the Bears').toHaveText('20');
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

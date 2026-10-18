/**
 * The operator, 2026-10-13: *"enemy planeswalker is showing as clickable not sure"*.
 *
 * Production match m-a58ab8a6bb79 (2026-10-14T01:04Z): at the attacker's own priority stop after
 * combat began, Forge's offer named only the seat's own cards, yet the board sent a click on the
 * opponent's planeswalker (card 51) and Forge never answered it (`act-unanswered`). A planeswalker
 * is a defender only while `InputAttack` runs; at the same step's priority stop nothing of the
 * opponent's is Forge's to take.
 *
 * Alice attacks with Memnite and keeps her declare-attackers priority (Giant Growth, a Forest up).
 * Bob holds a planeswalker, an artifact, an enchantment and a land. While InputAttack runs, Jace is
 * offered (Forge takes the click: it picks what the next attacker attacks); once the attack is
 * confirmed, none of bob's permanents is drawn clickable — no offer mark, no can-act glow, no
 * pointer cursor.
 *
 * Scenario: `st-enemy-clickable`. Every step prints one `[st]` line.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickCombat, clickRecords, enabledOk, makeTitled, resizeWindow, says } from './play/board.ts';
import { passToDeclareAttackers, phaseOf } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (step: string, data: unknown): void => console.log(`[st] ${JSON.stringify({ step, data })}`);

interface Drawn {
  id: number;
  name: string;
  selectable: boolean;
  canAct: boolean;
  cursor: string;
}

/** Every permanent on the opponent's battlefield as `page` draws it, and whether it is drawn clickable. */
function theirs(page: Page): Promise<Drawn[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.seat:not([data-viewer]) [data-zone="battlefield"] li.board-card')).map((li) => {
      const face = li.querySelector<HTMLElement>(':scope > .board-card__face');
      return {
        id: Number(li.dataset.boardCard),
        name: li.querySelector('.card__name')?.textContent?.trim() ?? '',
        selectable: li.hasAttribute('data-selectable'),
        canAct: li.hasAttribute('data-can-act'),
        cursor: face === null ? '' : getComputedStyle(face).cursor,
      };
    }),
  );
}

const clickable = (d: Drawn): boolean => d.selectable || d.canAct || d.cursor === 'pointer';

test(titled('the opponent’s permanents are drawn clickable only while Forge takes the click: Jace in InputAttack, nothing at the priority stop after it'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'st-enemy-clickable');
    const page = alice.page;
    await resizeWindow(page, { width: 1280, height: 800 });

    await expect.poll(async () => (await theirs(page)).length, { timeout: 30_000, message: 'bob’s four permanents are drawn' }).toBe(4);
    const memnite = Number(await page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card').filter({ hasText: 'Memnite' }).first().getAttribute('data-board-card'));
    const jace = (await theirs(page)).find((d) => d.name === 'Jace Beleren')!.id;
    log('start', { memnite, jace, theirs: await theirs(page) });

    await passToDeclareAttackers(page);
    // InputAttack: a click on a planeswalker picks it as the defender (`InputAttack.java:230-235`).
    await expect(page.locator(`[data-board-card="${jace}"]`), 'Jace is offered while InputAttack runs').toHaveAttribute('data-selectable', 'true', { timeout: 10_000 });
    log('input-attack', { theirs: await theirs(page) });

    // AF140: a click aims Memnite, a click on Jace attacks him.
    expect(await clickCombat(page.locator(`[data-board-card="${memnite}"]`), page.locator(`[data-board-card="${jace}"]`)), 'Memnite aimed at Jace').toBe(true);
    await expect(page.locator(`[data-board-card="${memnite}"]`), 'Memnite is declared attacking').toHaveAttribute('data-attacking', 'true', { timeout: 10_000 });
    expect(clickRecords(stack, jace), 'the second click went to Forge on Jace, making him the defender').not.toBe('none');
    await enabledOk(page).first().click();

    // The attacker's own priority stop in declare attackers: Forge's bar is OK / End Turn now.
    await expect
      .poll(async () => `${(await phaseOf(page))?.phase ?? ''} | ${await says(page)}`, { timeout: 25_000, message: 'alice holds her declare-attackers priority' })
      .toMatch(/^COMBAT_DECLARE_ATTACKERS \| Priority:/);
    await expect(page.getByTestId('live-button-end-turn'), 'the priority stop’s own bar').toBeEnabled({ timeout: 10_000 });
    const atStop = await theirs(page);
    log('priority-stop', { says: await says(page), theirs: atStop });
    expect(atStop.filter(clickable), 'nothing of bob’s is drawn clickable at alice’s priority stop').toEqual([]);
  } finally {
    await stack.stop();
  }
});

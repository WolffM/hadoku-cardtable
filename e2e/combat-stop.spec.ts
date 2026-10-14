/**
 * The operator cast Hydrolash ("attacking creatures get -2/-0") from a Combat stop on the
 * opponent's turn and it did nothing: the collapsed Combat row held their priority at Beginning
 * of combat, before anything attacked. Their decision (2026-10-12): on the opponent's turn the
 * Combat stop holds priority once attackers are declared, before blocks; on the seat's own turn
 * it is still Beginning of combat.
 *
 * Two real browsers, `cs-combat-stop`: bob's own Main 1 with a Hill Giant (3/3); alice holds
 * Hydrolash and three Islands, and no creature. Alice clicks the rail's Combat row; bob goes to
 * combat and attacks with the Giant. Alice's first live window is Declare attackers with the
 * Giant attacking; she casts Hydrolash there and takes 1, not 3.
 *
 * Needs a Forge build; without one the test SKIPS and its title says why.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { castCard, clickOnce, enabledOk, handCardNamed, makeTitled, says, serverLog } from './play/board.ts';
import { railAt, type RailAt } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const ATTACK = /Select creatures to attack/i;

const rail = (page: Page): Locator => page.getByTestId('live-phases');
const row = (page: Page, phase: string): Locator => rail(page).locator(`li[data-phase="${phase}"]`);
const ownLife = (page: Page): Locator => page.locator('.seat[data-viewer] [data-testid="life"]');
const attacking = (page: Page): Locator => page.locator('li.board-card[data-attacking="true"]');

/** The screen at one instant (`railAt`); an absent rail reads as nowhere, not live. */
const at = async (page: Page): Promise<RailAt> => (await railAt(page)) ?? { phase: '', whose: '', turn: 0, live: false };

const decisionText = async (page: Page): Promise<string> => {
  const pop = page.getByTestId('live-decision');
  return (await pop.count()) === 0 ? '' : ((await pop.first().textContent()) ?? '');
};

test(titled("the Combat stop on the opponent's turn holds priority once attackers are declared"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'cs-combat-stop');
    await expect.poll(async () => `${(await at(alice.page)).whose}:${(await at(alice.page)).phase}`, { timeout: 60_000 }).toBe('theirs:MAIN1');

    // Alice's Combat row: a real pointer click in its middle.
    const box = await row(alice.page, 'COMBAT').boundingBox();
    if (box === null) throw new Error('no Combat row on the rail');
    await alice.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(row(alice.page, 'COMBAT'), 'the Combat row is marked').toHaveAttribute('data-stop', '', { timeout: 10_000 });

    // Bob passes his Main 1 and attacks with the Giant, until alice's own bar is live.
    const giant = bob.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card').first();
    const giantId = Number(await giant.getAttribute('data-board-card'));
    let passedMain = false;
    let declared = false;
    const deadline = Date.now() + 60_000;
    while (!(await at(alice.page)).live && Date.now() < deadline) {
      const line = await says(bob.page);
      if (!passedMain && /^Priority:/.test(line) && /Main phase, precombat/i.test(line) && (await enabledOk(bob.page).count()) > 0) {
        passedMain = true;
        await enabledOk(bob.page).first().click();
      }
      if (!declared && ATTACK.test(await decisionText(bob.page)) && (await giant.getAttribute('data-selectable')) === 'true') {
        const g = (await giant.boundingBox())!;
        await bob.page.mouse.click(g.x + g.width / 2, g.y + g.height / 2);
        await expect(bob.page.locator(`[data-board-card="${giantId}"]`), 'Forge declared the Giant attacking').toHaveAttribute('data-attacking', 'true', {
          timeout: 10_000,
        });
        declared = true;
        await bob.page.locator('[data-testid="live-decision-ok"]:enabled').click();
      }
      await alice.page.waitForTimeout(40);
    }
    const first = await at(alice.page);
    const attackers = await attacking(alice.page).count();
    console.log(`[cs-stop] alice's first window ${JSON.stringify(first)}, attackers drawn ${attackers}, bob declared ${String(declared)}`);
    expect({ ...first, attackers }, "alice's stop holds her priority in bob's Declare attackers step, the Giant attacking").toEqual({
      phase: 'COMBAT_DECLARE_ATTACKERS',
      whose: 'theirs',
      turn: 1,
      live: true,
      attackers: 1,
    });
    await expect(row(alice.page, 'COMBAT_DECLARE_ATTACKERS'), 'the stop is spent once it fired').not.toHaveAttribute('data-stop');

    const lash = await handCardNamed(alice.page, 'Hydrolash');
    expect(lash, 'Hydrolash is in alice’s hand').toBeDefined();
    await castCard(alice.page, lash!);
    console.log(`[cs-stop] Hydrolash cast at ${JSON.stringify(await at(alice.page))}`);

    // Both seats pass on until bob's combat is over.
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      const now = await at(alice.page);
      if (now.turn > 1 || now.phase === 'MAIN2' || now.phase === 'END_OF_TURN') break;
      for (const page of [alice.page, bob.page]) if ((await enabledOk(page).count()) > 0) await clickOnce(page, await says(page), 'ok');
      await alice.page.waitForTimeout(60);
    }
    console.log(`[cs-stop] after combat ${JSON.stringify(await at(alice.page))}, alice's life ${await ownLife(alice.page).textContent()}`);
    await expect(ownLife(alice.page), 'the Giant hit for 3 − 2').toHaveText('19', { timeout: 15_000 });

    const log = serverLog(stack).filter((r) => r.seat === 0 && ['stop-set', 'stop-fired', 'stop-cleared'].includes(String(r.evt)));
    console.log(`[cs-stop] log ${JSON.stringify(log.map((r) => [r.evt, r.phase, r.at ?? null, r.myTurn ?? null, r.why ?? null]))}`);
    expect(log.map((r) => `${String(r.evt)}:${String(r.phase)}:${String(r.at ?? '')}`)).toEqual(['stop-set:COMBAT:', 'stop-fired:COMBAT:COMBAT_DECLARE_ATTACKERS']);
  } finally {
    await stack.stop();
  }
});

/**
 * The operator, 2026-10-24: *"eldrazi spawn on the board should be sacrificable even if theres nothing to
 * do with them."* In match m-32b7a3ef1a95 Spawn token 159 was offered from 04:38:49 on and the server
 * logged no click on it. Two browsers, a real Forge match, the operator's two windows: her own Main 1
 * (`scenarios/spawn-own-main.state`) and her response to the other player's Pyroclasm
 * (`scenarios/spawn-response.state`). Each click on the Spawn sacrifices it and floats {C}; a refused
 * click is in the server log as the client's `click-refused` event.
 *
 * Serves the prebuilt dist (`e2e/play/harness.ts`); skips, with a title that says why, when Forge is
 * absent.
 */

import { expect, test, type Page } from '@playwright/test';

import { castCard, clickRecords, handCardNamed, holdsLiveWindow, makeTitled, manaPool, offered, serverLog } from './play/board.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The viewer's own Eldrazi Spawn token, by the name the board draws. */
function spawnOf(page: Page): Promise<number | undefined> {
  return page
    .locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]')
    .evaluateAll((els) => els.filter((e) => (e.querySelector('.card__name')?.textContent ?? '').includes('Eldrazi Spawn')).map((e) => Number(e.getAttribute('data-board-card'))))
    .then((ids) => ids[0]);
}

async function sacrificeSpawn(page: Page, stack: PlayStack): Promise<void> {
  const spawn = await spawnOf(page);
  expect(spawn, 'the Spawn is on alice’s battlefield').not.toBeUndefined();
  await expect.poll(() => offered(page), { timeout: 30_000, message: 'the Spawn is offered' }).toContain(spawn);
  await page.locator(`.seat[data-viewer] [data-board-card="${spawn}"] .board-card__face`).click();
  await expect
    .poll(async () => (await manaPool(page)).C, {
      timeout: 15_000,
      message: `the Spawn sacrificed for {C} (clicks: ${clickRecords(stack, spawn!)}; refused: ${JSON.stringify(serverLog(stack).filter((r) => r.what === 'click-refused'))})`,
    })
    .toBe(1);
  expect(await spawnOf(page), 'the Spawn is gone').toBeUndefined();
}

test(titled('alice’s own Main 1: a click on her Eldrazi Spawn sacrifices it for {C}'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'spawn-own-main');
    await sacrificeSpawn(alice.page, stack);
  } finally {
    await stack.stop();
  }
});

test(titled('bob’s Pyroclasm on the stack: alice’s click on her Eldrazi Spawn sacrifices it for {C} in response'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'spawn-response');
    await expect.poll(() => handCardNamed(bob.page, 'Pyroclasm'), { timeout: 30_000, message: 'Pyroclasm is in bob’s hand' }).not.toBeUndefined();
    await castCard(bob.page, (await handCardNamed(bob.page, 'Pyroclasm'))!);
    await expect.poll(() => holdsLiveWindow(alice.page), { timeout: 30_000, message: 'alice holds priority over the Pyroclasm' }).toBe(true);
    await sacrificeSpawn(alice.page, stack);
  } finally {
    await stack.stop();
  }
});

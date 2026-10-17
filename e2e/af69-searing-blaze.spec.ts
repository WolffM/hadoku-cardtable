/**
 * A spell whose second target is defined by its first is offered. The operator, 2026-10-14:
 * *"landfall trigger makes searing blaze not playable? actually searing blaze appeared to never be
 * playable."* Searing Blaze targets a player or planeswalker, then a creature THAT player
 * controls (`ValidTgts$ Creature.ControlledBy ParentTargetedController`): asked before any first
 * target is chosen, the second has no candidates at all, so the offer left it out every time.
 *
 * `af69-searing-blaze.state`: alice has two Mountains out and Searing Blaze + a Mountain in hand;
 * bob controls a Grizzly Bears. Alice plays the Mountain (landfall), Searing Blaze is offered, and
 * cast at bob and his Bears it deals 3 to each: bob 20 → 17, the Bears to the graveyard.
 */
import { expect, test } from '@playwright/test';

import { castUntilOnStack, clickHandCard, handCardNamed, makeTitled, offered, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('Searing Blaze is offered with a creature to hit, and hits bob and his creature for 3 after landfall'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: ScenarioMatch | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'af69-searing-blaze');
    const page = seated.alice.page;
    const bobLife = page.locator('.seat:not([data-viewer]) [data-testid="life"]');
    const bobGraveyard = page.locator('[data-zone="graveyard"][data-owner="them"]');

    await expect.poll(() => handCardNamed(page, 'Searing Blaze'), { timeout: 30_000, message: 'alice holds Searing Blaze' }).not.toBeUndefined();
    const blaze = (await handCardNamed(page, 'Searing Blaze'))!;
    const land = (await handCardNamed(page, 'Mountain'))!;
    await expect.poll(() => offered(page), { timeout: 45_000, message: 'alice is offered her Mountain' }).toContain(land);
    const before = await offered(page);
    console.log(`[af69] before landfall: offered [${before.join(', ')}], Searing Blaze ${blaze} ${before.includes(blaze) ? 'offered' : 'NOT offered'}`);
    expect(before, 'Searing Blaze is offered before any land is played (1 damage each)').toContain(blaze);

    expect(await clickHandCard(page, land, { row: 'back' }), 'the Mountain is played').toBe(true);
    await expect.poll(() => handCardNamed(page, 'Mountain'), { timeout: 15_000, message: 'the Mountain left alice’s hand' }).toBeUndefined();
    await expect.poll(() => offered(page), { timeout: 15_000, message: `Searing Blaze is offered after landfall — says: "${await says(page)}"` }).toContain(blaze);

    const bobFace = page.locator('[data-player-face]:not([data-viewer])');
    const bears = page.locator('.seat:not([data-viewer]) [data-zone="battlefield"] [data-board-card]');
    await castUntilOnStack(page, stack, blaze, [bobFace, bears]);
    await expect.poll(() => bobLife.textContent(), { timeout: 20_000, message: 'Searing Blaze resolved: bob took 3' }).toBe('17');
    await expect.poll(() => bobGraveyard.getAttribute('data-count'), { timeout: 15_000, message: 'the Grizzly Bears took 3 and died' }).toBe('1');
    console.log(`[af69] resolved: bob life=${await bobLife.textContent()} bob graveyard=${await bobGraveyard.getAttribute('data-count')}`);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

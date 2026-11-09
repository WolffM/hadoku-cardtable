/**
 * With one place to send it, one click puts a creature into combat, against a real Forge match.
 *
 * The operator, 2026-11-08, prod match m-e494cfef600d: *"looks like the 'combat attack arrow when only
 * one target is there' didn't land. i'm still having to drag arrows even with only one target"*. A
 * click on an attacker or a blocker aims (`gestures/install.ts`'s `aim`) only when it has a choice
 * (`match.ts`'s `combatAimer`): against the opponent alone the click is the card's own, and Forge's
 * `InputAttack` declares it; facing one attacker, a blocker's click blocks it. The declared attack still
 * draws its arrow to bob, on both screens, for as long as it stands.
 *
 * Scenario `one-defender-click`: alice's Grizzly Bears against bob alone; bob's Wall of Stone. Forge's
 * own state is read off `data-attacking`/`data-blocking`, drawn from Forge's CardView, and once alice
 * confirms, off bob's screen too — the other seat, which only Forge could have told. Scenario
 * `click-aim` (Jace out) proves the aim still happens where there is a choice, and that the swallow this
 * spec asserts absent is logged when it happens.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and the
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Page } from '@playwright/test';

import { enabledOk, makeTitled, pressOffered, says, serverLog } from './play/board.ts';
import { passToDeclareAttackers } from './play/combat.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The id of the creature named `name` on `whose` battlefield, as `page` draws it. */
async function idOf(page: Page, whose: 'mine' | 'theirs', name: string): Promise<number> {
  const seat = whose === 'mine' ? '.seat[data-viewer]' : '.seat:not([data-viewer])';
  const li = page.locator(`${seat} [data-zone="battlefield"] li.board-card`).filter({ hasText: name }).first();
  await expect(li, `${name} is drawn`).toBeVisible({ timeout: 30_000 });
  return Number(await li.getAttribute('data-board-card'));
}

const flag = (page: Page, id: number, name: string): Promise<string | null> => page.locator(`[data-board-card="${id}"]`).first().getAttribute(name);

/** The presses the gestures layer swallowed for an aim, as the client reported them to the match log. */
const aimSwallows = (stack: PlayStack): Record<string, unknown>[] =>
  serverLog(stack).filter((r) => r.evt === 'client' && r.what === 'click-swallowed' && r.by === 'combat-aim');

test(titled('against bob alone one click declares the Bears, and facing one attacker one click on the Wall blocks: no aim, no second press'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'one-defender-click');
    const a = seated.alice.page;
    const b = seated.bob.page;
    const bears = await idOf(a, 'mine', 'Grizzly Bears');
    const wall = await idOf(b, 'mine', 'Wall of Stone');

    await passToDeclareAttackers(a);
    expect(await pressOffered(a.locator(`[data-board-card="${bears}"]`)), 'the Bears pressed, once').toBe(true);
    await expect(a.locator('[data-gesture-canvas][data-aiming]'), 'alice’s board never aims').toHaveCount(0);
    await expect.poll(() => flag(a, bears, 'data-attacking'), { timeout: 10_000, message: 'Forge declared the Bears' }).toBe('true');
    expect(aimSwallows(stack), 'no press was swallowed for an aim').toEqual([]);
    // The one click still draws the Bears' arrow to bob (the operator, 2026-11-09: "i wanted creatures to
    // auto-target the player, not for the combat arrow to be gone"), and it stays while they attack.
    const arrow = (page: Page) => page.locator(`[data-testid="stack-target-arrow"][data-key="combat:${bears}"][data-role="attack"]`);
    await expect(arrow(a), 'the Bears draw their attack arrow on alice’s screen').toHaveCount(1, { timeout: 10_000 });
    await enabledOk(a).first().click();
    await expect.poll(() => flag(b, bears, 'data-attacking'), { timeout: 30_000, message: 'confirmed, bob sees the Bears attacking' }).toBe('true');

    await expect.poll(() => says(b), { timeout: 30_000, message: 'bob’s block window opens' }).toMatch(/select creatures to block/i);
    for (const [name, page] of [['alice', a], ['bob', b]] as const) {
      await expect(arrow(page), `${name}: the arrow to bob stays while the Bears attack`).toHaveCount(1, { timeout: 10_000 });
    }
    expect(await pressOffered(b.locator(`[data-board-card="${wall}"]`)), 'the Wall pressed, once').toBe(true);
    await expect(b.locator('[data-gesture-canvas][data-aiming]'), 'bob’s board never aims').toHaveCount(0);
    await expect.poll(() => flag(b, wall, 'data-blocking'), { timeout: 10_000, message: 'Forge assigned the block' }).toBe('true');
    expect(aimSwallows(stack), 'no press was swallowed for an aim').toEqual([]);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

test(titled('with Jace out a click on an attacker still aims: nothing declared, and the swallow is logged'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'click-aim');
    const a = seated.alice.page;
    const b = seated.bob.page;
    const memnite = await idOf(a, 'mine', 'Memnite');
    const jace = await idOf(a, 'theirs', 'Jace Beleren');

    await passToDeclareAttackers(a);
    await expect(a.locator(`[data-board-card="${jace}"]`), 'Jace is offered as a defender').toHaveAttribute('data-selectable', 'true', { timeout: 10_000 });
    expect(await pressOffered(a.locator(`[data-board-card="${memnite}"]`)), 'Memnite pressed').toBe(true);
    await expect(a.locator('[data-gesture-canvas][data-aiming]'), 'the board aims').toHaveCount(1);
    await expect.poll(() => aimSwallows(stack).length, { timeout: 10_000, message: 'the swallowed click is logged' }).toBeGreaterThan(0);
    await a.waitForTimeout(750);
    expect(await flag(b, memnite, 'data-attacking'), 'nothing declared').not.toBe('true');
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

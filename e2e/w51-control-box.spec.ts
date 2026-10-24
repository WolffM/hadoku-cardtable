/**
 * Wave 51 — the control box is fixed furniture, and every other answer to
 * Forge's bar is a decision pop-up. The operator, 2026-10-06:
 *
 *  - *"i don't like the 'Ok' button as a confirm for when spells are on the
 *    stack. any game action that requires the players to do something should
 *    land in the decision box not in the control box. can we change the control
 *    box word to 'Next Phase' so that button is specifically only for that. and
 *    any 'Ok' situations are popups decisions instead?"*
 *  - *"also can we keep the same 4 buttons in the control box at all times?
 *    just grey out the 'Next Phase' and 'End Turn' buttons when they are not
 *    relevant."*
 *  - *"why is the stack carousel so much higher than the decision box? thats
 *    silly it should be right above the decision box."*
 *
 * Wave 75 — the operator, 2026-10-24: *"the 'next phase' button must go and
 * instead we should use the decision modal for passing priority always."*
 * `Next Phase` left the control box entirely: the empty-stack priority pass
 * is now the decision pop-up too, asked as `Proceed to <next step>?` with one
 * `Next Phase` button; the same pass over a stack is `Resolve <name>?` with a
 * `Resolve` button (never a bare `OK`). The control box keeps three fixed
 * buttons — `End Turn`, `Full control`, `Concede` — greyed when they do not
 * apply, never four.
 *
 * Every rule is proven against real Forge, on two committed scenarios:
 * `bolt-player.state` (seat 0's Main 1, Lightning Bolt and a Mountain) and
 * `attackers-declared.state` (seat 0's Main 1, an untapped Memnite, bob with
 * nothing). The three buttons are checked in every state the spec passes
 * through.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one each test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { castUntilOnStack, clickHandCard, clickOnce, enabledOk, makeTitled, nextPhaseLive, pressOffered, resizeWindow, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Screenshots, gitignored (`*.png`) and described in the README beside them. */
const SHOTS = resolve(import.meta.dirname, '..', 'docs', 'planning', 'wave51-evidence', 'B');

/**
 * The first slot reads `End Turn` on the viewer's OWN turn and `Auto Yield`
 * on the other seat's. Every scenario here is alice's own turn throughout,
 * so her page keeps the default and bob's page passes `'Auto Yield'`.
 */
const three = (endTurnLabel = 'End Turn'): string[] => [`live-button-end-turn=${endTurnLabel}`, 'live-full-control=Full control', 'live-concede=Concede'];

/** The control box is its three buttons, in order, in their own words — never one of Forge's, never a fourth. */
async function expectThree(page: Page, where: string, endTurnLabel = 'End Turn'): Promise<void> {
  const buttons = await page
    .getByTestId('live-buttons')
    .locator('button')
    .evaluateAll((els) => els.map((b) => `${(b as HTMLElement).dataset.testid}=${b.textContent}`));
  expect(buttons, `${where}: the three buttons`).toEqual(three(endTurnLabel));
}

const endTurn = (page: Page): Locator => page.getByTestId('live-button-end-turn');
const decision = (page: Page): Locator => page.getByTestId('live-decision');
const decisionOk = (page: Page): Locator => page.getByTestId('live-decision-ok');
const bobLife = (page: Page): Locator => page.locator('.seat:not([data-viewer]) [data-testid="life"]');
const opponentFace = (page: Page): Locator => page.locator('[data-player-face]:not([data-viewer])');

/** The hand card of this name that Forge offers, by id. */
async function offeredNamed(page: Page, name: string): Promise<number> {
  let id: number | undefined;
  await expect
    .poll(
      async () => {
        const cards = await page
          .locator('[data-zone="hand"][data-owner="you"] [data-board-card][data-selectable]')
          .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), name: e.querySelector('.card__name')?.textContent?.trim() ?? '' })));
        id = cards.find((c) => c.name === name)?.id;
        return id;
      },
      { timeout: 30_000, message: `${name} is offered` },
    )
    .not.toBeUndefined();
  return id!;
}

test.describe.configure({ mode: 'serial' });

test(titled('the empty-stack pass is the pop-up’s Next Phase; a target’s Cancel and a stacked spell’s Resolve are pop-ups too; End Turn greys, never vanishes; the box keeps three buttons'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'bolt-player');
    const page = alice.page;
    await resizeWindow(page, { width: 1280, height: 800 });
    mkdirSync(SHOTS, { recursive: true });

    // Full control: alice holds priority with the bolt on the stack (nothing
    // else would stop it resolving the instant both seats auto-pass).
    await page.getByTestId('live-full-control').click();
    await expect(page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');

    /* ── the empty-stack priority pass: the pop-up's Next Phase ────────── */
    const bolt = await offeredNamed(page, 'Lightning Bolt');
    await expect(nextPhaseLive(page), 'Main 1, nothing on the stack: the pop-up asks to proceed').toHaveCount(1);
    await expect(decisionOk(page), 'and names the next step').toHaveText('Next Phase');
    await expect(decision(page)).toContainText('Proceed to Combat?');
    await expect(endTurn(page), 'End Turn is live too').toBeEnabled();
    await expectThree(page, 'empty-stack priority');
    await expectThree(bob.page, 'bob, waiting', 'Auto Yield');
    await expect(decision(bob.page), 'bob holds nothing: no pop-up of his own').toHaveCount(0);
    // It is alice's turn, so bob's slot is Auto Yield, a standing
    // preference rather than an answer to Forge's bar — pressable, not greyed.
    await expect(endTurn(bob.page), 'bob: Auto Yield, pressable on alice’s turn').toBeEnabled();

    /* ── a target's Cancel is the pop-up's, and it backs out ──────────── */
    await clickHandCard(page, bolt);
    await expect(page.getByTestId('live-decision-cancel'), 'choosing a target: Forge’s Cancel, in the pop-up').toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('live-decision-cancel')).toHaveText('Cancel');
    await expect(nextPhaseLive(page), 'choosing a target: the pass pop-up is gone, this one is a target pick').toHaveCount(0);
    await expect(endTurn(page), 'End Turn is greyed, not absent, while Forge has no End Turn').toBeDisabled();
    await expectThree(page, 'choosing a target');
    await page.screenshot({ path: resolve(SHOTS, 'target-cancel.png') });
    await page.getByTestId('live-decision-cancel').click();
    await expect(nextPhaseLive(page), 'backed out: the plain pass pop-up is back').toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator(`[data-zone="hand"][data-owner="you"] [data-board-card="${bolt}"]`), 'the bolt is back in hand').toHaveCount(1, { timeout: 15_000 });
    expect(await stackCount(page), 'nothing went on the stack').toBe(0);
    await expectThree(page, 'after backing out');

    /* ── the bolt on the stack: Forge's OK is the pop-up's Resolve ─────── */
    await castUntilOnStack(page, stack, await offeredNamed(page, 'Lightning Bolt'), [opponentFace(page)]);
    expect(await stackCount(page), 'exactly the one bolt').toBe(1);
    await expect(decisionOk(page), 'a spell on the stack: the pop-up’s own button').toBeVisible({ timeout: 15_000 });
    await expect(decisionOk(page), 'it names what passing does — Resolve, never a bare OK').toHaveText('Resolve');
    await expect(decision(page)).toContainText('Resolve Lightning Bolt?');
    await expect(page.getByTestId('live-decision-cancel'), 'End Turn is the box’s, never drawn twice').toHaveCount(0);
    await expect(nextPhaseLive(page), 'this is the resolve route, not the plain pass').toHaveCount(0);
    await expect(endTurn(page), 'End Turn stays pressable: Forge offers it').toBeEnabled();
    await expect(page.getByTestId('live-buttons'), 'the box never says Forge’s own word').not.toContainText(/OK|Resolve/);
    await expectThree(page, 'a spell on the stack');

    /*
     * §A.6 is superseded by wave 59 §S: the operator's own "right above the
     * decision box" rule was about the deleted thumbnail row's FIXED column;
     * AD4's placed-cards layer puts the bolt where it was actually released
     * (`clickHandCard`'s default — the viewer's own battlefield centre),
     * never in that column, at either size. What survives is the item this
     * sub-test shared with the row's own existence: the bolt stays drawn,
     * and flashes as the one thing next to resolve, whatever the viewport.
     */
    for (const size of [
      { width: 1280, height: 800 },
      { width: 1366, height: 768 },
    ]) {
      await resizeWindow(page, size);
      const placed = page.locator('[data-placed-spell]');
      await expect(placed, 'the bolt is still drawn, at this size too').toHaveCount(1, { timeout: 10_000 });
      await expect(placed, 'the one thing on the stack flashes as next to resolve').toHaveAttribute('data-placed-next', '');
      await page.screenshot({ path: resolve(SHOTS, `stack-placed-${size.width}x${size.height}.png`) });
    }
    await resizeWindow(page, { width: 1280, height: 800 });

    await decisionOk(page).click();
    // Bob holds nothing, so the server passes for him; his pop-up's OK is pressed only if it ever shows.
    const resolvedBy = Date.now() + 30_000;
    while ((await stackCount(page)) > 0 && Date.now() < resolvedBy) {
      if ((await decisionOk(bob.page).count()) > 0) await clickOnce(bob.page, await says(bob.page), 'ok');
      await page.waitForTimeout(100);
    }
    expect(await stackCount(page), 'the pop-up’s Resolve let the bolt resolve').toBe(0);
    await expect(bobLife(page), 'and it hit bob').toHaveText('17', { timeout: 15_000 });
    await expect(nextPhaseLive(page), 'resolved: back to the plain pass pop-up, not gone').toHaveCount(1, { timeout: 15_000 });
    await expectThree(page, 'after the bolt resolved');
    await expectThree(bob.page, 'bob, after the bolt resolved', 'Auto Yield');
  } finally {
    await stack.stop();
  }
});

test(titled('attackers declared → the pop-up’s OK confirms them; the box keeps its three buttons through combat'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'attackers-declared');
    const page = alice.page;
    await resizeWindow(page, { width: 1280, height: 800 });
    const memnite = Number(await page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card').first().getAttribute('data-board-card'));
    expect(Number.isInteger(memnite), 'Memnite is on alice’s battlefield').toBe(true);

    // Main 1, nothing on the stack: the pop-up's Next Phase moves the game into combat.
    await expect(nextPhaseLive(page), 'Main 1: the pop-up asks to proceed').toHaveCount(1, { timeout: 15_000 });
    await expect(decision(page)).toContainText('Proceed to Combat?');
    await expectThree(page, 'Main 1');
    await nextPhaseLive(page).click();
    await expect.poll(() => says(page), { timeout: 20_000, message: 'Forge’s own declare-attackers window opened' }).toMatch(/^Select creatures to attack/i);

    await expect(decisionOk(page), 'declaring: Forge’s OK is the pop-up’s').toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('live-decision-cancel'), 'the attack step’s second button stays refused').toHaveCount(0);
    await expect(nextPhaseLive(page), 'declaring: this is not the plain pass').toHaveCount(0);
    await expect(endTurn(page), 'declaring: End Turn greyed, not absent').toBeDisabled();
    await expectThree(page, 'declaring attackers');

    await expect(page.locator(`[data-board-card="${memnite}"]`), 'Memnite is offered to attack').toHaveAttribute('data-selectable', 'true', { timeout: 10_000 });
    expect(await pressOffered(page.locator(`[data-board-card="${memnite}"]`)), 'Memnite pressed').toBe(true);
    await expect(page.locator(`[data-board-card="${memnite}"]`), 'Memnite is declared').toHaveAttribute('data-attacking', 'true', { timeout: 10_000 });
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: resolve(SHOTS, 'attackers-declared.png') });

    await decisionOk(page).click();
    await expect.poll(() => page.getByTestId('live-phases').getAttribute('data-phase'), { timeout: 15_000, message: 'the pop-up’s OK confirmed the attack' }).not.toBe('COMBAT_DECLARE_ATTACKERS');

    // Let combat run out: whichever of Forge's button one either seat is shown, until the damage lands.
    const by = Date.now() + 45_000;
    while ((await bobLife(page).textContent()) !== '19' && Date.now() < by) {
      // This whole scenario is alice's own turn — her slot is End Turn,
      // bob's is Auto Yield, throughout.
      for (const [p, endTurnLabel] of [
        [page, 'End Turn'],
        [bob.page, 'Auto Yield'],
      ] as const) {
        await expectThree(p, 'through combat', endTurnLabel);
        if ((await enabledOk(p).count()) > 0) await clickOnce(p, await says(p), 'ok');
      }
      await page.waitForTimeout(100);
    }
    await expect(bobLife(page), 'the confirmed attack dealt its damage').toHaveText('19');
  } finally {
    await stack.stop();
  }
});

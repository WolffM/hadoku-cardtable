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
 * Every rule is proven against real Forge, on two committed scenarios:
 * `bolt-player.state` (seat 0's Main 1, Lightning Bolt and a Mountain) and
 * `attackers-declared.state` (seat 0's Main 1, an untapped Memnite, bob with
 * nothing). The four buttons are checked in every state the spec passes
 * through.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one each test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { clickHandCard, clickOnce, enabledOk, makeTitled, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** Screenshots, gitignored (`*.png`) and described in the README beside them. */
const SHOTS = resolve(import.meta.dirname, '..', 'docs', 'planning', 'wave51-evidence', 'B');

const FOUR = [
  'live-button-next-phase=Next Phase',
  'live-button-end-turn=End Turn',
  'live-full-control=Full control',
  'live-concede=Concede',
];

/** The control box is its four buttons, in order, in their own words — never one of Forge's. */
async function expectFour(page: Page, where: string): Promise<void> {
  const buttons = await page
    .getByTestId('live-buttons')
    .locator('button')
    .evaluateAll((els) => els.map((b) => `${(b as HTMLElement).dataset.testid}=${b.textContent}`));
  expect(buttons, `${where}: the four buttons`).toEqual(FOUR);
}

const nextPhase = (page: Page): Locator => page.getByTestId('live-button-next-phase');
const endTurn = (page: Page): Locator => page.getByTestId('live-button-end-turn');
const decision = (page: Page): Locator => page.getByTestId('live-decision');
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

/** How far the stack's thumbnail row sits above the decision pop-up's top edge, and whether a thumbnail is drawn. */
async function stackOverDecision(page: Page): Promise<{ gap: number; thumbs: number; size: string }> {
  return page.evaluate(() => {
    const row = document.querySelector('[data-zone="stack"] > ol.stack__items')!.getBoundingClientRect();
    const sheet = document.querySelector('[data-testid="live-decision"]')!.getBoundingClientRect();
    return {
      gap: Math.round(sheet.top - row.bottom),
      thumbs: document.querySelectorAll('[data-zone="stack"] li.stack__item').length,
      size: `${innerWidth}x${innerHeight}`,
    };
  });
}

test.describe.configure({ mode: 'serial' });

test(titled('Next Phase only at the empty-stack pass; a target’s Cancel and a stacked spell’s OK are pop-ups; End Turn greys, never vanishes; the stack sits on the pop-up'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'bolt-player');
    const page = alice.page;
    await page.setViewportSize({ width: 1280, height: 800 });
    mkdirSync(SHOTS, { recursive: true });

    // Full control: alice holds priority with the bolt on the stack (nothing
    // else would stop it resolving the instant both seats auto-pass).
    await page.getByTestId('live-full-control').click();
    await expect(page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');

    /* ── the empty-stack priority pass: the box's, and no pop-up ───────── */
    const bolt = await offeredNamed(page, 'Lightning Bolt');
    await expect(nextPhase(page), 'Main 1, nothing on the stack: Next Phase is the answer').toBeEnabled();
    await expect(endTurn(page), 'and End Turn').toBeEnabled();
    await expect(decision(page), 'no pop-up for the empty-stack pass').toHaveCount(0);
    await expectFour(page, 'empty-stack priority');
    await expectFour(bob.page, 'bob, waiting');
    await expect(nextPhase(bob.page), 'bob holds nothing: greyed').toBeDisabled();
    await expect(endTurn(bob.page), 'bob: End Turn greyed, not absent').toBeDisabled();

    /* ── a target's Cancel is the pop-up's, and it backs out ──────────── */
    await clickHandCard(page, bolt);
    // Full control asks which of the card's abilities to play first (`getAbilityToPlay`), an ask answered as one.
    await expect(page.getByTestId('live-prompt'), 'full control: which ability').toHaveAttribute('data-method', 'getAbilityToPlay', { timeout: 15_000 });
    await page.getByTestId('live-prompt').getByTestId('prompt-choice').first().click();
    await expect(page.getByTestId('live-decision-cancel'), 'choosing a target: Forge’s Cancel, in the pop-up').toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('live-decision-cancel')).toHaveText('Cancel');
    await expect(nextPhase(page), 'choosing a target: Next Phase greyed').toBeDisabled();
    await expect(endTurn(page), 'End Turn is greyed, not absent, while Forge has no End Turn').toBeDisabled();
    await expectFour(page, 'choosing a target');
    await page.screenshot({ path: resolve(SHOTS, 'target-cancel.png') });
    await page.getByTestId('live-decision-cancel').click();
    await expect(decision(page), 'backed out: the pop-up is gone').toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator(`[data-zone="hand"][data-owner="you"] [data-board-card="${bolt}"]`), 'the bolt is back in hand').toHaveCount(1, { timeout: 15_000 });
    expect(await stackCount(page), 'nothing went on the stack').toBe(0);
    await expect(nextPhase(page), 'back at the empty-stack pass').toBeEnabled({ timeout: 15_000 });
    await expectFour(page, 'after backing out');

    /* ── the bolt on the stack: Forge's OK is the pop-up's ────────────── */
    await clickHandCard(page, await offeredNamed(page, 'Lightning Bolt'));
    const castBy = Date.now() + 30_000;
    while ((await stackCount(page)) === 0 && Date.now() < castBy) {
      await answerPrompt(page);
      if ((await opponentFace(page).getAttribute('data-selectable')) === 'true') await opponentFace(page).click();
      else if ((await page.getByTestId('live-payment-ok').count()) > 0) await clickOnce(page, await says(page), 'ok');
      await page.waitForTimeout(40);
    }
    expect(await stackCount(page), 'the bolt is on the stack').toBe(1);
    await expect(page.getByTestId('live-decision-ok'), 'a spell on the stack: Forge’s OK is in the pop-up').toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('live-decision-ok')).toHaveText('OK');
    await expect(page.getByTestId('live-decision-cancel'), 'End Turn is the box’s, never drawn twice').toHaveCount(0);
    await expect(nextPhase(page), 'Next Phase is greyed with a spell on the stack').toBeDisabled();
    await expect(endTurn(page), 'End Turn stays pressable: Forge offers it').toBeEnabled();
    await expect(page.getByTestId('live-buttons'), 'the box never says OK').not.toContainText('OK');
    await expectFour(page, 'a spell on the stack');

    /* ── §A.6: the stack sits right above the pop-up, at both sizes ────── */
    for (const size of [
      { width: 1280, height: 800 },
      { width: 1366, height: 768 },
    ]) {
      await page.setViewportSize(size);
      // A targeted cast is parked, not played, so the stack draws it: alone, as the card itself (the stack redesign).
      await expect(page.locator('[data-zone="stack"] li.stack__item'), 'the bolt is drawn on the stack').toHaveCount(1, { timeout: 10_000 });
      await expect
        .poll(async () => (await stackOverDecision(page)).gap, { timeout: 5_000, message: `${size.width}x${size.height}: the thumbnails sit a gap above the pop-up` })
        .toBeGreaterThanOrEqual(3);
      const at = await stackOverDecision(page);
      console.log(`[w51 §A.6] ${at.size}: thumbnail row bottom → pop-up top = ${at.gap}px, ${at.thumbs} thumbnail(s)`);
      expect(at.gap, `${at.size}: right above the decision box, not at the top of the column`).toBeLessThanOrEqual(12);
      await page.screenshot({ path: resolve(SHOTS, `stack-over-decision-${size.width}x${size.height}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.getByTestId('live-decision-ok').click();
    // Bob holds nothing, so the server passes for him; his pop-up's OK is pressed only if it ever shows.
    const resolvedBy = Date.now() + 30_000;
    while ((await stackCount(page)) > 0 && Date.now() < resolvedBy) {
      if ((await bob.page.getByTestId('live-decision-ok').count()) > 0) await clickOnce(bob.page, await says(bob.page), 'ok');
      await page.waitForTimeout(100);
    }
    expect(await stackCount(page), 'the pop-up’s OK let the bolt resolve').toBe(0);
    await expect(bobLife(page), 'and it hit bob').toHaveText('17', { timeout: 15_000 });
    await expect(decision(page), 'resolved: the pop-up is gone').toHaveCount(0);
    await expectFour(page, 'after the bolt resolved');
    await expectFour(bob.page, 'bob, after the bolt resolved');
  } finally {
    await stack.stop();
  }
});

test(titled('attackers declared → the pop-up’s OK confirms them; the box keeps its four buttons through combat'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'attackers-declared');
    const page = alice.page;
    await page.setViewportSize({ width: 1280, height: 800 });
    const memnite = Number(await page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card').first().getAttribute('data-board-card'));
    expect(Number.isInteger(memnite), 'Memnite is on alice’s battlefield').toBe(true);

    // Main 1, nothing on the stack: Next Phase moves the game into combat.
    await expect(nextPhase(page), 'Main 1: Next Phase').toBeEnabled({ timeout: 15_000 });
    await expectFour(page, 'Main 1');
    await nextPhase(page).click();
    await expect.poll(() => says(page), { timeout: 20_000, message: 'Forge’s own declare-attackers window opened' }).toMatch(/^Select creatures to attack/i);

    await expect(page.getByTestId('live-decision-ok'), 'declaring: Forge’s OK is the pop-up’s').toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('live-decision-cancel'), 'the attack step’s second button stays refused').toHaveCount(0);
    await expect(nextPhase(page), 'declaring: Next Phase greyed').toBeDisabled();
    await expect(endTurn(page), 'declaring: End Turn greyed, not absent').toBeDisabled();
    await expectFour(page, 'declaring attackers');

    await expect(page.locator(`[data-board-card="${memnite}"]`), 'Memnite is offered to attack').toHaveAttribute('data-selectable', 'true', { timeout: 10_000 });
    await page.locator(`[data-board-card="${memnite}"] button`).first().click();
    await expect(page.locator(`[data-board-card="${memnite}"]`), 'Memnite is declared').toHaveAttribute('data-attacking', 'true', { timeout: 10_000 });
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: resolve(SHOTS, 'attackers-declared.png') });

    await page.getByTestId('live-decision-ok').click();
    await expect.poll(() => page.getByTestId('live-phases').getAttribute('data-phase'), { timeout: 15_000, message: 'the pop-up’s OK confirmed the attack' }).not.toBe('COMBAT_DECLARE_ATTACKERS');

    // Let combat run out: whichever of Forge's button one either seat is shown, until the damage lands.
    const by = Date.now() + 45_000;
    while ((await bobLife(page).textContent()) !== '19' && Date.now() < by) {
      for (const p of [page, bob.page]) {
        await expectFour(p, 'through combat');
        if ((await enabledOk(p).count()) > 0) await clickOnce(p, await says(p), 'ok');
      }
      await page.waitForTimeout(100);
    }
    await expect(bobLife(page), 'the confirmed attack dealt its damage').toHaveText('19');
  } finally {
    await stack.stop();
  }
});

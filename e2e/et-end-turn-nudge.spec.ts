/**
 * The operator, 2026-10-14: *"can we have the 'end turn' do a bigger visual
 * pulse after ~10s of being 'active' (active meaning we decided the player
 * has nothing left to do)"*.
 *
 * Against real Forge: `nothing-left.state` is alice's own postcombat main
 * with nothing to decide, so End Turn carries its highlight (`data-highlight`,
 * w35 R5). Held unchanged for `END_TURN_NUDGE_MS` it escalates (`data-nudge`)
 * without moving the control box, a reduced-motion browser gets a still
 * emphasis instead, bob's screen never shows it, and pressing End Turn
 * clears it.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one every test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist`.
 */

import { expect, test, type Locator } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The layout box (untransformed) of an element, so a scale never reads as a size change. */
const layoutBox = (el: Locator) =>
  el.evaluate((node) => {
    const h = node as HTMLElement;
    return { left: h.offsetLeft, top: h.offsetTop, width: h.offsetWidth, height: h.offsetHeight };
  });
const css = (el: Locator, property: string) => el.evaluate((node, p) => getComputedStyle(node).getPropertyValue(p), property);

test(titled('End Turn held highlighted with nothing left to do escalates to a bigger pulse, and pressing it clears it'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'nothing-left');
    const endTurn = alice.page.getByTestId('live-button-end-turn');
    const buttons = alice.page.getByTestId('live-buttons');
    await expect(endTurn, 'End Turn is pressable').toBeEnabled({ timeout: 30_000 });
    await expect(endTurn, 'and highlighted: nothing left to decide').toHaveAttribute('data-highlight', '', { timeout: 30_000 });
    const highlightedAt = Date.now();
    expect(await endTurn.getAttribute('data-nudge'), 'no nudge the moment the highlight lands').toBeNull();
    const barBefore = await layoutBox(buttons);
    const buttonBefore = await layoutBox(endTurn);

    await expect(endTurn, 'the held highlight escalates').toHaveAttribute('data-nudge', '', { timeout: 30_000 });
    console.log(`[et] nudge after ${Date.now() - highlightedAt} ms of observed highlight`);
    expect(await css(endTurn, 'animation-name'), 'the bigger pulse runs').toBe('live-end-turn-nudge');
    expect(await layoutBox(buttons), 'the control box keeps its place and size').toEqual(barBefore);
    expect(await layoutBox(endTurn), 'and so does the button’s own layout box').toEqual(buttonBefore);
    await expect(bob.page.getByTestId('live-button-end-turn'), 'never on the other seat’s screen').not.toHaveAttribute('data-nudge', '');

    await alice.page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await css(endTurn, 'animation-name'), 'reduced motion: nothing moves').toBe('none');
    expect(await css(endTurn, 'filter'), 'reduced motion: a still glow instead').not.toBe('none');
    await alice.page.emulateMedia({ reducedMotion: 'no-preference' });

    await endTurn.click();
    await expect(endTurn, 'pressing End Turn clears the nudge').not.toHaveAttribute('data-nudge', '', { timeout: 15_000 });
    await expect(endTurn, 'and the highlight').not.toHaveAttribute('data-highlight', '');
    console.log(`[et] after press: label=${await endTurn.textContent()} nudge=${await endTurn.getAttribute('data-nudge')}`);
  } finally {
    await stack.stop();
  }
});

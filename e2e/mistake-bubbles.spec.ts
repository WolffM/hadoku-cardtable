/**
 * The mistake bubble's other three lines (`af409-mistake-bubble.spec.ts` covers "land"), each on
 * the screen of the seat that made the mistake and never the other's, and each gone by itself.
 *
 * A refused press that Forge never sees changes nothing else on the board, so the bubble shows
 * only if the press itself redraws it (`setMistake` in `apps/ui/src/play/live/match.ts`). The
 * `mistake-bubbles` board is built so that nothing else moves: the bubble has to show within a
 * second of the press, well inside its own 3.2 s on screen.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one this SKIPS and
 * the title says why. Serves the prebuilt `apps/ui/dist`.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickHandCard, dragHandCard, handCardNamed, makeTitled, offeredCard, ownNamed, pressOffered, resizeWindow, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const MISTAKE_BUBBLE = '[data-testid="mistake-bubble"]';

/** `page`'s bubble says `line`, as `key`, within a second of the press, while `other`'s says nothing; then it leaves by itself. */
async function saysThenLeaves(page: Page, other: Page, key: string, line: string): Promise<void> {
  const bubble = page.locator(MISTAKE_BUBBLE);
  await expect(bubble, `the "${key}" line shows at once`).toHaveText(line, { timeout: 1_000 });
  expect(await bubble.getAttribute('data-mistake')).toBe(key);
  await expect(other.locator(MISTAKE_BUBBLE), 'never on the other seat’s screen').toHaveCount(0);
  await expect(bubble, 'and leaves by itself').toHaveCount(0, { timeout: 5_000 });
}

test(titled('a press without priority and a summoning-sick creature each say their line, on their own screen, and leave'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'mistake-bubbles');

    // Bob presses his Forest on alice's turn: he has no priority.
    const forest = await handCardNamed(bob.page, 'Forest');
    expect(forest, 'bob holds a Forest').toBeDefined();
    await clickHandCard(bob.page, forest!);
    await saysThenLeaves(bob.page, alice.page, 'priority', 'I have to wait for priority.');

    // Alice presses her Runeclaw Bear, which came in this turn.
    const [bear] = await ownNamed(alice.page, 'Runeclaw Bear');
    expect(bear, 'alice has a Runeclaw Bear').toBeDefined();
    await alice.page.locator(`.seat[data-viewer] [data-board-card="${bear}"]`).click();
    await saysThenLeaves(alice.page, bob.page, 'sick', 'Give that creature a turn to get ready.');
  } finally {
    await stack.stop();
  }
});

test(titled('a cost nothing can pay, cancelled for the seat, says the mana line'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    // Alice has exactly {1}{B} for Doom Blade and nothing for the Armadillo's Ward {1}, which the
    // server cancels for her (`maybeCancelUnpayable`) — `ward-defined-counter.spec.ts`'s cast.
    const { alice, bob } = await startScenarioMatch(browser, stack, 'ward-defined-counter');
    await resizeWindow(alice.page, { width: 1600, height: 1000 });

    const blade = await offeredCard(alice.page, 'Doom Blade', { zone: 'hand', timeout: 45_000, message: 'alice is offered Doom Blade' });
    const armadillo = alice.page.locator('[data-zone="battlefield"][data-owner="them"] [data-board-card]');
    const battlefield = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    expect(await dragHandCard(alice.page, blade, { x: battlefield.x + battlefield.width / 2, y: battlefield.y + battlefield.height / 2 }), 'the press armed the cast').toBe(true);
    await expect.poll(() => says(alice.page), { timeout: 10_000, message: 'the cast opened a targeting ask' }).toMatch(/Doom Blade.*target/is);
    await expect(armadillo).toHaveAttribute('data-selectable', /.*/, { timeout: 10_000 });
    expect(await pressOffered(armadillo.first()), 'Armored Armadillo pressed as the target').toBe(true);

    const bubble = alice.page.locator(MISTAKE_BUBBLE);
    await expect(bubble, 'the mana line, on alice’s screen').toHaveText("I don't have enough mana for that.", { timeout: 10_000 });
    expect(await bubble.getAttribute('data-mistake')).toBe('mana');
    await expect(bob.page.locator(MISTAKE_BUBBLE), 'never on bob’s screen').toHaveCount(0);
  } finally {
    await stack.stop();
  }
});

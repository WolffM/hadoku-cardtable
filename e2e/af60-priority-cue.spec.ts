/**
 * The operator, 2026-10-14: *"we need to play a sound effect when players get priority beyond the
 * first time. makes it easier to know when you have priority."*
 *
 * `ui.priority` sounds as a window of the seat's own opens — never for one the server passed for
 * it, never for the first window of its own turn. Read off the match log's client sound rows,
 * which say what the table raised (`why: 'priority'`).
 *
 * Two real browsers, `af66-swords`: bob attacks with a Hill Giant, alice holds Swords to
 * Plowshares and a Plains and passes every window she is given; bob's turn ends, alice's begins.
 *
 * Needs a Forge build; without one the test SKIPS and its title says why.
 */
import { expect, test, type Page } from '@playwright/test';

import { clickOnce, enabledOk, makeTitled, says, serverLog } from './play/board.ts';
import { railAt, type RailAt } from './play/combat.ts';
import { forgeAvailability, startPlayStack, type PlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const ATTACK = /^Select creatures to attack/i;

const at = async (page: Page): Promise<RailAt> => (await railAt(page)) ?? { phase: '', whose: '', turn: 0, live: false };

const cues = (stack: PlayStack, seat: number): Record<string, unknown>[] =>
  serverLog(stack).filter((r) => r.evt === 'client' && r.kind === 'sound' && r.why === 'priority' && r.seat === seat);
const kept = (stack: PlayStack, seat: number): Record<string, unknown>[] =>
  serverLog(stack).filter((r) => r.evt === 'prompt-forwarded' && r.kind === 'priority' && r.seat === seat);

test(titled('priority handed back sounds for each window the seat is given, never for the first of its own turn'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'af66-swords');
    const giant = bob.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card').first();
    let declared = false;
    const aliceWindows: string[] = [];
    const deadline = Date.now() + 90_000;
    // Bob plays his turn out (Main 1, the attack, Main 2); alice passes every window she is given.
    while (Date.now() < deadline) {
      const a = await at(alice.page);
      if (a.whose === 'yours' && a.live) break;
      if (a.live && a.whose === 'theirs' && (await enabledOk(alice.page).count()) > 0) {
        aliceWindows.push(a.phase);
        await clickOnce(alice.page, await says(alice.page), 'ok');
      }
      const line = await says(bob.page);
      if (!declared && ATTACK.test(line) && (await giant.getAttribute('data-selectable')) === 'true') {
        const g = (await giant.boundingBox())!;
        await bob.page.mouse.click(g.x + g.width / 2, g.y + g.height / 2);
        await expect(giant, 'Forge declared the Giant attacking').toHaveAttribute('data-attacking', 'true', { timeout: 10_000 });
        declared = true;
        await clickOnce(bob.page, await says(bob.page), 'ok');
      } else if (/^Priority:/.test(line) && (await enabledOk(bob.page).count()) > 0) {
        await clickOnce(bob.page, line, 'ok');
      }
      await alice.page.waitForTimeout(40);
    }
    // Alice's own Main 1 is open: the first window of her own turn.
    await expect.poll(async () => { const a = await at(alice.page); return a.whose === 'yours' && a.live; }, { timeout: 30_000, message: "alice's own turn opens" }).toBe(true);
    await alice.page.waitForTimeout(1_500);
    const aliceCues = cues(stack, 0);
    const bobCues = cues(stack, 1);
    console.log(
      `[af60] alice windows on bob's turn [${aliceWindows.join(', ')}]; alice kept ${kept(stack, 0).length}; alice cues ${JSON.stringify(aliceCues.map((r) => [r.turn, r.held]))}; bob kept ${kept(stack, 1).length}; bob cues ${JSON.stringify(bobCues.map((r) => [r.turn, r.held]))}`,
    );
    expect(declared, 'bob attacked').toBe(true);
    expect(aliceWindows.length, 'alice was given windows on bob’s turn').toBeGreaterThanOrEqual(2);
    expect(aliceCues.filter((r) => r.turn === 1), 'one cue per window alice was given on bob’s turn').toHaveLength(aliceWindows.length);
    expect(aliceCues.filter((r) => r.turn === 2), 'none for the first window of her own turn').toHaveLength(0);
    // Bob's own turn: his first window (Main 1) is silent; each later one he was given sounds.
    const bobTurnWindows = kept(stack, 1).length;
    expect(bobCues, 'bob: every window of his own turn but the first').toHaveLength(Math.max(0, bobTurnWindows - 1));
  } finally {
    await stack.stop();
  }
});

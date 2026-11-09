/**
 * Prod, 2026-11-08 (m-e9160fef5f50): a seat pressed End Turn on its own turn, the opponent cast
 * Hero's Downfall on its Jace in the End step, and the seat never got a window over it — holding
 * two castable Azorius Charms and six untapped mana sources.
 *
 * End Turn is Forge's own yield (`InputPassPriority.onCancel` → `autoPassUntilEndOfTurn`), held in
 * the seat's server-side `YieldController`. An opponent's spell is meant to end it
 * (`YIELD_INTERRUPT_ON_OPPONENT_SPELL`, on by default), and the window over that spell is then the
 * seat's to answer like any other.
 *
 * Two real browsers, `ei-end-turn-interrupt`: alice's own Main 1, Counterspell over two Islands;
 * bob holds Lightning Bolt over a Mountain. Alice presses End Turn and nothing else; bob bolts her
 * in her End step. Alice must hold priority over the Bolt with her Counterspell offered.
 *
 * Needs a Forge build; without one the test SKIPS and its title says why.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { castUntilOnStack, lifeOf, makeTitled, offeredNamed, serverLog, stackCount } from './play/board.ts';
import { railAt } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const opponentFace = (page: Page): Locator => page.locator('[data-player-face]:not([data-viewer])');
const decisionOk = (page: Page): Locator => page.locator('[data-testid="live-decision-ok"]:enabled');

test(titled("after End Turn, the opponent's spell still gives the seat a window to answer it"), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'ei-end-turn-interrupt');
    const a = alice.page;
    const endTurn = a.getByTestId('live-button-end-turn');
    await expect(endTurn, "alice's own turn: the slot reads End Turn").toHaveText('End Turn', { timeout: 30_000 });
    await expect(endTurn, 'and is pressable in her Main 1').toBeEnabled({ timeout: 30_000 });
    await endTurn.click();

    // Bob's End step stop holds him over alice's End step (he has a play): he bolts her there.
    let bolt: number | undefined;
    await expect.poll(async () => (bolt = await offeredNamed(bob.page, 'Lightning Bolt')), { timeout: 60_000, message: 'bob is offered Lightning Bolt' }).not.toBeUndefined();
    const bobAt = await railAt(bob.page);
    console.log(`[ei] bob holds priority at ${JSON.stringify(bobAt)}`);
    expect(bobAt?.whose, "bob holds priority on alice's turn").toBe('theirs');
    const logFrom = serverLog(stack).length;
    await castUntilOnStack(bob.page, stack, bolt!, [opponentFace(bob.page)]);

    // Nobody presses for alice: either her bar goes live over the Bolt, or the Bolt resolves past her.
    let held = false;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if ((await stackCount(a)) === 1 && (await decisionOk(a).count()) === 1) {
        held = true;
        break;
      }
      if ((await lifeOf(a, 'me').textContent()) === '17') break;
      await a.waitForTimeout(40);
    }
    const rows = serverLog(stack)
      .slice(logFrom)
      .filter((r) => r.seat === 0 && /auto-passed|prompt-(withheld|forwarded)/.test(String(r.evt)))
      .map((r) => [r.evt, r.kind ?? r.phase, r.why, r.rule].filter((x) => x !== undefined).join(' '));
    console.log(`[ei] held ${held}; alice's rows after the cast [${rows.join(' | ')}]`);
    expect(held, "alice holds priority over bob's Bolt after her End Turn").toBe(true);
    expect(await offeredNamed(a, 'Counterspell'), 'with her Counterspell offered').not.toBeUndefined();
    expect(rows, 'the server forwarded that window as a play').toContain('prompt-forwarded priority kept has-play');

    // Her answer is hers: OK passes, and the Bolt resolves.
    await decisionOk(a).click();
    await expect(lifeOf(a, 'me'), 'the Bolt resolved once alice passed').toHaveText('17', { timeout: 20_000 });
  } finally {
    await stack.stop();
  }
});

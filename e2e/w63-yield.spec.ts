/**
 * The operator: *"when it's the opponents turn the 'End turn' button should
 * turn to 'Auto Yield' meaning that we auto-pass on whatever the opponent
 * plays even if we did have a response even though the game would have
 * given us a chance … Auto Yield should only last for that turn."*
 *
 * Two real browsers, `w63-yield.state`: bob's own Main 1 from the start,
 * Lightning Bolt castable; alice holds Counterspell and two untapped
 * Islands. Alice presses Auto Yield the instant it is bob's turn (no bar
 * from Forge needed at all), bob casts his Bolt at her, her own bar never
 * enables for it, and the Bolt still resolves. Then bob ends his turn and,
 * once it is alice's own turn again, her button reads End Turn — nothing
 * here re-armed or cancelled the override; the turn itself expired it.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without
 * one the test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { castUntilOnStack, makeTitled, resizeWindow, serverLog, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const endTurnSlot = (page: Page): Locator => page.getByTestId('live-button-end-turn');
const opponentFace = (page: Page): Locator => page.locator('[data-player-face]:not([data-viewer])');
const ownLife = (page: Page): Locator => page.locator('.seat[data-viewer] [data-testid="life"]');

/** The hand card of this name that Forge offers, by id — polls, since the actionable set lands after the hand does. */
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

test(
  titled("bob's Bolt never reaches alice's bar while she yields, and resolves anyway; next turn her button is End Turn again"),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);
    const stack = await startPlayStack(forge);
    try {
      const { alice, bob } = await startScenarioMatch(browser, stack, 'w63-yield');
      const page = alice.page;
      await resizeWindow(page, { width: 1280, height: 800 });
      await resizeWindow(bob.page, { width: 1280, height: 800 });

      // Bob's own turn from the scenario, before Forge has sent alice anything
      // at all — the slot is pressable from the instant whose-turn flips.
      await expect(page.getByTestId('live-phases'), "it is bob's turn, from the scenario").toHaveAttribute('data-whose', 'theirs');
      await expect(endTurnSlot(page), 'the slot reads Auto Yield, off, with no bar from Forge yet').toHaveText('Auto Yield');
      await expect(endTurnSlot(page)).toHaveAttribute('data-yield', 'off');
      await expect(endTurnSlot(page), 'pressable: a standing preference, not an answer to Forge').toBeEnabled();

      await endTurnSlot(page).click();
      await expect(endTurnSlot(page), 'Cancel Yield').toHaveText('Cancel Yield');
      await expect(endTurnSlot(page)).toHaveAttribute('data-yield', 'on');

      // Bob casts his Lightning Bolt at alice. Nobody holds priority on it — bob's own spell is
      // passed (`passOwnSpell`) and alice yields.
      const bolt = await offeredNamed(bob.page, 'Lightning Bolt');
      const hit = async (): Promise<boolean> => (await ownLife(page).textContent()) === '17';
      await castUntilOnStack(
        bob.page,
        stack,
        bolt,
        async () => {
          const ready = (await opponentFace(bob.page).getAttribute('data-selectable')) === 'true';
          if (ready) await opponentFace(bob.page).click();
          return ready;
        },
      );

      // The claim: alice's own bar never enables for it, the whole time it
      // resolves — polled, by STATE (enabled), never by watching for text.
      const resolvedBy = Date.now() + 30_000;
      let aliceBarLive = false;
      while (!(await hit()) && Date.now() < resolvedBy) {
        if (await endTurnSlot(page).isEnabled() && (await endTurnSlot(page).getAttribute('data-yield')) === null) aliceBarLive = true;
        const decisionOk = page.getByTestId('live-decision-ok');
        if ((await decisionOk.count()) > 0 && (await decisionOk.isEnabled())) aliceBarLive = true;
        await page.waitForTimeout(40);
      }
      expect(aliceBarLive, "alice's own bar never enabled for bob's spell").toBe(false);
      await expect(ownLife(page), 'and it hit alice').toHaveText('17', { timeout: 15_000 });
      await expect.poll(() => stackCount(page), { timeout: 15_000, message: "bob's Bolt resolved" }).toBe(0);

      // And the server's own record: from alice's press to the Bolt's resolution, every priority
      // window Forge gave her was passed for the yield, and none was forwarded to her screen.
      const log = serverLog(stack);
      const armed = log.findIndex((r) => r.evt === 'auto-yield' && r.seat === 0 && r.on === true);
      expect(armed, "the server saw alice's Auto Yield").toBeGreaterThanOrEqual(0);
      const after = log.slice(armed).filter((r) => r.seat === 0);
      const yielded = after.filter((r) => r.evt === 'auto-passed' && r.why === 'auto-yield').length;
      const forwarded = after.filter((r) => r.evt === 'prompt-forwarded').map((r) => String(r.kind));
      console.log(`[w63-yield] alice yielded ${String(yielded)} window(s); forwarded to her after the press: [${forwarded.join(', ')}]`);
      expect(yielded, "alice's priority on bob's Bolt was passed for her yield").toBeGreaterThan(0);
      expect(forwarded, 'no window reached alice while she yields').toEqual([]);
      // Auto Yield still reads on: it has not been cancelled, only expired —
      // and it is still bob's own turn, the one it was armed for.
      await expect(endTurnSlot(page)).toHaveText('Cancel Yield');

      // Bob ends his turn: the one remaining stop (his own Main 1, post-resolve) is his to press.
      await expect(endTurnSlot(bob.page), "bob's own End Turn, at his post-resolve Main 1").toBeEnabled({ timeout: 15_000 });
      await endTurnSlot(bob.page).click();

      // Once it is alice's own turn again, nothing re-armed or cancelled the
      // override — it simply no longer applies, because the turn moved on.
      await expect
        .poll(() => page.getByTestId('live-phases').getAttribute('data-whose'), { timeout: 45_000, message: "alice's own turn comes round" })
        .toBe('yours');
      await expect(endTurnSlot(page), 'End Turn, not Auto Yield, on alice’s own turn').toHaveText('End Turn');
      await expect(endTurnSlot(page)).not.toHaveAttribute('data-yield');
    } finally {
      await stack.stop();
    }
  },
);

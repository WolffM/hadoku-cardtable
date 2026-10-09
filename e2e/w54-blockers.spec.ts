/**
 * Undoing a block, and the lasting arrow to what it blocks — against a real
 * Forge match.
 *
 * The operator, Playtest 10: *"blockers cannot be undone; they should work
 * like attackers: an arrow to what they block, and a second click undoes
 * it."* Forge's own `InputBlock` already undoes a block on the second click
 * (`InputBlock.java:132-146`, "lblRemoveFromCombat") — the client just never
 * offered the already-blocking creature for that click to land on
 * (`PlayerControllerHuman.pushBlockerCandidates`,
 * `PlayerControllerHuman.java:1621-1647`, drops an assigned creature from the
 * candidate set). `match.ts`'s `declaredBlockers` offers it back, off the
 * wire's own planned map (`adapter.ts`'s `CombatBand.plannedBlockers`,
 * `AttackersWithPlannedBlockers`), and `gestures/install.ts`'s `blockArrows`
 * draws the lasting blocker→attacker arrow from that same map while
 * declaring and from the confirmed one (`CombatBand.blockers`,
 * `AttackersWithBlockers`) once Forge has moved past it — see each
 * function's own doc comment for the Forge source the planned/confirmed
 * split rests on (`GameView.java:215-229`, `Combat.java:677-679`,
 * `AttackingBand.java:14,71-72`).
 *
 * Driver: `e2e/play/combat.ts`. Scenario: `w54-b-two-blockers` — bob (ai,
 * seat 1) already attacks alice (human, seat 0) with TWO creatures; alice
 * holds TWO untapped, non-sick creatures able to block either one.
 *
 * Evidence: `forge.yml` only uploads the failure artifact on a FAILURE
 * (`W54-C-EVIDENCE`'s own note in `e2e/w46-attack.spec.ts`), so every step
 * this spec cares about is also printed as one `W54-B-EVIDENCE` JSON line on
 * stdout — the list reporter prints it into the job log on every run, green
 * or red.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`);
 * without one this SKIPS and the title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { enabledOk, makeTitled, offered, says } from './play/board.ts';
import { assignBlock, attackingCards, blockArrow, blockArrowKey, ownBattlefieldCards, passDeclareAttackers, phaseOf, undoBlock } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/**
 * One structured line per step: every offered id, whether the arrow for
 * `(blocker, attacker)` exists, and `data-blocking` on the blocker — read in
 * ONE evaluate pass (`w46-attack.spec.ts`'s own note on why: a second
 * `evaluate` is a second task, and a repaint between the two would compare a
 * box or an attribute against a state that already moved on).
 */
async function logStep(page: Page, step: string, blockerId: number, attackerId: number): Promise<void> {
  const key = blockArrowKey(blockerId, attackerId);
  const data = await page.evaluate(
    ({ key, blockerId }) => {
      const offeredIds = Array.from(document.querySelectorAll('[data-board-card][data-selectable]')).map((el) =>
        Number(el.getAttribute('data-board-card')),
      );
      const arrow = document.querySelector(`[data-testid="stack-target-arrow"][data-key="${key}"]`);
      const blocker = document.querySelector(`[data-board-card="${blockerId}"]`);
      return {
        offered: offeredIds.sort((a, b) => a - b),
        arrowPresent: arrow !== null,
        blockerDataBlocking: blocker?.getAttribute('data-blocking') ?? null,
      };
    },
    { key, blockerId },
  );
  console.log(`W54-B-EVIDENCE ${JSON.stringify({ step, blockerId, attackerId, key, ...data })}`);
}

/** The curved arrow's own tail/tip, read off its `path`'s `d` in the overlay's own coordinates. */
function arrowTip(key: string): { x: number; y: number } | null {
  const arrow = document.querySelector(`[data-testid="stack-target-arrow"][data-key="${key}"]`);
  const box = arrow?.getBoundingClientRect();
  const d = arrow?.querySelector('path')?.getAttribute('d') ?? '';
  const nums = d.replace(/[MQ]/g, ' ').trim().split(/\s+/).map(Number);
  if (box === undefined || nums.length < 6) return null;
  return { x: nums[4]! + box.left, y: nums[5]! + box.top };
}

/** The four corners and four edge midpoints of a card's own box — `edgePointNearest`'s eight points, read from the page. */
function eightPointsOf(selector: string): { x: number; y: number }[] {
  const el = document.querySelector(selector);
  if (el === null) return [];
  const r = el.getBoundingClientRect();
  const xs = [r.left, r.left + r.width / 2, r.right];
  const ys = [r.top, r.top + r.height / 2, r.bottom];
  const out: { x: number; y: number }[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      if (row === 1 && col === 1) continue;
      out.push({ x: xs[col]!, y: ys[row]! });
    }
  }
  return out;
}

test(
  titled('a block undoes on the second click, and the lasting arrow follows the planned map, then the confirmed one'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);

    const stack = await startPlayStack(forge);
    let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
    try {
      seated = await startScenarioMatch(browser, stack, 'w54-b-two-blockers');
      const { alice, bob } = seated;

      // Precondition: the scenario's own shape — two attackers already
      // declared against alice, two blockers on her own battlefield.
      const attackerLocators = attackingCards(alice.page);
      await expect(attackerLocators, 'the scenario declared exactly two attackers').toHaveCount(2);
      const attackerIds = (await attackerLocators.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))))).sort(
        (a, b) => a - b,
      );
      const blockerLocators = ownBattlefieldCards(alice.page);
      await expect(blockerLocators, 'alice holds exactly two blockers').toHaveCount(2);
      const blockerIds = (await blockerLocators.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-board-card'))))).sort(
        (a, b) => a - b,
      );
      // `attackerA`/`attackerB` and `blockerX`/`blockerY` name the scenario's
      // own four creatures; only one pair of each is driven below (A with
      // X), with the second attacker and second blocker left on the board so
      // neither assertion is "the only thing there to find".
      const [attackerA, attackerB] = attackerIds as [number, number];
      const [blockerX, blockerY] = blockerIds as [number, number];
      const everyCreature = [attackerA, attackerB, blockerX, blockerY].sort((a, b) => a - b);

      await passDeclareAttackers(bob.page);
      await expect.poll(() => says(alice.page), { timeout: 90_000, message: 'the block window is open for alice — the scenario sets up' }).toMatch(
        /select creatures to block/i,
      );
      await logStep(alice.page, 'declare-blockers opened', blockerX, attackerA);

      // Before any block: both of alice's creatures are offered as blocker
      // candidates (Forge's ordinary actionable set), AND both attackers are
      // offered too — `blockTargets` (`match.ts`): a click on an attacker is
      // what makes it `InputBlock`'s CURRENT one (`InputBlock.java:112-115`),
      // so the offer while declaring is blockers ∪ attackers, not blockers
      // alone. Neither draws an arrow yet.
      await expect.poll(() => offered(alice.page), { timeout: 10_000, message: 'both blockers and both attackers are offered before any block is made' }).toEqual(
        everyCreature,
      );
      await expect(blockArrow(alice.page, blockerX, attackerA), 'no arrow before any block').toHaveCount(0);
      // Forge's current attacker (the next blocker click goes to it) is a focus ring, never the
      // picked check — the operator, 2026-10-09: "a green checkmark on one of the attackers?".
      await expect(alice.page.locator('.board-card__picked'), 'no check on any card while blocking').toHaveCount(0);
      await expect(alice.page.locator('[data-block-focus]'), 'one attacker is the block focus').toHaveCount(1);
      const focus = Number(await alice.page.locator('[data-block-focus]').getAttribute('data-card-id'));
      expect([attackerA, attackerB], 'the focus is an attacker').toContain(focus);
      console.log(`[block-focus] focus on ${focus} (attackers ${attackerA}, ${attackerB})`);

      // Block A with X: arrow X → A drawn, off the PLANNED map while declaring.
      await assignBlock(alice.page, blockerX, attackerA);
      await expect(alice.page.locator(`[data-board-card="${blockerX}"]`), 'X is marked blocking').toHaveAttribute('data-blocking', 'true', {
        timeout: 10_000,
      });
      await expect(alice.page.locator(`[data-card-id="${attackerA}"][data-block-focus]`), 'clicking A made it the focus').toHaveCount(1);
      await expect(alice.page.locator('.board-card__picked'), 'still no check').toHaveCount(0);
      const key = blockArrowKey(blockerX, attackerA);
      await expect(blockArrow(alice.page, blockerX, attackerA), 'the arrow from X to A is drawn').toHaveCount(1, { timeout: 10_000 });
      const tip1 = await alice.page.evaluate(arrowTip, key);
      const edges1 = await alice.page.evaluate(eightPointsOf, `[data-board-card="${attackerA}"]`);
      expect(tip1, 'the arrow has a real tip').not.toBeNull();
      const nearest1 = edges1.reduce((best, p) => (Math.hypot(p.x - tip1!.x, p.y - tip1!.y) < Math.hypot(best.x - tip1!.x, best.y - tip1!.y) ? p : best));
      expect(Math.hypot(tip1!.x - nearest1.x, tip1!.y - nearest1.y), 'the tip lands on one of A’s eight edge points').toBeLessThanOrEqual(1);
      await logStep(alice.page, 'blocked once (planned map)', blockerX, attackerA);

      // X is STILL offered — not through the ordinary candidate set any
      // more (it is assigned), but through `declaredBlockers`'s own read of
      // the planned map — which is the whole point: the second click has
      // somewhere to land.
      await expect.poll(() => offered(alice.page), { timeout: 5_000 }).toContain(blockerX);
      const promptBeforeUndo = await says(alice.page);

      // Click X again: Forge's own undo. Arrow gone, X no longer marked
      // blocking, and Forge's own prompt is UNCHANGED — the undo is still
      // `InputBlock` running, not a different input.
      await undoBlock(alice.page, blockerX);
      await expect(alice.page.locator(`[data-board-card="${blockerX}"]`), 'X is no longer marked blocking').not.toHaveAttribute('data-blocking', 'true', {
        timeout: 10_000,
      });
      await expect(blockArrow(alice.page, blockerX, attackerA), 'the arrow is gone — no click of ours drew its absence, Forge’s own next frame did').toHaveCount(
        0,
        { timeout: 10_000 },
      );
      expect(await says(alice.page), 'Forge’s own prompt is unchanged by the undo').toBe(promptBeforeUndo);
      await logStep(alice.page, 'undone (second click)', blockerX, attackerA);

      // Block it again, then confirm (Forge's own `onOk`, "Done blocking").
      await assignBlock(alice.page, blockerX, attackerA);
      await expect(blockArrow(alice.page, blockerX, attackerA), 'the arrow is back after blocking again').toHaveCount(1, { timeout: 10_000 });
      await logStep(alice.page, 'blocked again (planned map)', blockerX, attackerA);

      /*
       * Turn on full control for alice before confirming. Measured against
       * the real jar (claws run 37584358566): once nobody has anything left
       * to respond with, Declare Blockers Step → Combat Damage Step → End of
       * Combat Step → Main 2 auto-paces in well under 100ms — too fast for
       * any poll here to reliably land mid-combat rather than already at
       * Main 2, where Forge's own `CombatView` has gone null regardless of
       * what the confirmed map said (`GameView.updateCombat`: a null
       * `Game.getCombat()` clears it outright, combat over or not). Full
       * control holds alice's OWN priority at each step instead of
       * auto-passing it — the same escape hatch `w33.spec.ts`/
       * `w46-stack.spec.ts` already use for this exact race; bob has
       * nothing either way and keeps auto-passing on his own.
       */
      await alice.page.getByTestId('live-full-control').click();
      await expect(alice.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');

      await enabledOk(alice.page).click(); // "Done blocking" — ends `InputBlock`.
      // The ordinary priority that follows, still inside Declare Blockers
      // Step, now held open by full control instead of auto-passed: pass it too.
      await expect.poll(() => enabledOk(alice.page).count(), { timeout: 10_000, message: 'alice’s own priority opens, held by full control' }).toBeGreaterThan(0);
      await enabledOk(alice.page).click();

      /*
       * Held at Combat Damage Step. Damage is a turn-based action that runs
       * BEFORE any priority is given in that step, so this is the FIRST
       * moment `declaringBlockers` reads false with both creatures still on
       * the board — `Wall of Stone` (0/8) survives the 1 damage back, and
       * its own 0 power never kills the 1/1 Memnite attacker either. No
       * `COMBAT_FIRST_STRIKE_DAMAGE` step exists here (neither creature has
       * first strike), so Declare Blockers lands straight on Combat Damage.
       */
      await expect
        .poll(async () => (await phaseOf(alice.page))?.phase ?? '', {
          timeout: 15_000,
          message: 'Forge moved past Declare Blockers and is held at Combat Damage Step by full control',
        })
        .toBe('COMBAT_DAMAGE');
      await expect(alice.page.locator(`[data-board-card="${blockerX}"]`), 'the blocker survived combat damage').toHaveCount(1);
      await expect(alice.page.locator(`[data-board-card="${attackerA}"]`), 'the attacker survived combat damage too').toHaveCount(1);

      // Same key, same arrow — now off the CONFIRMED map (`CombatBand.blockers`),
      // not the planned one, because declare-blockers is over
      // (`declaringBlockers` is false here). It did not flash off and back on;
      // `install.ts`'s own reconciler key is unchanged across the switch.
      await expect(blockArrow(alice.page, blockerX, attackerA), 'the same arrow is still drawn, now off the CONFIRMED map').toHaveCount(1, {
        timeout: 10_000,
      });
      await logStep(alice.page, 'confirmed (combat map)', blockerX, attackerA);
    } finally {
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  },
);

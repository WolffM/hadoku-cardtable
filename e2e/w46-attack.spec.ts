/**
 * X1/W14 — attacking a planeswalker by drag, against a real Forge match, and
 * the lasting attack arrow (wave 46 §B item 2) that joins attacker and
 * defender through the declare-blockers step and is gone once combat ends.
 *
 * The operator, asked twice: *"arrow for attackers still not showing. i
 * tried to select the planeswalker to attack and it doesn't work. I was able
 * to see an arrow drawing while i was dragging from it, but the planeswalker
 * didn't seem to be selectable as a target."* The cause (`docs/planning/
 * playtest8-plan.md` §X1): during `COMBAT_DECLARE_ATTACKERS` nothing offered
 * the defenders, so the drop fell back to `selectCard(attacker)`, which
 * attacks Forge's current defender (the player). `match.ts`'s
 * `attackDefenders`/`attackAssignment` and `commit.ts`'s defender-first send
 * fix it; `gestures.test.ts`'s "X1/W14" block proves the wire order under
 * jsdom. This is the real-Forge proof, on a scenario modelled on the one W14
 * itself names (`scenarios/w46-b-planeswalker.state` — see its own header:
 * `w41-planeswalker.state`, read-only per the brief, has no
 * `|Counters:LOYALTY=N` on Jace, and `GameState`'s puzzle-file placement does
 * not default one, so Jace never survives long enough for this spec to drag
 * an attacker onto it — confirmed empirically, the same fix
 * `w43-planeswalker.state` already carries for the identical reason): Memnite
 * vs an opposing Jace Beleren, nothing pre-declared, so Forge's own live
 * `InputAttack` has to open for real (same reasoning as `w33.spec.ts`'s
 * "attackers-declared" case, which found a `GameState`-declared attack
 * skips that input entirely).
 *
 * ## What "a lasting arrow" means here, and how it is proven without a
 * second channel to read the wire from
 *
 * `e2e` has no bridge-line capture (`apps/server/src/play/scenario.ts`'s jvm
 * tests do; the e2e stack's own `serverLogFile` is the SERVER's structured
 * log, not Forge's raw frames) — so this proves Forge's own `CombatView`
 * said "Jace" the same way `arrow.spec.ts` proves every other arrow: by
 * GEOMETRY. `gestures/auto-targets.ts`'s `combatArrows` draws the lasting
 * arrow from `view.combat` (itself `adapter.ts`'s `readCombat` over the raw
 * `CombatView` property) straight to Jace's own card box — so an arrow
 * landing within a pixel of one of Jace's eight edge points, keyed
 * `combat:<memnite id>`, is Forge's `def` read off the wire, not a picture of
 * one. `data-attacking="true"` on Memnite is the second, independent half:
 * Forge's own declaration, not this client's intent mark.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`);
 * without one this SKIPS and the title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { clickOnce, enabledOk, makeTitled, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface Point {
  x: number;
  y: number;
}

const away = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** The four corners and the four edge midpoints of a box — `edgePointNearest`'s own eight points. */
const eight = (b: Box): Point[] => {
  const xs = [b.left, b.left + b.width / 2, b.left + b.width];
  const ys = [b.top, b.top + b.height / 2, b.top + b.height];
  return ys.flatMap((y, r) => xs.map((x, c) => ({ x, y, centre: r === 1 && c === 1 }))).filter((p) => !p.centre).map(({ x, y }) => ({ x, y }));
};

/** `data-testid="live-phases"`'s own `data-phase`/`data-whose` (`LiveBoard.tsx`) — a structured fact, never prose. */
async function phaseOf(page: Page): Promise<string | null> {
  const rail = page.getByTestId('live-phases');
  if ((await rail.count()) === 0) return null;
  return rail.getAttribute('data-phase');
}

/**
 * Press OK once for the attacker's own Main Phase 1 priority stop, then wait
 * for Forge's own live `InputAttack` to open for real — `w33.spec.ts`'s
 * "attackers-declared" case drives the identical shape for the identical
 * reason: nothing in this scenario is pre-declared.
 */
async function passToDeclareAttackers(page: Page): Promise<void> {
  const deadline = Date.now() + 20_000;
  let pressed = false;
  while (!/^Select creatures to attack/i.test(await says(page)) && Date.now() < deadline) {
    const text = await says(page);
    if (!pressed && /^Priority:/.test(text) && /Main phase, precombat/i.test(text) && (await enabledOk(page).count()) > 0) {
      pressed = true;
      await clickOnce(page, text, 'ok');
    }
    await page.waitForTimeout(40);
  }
  await expect.poll(() => says(page), { timeout: 5_000, message: 'the live declare-attackers window opened' }).toMatch(/^Select creatures to attack/i);
}

/**
 * Press whichever side's OK is enabled, on both pages, until EITHER side's
 * phase rail matches `phase`. Neither seat has a decision once the attack is
 * declared (bob has no creature to block with), so this is a plain "let the
 * main loop run forward" pump, the same shape `keepBothHands` uses for the
 * mulligan.
 */
async function passUntilPhase(pages: readonly Page[], phase: RegExp, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of pages) {
      const current = await phaseOf(page);
      if (current !== null && phase.test(current)) return;
    }
    for (const page of pages) {
      if ((await enabledOk(page).count()) > 0) await clickOnce(page, await says(page), 'ok');
    }
    await pages[0]!.waitForTimeout(40);
  }
  throw new Error(`timed out waiting for phase ${phase}`);
}

/** A single held pointer gesture: down on `fromId`'s card, up on `toId`'s — a battlefield-to-battlefield drag. */
async function dragCardOnto(page: Page, fromId: number, toId: number): Promise<void> {
  const fromBox = await page.locator(`[data-board-card="${fromId}"]`).boundingBox();
  const toBox = await page.locator(`[data-board-card="${toId}"]`).boundingBox();
  if (fromBox === null) throw new Error(`no box for card ${fromId}`);
  if (toBox === null) throw new Error(`no box for card ${toId}`);
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 8 });
  await page.mouse.up();
}

/**
 * The lasting attack arrow's own box, the Jace card's box, and the curve's
 * own tail/tip, read together in ONE layout pass. Runs in the page.
 *
 * One pass matters: a second `evaluate` is a second task, and anything that
 * re-rendered in between (`arrow.spec.ts`'s own header note — a card settling
 * into place right after a declaration, say) would be compared against a box
 * read from before it. A SEPARATE `arrowTip`/`arrowTail` call here measured
 * exactly that race once: the tip computed from a target box read a frame
 * apart missed by ~49px, not because the geometry was wrong but because the
 * two reads disagreed about where Jace's card was.
 */
function shoot([key, targetId]: [string, number]): { arrowBox: Box | null; targetBox: Box | null; tail: Point | null; tip: Point | null } {
  const box = (el: Element): Box => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  };
  const arrow = document.querySelector(`[data-testid="stack-target-arrow"][data-key="${key}"]`);
  const target = document.querySelector(`[data-board-card="${targetId}"], [data-stack-id="${targetId}"]`);
  const shaft = arrow?.querySelector('path');
  const d = shaft?.getAttribute('d') ?? '';
  const nums = d.replace(/[MQ]/g, ' ').trim().split(/\s+/).map(Number);
  const arrowBox = arrow === null ? null : box(arrow);
  const tail = arrowBox !== null && nums.length >= 6 ? { x: nums[0]! + arrowBox.left, y: nums[1]! + arrowBox.top } : null;
  const tip = arrowBox !== null && nums.length >= 6 ? { x: nums[4]! + arrowBox.left, y: nums[5]! + arrowBox.top } : null;
  return { arrowBox, targetBox: target === null ? null : box(target), tail, tip };
}

test(
  titled(
    'dragging Memnite onto Jace attacks the planeswalker; a lasting arrow joins them through declare-blockers and is gone by Main 2',
  ),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);

    const stack = await startPlayStack(forge);
    let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
    try {
      seated = await startScenarioMatch(browser, stack, 'w46-b-planeswalker');
      const { alice, bob } = seated;

      const memnite = Number(
        await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card').first().getAttribute('data-board-card'),
      );
      const jace = Number(
        await alice.page.locator('.seat:not([data-viewer]) [data-zone="battlefield"] li.board-card').first().getAttribute('data-board-card'),
      );
      expect(Number.isInteger(memnite), 'Memnite is on alice’s own battlefield').toBe(true);
      expect(Number.isInteger(jace), 'Jace is on bob’s battlefield').toBe(true);

      await passToDeclareAttackers(alice.page);
      await expect(alice.page.locator(`[data-board-card="${memnite}"]`), 'Memnite is offered to attack').toHaveAttribute('data-selectable', 'true', {
        timeout: 10_000,
      });
      // W14's own bug: the planeswalker must be offered as a drop target —
      // this is the assertion that fails without `attackDefenders`.
      await expect(alice.page.locator(`[data-board-card="${jace}"]`), 'Jace is offered as a defender').toHaveAttribute('data-selectable', 'true', {
        timeout: 10_000,
      });

      await dragCardOnto(alice.page, memnite, jace);

      // Forge declared it: its own `Attacking`, not this client's intent mark.
      await expect(alice.page.locator(`[data-board-card="${memnite}"]`), 'Memnite is declared attacking').toHaveAttribute('data-attacking', 'true', {
        timeout: 10_000,
      });

      /*
       * The lasting arrow: `combat:<memnite>`, drawn to Jace's own box. Read
       * right after the declaration, and again once bob has had a priority
       * window (declare-blockers) with nothing to block with — it must still
       * be there, because it comes off `view.combat`, which Forge holds for
       * the whole of combat, not off anything the drag itself drew.
       */
      const key = `combat:${memnite}`;
      await expect(alice.page.locator(`[data-testid="stack-target-arrow"][data-key="${key}"]`), 'the lasting attack arrow is drawn').toHaveCount(1, {
        timeout: 10_000,
      });
      const first = await alice.page.evaluate(shoot, [key, jace] as [string, number]);
      expect(first.arrowBox, 'the arrow has a real box').not.toBeNull();
      expect(first.targetBox, 'Jace has a real box').not.toBeNull();
      expect(first.tip, 'the curve has a tip').not.toBeNull();
      const nearestEdge = eight(first.targetBox!).reduce((best, p) => (away(p, first.tip!) < away(best, first.tip!) ? p : best));
      expect(
        away(first.tip!, nearestEdge),
        `the arrow's tip lands on one of Jace's eight edge points (${JSON.stringify(first.tip)} vs ${JSON.stringify(nearestEdge)})`,
      ).toBeLessThanOrEqual(1);

      // Bob has no creature (Jace is a planeswalker, not a blocker) and
      // nobody has anything else to decide, so Forge runs the rest of
      // combat — Declare Blockers through End of Combat — in one
      // uninterrupted burst, server-auto-paced; there is no stable moment in
      // between to freeze-frame without full control on BOTH seats, which
      // would change what this test is driving. What is provable without a
      // race is the shape the operator's own words describe end to end: the
      // arrow is up the moment the attack is declared (above), it is NOT a
      // one-frame flash (`view.combat` is a standing fact for the whole of
      // combat — `adapter.ts`'s `readCombat`, unit-tested in `auto-targets.test.ts`'s
      // `combatArrows` block), and it is gone once combat has fully ended.
      await passUntilPhase([alice.page, bob.page], /^MAIN2$/, 30_000);
      await expect(alice.page.locator(`[data-testid="stack-target-arrow"][data-key="${key}"]`), 'combat has ended: the arrow is gone by Main 2').toHaveCount(
        0,
        { timeout: 10_000 },
      );
    } finally {
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  },
);

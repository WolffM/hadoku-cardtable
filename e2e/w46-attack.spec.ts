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

import { expect, test, type Locator, type Page } from '@playwright/test';

import { clickOnce, enabledOk, grindPriority, makeTitled, says } from './play/board.ts';
import { phaseOf } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/**
 * Wave 54 §C evidence: the computed marks on one card's `<li>`, as ONE
 * structured line in the job log. `forge.yml` only uploads the evidence
 * artifact on a FAILURE, so a line the list reporter prints on stdout is
 * what survives a green run — read as REAL computed styles, never the
 * stylesheet text.
 */
async function logMarks(card: Locator, label: string): Promise<void> {
  const data = await card.evaluate((li: Element) => {
    const face = li.querySelector('.board-card__face');
    const art = li.querySelector('.card');
    const badge = li.querySelector('.board-card__picked');
    const faceCs = face === null ? null : getComputedStyle(face);
    const artCs = art === null ? null : getComputedStyle(art);
    const badgeCs = badge === null ? null : getComputedStyle(badge);
    return {
      outlineStyle: faceCs?.outlineStyle ?? null,
      outlineWidth: faceCs?.outlineWidth ?? null,
      outlineColor: faceCs?.outlineColor ?? null,
      outlineOffset: faceCs?.outlineOffset ?? null,
      boxShadow: faceCs?.boxShadow ?? null,
      transform: artCs?.transform ?? null,
      badgePresent: badge !== null,
      badgeBackground: badgeCs?.backgroundColor ?? null,
    };
  });
  console.log(`W54-C-EVIDENCE ${JSON.stringify({ case: label, ...data })}`);
}

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
 * main loop run forward" pump — T6: `board.ts`'s own `grindPriority`.
 */
async function passUntilPhase(pages: readonly Page[], phase: RegExp, timeoutMs = 30_000): Promise<void> {
  await grindPriority(
    pages,
    async () => {
      for (const page of pages) {
        const current = await phaseOf(page);
        if (current !== null && phase.test(current.phase)) return true;
      }
      return false;
    },
    { timeoutMs },
  );
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
       * The operator, Playtest 10: *"after declaring attackers there is no
       * visible change … mark committed attackers, e.g. a red border."*
       * `card.css` draws that mark on `[data-attacking]` with no
       * `:not([data-vigilant])` exclusion, so the same rule this scenario's
       * (non-vigilant) Memnite exercises here is the one that also reaches a
       * vigilant attacker, which never turns and so has no other visible
       * change at all. Read as a REAL computed style, not the stylesheet
       * text — this is the proof the operator's own complaint is answered on
       * a real page, not merely declared in a rule nobody renders.
       */
      const outline = await alice.page
        .locator(`[data-board-card="${memnite}"] > .board-card__face`)
        .evaluate((el) => {
          const cs = getComputedStyle(el);
          return { style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor };
        });
      expect(outline.style, 'the committed-attacker mark is a real outline').toBe('solid');
      expect(outline.width, 'with real width').not.toBe('0px');
      await logMarks(alice.page.locator(`[data-board-card="${memnite}"]`), 'non-vigilant-attacker (Memnite)');

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

/*
 * The operator, Playtest 10: *"after declaring attackers there is no visible
 * change (Lightning Angel has vigilance, so nothing turns); mark committed
 * attackers, e.g. a red border."* `w46-b-planeswalker`'s own Memnite (above)
 * proves the mark on a NON-vigilant attacker, which also turns — so the mark
 * alone is not yet proof the operator's actual complaint is answered, since a
 * vigilant attacker has no turn to hide behind. `w54-c-vigilant` is Serra
 * Angel (Flying, Vigilance — `forge-gui/res/cardsfolder/s/serra_angel.txt`)
 * alone on seat 0's battlefield, nothing on seat 1's: the same
 * `attackers-declared.state` shape `w33.spec.ts` already drives (a plain
 * click on the creature's own button, no drag — there is no planeswalker
 * here, so the click attacks the defending player directly), landing Forge's
 * real, live `InputAttack` rather than a `GameState`-declared one.
 */
test(
  titled('a vigilant attacker (Serra Angel) is marked whether or not it turns'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(2 * 60_000);

    const stack = await startPlayStack(forge);
    let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
    try {
      seated = await startScenarioMatch(browser, stack, 'w54-c-vigilant');
      const { alice, bob } = seated;
      void bob;

      const angel = alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card');
      await expect(angel, 'exactly the one scripted Serra Angel is on seat 0’s board').toHaveCount(1);
      const angelId = Number(await angel.first().getAttribute('data-board-card'));
      expect(Number.isInteger(angelId), 'Serra Angel is on alice’s own battlefield').toBe(true);

      await passToDeclareAttackers(alice.page);
      const attacker = alice.page.locator(`[data-board-card="${angelId}"]`);
      await expect(attacker, 'Serra Angel is offered to attack').toHaveAttribute('data-selectable', 'true', { timeout: 10_000 });
      await expect(attacker, 'not yet declared').not.toHaveAttribute('data-attacking');

      // A plain click: no drop target other than the defending player exists here.
      await attacker.locator('button').first().click();
      await expect(attacker, 'Forge declared it — its own `Attacking`').toHaveAttribute('data-attacking', 'true', { timeout: 10_000 });
      await expect(attacker, 'and its own `Vigilance`').toHaveAttribute('data-vigilant', 'true');

      const read = await attacker.locator('> .board-card__face').evaluate((face) => {
        const art = face.querySelector('.card');
        return {
          outline: { style: getComputedStyle(face).outlineStyle, width: getComputedStyle(face).outlineWidth },
          // `transform` on the ART, not the face: the turn rule rotates `.board-card__face > .card` (§C's own
          // header), so a vigilant attacker's own proof that it did NOT turn is this element carrying none.
          transform: art === null ? null : getComputedStyle(art).transform,
        };
      });
      expect(read.outline.style, 'the committed-attacker mark is a real outline, same as the non-vigilant case').toBe('solid');
      expect(read.outline.width, 'with real width').not.toBe('0px');
      expect(read.transform, 'a vigilant attacker is NOT turned — Forge never taps it for attacking').toBe('none');
      await logMarks(attacker, 'vigilant-attacker (Serra Angel)');
    } finally {
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  },
);

/*
 * The operator, 2026-10-15: *"let's show a 'crossed swords' pill icon on top of cards that have been
 * selected as attackers."* Forge's own `Attacking` is set by the click that declares a creature in
 * `InputAttack`, so the mark is on BOTH screens from that click, comes off when the creature is called
 * back (a second click), and is gone once combat has ended. On the turned attacker it is the `<li>`'s
 * own, so it sits upright on the card's top-left corner while the art inside turns.
 */
test(titled('a selected attacker wears the crossed-swords mark on both screens, upright on its turned card, off when called back and after combat'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);

  const stack = await startPlayStack(forge);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'w46-b-planeswalker');
    const { alice, bob } = seated;
    const pages = [alice.page, bob.page] as const;

    const memnite = Number(
      await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card').first().getAttribute('data-board-card'),
    );
    expect(Number.isInteger(memnite), 'Memnite is on alice’s own battlefield').toBe(true);
    const swords = (page: Page): Locator => page.locator(`li.board-card[data-board-card="${memnite}"] > .board-card__marks > [data-mark="attacking"]`);

    /** The mark and its card, read in one pass on `page`: whether it is drawn, upright, and on the card's own top-left. */
    const read = (page: Page) =>
      page.locator(`li.board-card[data-board-card="${memnite}"]`).evaluate((li) => {
        const mark = li.querySelector<HTMLElement>(':scope > .board-card__marks > [data-mark="attacking"]');
        const art = li.querySelector(':scope > .board-card__face > .card');
        const card = li.getBoundingClientRect();
        const m = mark?.getBoundingClientRect() ?? null;
        return {
          attacking: li.getAttribute('data-attacking'),
          mark: mark !== null,
          tip: mark?.dataset.tip ?? null,
          artTransform: art === null ? null : getComputedStyle(art).transform,
          marksTransform: mark === null ? null : getComputedStyle(mark.parentElement!).transform,
          markTransform: mark === null ? null : getComputedStyle(mark).transform,
          card: { left: Math.round(card.left), top: Math.round(card.top), width: Math.round(card.width), height: Math.round(card.height) },
          markBox: m === null ? null : { left: Math.round(m.left), top: Math.round(m.top), width: Math.round(m.width), height: Math.round(m.height) },
        };
      });
    const log = async (step: string): Promise<void> => {
      for (const [who, page] of [['alice', alice.page], ['bob', bob.page]] as const) console.log(`[at] ${step} ${who} ${JSON.stringify(await read(page))}`);
    };

    await passToDeclareAttackers(alice.page);
    const attacker = alice.page.locator(`[data-board-card="${memnite}"]`);
    await expect(attacker, 'Memnite is offered to attack').toHaveAttribute('data-selectable', 'true', { timeout: 10_000 });
    for (const page of pages) await expect(swords(page), 'no mark before it is selected').toHaveCount(0);

    // Selected: Forge's own `Attacking`, and the mark, on both screens.
    await attacker.locator('button').first().click();
    for (const page of pages) await expect(swords(page), 'the click that selects it marks it, on both screens').toHaveCount(1, { timeout: 10_000 });
    await log('selected');
    for (const page of pages) {
      const r = await read(page);
      expect(r.attacking, 'it is Forge’s declared attacker').toBe('true');
      expect(r.tip).toBe('Attacking');
      expect(r.artTransform, 'the card is turned a quarter').not.toBe('none');
      expect(r.marksTransform, 'the mark is not turned with it').toBe('none');
      expect(r.markTransform, 'nor turned on its own').toBe('none');
      expect(r.markBox, 'the mark is drawn').not.toBeNull();
      expect(r.markBox!.left - r.card.left, 'on the turned card’s own left edge').toBeLessThanOrEqual(4);
      expect(r.markBox!.top - r.card.top, 'on the turned card’s own top edge').toBeLessThanOrEqual(4);
      expect(r.markBox!.top - r.card.top, 'not hanging above it').toBeGreaterThanOrEqual(0);
    }

    // Called back: a second click undeclares it, and the mark goes with it on both screens.
    await attacker.locator('button').first().click();
    for (const page of pages) await expect(swords(page), 'calling it back takes the mark off, on both screens').toHaveCount(0, { timeout: 10_000 });
    await log('called-back');

    // Selected again, then combat runs out: the mark stays through combat and is gone by Main 2.
    await expect(attacker, 'it is offered again').toHaveAttribute('data-selectable', 'true', { timeout: 10_000 });
    await attacker.locator('button').first().click();
    for (const page of pages) await expect(swords(page), 'selected again, marked again').toHaveCount(1, { timeout: 10_000 });
    await passUntilPhase(pages, /^MAIN2$/, 30_000);
    for (const page of pages) await expect(swords(page), 'combat has ended: the mark is gone').toHaveCount(0, { timeout: 10_000 });
    await log('main2');
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
});

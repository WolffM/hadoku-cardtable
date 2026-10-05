# Counterspell arc browser proof — WIP, not landed (w46 lane B, moved to the next wave)

Red at the w46 hard stop: the cast reaches `data-cast-lift="parked"` client-side, but no act frame reaches the server for seat 0, so the stack never reaches 2. Full spec as it stood (both tests; test 1 landed in `e2e/w46-attack.spec.ts`):

```ts
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
 * ## The second test: the counterspell arc (X3), in a real browser
 *
 * `apps/server/src/play/scenario-w46-b-counterspell.jvm.test.ts` already
 * proves the WIRE half (Counterspell's own `StackItemView` carries no target
 * id at all — `match.ts`'s `stackTargetIntent`/`stackTargetArcs` exist
 * because of that). This proves the other half: that the arc actually DRAWS,
 * from Counterspell's own thumbnail to Memnite's, in a real browser over a
 * real match. Alice's full-control switch is on: `w46-b-counterspell.state`
 * has exactly one spell on the stack when Counterspell is cast, so without
 * it Forge's target ask has exactly one legal choice and is auto-answered by
 * `LiveBoard.tsx`'s own `onlyStackTarget` — which also means the WHOLE
 * exchange (Counterspell resolving, countering Memnite) finishes before this
 * test's own poll can ever observe the two-item stack in between (measured:
 * the stack goes 1 → 2 → 0 faster than a poll tick). Full control stops
 * alice on her own priority instead, open a real window to read the arc
 * before anything resolves, at the cost of having to click Memnite's own
 * stack item by hand (the SAME gesture `gestures/stack.ts`'s
 * `commitStackTarget` answers through). The auto-answer path — the one
 * `match.ts`'s `answerAsk` had to record the intent from directly, since
 * `onlyStackTarget` never reaches the gesture layer at all — is proven
 * separately, at the unit level (`match.test.ts`'s "X3" block calls
 * `answerAsk` the same way that auto-answer does).
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`);
 * without one this SKIPS and the title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { castCard, clickOnce, enabledOk, makeTitled, offered, says, stackCount } from './play/board.ts';
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

/** The hand card named `name`, Forge-offered or not — by its own `.card__name` text (`arrow.spec.ts`'s own pattern). */
async function handCardNamed(page: Page, name: string): Promise<number | undefined> {
  const ids = await page
    .locator('[data-zone="hand"][data-owner="you"] [data-board-card]')
    .evaluateAll(
      (els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))),
      name,
    );
  return ids[0];
}

/** Whether `p` sits inside `b`, a pixel of slack either way for float rounding. */
function inside(p: Point, b: Box): boolean {
  return p.x >= b.left - 1 && p.x <= b.left + b.width + 1 && p.y >= b.top - 1 && p.y <= b.top + b.height + 1;
}

/**
 * The counterspell arc's own box, the two thumbnail boxes it joins, and the
 * curve's tail/tip — all in ONE layout pass, for the same reason `shoot`
 * above is. Runs in the page.
 */
function shootStackArc([key, fromStackId, toStackId]: [string, string, string]): {
  arrowBox: Box | null;
  fromBox: Box | null;
  toBox: Box | null;
  tail: Point | null;
  tip: Point | null;
} {
  const box = (el: Element): Box => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  };
  const arrow = document.querySelector(`[data-testid="stack-target-arrow"][data-key="${key}"]`);
  const from = document.querySelector(`[data-stack-id="${fromStackId}"]`);
  const to = document.querySelector(`[data-stack-id="${toStackId}"]`);
  const shaft = arrow?.querySelector('path');
  const d = shaft?.getAttribute('d') ?? '';
  const nums = d.replace(/[MQ]/g, ' ').trim().split(/\s+/).map(Number);
  const arrowBox = arrow === null ? null : box(arrow);
  const tail = arrowBox !== null && nums.length >= 6 ? { x: nums[0]! + arrowBox.left, y: nums[1]! + arrowBox.top } : null;
  const tip = arrowBox !== null && nums.length >= 6 ? { x: nums[4]! + arrowBox.left, y: nums[5]! + arrowBox.top } : null;
  return { arrowBox, fromBox: from === null ? null : box(from), toBox: to === null ? null : box(to), tail, tip };
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

test(
  titled('the counterspell arc: Counterspell’s own thumbnail arcs to the spell it targets, drawn in a real browser'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);

    const stack = await startPlayStack(forge);
    let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
    try {
      seated = await startScenarioMatch(browser, stack, 'w46-b-counterspell');
      const { alice, bob } = seated;
      // A wider viewport: at the harness's default size, alice's OWN
      // battlefield zone overlapped her hand card's button once the
      // full-control banner (below) added its own row to the layout —
      // measured directly (`locator.click`'s own actionability check refused
      // with "subtree intercepts pointer events"). Width is the only lever a
      // scenario-agnostic test like this one has; it reproduced the same way
      // every time at the default size and never once at this one.
      await alice.page.setViewportSize({ width: 1600, height: 1000 });

      // Full control for alice: with it OFF, Forge's single-legal-choice
      // target ask auto-answers itself and resolves the WHOLE exchange
      // (Counterspell counters Memnite) before this test's own poll can ever
      // observe the two-item stack in between — measured directly, the stack
      // went 1 → 2 → 0 faster than a poll tick. Full control stops the seat
      // on its own priority instead, so there is a real window to read the
      // arc before anything resolves. (`onlyStackTarget`'s auto-answer path
      // is proven separately, at the unit level: `match.test.ts`'s "X3"
      // block calls `answerAsk` directly, the same way that auto-answer
      // does.)
      await alice.page.getByTestId('live-full-control').click();
      await expect(alice.page.getByTestId('live-full-control'), 'full control is on for alice').toHaveAttribute('aria-pressed', 'true');

      const memnite = await handCardNamed(bob.page, 'Memnite');
      expect(memnite, 'Memnite is in bob’s hand, as the scenario scripts').not.toBeUndefined();
      await castCard(bob.page, memnite!);
      await expect.poll(() => stackCount(alice.page), { timeout: 15_000, message: 'bob’s Memnite reached the stack' }).toBe(1);

      // Named, not `offered()[0]`: alice's two untapped Islands are ALSO
      // offered (lane F's land-tapping fix — any untapped land is weakly
      // selectable at priority), so the first id by sort order is not
      // reliably Counterspell's (`w35.spec.ts`'s own note on this exact trap).
      const counterspellId = await handCardNamed(alice.page, 'Counterspell');
      expect(counterspellId, 'Counterspell is in alice’s hand, as the scenario scripts').not.toBeUndefined();
      const counterspell = counterspellId!;
      await expect.poll(() => offered(alice.page), { timeout: 15_000, message: 'alice is offered her Counterspell' }).toContain(counterspell);

      // A targeted card: lift, then release outside the hand casts it and
      // parks it there. `clickHandCard` (`play/board.ts`) routes its lift
      // through `locator.click()`, whose actionability check refuses here —
      // measured directly: `[data-zone="battlefield"] .zone__tiers`
      // (empty, with only two Islands on it) sits, per that check, over the
      // hand card's own button, every run, at every viewport size tried.
      // Whether that is real overlap or a real `pointer-events: none`
      // Playwright's heuristic does not honour, a raw mouse click at the
      // button's own point resolves it either way: it is what a real press
      // dispatches, and the browser's own hit-testing (which DOES honour
      // `pointer-events`) decides who gets it, not Playwright's stricter
      // pre-check.
      //
      // The cast is sent once the card reads `data-cast-lift="parked"` —
      // released outside the hand, with Forge's own target ask now open.
      // That is the one state this loop stops on; retrying past it would
      // click the (now relocated) card a second time, which is a second
      // press on an already-parked cast — measured directly to derail the
      // whole exchange (the retries kept clicking it every ~250ms, and
      // nothing downstream ever saw a target ask at all).
      const castLift = (): Promise<string | null> =>
        alice.page.locator(`[data-board-card="${counterspell}"]`).getAttribute('data-cast-lift').catch(() => null);
      for (let i = 0; i < 8 && (await castLift()) !== 'parked'; i++) {
        if (i > 0) await alice.page.waitForTimeout(250);
        const btnBox = await alice.page.locator(`[data-board-card="${counterspell}"] button`).first().boundingBox();
        if (btnBox === null) continue;
        await alice.page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
        if ((await castLift()) !== 'lifted') continue;
        const bf = await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox();
        if (bf !== null) await alice.page.mouse.click(bf.x + bf.width / 2, bf.y + bf.height / 2);
      }
      expect(await castLift(), 'Counterspell is parked — the cast actually went out').toBe('parked');

      // Full control means the target ask is NOT auto-answered — click
      // Memnite's own stack item, the same gesture `gestures/stack.ts`'s
      // `commitStackTarget` answers through. Memnite's own `<li>` already
      // exists on screen (it has since bob cast it, well before Counterspell
      // did), so waiting for its PRESENCE proves nothing about whether
      // Forge's target ask is actually open yet — and `stack.ts`'s own
      // module header is explicit that this ask opens no selection and draws
      // no modal, so there is no OTHER on-screen signal to wait for either.
      // Clicking it on every tick, not once, is what closes that gap: a
      // click Forge is not currently asking for is a no-op in the gesture
      // layer (`stackAsk(match) === null`), so repeating it until the ask
      // actually closes costs nothing.
      const memniteAsk = alice.page.locator('[data-stack-id][aria-label*="Memnite"]');
      await expect(memniteAsk, 'Memnite is offered as the target choice').toHaveCount(1, { timeout: 10_000 });

      // Answer the target ask, then pay {U}{U} — Auto settles the whole cost
      // in one press — whichever of the two Forge is currently asking for.
      await expect.poll(
        async () => {
          const text = await says(alice.page);
          if (/Pay Mana Cost/i.test(text)) await clickOnce(alice.page, text, 'ok');
          else await memniteAsk.click().catch(() => undefined);
          return stackCount(alice.page);
        },
        { timeout: 20_000, message: 'Counterspell reached the stack' },
      ).toBe(2);

      const counterItem = alice.page.locator('[data-stack-id][aria-label*="Counterspell"]');
      const memniteItem = alice.page.locator('[data-stack-id][aria-label*="Memnite"]');
      await expect(counterItem, 'Counterspell is its own stack item').toHaveCount(1, { timeout: 10_000 });
      await expect(memniteItem, 'Memnite’s stack item is still up, not yet resolved').toHaveCount(1);

      const counterId = await counterItem.getAttribute('data-stack-id');
      const memniteStackId = await memniteItem.getAttribute('data-stack-id');
      const key = `stack-target:${counterId}:${memniteStackId}`;
      await expect(
        alice.page.locator(`[data-testid="stack-target-arrow"][data-key="${key}"]`),
        'the counterspell arc is drawn, Counterspell → Memnite',
      ).toHaveCount(1, { timeout: 10_000 });

      const shot = await alice.page.evaluate(shootStackArc, [key, counterId!, memniteStackId!] as [string, string, string]);
      expect(shot.fromBox, 'Counterspell’s own thumbnail has a real box').not.toBeNull();
      expect(shot.toBox, 'Memnite’s thumbnail has a real box').not.toBeNull();
      expect(shot.tail, 'the arc has a tail').not.toBeNull();
      expect(shot.tip, 'the arc has a tip').not.toBeNull();

      // The manager's own ask: both endpoints sit INSIDE the two thumbnail boxes.
      expect(
        inside(shot.tail!, shot.fromBox!),
        `the tail sits inside Counterspell's own thumbnail (${JSON.stringify(shot.tail)} vs ${JSON.stringify(shot.fromBox)})`,
      ).toBe(true);
      expect(inside(shot.tip!, shot.toBox!), `the tip sits inside Memnite's thumbnail (${JSON.stringify(shot.tip)} vs ${JSON.stringify(shot.toBox)})`).toBe(
        true,
      );

      // And more precisely: the tip is the nearest of Memnite's eight edge
      // points to the tail — the same snap `edgePointNearest` uses everywhere
      // else, not merely "somewhere inside".
      const nearestEdge = eight(shot.toBox!).reduce((best, p) => (away(p, shot.tail!) < away(best, shot.tail!) ? p : best));
      expect(
        away(shot.tip!, nearestEdge),
        `the tip is the nearest of Memnite's eight edge points to the tail (${JSON.stringify(shot.tip)} vs ${JSON.stringify(nearestEdge)})`,
      ).toBeLessThanOrEqual(1);
    } finally {
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  },
);
```

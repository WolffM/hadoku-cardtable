/**
 * Wave 49 §A — the counterspell arc, both directions, against a real Forge
 * match. Lands wave 46 §B's own WIP (`docs/planning/wave46-evidence/B/
 * counterspell-e2e-wip.md`), after diagnosing its parked-cast symptom: see
 * `docs/planning/wave49-evidence/A/README.md` for the verdict (a TEST bug —
 * the browser's act frame reaches the server every time; see that file for
 * the captured `WebSocket.send` traffic that proves it).
 *
 * ## Two tests, one mechanism each
 *
 * 1. **The caster's arc** (X3, from the WIP): alice casts Counterspell on
 *    bob's Memnite. Full control is ON for alice so Forge's single-legal-
 *    choice auto-answer does not resolve the whole exchange before this test
 *    can observe the two-item stack — see that test's own header for why.
 *    Drawn, like every arc here, straight off the BRIDGE's own wire fact
 *    (`stackTargetSpells`, below) — wave 64/J6 deleted the CASTER's own
 *    client-side pairing (`match.ts`'s `stackTargetArcs`) this test used to
 *    read, once the wire fact's own frame made it redundant for this seat too.
 *
 * 2. **The opponent's arc** (wave 49 §A item 3): the mirror scenario
 *    (`w49-a-counterspell-opponent.state`) — bob holds Counterspell, alice
 *    the free creature. Alice casts Memnite, bob counters it with NO click
 *    from this test (Forge's single-legal-choice ask auto-answers for him,
 *    same as alice's own cast auto-answers in test 1 when full control is
 *    off) — so alice, who answered no ask, can only see the arc from the
 *    BRIDGE's own wire fact (`PlayBridge.java`'s `stackTargetSpells`,
 *    `packages/forge-wire/src/tier-c.ts`'s `StackTargetSpellsSchema`, read by
 *    `adapter.ts` onto each `StackEntry.targetStackItemId` and drawn by
 *    `live/placed.ts`'s `.placed__arrow`s). Full control is ON for alice so
 *    SHE gets a window at her own priority to read the arc before anything
 *    resolves — the same role full control played in test 1, just assigned
 *    to the other seat this time.
 */

import { expect, test, type Page } from '@playwright/test';

import { castCard, clickOnce, makeTitled, offered, says, stackCount } from './play/board.ts';
import { answerLoneAbility } from './play/prompts.ts';
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

/** The four corners and the four edge midpoints of a box, centre excluded. */
const eight = (b: Box): Point[] => {
  const xs = [b.left, b.left + b.width / 2, b.left + b.width];
  const ys = [b.top, b.top + b.height / 2, b.top + b.height];
  return ys
    .flatMap((y, r) => xs.map((x, c) => ({ x, y, centre: r === 1 && c === 1 })))
    .filter((p) => !p.centre)
    .map(({ x, y }) => ({ x, y }));
};

/** The hand card named `name`, Forge-offered or not — by its own `.card__name` text. */
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
 * curve's tail/tip — all in ONE layout pass (a second `evaluate` is a second
 * task, and anything that re-rendered in between would be compared against a
 * box read from before it — `arrow.spec.ts`'s own header note). Runs in the
 * page.
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
  // §S: `live/placed.ts`'s own `.placed__arrow` superseded, and wave 64/J6 deleted,
  // the old `auto-targets.ts` `stackTargetArrows` producer — same geometry (`aimAt`),
  // a new testid/key scheme.
  const arrow = document.querySelector(`[data-testid="placed-arrow"][data-key="${key}"]`);
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

/**
 * Lift-and-release a hand card that needs a target, outside the hand, by raw
 * mouse events at the button's own point — never `locator.click()`, whose
 * actionability check refuses here (the battlefield's empty `.zone__tiers`
 * sits, per that check, over the hand card's own button at this viewport).
 * Retries the press (never the release) until `data-cast-lift` reads
 * `parked`: a second press after that would hit the (now relocated) card
 * again, which derails the whole exchange — confirmed empirically, wave 46 §B.
 *
 * **Diagnosed, wave 49 §A item 1**: this is exactly the WIP's own gesture,
 * unchanged. A `WebSocket.prototype.send` patch in the page during diagnosis
 * showed the `selectCard` act frame reaching the server on the FIRST press,
 * every time (`docs/planning/wave49-evidence/A/README.md`) — so the WIP's
 * "no act frame reaches the server" symptom was the test's own drive, not a
 * product bug. Nothing here is a workaround for that: it is the same
 * gesture, now proven to work.
 */
async function liftAndParkOutsideHand(page: Page, cardId: number): Promise<void> {
  const castLift = (): Promise<string | null> =>
    page.locator(`[data-board-card="${cardId}"]`).getAttribute('data-cast-lift').catch(() => null);
  for (let i = 0; i < 8 && (await castLift()) !== 'parked'; i++) {
    if (i > 0) await page.waitForTimeout(250);
    const btnBox = await page.locator(`[data-board-card="${cardId}"] button`).first().boundingBox();
    if (btnBox === null) continue;
    await page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
    if ((await castLift()) !== 'lifted') continue;
    const bf = await page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox();
    if (bf !== null) await page.mouse.click(bf.x + bf.width / 2, bf.y + bf.height / 2);
  }
  expect(await castLift(), `card ${cardId} is parked — the cast actually went out`).toBe('parked');
}


/**
 * Answer the stack-target ask for `name` (`ChoicePrompts.tsx`'s
 * `GetChoicesPrompt`, `data-prompt="getChoices"`): check the one choice
 * whose label names it, then submit. The WIP assumed this ask "opens no
 * selection and draws no modal" (`gestures/stack.ts`'s own header) and is
 * answered by clicking the board's own stack item instead — contradicted
 * directly: full control draws the ordinary checkbox-list modal for it, same
 * as any other `getChoices`, and the gesture layer is a second, independent
 * way to answer the SAME ask, not the only one. This uses the modal, because
 * it is what full control actually renders.
 */
async function answerStackTargetChoice(page: Page, name: string): Promise<boolean> {
  const prompt = page.locator('section[data-prompt="getChoices"]');
  if ((await prompt.count()) === 0) return false;
  const item = prompt.locator('li', { hasText: name }).first();
  if ((await item.count()) === 0) return false;
  const checkbox = item.locator('input[type="checkbox"]');
  // The `<label>` wraps the checkbox (`GetChoicesPrompt`'s own markup), so a
  // click on the INPUT itself is refused by Playwright's actionability check
  // ("<label>… intercepts pointer events") — measured directly, every retry,
  // every timeout. Clicking the LABEL is what a real press does; the browser's
  // own semantics forward it to the input exactly as a user's click would.
  if ((await checkbox.count()) > 0 && !(await checkbox.isChecked().catch(() => true))) {
    await item.locator('label').click().catch(() => undefined);
  }
  const submit = prompt.locator('[data-testid="prompt-submit"]');
  if ((await submit.count()) > 0 && (await submit.isEnabled().catch(() => false))) {
    await submit.click().catch(() => undefined);
  }
  return true;
}

/**
 * Pump a page through whatever Forge is currently asking THIS seat that a
 * plain OK/Pay-mana click (or a lone `getAbilityToPlay` offer) answers, until
 * `stackCount` reaches `want` — the same "whichever of the two Forge is
 * asking for" loop the WIP used for the caster's own mana payment,
 * generalised so either seat in either test can reuse it instead of a
 * bespoke poll each time.
 */
async function pumpToStackCount(page: Page, want: number, label: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const text = await says(page);
        if (await answerLoneAbility(page)) return stackCount(page);
        if (/Pay Mana Cost/i.test(text)) await clickOnce(page, text, 'ok');
        return stackCount(page);
      },
      { timeout: 20_000, message: label },
    )
    .toBe(want);
}

test.describe(titled('the counterspell arc'), () => {
  test('the caster’s own thumbnail arcs to the spell it targets, drawn in a real browser', async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);

    const stack = await startPlayStack(forge);
    let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
    try {
      seated = await startScenarioMatch(browser, stack, 'w46-b-counterspell');
      const { alice, bob } = seated;
      // A wider viewport: see `liftAndParkOutsideHand`'s own note — the
      // full-control banner adds a row that overlaps the hand button at the
      // harness's default size, every run, at every narrower size tried.
      await alice.page.setViewportSize({ width: 1600, height: 1000 });

      await alice.page.getByTestId('live-full-control').click();
      await expect(alice.page.getByTestId('live-full-control'), 'full control is on for alice').toHaveAttribute('aria-pressed', 'true');

      const memnite = await handCardNamed(bob.page, 'Memnite');
      expect(memnite, 'Memnite is in bob’s hand, as the scenario scripts').not.toBeUndefined();
      await castCard(bob.page, memnite!);
      await expect.poll(() => stackCount(alice.page), { timeout: 15_000, message: 'bob’s Memnite reached the stack' }).toBe(1);

      const counterspellId = await handCardNamed(alice.page, 'Counterspell');
      expect(counterspellId, 'Counterspell is in alice’s hand, as the scenario scripts').not.toBeUndefined();
      const counterspell = counterspellId!;
      await expect.poll(() => offered(alice.page), { timeout: 15_000, message: 'alice is offered her Counterspell' }).toContain(counterspell);

      await liftAndParkOutsideHand(alice.page, counterspell);

      const memniteAsk = alice.page.locator('[data-stack-id][aria-label*="Memnite"]');
      await expect(memniteAsk, 'Memnite is on the stack already (sanity check)').toHaveCount(1, { timeout: 10_000 });

      // Full control means NOTHING auto-answers (`LiveBoard.tsx`'s own gate on
      // `selfAnswer`) — not only the stack-target ask, but the `getAbilityToPlay`
      // ask Counterspell's own cast opens FIRST (one ability, "Counter target
      // spell."), before Forge ever asks for the target. Click through both,
      // in whichever order Forge is currently asking for.
      await expect
        .poll(
          async () => {
            const text = await says(alice.page);
            if (await answerLoneAbility(alice.page)) return stackCount(alice.page);
            if (await answerStackTargetChoice(alice.page, 'Memnite')) return stackCount(alice.page);
            if (/Pay Mana Cost/i.test(text)) await clickOnce(alice.page, text, 'ok');
            return stackCount(alice.page);
          },
          { timeout: 20_000, message: 'Counterspell reached the stack' },
        )
        .toBe(2);

      const counterItem = alice.page.locator('[data-stack-id][aria-label*="Counterspell"]');
      const memniteItem = alice.page.locator('[data-stack-id][aria-label*="Memnite"]');
      await expect(counterItem, 'Counterspell is its own stack item').toHaveCount(1, { timeout: 10_000 });
      await expect(memniteItem, 'Memnite’s stack item is still up, not yet resolved').toHaveCount(1);

      const counterId = await counterItem.getAttribute('data-stack-id');
      const memniteStackId = await memniteItem.getAttribute('data-stack-id');
      const key = `${counterId}:stack:${memniteStackId}`;
      await expect(
        alice.page.locator(`[data-testid="placed-arrow"][data-key="${key}"]`),
        'the counterspell arc is drawn, Counterspell → Memnite',
      ).toHaveCount(1, { timeout: 10_000 });

      const shot = await alice.page.evaluate(shootStackArc, [key, counterId!, memniteStackId!] as [string, string, string]);
      expect(shot.fromBox, 'Counterspell’s own thumbnail has a real box').not.toBeNull();
      expect(shot.toBox, 'Memnite’s thumbnail has a real box').not.toBeNull();
      expect(shot.tail, 'the arc has a tail').not.toBeNull();
      expect(shot.tip, 'the arc has a tip').not.toBeNull();

      expect(inside(shot.tail!, shot.fromBox!), `the tail sits inside Counterspell's own thumbnail`).toBe(true);
      expect(inside(shot.tip!, shot.toBox!), `the tip sits inside Memnite's thumbnail`).toBe(true);

      // Ledger Z9 (`aimAt`, `gestures/arrow.ts`; its ADJACENT_PX, which this tsconfig cannot import): a target within 72px of the tail — the next thumbnail in the stack row is — takes the
      // tip at its centre, so the shaft crosses the cards instead of vanishing in the gap; a farther one, at its nearest edge.
      const centre = { x: shot.toBox!.left + shot.toBox!.width / 2, y: shot.toBox!.top + shot.toBox!.height / 2 };
      const nearestEdge = eight(shot.toBox!).reduce((best, p) => (away(p, shot.tail!) < away(best, shot.tail!) ? p : best));
      const aimed = away(shot.tail!, centre) < 72 ? centre : nearestEdge;
      expect(away(shot.tip!, aimed), `the tip is Memnite's centre when adjacent to the tail, else the nearest of its eight edge points`).toBeLessThanOrEqual(1);
    } finally {
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  });

  test('the opponent sees the arc too, off the bridge’s own wire fact — she answered no ask and holds no client-side intent', async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);

    const stack = await startPlayStack(forge);
    let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
    try {
      seated = await startScenarioMatch(browser, stack, 'w49-a-counterspell-opponent');
      const { alice, bob } = seated;
      await alice.page.setViewportSize({ width: 1600, height: 1000 });

      // Full control for ALICE this time: she is the OPPONENT (the victim of
      // the counter, never asked a thing), and it is HER priority stop that
      // must hold the resolve so this test has a window to read the arc on
      // HER OWN page — the same role it played for the caster in the test
      // above, just assigned to the other seat.
      await alice.page.getByTestId('live-full-control').click();
      await expect(alice.page.getByTestId('live-full-control'), 'full control is on for alice').toHaveAttribute('aria-pressed', 'true');

      const memnite = await handCardNamed(alice.page, 'Memnite');
      expect(memnite, 'Memnite is in alice’s hand, as the mirror scenario scripts').not.toBeUndefined();
      await castCard(alice.page, memnite!);
      await expect.poll(() => stackCount(alice.page), { timeout: 15_000, message: 'alice’s own Memnite reached the stack' }).toBe(1);

      // Alice just cast; Forge gives priority back to the active player (her)
      // first. Full control means she does not auto-pass it — one OK click
      // on her own priority stop lets bob act.
      await expect
        .poll(async () => (/^Priority:/.test(await says(alice.page)) ? await clickOnce(alice.page, await says(alice.page), 'ok') : false), {
          timeout: 10_000,
          message: 'alice passes priority on her own cast Memnite',
        })
        .toBe(true);

      // Bob casts Counterspell — a targeted spell, so the lift-and-park
      // gesture (never `castCard`'s plain click, see that helper's own note)
      // — with NO full control and no click from this test for the target
      // itself: Forge's own single-legal-choice ask auto-answers it
      // (`selfAnswer`), exactly the mechanism the test above relies on
      // for whichever seat has full control off.
      const counterspell = await handCardNamed(bob.page, 'Counterspell');
      expect(counterspell, 'Counterspell is in bob’s hand, as the mirror scenario scripts').not.toBeUndefined();
      await liftAndParkOutsideHand(bob.page, counterspell!);

      // Bob's own mana payment is a plain OK/Pay-Mana pump — on BOB's page,
      // since he is the one Forge is asking.
      await pumpToStackCount(bob.page, 2, 'Counterspell reached the stack (bob’s own cast)');

      const counterItem = alice.page.locator('[data-stack-id][aria-label*="Counterspell"]');
      const memniteItem = alice.page.locator('[data-stack-id][aria-label*="Memnite"]');
      await expect(counterItem, 'Counterspell is its own stack item, on alice’s page').toHaveCount(1, { timeout: 10_000 });
      await expect(memniteItem, 'Memnite’s stack item is still up, on alice’s page').toHaveCount(1);

      const counterId = await counterItem.getAttribute('data-stack-id');
      const memniteStackId = await memniteItem.getAttribute('data-stack-id');
      const key = `${counterId}:stack:${memniteStackId}`;

      // The proof: ALICE's own page draws the arc. She never answered a
      // `getChoices` ask (bob did, auto-answered) — the wire fact
      // `adapter.ts` reads onto `StackEntry.targetStackItemId` is the only
      // source there ever was for her, and (wave 64/J6) the only source at
      // all now.
      await expect(
        alice.page.locator(`[data-testid="placed-arrow"][data-key="${key}"]`),
        'the counterspell arc is drawn on ALICE’s page — the opponent, not the caster',
      ).toHaveCount(1, { timeout: 10_000 });

      const shot = await alice.page.evaluate(shootStackArc, [key, counterId!, memniteStackId!] as [string, string, string]);
      expect(shot.fromBox, 'Counterspell’s own thumbnail has a real box').not.toBeNull();
      expect(shot.toBox, 'Memnite’s thumbnail has a real box').not.toBeNull();
      expect(shot.tail, 'the arc has a tail').not.toBeNull();
      expect(shot.tip, 'the arc has a tip').not.toBeNull();
      expect(inside(shot.tail!, shot.fromBox!), `the tail sits inside Counterspell's own thumbnail`).toBe(true);
      expect(inside(shot.tip!, shot.toBox!), `the tip sits inside Memnite's thumbnail`).toBe(true);
    } finally {
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  });
});

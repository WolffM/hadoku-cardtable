/**
 * Wave 59 §P item 3 — the operator's own situation (AD4's design boards,
 * https://claude.ai/artifact/DBNEciEeHeFXwsChCGx3C5), against real Forge and
 * both screens at once: alice casts Keiga, the Tide Star (placed by a drag);
 * bob casts Hinder on it (placed); alice casts Remand on Hinder. The whole
 * exchange proves S's `placed.ts` DOM contract (`[data-placed-spell]`,
 * `data-placed-next`, `.placed__arrow[data-for]`), W's mirrored copy on the
 * OTHER screen, AD4 rule 6's "Resolve {name}?" wording (lane P's own
 * `decisionMessage`), and the chain reaction's pacing in one real match.
 *
 * ## Why full control, and only for alice, and only from the third cast on
 *
 * Measured directly (a throwaway jvm-only script, never committed): with full control off, once alice casts Remand
 * neither seat has anything left to do (both hands and all lands are spent),
 * so the server's own auto-pass (`auto.ts`'s `decideStop`, `passOwnSpell` and
 * `passWhenNothingToDo`) drains BOTH players' priority and Forge resolves the
 * entire three-item stack — Remand, then Keiga — before a human ever reads
 * "Stack: 3 to Resolve.": the very next prompt read "Stack: Empty". Full
 * control for alice (same mechanism `e2e/w49-counterspell.spec.ts` uses) is
 * what turns each of HER priority stops back into a real stop, so this spec
 * can observe the static three-item moment and press "Resolve {name}?"
 * itself, exactly as the design boards show. Bob never gets full control:
 * his own stops (does he have anything castable right now?) are already
 * real ones without it, and once his hand and mana are spent he SHOULD
 * auto-pass — that is the chain actually chaining, not a test workaround.
 *
 * ## "Three arrows" vs. two
 *
 * The wave file's own prose says "three arrows with the right `data-for`"
 * for the three-item moment. Keiga, the Tide Star's only ability is a DEATH
 * trigger ("When Keiga, the Tide Star dies, gain control of target
 * creature"), not an ETB — casting it opens no target ask at all
 * (`forge/forge-gui/res/cardsfolder/k/keiga_the_tide_star.txt`). The only two
 * targeting relationships that exist among these three stack items are
 * Hinder → Keiga and Remand → Hinder, so this spec asserts exactly TWO
 * `.placed__arrow[data-for]` elements, not three — a decision, not a typo
 * fix, since the wave file is Settled and this lane does not edit it.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`);
 * without one every test SKIPs and its title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page, type Locator } from '@playwright/test';

import { clickHandCard, clickOnce, dragHandCard, handCardNamed, makeTitled, offered, says, serverLog, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { closeHeaderSettings, openHeaderSettings } from './play/w32.ts';

/**
 * Fast Mode is ON by default inside the e2e harness (`prefs.ts`'s override); the chain is the
 * pacer's, so it goes off first — and the spec PROVES it went off: the checkbox read on, the
 * click took, and the server logged this seat's `info` row with `fastMode: false` (the client
 * telemetry every settings change writes).
 */
async function turnFastModeOff(page: Page, stack: { serverLogFile: string }, seat: number): Promise<void> {
  const toggle = (await openHeaderSettings(page)).locator('[data-testid="live-settings-fast-mode"]');
  await expect(toggle, `seat ${seat}: the Fast Mode box reads ON before the click (the harness default)`).toBeChecked();
  await toggle.click();
  await expect(toggle, `seat ${seat}: the click took`).not.toBeChecked();
  await closeHeaderSettings(page);
  await expect
    .poll(() => serverLog(stack).some((r) => r.evt === 'client' && r.kind === 'info' && r.seat === seat && r.fastMode === false), {
      timeout: 10_000,
      message: `seat ${seat}: the server logged Fast Mode off`,
    })
    .toBe(true);
}

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface Point {
  x: number;
  y: number;
}

/** Pixel-exact, for a point and an element on the SAME screen (`played-card.spec.ts`'s own `near`). */
const near = (a: Point, b: Point, px = 10): boolean => Math.abs(a.x - b.x) <= px && Math.abs(a.y - b.y) <= px;

async function centerOf(locator: Locator): Promise<Point | null> {
  const box = await locator.boundingBox();
  return box === null ? null : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Whether `locator`'s own centre falls inside `zoneSelector`'s box on the SAME page — `presence.spec.ts`'s own inX/inY check, a few px of slack for float rounding. */
async function insideZone(page: Page, locator: Locator, zoneSelector: string): Promise<boolean> {
  const zone = await page.locator(zoneSelector).boundingBox();
  const c = await centerOf(locator);
  if (zone === null || c === null) return false;
  return c.x >= zone.x - 4 && c.x <= zone.x + zone.width + 4 && c.y >= zone.y - 4 && c.y <= zone.y + zone.height + 4;
}

/** `[data-placed-spell]` whose own `CardTile` names `name` — the one attribute S's contract commits to is the id, not a name, so this reads the same `.card__name` text every hand/board card already carries. */
const placedSpell = (page: Page, name: string): Locator =>
  page.locator('[data-placed-spell]').filter({ has: page.locator('.card__name', { hasText: name }) });

async function placedSpellId(page: Page, name: string): Promise<string> {
  const id = await placedSpell(page, name).getAttribute('data-placed-spell');
  if (id === null) throw new Error(`no [data-placed-spell] named "${name}" on this page`);
  return id;
}

/**
 * Answer a "Select target spell" `getChoices` ask by the label naming `name`
 * — the ordinary ask flow (`GetChoicesPrompt`, `e2e/play/prompts.ts`'s own
 * `answerPrompt` ticks the FIRST option, which is wrong here once two spells
 * are both legal targets). `false` with nothing touched when no such ask is
 * showing, or it names no option with this text, so a caller can poll it on
 * every tick alongside a plain mana-cost click.
 */
async function answerTargetChoice(page: Page, name: string): Promise<boolean> {
  const sheet = page.getByTestId('live-prompt');
  if ((await sheet.count()) === 0 || (await sheet.getAttribute('data-method')) !== 'getChoices') return false;
  const item = sheet.locator('li', { hasText: name }).first();
  if ((await item.count()) === 0) return false;
  const checkbox = item.locator('input[data-testid="prompt-choice"]');
  if ((await checkbox.count()) === 0) return false;
  if (!(await checkbox.isChecked().catch(() => false))) await checkbox.click({ force: true }).catch(() => undefined);
  const submit = sheet.getByTestId('prompt-submit');
  if ((await submit.count()) > 0 && (await submit.isEnabled().catch(() => false))) await submit.click().catch(() => undefined);
  return true;
}

/**
 * The ONE cast step every spell in this spec goes through: a held drag from
 * the hand to `to` (AD4 rule 2/3 — "placed by a drag", never a plain click),
 * then whatever Forge asks next (a plain mana payment; the stack-target ask,
 * answered by `targetName` when given, else left to the single-legal-choice
 * auto-answer the way Hinder's own cast reaches it) until the stack count on
 * `page` changes.
 */
async function castByDrag(page: Page, stack: { serverLogFile: string }, cardId: number, to: Point, targetName?: string): Promise<void> {
  const before = await stackCount(page);
  // Not before Forge offers it: a drag released before the offer is a no-op, and the first act after
  // a scenario start can be dropped outright (ledger AB15, `PlayBridge.java`'s `refreshActionable`) —
  // so the drag is repeated, bounded, while the card is still in the hand and the stack unchanged.
  await expect.poll(() => offered(page), { timeout: 45_000, message: `card ${cardId} is offered` }).toContain(cardId);
  const inHand = () => page.locator(`[data-zone="hand"][data-owner="you"] [data-board-card="${cardId}"]`).count();
  for (let attempt = 0; attempt < 3; attempt++) {
    // A press that does not lift (the offer moved between the poll and the press) is not a failure
    // yet: the next attempt waits for the offer again.
    if (!(await dragHandCard(page, cardId, to))) {
      await expect.poll(() => offered(page), { timeout: 10_000 }).toContain(cardId).catch(() => undefined);
      continue;
    }
    const arrived = await expect
      .poll(
        async () => {
          const text = await says(page);
          if (/Pay Mana Cost/i.test(text)) await clickOnce(page, text, 'ok');
          if (targetName !== undefined) await answerTargetChoice(page, targetName);
          return stackCount(page);
        },
        { timeout: 8_000 },
      )
      .not.toBe(before)
      .then(
        () => true,
        () => false,
      );
    if (arrived) return;
    if ((await inHand()) === 0) break;
  }
  // Name what happened before failing: what the server saw played, and what this page draws.
  const placements = serverLog(stack).filter((r) => r.evt === 'placement').map((r) => `seat ${String(r.seat)} card ${String(r.card)}`);
  const hand = await page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-board-card')}:${e.querySelector('.card__name')?.textContent?.trim() ?? ''}`));
  expect(
    await stackCount(page),
    `card ${cardId} reached the stack — placements on the server: [${placements.join(', ')}]; this hand now: [${hand.join(', ')}]; says: "${await says(page)}"`,
  ).not.toBe(before);
}

/** A press-drag-release of an ALREADY-PLACED spell (S's rule 5) — no cast, no target, just a move. */
async function dragPlacedSpell(page: Page, locator: Locator, to: Point): Promise<void> {
  const from = await centerOf(locator);
  if (from === null) throw new Error('no box for the placed spell being dragged');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

test(
  titled(
    'Keiga, Hinder, Remand: three placed spells on both screens, two arrows, the chain resolves one at a time with the right words',
  ),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    // Where this stands (the tracker, 2026-10-08, runs 37763694613 → 37765728857): Keiga's drag-cast
    // is placed (server `placement` card 160), bob's Hinder reaches the stack, and Remand's drag-cast
    // — a TARGETED spell, parked by the drag, its target Hinder's placed card clicked — never reaches
    // the stack (`says` stays "Priority: Alice"). The next wave's first item; the day it passes is its land.
    test.fail(true, 'Remand’s targeted drag-cast never reaches the stack after its placed target is clicked (ledger AD4)');
    test.setTimeout(3 * 60_000);

    const stack = await startPlayStack(forge);
    let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
    try {
      seated = await startScenarioMatch(browser, stack, 'w59-keiga');
      const { alice, bob } = seated;
      for (const p of [alice.page, bob.page]) await p.setViewportSize({ width: 1600, height: 1000 });

      const herField = (await alice.page.locator('[data-zone="battlefield"][data-owner="you"]').boundingBox())!;
      const hisField = (await bob.page.locator('[data-zone="battlefield"][data-owner="you"]').boundingBox())!;
      const keigaPoint: Point = { x: Math.round(herField.x + herField.width * 0.25), y: Math.round(herField.y + herField.height * 0.5) };
      const hinderPoint: Point = { x: Math.round(hisField.x + hisField.width * 0.5), y: Math.round(hisField.y + hisField.height * 0.5) };
      const remandPoint: Point = { x: Math.round(herField.x + herField.width * 0.75), y: Math.round(herField.y + herField.height * 0.5) };

      /* ── alice casts Keiga, the Tide Star (no target — a death trigger, not an ETB) ── */
      // Which `<li>` carries which names, verbatim: run 37763694613 dragged 161 for Keiga and the server
      // played 160 — the shared reader matched a `.card__name` that was not the card's own.
      const handNames = await alice.page
        .locator('[data-zone="hand"][data-owner="you"] [data-board-card]')
        .evaluateAll((els) => els.map((e) => `${e.tagName.toLowerCase()}#${e.getAttribute('data-board-card')}=[${Array.from(e.querySelectorAll('.card__name')).map((n) => n.textContent?.trim()).join(' | ')}]`));
      console.log('[w59-hand]', handNames.join(' ; '));
      // The id of the `<li>` whose OWN face names Keiga (`:scope >`), not the first `.card__name` under it.
      const keigaCardId = await alice.page
        .locator('[data-zone="hand"][data-owner="you"] li[data-board-card]')
        .evaluateAll((els) =>
          els
            .filter((e) => e.querySelector(':scope > .board-card__face .card__name')?.textContent?.trim() === 'Keiga, the Tide Star')
            .map((e) => Number(e.getAttribute('data-board-card'))),
        )
        .then((ids) => ids[0]);
      expect(keigaCardId, `Keiga is in alice’s hand, as the scenario scripts — hand: ${handNames.join(' ; ')}`).not.toBeUndefined();
      await castByDrag(alice.page, stack, keigaCardId!, keigaPoint);
      await expect.poll(() => stackCount(alice.page), { timeout: 10_000, message: 'Keiga reached the stack' }).toBe(1);

      /* ── bob is offered Hinder once priority auto-passes to him (alice has nothing further forced on her own cast) ── */
      const hinderCardId = await handCardNamed(bob.page, 'Hinder');
      expect(hinderCardId, 'Hinder is in bob’s hand, as the scenario scripts').not.toBeUndefined();
      await expect.poll(() => offered(bob.page), { timeout: 15_000, message: 'bob is offered Hinder' }).toContain(hinderCardId);

      /* ── bob casts Hinder on Keiga — the only spell up, so the target ask auto-answers ── */
      await castByDrag(bob.page, stack, hinderCardId!, hinderPoint);
      await expect.poll(() => stackCount(bob.page), { timeout: 10_000, message: 'Hinder reached the stack, targeting Keiga' }).toBe(2);

      /* ── alice is offered Remand once priority auto-passes back to her ── */
      const remandCardId = await handCardNamed(alice.page, 'Remand');
      expect(remandCardId, 'Remand is in alice’s hand, as the scenario scripts').not.toBeUndefined();
      await expect.poll(() => offered(alice.page), { timeout: 15_000, message: 'alice is offered Remand' }).toContain(remandCardId);

      /* ── full control for alice ONLY, from here on — see the module header ── */
      await alice.page.getByTestId('live-full-control').click();
      await expect(alice.page.getByTestId('live-full-control'), 'full control is on for alice').toHaveAttribute('aria-pressed', 'true');

      /* ── alice casts Remand on Hinder — TWO legal spell targets now (Hinder, Keiga), so this is a real choice, not an auto-answer ── */
      // A targeted spell let go over the table parks and waits for its target to be CLICKED (the arrow
      // follows the pointer to it): Hinder's placed card is that target now — never a list.
      await expect.poll(() => offered(alice.page), { timeout: 45_000, message: 'Remand is offered' }).toContain(remandCardId);
      expect(await dragHandCard(alice.page, remandCardId!, remandPoint), 'Remand armed the drag-cast gesture').toBe(true);
      await expect(placedSpell(alice.page, 'Hinder'), 'Hinder, the target, is a placed card to click').toHaveCount(1, { timeout: 10_000 });
      await placedSpell(alice.page, 'Hinder').click();
      await expect
        .poll(
          async () => {
            const text = await says(alice.page);
            if (/Pay Mana Cost/i.test(text)) await clickOnce(alice.page, text, 'ok');
            await answerTargetChoice(alice.page, 'Hinder');
            return stackCount(alice.page);
          },
          { timeout: 20_000, message: 'Remand reached the stack after its target was clicked' },
        )
        .toBe(3);
      await expect.poll(() => stackCount(alice.page), { timeout: 10_000, message: 'Remand reached the stack, targeting Hinder' }).toBe(3);
      await expect.poll(() => stackCount(bob.page), { timeout: 10_000, message: 'bob’s own screen also reads three' }).toBe(3);

      /** Whether `name`'s own placed spell on `page` carries `data-placed-next` at all — never its value, which the flash keyframe owns. */
      const carriesNext = async (page: Page, name: string): Promise<boolean> =>
        placedSpell(page, name).evaluate((el) => el.hasAttribute('data-placed-next'));

      /* ── the static three-item moment: three placed spells on BOTH screens, at the places they were released, nothing has left ── */
      for (const page of [alice.page, bob.page]) {
        await expect(placedSpell(page, 'Keiga, the Tide Star'), 'Keiga is a placed spell').toHaveCount(1, { timeout: 10_000 });
        await expect(placedSpell(page, 'Hinder'), 'Hinder is a placed spell').toHaveCount(1);
        await expect(placedSpell(page, 'Remand'), 'Remand is a placed spell').toHaveCount(1);
        expect(await carriesNext(page, 'Remand'), 'Remand, the top of the stack, carries data-placed-next alone').toBe(true);
        expect(await carriesNext(page, 'Keiga, the Tide Star'), 'Keiga does not carry data-placed-next yet').toBe(false);
        expect(await carriesNext(page, 'Hinder'), 'Hinder does not carry data-placed-next').toBe(false);
      }

      const hinderStackId = await placedSpellId(alice.page, 'Hinder');
      const remandStackId = await placedSpellId(alice.page, 'Remand');

      for (const page of [alice.page, bob.page]) {
        // Two arrows, not three — see the module header.
        await expect(page.locator('.placed__arrow[data-for]'), 'exactly two arrows: Hinder → Keiga, Remand → Hinder').toHaveCount(2, { timeout: 10_000 });
        await expect(page.locator(`.placed__arrow[data-for="${hinderStackId}"]`), 'Hinder’s own arrow').toHaveCount(1);
        await expect(page.locator(`.placed__arrow[data-for="${remandStackId}"]`), 'Remand’s own arrow').toHaveCount(1);
      }

      // Released where they were let go: pixel-exact on the caster's own screen, inside the opponent's equivalent zone on the other.
      expect(near((await centerOf(placedSpell(alice.page, 'Keiga, the Tide Star')))!, keigaPoint), 'Keiga sits where alice released it, on her own screen').toBe(true);
      expect(
        await insideZone(bob.page, placedSpell(bob.page, 'Keiga, the Tide Star'), '[data-zone="battlefield"][data-owner="them"]'),
        'Keiga sits inside alice’s battlefield as bob draws it',
      ).toBe(true);
      expect(near((await centerOf(placedSpell(bob.page, 'Hinder')))!, hinderPoint), 'Hinder sits where bob released it, on his own screen').toBe(true);
      expect(
        await insideZone(alice.page, placedSpell(alice.page, 'Hinder'), '[data-zone="battlefield"][data-owner="them"]'),
        'Hinder sits inside bob’s battlefield as alice draws it',
      ).toBe(true);
      expect(near((await centerOf(placedSpell(alice.page, 'Remand')))!, remandPoint), 'Remand sits where alice released it, on her own screen').toBe(true);

      await expect(bob.page.getByTestId('live-says'), 'nothing has left: the status line still names three to resolve').toContainText('Stack: 3 to Resolve');

      /* ── alice drags Keiga and Hinder's arrow follows, on both screens ── */
      const dragTo: Point = { x: Math.round(herField.x + herField.width * 0.4), y: Math.round(herField.y + herField.height * 0.25) };
      await dragPlacedSpell(alice.page, placedSpell(alice.page, 'Keiga, the Tide Star'), dragTo);
      for (const page of [alice.page, bob.page]) {
        await expect
          .poll(
            async () => {
              const keigaBox = await centerOf(placedSpell(page, 'Keiga, the Tide Star'));
              const arrowBox = await page.locator(`.placed__arrow[data-for="${hinderStackId}"]`).boundingBox();
              return keigaBox !== null && arrowBox !== null && keigaBox.y <= arrowBox.y + arrowBox.height + 20;
            },
            { timeout: 10_000, message: 'Hinder’s arrow followed Keiga to its new spot' },
          )
          .toBe(true);
      }

      /* ── resolve Remand: it fades, Hinder leaves (bounced to bob's hand, not a resolution of its own), the flash moves to Keiga ── */
      await expect(alice.page.getByTestId('live-decision'), 'AD4 rule 6: the words name the top of the stack').toContainText('Resolve Remand?');
      await alice.page.getByTestId('live-decision-ok').click();

      await expect.poll(() => stackCount(alice.page), { timeout: 15_000, message: 'Remand resolved, Hinder bounced: one item left' }).toBe(1);
      await expect.poll(() => stackCount(bob.page), { timeout: 10_000, message: 'bob’s own screen agrees' }).toBe(1);
      for (const page of [alice.page, bob.page]) {
        await expect(placedSpell(page, 'Remand'), 'Remand is gone').toHaveCount(0);
        await expect(placedSpell(page, 'Hinder'), 'Hinder is gone').toHaveCount(0);
        await expect(placedSpell(page, 'Keiga, the Tide Star'), 'Keiga is the only one left').toHaveCount(1);
        expect(await carriesNext(page, 'Keiga, the Tide Star'), 'and now carries the flash').toBe(true);
      }
      expect(await handCardNamed(bob.page, 'Hinder'), 'Hinder is back in bob’s own hand, countered by Remand, never resolved itself').not.toBeUndefined();

      /* ── resolve Keiga: it lands in its own column ── */
      await expect(alice.page.getByTestId('live-decision'), 'AD4 rule 6, Keiga’s full name').toContainText('Resolve Keiga, the Tide Star?');
      await alice.page.getByTestId('live-decision-ok').click();

      await expect.poll(() => stackCount(alice.page), { timeout: 15_000, message: 'Keiga resolved: the stack is empty' }).toBe(0);
      await expect.poll(() => stackCount(bob.page), { timeout: 10_000, message: 'bob’s own screen agrees' }).toBe(0);
      for (const page of [alice.page, bob.page]) {
        await expect(placedSpell(page, 'Keiga, the Tide Star'), 'Keiga is no longer a placed spell').toHaveCount(0);
      }
      await expect(alice.page.locator(`[data-zone="battlefield"][data-owner="you"] [data-board-card="${keigaCardId}"]`), 'Keiga is a permanent on alice’s own battlefield').toHaveCount(1, { timeout: 10_000 });
      await expect(bob.page.locator(`[data-zone="battlefield"][data-owner="them"] [data-board-card="${keigaCardId}"]`), 'and on bob’s screen, in her column').toHaveCount(1);
    } finally {
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  },
);

/**
 * Wave 59 §P item 2 — the chain-reaction measurement, against real Forge.
 * Independent of S and W: nothing here reads `[data-placed-spell]`, only
 * `[data-zone="stack"]`'s own `data-count`, which the placed-cards layer leaves
 * as it was.
 *
 * Four independent Opt casts (alice, bob, alice, bob — an INSTANT, so each
 * can be cast in response to the one before it; see `scenarios/w59-keiga
 * .state`'s own header for why a 0-cost CREATURE version of this does not
 * work: sorcery speed only, refused the instant anything else is on the
 * stack), then the whole four-item stack is let drain — each departure a
 * separate `data-count` mutation, timestamped in the PAGE by
 * `performance.now()` and read back into Node, which is what actually
 * reaches a claw's job log (`console.log` INSIDE `page.evaluate` writes to
 * the browser's own console, never this process's stdout).
 */
test(
  titled('the chain reaction: a four-item stack drains one departure at a time, each spaced by the pacer’s own 600 ms'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(2 * 60_000);

    const stack = await startPlayStack(forge);
    let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
    try {
      seated = await startScenarioMatch(browser, stack, 'w59-keiga');
      const { alice, bob } = seated;

      /** Cast the one Opt in `page`'s own hand, then drain whatever Forge asks next (mana, Opt's own Scry choice) until the stack changes — the same generic "press whatever bar is up" `keepHands` uses at the JVM layer, translated to the browser. */
      await turnFastModeOff(alice.page, stack, 0);
      await turnFastModeOff(bob.page, stack, 1);
      const castQuicken = async (page: Page): Promise<void> => {
        const before = await stackCount(page);
        const optId = await handCardNamed(page, 'Quicken');
        expect(optId, 'a Quicken is in this seat’s own hand').not.toBeUndefined();
        await clickHandCard(page, optId!);
        await expect
          .poll(
            async () => {
              const text = await says(page);
              if (!/^Priority:/.test(text)) await clickOnce(page, text, 'ok');
              return stackCount(page);
            },
            { timeout: 15_000, message: 'a Quicken reached the stack' },
          )
          .not.toBe(before);
      };

      await castQuicken(alice.page);
      await expect.poll(() => offered(bob.page), { timeout: 15_000, message: 'bob is offered his own Quicken' }).not.toEqual([]);
      await castQuicken(bob.page);
      await expect.poll(() => offered(alice.page), { timeout: 15_000, message: 'alice is offered her second Quicken' }).not.toEqual([]);
      await castQuicken(alice.page);
      await expect.poll(() => offered(bob.page), { timeout: 15_000, message: 'bob is offered his second Quicken' }).not.toEqual([]);
      await castQuicken(bob.page);
      await expect.poll(() => stackCount(alice.page), { timeout: 15_000, message: 'all four Quickens are on the stack' }).toBe(4);

      // THE MEASUREMENT: start logging only now, so the climb to four (0→1→2→3→4, each already
      // spaced by the SAME pacer) never pollutes the drain-phase numbers below.
      await alice.page.evaluate(() => {
        const w = window as unknown as { __w59Chain: { t: number; count: string }[] };
        w.__w59Chain = [];
        const el = document.querySelector('[data-zone="stack"]');
        if (el === null) return;
        const log = () => w.__w59Chain.push({ t: performance.now(), count: el.getAttribute('data-count') ?? '0' });
        log();
        new MutationObserver(log).observe(el, { attributes: true, attributeFilter: ['data-count'] });
      });

      // Nobody has anything left (every Quicken and every land that paid for one is spent); let it drain,
      // pressing whatever bar either screen shows (never a cast of our own) until it is empty. Quicken, not
      // Opt: an Opt asks a scry question on resolution, and a stack of four of them never drains by itself.
      await expect
        .poll(
          async () => {
            for (const page of [alice.page, bob.page]) {
              const text = await says(page);
              await clickOnce(page, text, 'ok');
            }
            return stackCount(alice.page);
          },
          { timeout: 30_000, message: 'the four-item stack drains unattended' },
        )
        .toBe(0);

      const log = await alice.page.evaluate(() => (window as unknown as { __w59Chain: { t: number; count: string }[] }).__w59Chain);
      for (const entry of log) console.log('[w59-chain]', entry.t.toFixed(1), entry.count);

      // Every departure (a strictly DECREASING count — the pacer never reorders) is at least ~500 ms
      // after the one before it: 600 ms minus render/delivery slop, read generously so a real claw's
      // own jitter does not fail this on its own. The exact gaps go in `docs/planning/wave59-evidence/
      // P/chain.md`, read off THIS test's own `[w59-chain]` lines in the job log, not off this bound.
      const departures = log.filter((e) => e.count !== '4').map((e) => e.t);
      expect(departures.length, 'four items left the stack, four separate mutations').toBeGreaterThanOrEqual(4);
      for (let i = 1; i < departures.length; i++) {
        expect(departures[i]! - departures[i - 1]!, `departure ${i} is spaced from departure ${i - 1}`).toBeGreaterThanOrEqual(500);
      }
    } finally {
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  },
);

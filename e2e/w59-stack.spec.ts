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

import { castByDrag, castCard, clickOnce, dragHandCard, handCardNamed, makeTitled, offered, resizeWindow, says, stackCount } from './play/board.ts'
import { turnFastModeOff } from './play/prefs.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

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


// `castByDrag` (T6): the identical drag-and-retry-and-wait-for-stack cast
// step, now `play/board.ts`'s own — one copy.

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
    test.setTimeout(3 * 60_000);

    const stack = await startPlayStack(forge);
    let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
    try {
      seated = await startScenarioMatch(browser, stack, 'w59-keiga');
      const { alice, bob } = seated;
      for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1600, height: 1000 });

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
      // Remand's one ability answers itself (`@hadoku/shared`'s `selfAnswer`), full control or not.
      // The stack-target ask, with TWO legal targets, is answered the way a player answers it: a click
      // on Hinder's placed card (`live/placed.ts` carries `data-stack-id` on it for exactly this;
      // `gestures/stack.ts`).
      await expect.poll(() => offered(alice.page), { timeout: 45_000, message: 'Remand is offered' }).toContain(remandCardId);
      expect(await dragHandCard(alice.page, remandCardId!, remandPoint), 'Remand armed the drag-cast gesture').toBe(true);
      await expect
        .poll(
          async () => {
            const text = await says(alice.page);
            if (/Pay Mana Cost/i.test(text)) await clickOnce(alice.page, text, 'ok');
            if ((await alice.page.locator('section[data-prompt="getChoices"]').count()) > 0) {
              await placedSpell(alice.page, 'Hinder').click({ timeout: 2_000 });
            }
            return stackCount(alice.page);
          },
          { timeout: 20_000, message: 'Remand reached the stack: Hinder’s placed card clicked as the target' },
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

      // A spell sits where it was let go: pixel-exact on the caster's own screen, inside the opponent's equivalent zone on
      // the other. A PERMANENT spell (Keiga) waits in the column its release reserved, where it will land — the
      // operator, 2026-10-08: the stand-in glides into the gap and waits there, "it must look the same" from both sides;
      // drawing it back at the release point was the back-and-forth AE37 removed (fb1c3ef).
      const keigaGap = await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.zone__gap[data-expected]').boundingBox();
      const keigaAt = (await centerOf(placedSpell(alice.page, 'Keiga, the Tide Star')))!;
      console.log(`[w59] keiga at ${Math.round(keigaAt.x)},${Math.round(keigaAt.y)} released ${Math.round(keigaPoint.x)},${Math.round(keigaPoint.y)} gap ${JSON.stringify(keigaGap)}`);
      expect(keigaGap, 'its release reserved a column').not.toBeNull();
      expect(near(keigaAt, { x: keigaGap!.x + keigaGap!.width / 2, y: keigaGap!.y + keigaGap!.height / 2 }), 'Keiga waits in its reserved column, on her own screen').toBe(true);
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

      // The status line of the seat HOLDING priority names the stack; the other seat's reads the
      // T2 banner ("Waiting for Alice…", `LiveBoard.tsx`) — bob's "nothing has left" is his three
      // placed spells and `stackCount` above (CI run 37788459694 read bob's line for this).
      await expect(alice.page.getByTestId('live-says'), 'nothing has left: the status line still names three to resolve').toContainText('Stack: 3 to Resolve');

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
 * Four independent Quicken casts (alice, bob, alice, bob — an INSTANT, so each
 * can be cast in response to the one before it; see `scenarios/w59-keiga
 * .state`'s own header for why a 0-cost CREATURE version of this does not
 * work: sorcery speed only, refused the instant anything else is on the
 * stack), then the whole four-item stack is let drain — each departure a
 * separate `data-count` mutation, timestamped in EACH page by
 * `performance.now()` and read back into Node, which is what actually
 * reaches a CI runner's job log (`console.log` INSIDE `page.evaluate` writes to
 * the browser's own console, never this process's stdout).
 *
 * Two of the operator's rulings meet here, and each screen is held to both:
 *
 * - 2026-10-08 (AD4 decision c): *"with several things on the stack they resolve one at a time with a
 *   small delay each — a chain reaction."* Every departure is its own mutation, one item at a time, and
 *   another player's item leaves after the pacer's `resolve` gap (600 ms, read here as ≥ 500).
 * - 2026-10-20 (AF216): *"shorten own-resolve pauses"* — *"i like the idea of lots of animations
 *   happening at the same time, seems fun."* The seat's OWN item resolving keeps no class gap
 *   (`pace.ts`, "The seat's own acts go out as Forge sends them"): it still leaves on its own, in order,
 *   but as soon as Forge sends it. How soon that is after the departure before it is Forge's timing, not
 *   the pacer's (measured: 160–190 ms on the seat whose previous departure was held, 440–680 ms on the
 *   other), so it is logged, not bounded; `pace.test.ts` pins that an own frame is never held.
 *
 * The stack drains top first, so the departures are bob's, alice's, bob's, alice's: on alice's screen
 * bob's are paced and hers are not, and on bob's the other way round.
 */
test(
  titled('the chain reaction: a four-item stack drains one departure at a time, the other player’s spaced by the pacer’s 600 ms'),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(2 * 60_000);

    const stack = await startPlayStack(forge);
    let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
    try {
      seated = await startScenarioMatch(browser, stack, 'w59-keiga');
      const { alice, bob } = seated;

      await turnFastModeOff(alice.page, stack, 0);
      await turnFastModeOff(bob.page, stack, 1);
      /** Cast the one Quicken in `page`'s own hand. */
      const castQuicken = async (page: Page): Promise<void> => {
        const quicken = await handCardNamed(page, 'Quicken');
        expect(quicken, 'a Quicken is in this seat’s own hand').not.toBeUndefined();
        await castCard(page, quicken!);
      };

      await castQuicken(alice.page);
      await expect.poll(() => offered(bob.page), { timeout: 15_000, message: 'bob is offered his own Quicken' }).not.toEqual([]);
      await castQuicken(bob.page);
      await expect.poll(() => offered(alice.page), { timeout: 15_000, message: 'alice is offered her second Quicken' }).not.toEqual([]);
      await castQuicken(alice.page);
      await expect.poll(() => offered(bob.page), { timeout: 15_000, message: 'bob is offered his second Quicken' }).not.toEqual([]);
      await castQuicken(bob.page);
      for (const page of [alice.page, bob.page]) {
        await expect.poll(() => stackCount(page), { timeout: 15_000, message: 'all four Quickens are on the stack, on both screens' }).toBe(4);
      }

      // THE MEASUREMENT: start logging only now, on both screens, so the climb to four (0→1→2→3→4)
      // never pollutes the drain-phase numbers below.
      for (const page of [alice.page, bob.page]) {
        await page.evaluate(() => {
          const w = window as unknown as { __w59Chain: { t: number; count: string }[] };
          w.__w59Chain = [];
          const el = document.querySelector('[data-zone="stack"]');
          if (el === null) return;
          const log = () => w.__w59Chain.push({ t: performance.now(), count: el.getAttribute('data-count') ?? '0' });
          log();
          new MutationObserver(log).observe(el, { attributes: true, attributeFilter: ['data-count'] });
        });
      }

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
            return Math.max(await stackCount(alice.page), await stackCount(bob.page));
          },
          { timeout: 30_000, message: 'the four-item stack drains unattended, on both screens' },
        )
        .toBe(0);

      // Bottom to top, the order they were cast in; the stack drains from the top.
      const casters = ['alice', 'bob', 'alice', 'bob'] as const;
      for (const [who, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
        const log = await page.evaluate(() => (window as unknown as { __w59Chain: { t: number; count: string }[] }).__w59Chain);
        for (const entry of log) console.log(`[w59-chain] ${who}`, entry.t.toFixed(1), entry.count);
        const counts = log.map((e) => Number(e.count));
        // One item at a time: every mutation after the first reading takes exactly one item away.
        expect(counts, `${who}: the stack drains 4, 3, 2, 1, 0 — one departure per mutation`).toEqual([4, 3, 2, 1, 0]);
        const at = log.map((e) => e.t);
        for (let k = 1; k < casters.length; k++) {
          const gap = at[k + 1]! - at[k]!;
          const owner = casters[casters.length - 1 - k]!;
          console.log(`[w59-chain] ${who} departure ${k} (${owner}'s Quicken) ${gap.toFixed(1)} ms after departure ${k - 1}`);
          if (owner !== who) expect(gap, `${who}: ${owner}'s Quicken's departure ${k} is spaced by the resolve gap`).toBeGreaterThanOrEqual(500);
        }
      }
    } finally {
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  },
);

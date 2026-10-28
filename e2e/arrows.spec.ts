/**
 * Wave 41 — the arrow only goes where Forge allows. Against a real Forge
 * match (`e2e/arrow.spec.ts`'s own header on why jsdom cannot prove this: a
 * wrong arrow still looks like an arrow).
 *
 * Two of the four playtest items are provable here, end to end, inside this
 * lane's own files:
 *
 *  - **W17** — the arrow's tail must sit at its SOURCE's own element; when
 *    the source is a card still being cast with no board element of its own
 *    (World Breaker's "when you cast this spell" trigger fires while World
 *    Breaker itself is still on the stack), the PLAYED CARD, waiting where
 *    it was let go, is that element — the stack redesign (2026-10-06) draws
 *    a lone spell as the card and no row. `gestures/install.ts`'s
 *    `clickOrigin` is the fix.
 *  - **W5** — a card lifted and brought back over the viewer's own hand,
 *    then left-clicked there, returns to the hand and nothing is sent.
 *
 * W9 (a creature-only removal must never snap to, or send to, a player
 * avatar) and W14 (planeswalker/player as attack-declaration drop targets;
 * a persistent post-declaration arrow) are diagnosed, not fixed, here: both
 * need `match.selectables`/`setWeaklySelectable` to carry player and
 * planeswalker legality during a selection and during `InputAttack`, which
 * Forge's own wire protocol does not publish (`match.ts`'s own header on
 * `boardInteraction`'s "Players" section says so, and
 * `gestures.test.ts`'s own pinned test — "a player is a legal target for
 * the whole selection" — asserts the current, documented trade-off
 * directly). That data lives in `apps/ui/src/play/live/match.ts`, which is
 * not this lane's file. `docs/planning/wave41-evidence/` has the real-Forge
 * reproduction for both.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`);
 * without one every test SKIPS and its title says why. Serves the prebuilt
 * `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { makeTitled, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch, type ScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The hand card named `name`, Forge-offered or not — by its own `.card__name` text. */
async function handCardNamed(page: Page, name: string): Promise<number | undefined> {
  const cards = await page
    .locator('[data-zone="hand"][data-owner="you"] [data-board-card]')
    .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), name: e.querySelector('.card__name')?.textContent?.trim() ?? '' })));
  return cards.find((c) => c.name === name)?.id;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

async function boxOf(page: Page, selector: string): Promise<Box | null> {
  const box = await page.locator(selector).first().boundingBox();
  return box === null ? null : { left: box.x, top: box.y, width: box.width, height: box.height };
}

/** The targeter's own shaft tail, in PAGE coordinates (the overlay's box added back). */
async function arrowTail(page: Page): Promise<{ x: number; y: number } | null> {
  const overlay = await boxOf(page, '[data-board-overlay]');
  if (overlay === null) return null;
  const svg = page.getByTestId('targeter');
  if ((await svg.count()) === 0) return null;
  // `M x1 y1 Q cx cy x2 y2`: the tail is the first pair.
  const [x1, y1] = ((await svg.locator('.arrow__spine').getAttribute('d')) ?? '').replace(/[MQ]/g, ' ').trim().split(/\s+/).map(Number) as [number, number];
  return { x: x1 + overlay.left, y: y1 + overlay.top };
}

const centre = (b: Box): { x: number; y: number } => ({ x: b.left + b.width / 2, y: b.top + b.height / 2 });
const away = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

test.describe.configure({ mode: 'serial' });

test(
  titled(
    'W17 — "i would expect it to show from the played card on the stack": casting World Breaker, the arrow leaves from the played card itself, never a fallback point',
  ),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(3 * 60_000);

    const stack = await startPlayStack(forge);
    let seated: ScenarioMatch | null = null;
    const log: string[] = [];
    try {
      seated = await startScenarioMatch(browser, stack, 'w41-worldbreaker');
      const page = seated.alice.page;

      const wb = await handCardNamed(page, 'World Breaker');
      expect(wb, 'World Breaker is in alice’s hand, as the scenario scripts').toBeDefined();
      await expect(page.locator(`[data-board-card="${wb}"]`), 'Forge offers World Breaker to cast').toHaveAttribute('data-selectable', /.*/, {
        timeout: 45_000,
      });

      // World Breaker needs no target itself (a creature, by type line): a
      // click lifts it and a second press over the viewer's own battlefield
      // plays it — Forge's cast trigger opens its OWN target ask next.
      await page.locator(`[data-board-card="${wb}"] button`).first().click();
      await expect(page.locator(`[data-board-card="${wb}"]`), 'the click lifted it').toHaveAttribute('data-cast-lift', 'lifted');
      const bfBox = await boxOf(page, '.seat[data-viewer] [data-zone="battlefield"]');
      expect(bfBox, "alice's own battlefield has a box").not.toBeNull();
      const bf = centre(bfBox!);
      await page.mouse.move(bf.x, bf.y);
      await page.mouse.down();
      await page.mouse.up();

      // The trigger's own ask: at least one land lights up as a legal target.
      await expect(page.locator('[data-board-card][data-selectable]').first(), "World Breaker's cast trigger opens its own target ask").toHaveCount(1, {
        timeout: 20_000,
      });
      log.push(`says: ${await says(page)}`);

      // World Breaker's own SPELL is the one thing on the stack here — Forge
      // reports it `isAbility: false` while it is still completing its own
      // cast trigger's target (confirmed against the real jar: an ABILITY
      // entry sharing World Breaker's id never appears here at all). §S's
      // handoff (`gestures/install.ts`'s `syncParkedGhost`) has already run:
      // the GHOST retires the moment this item appears, and `live/placed.ts`
      // draws it instead, at the exact same park point — the SAME element
      // the arrow's tail must sit at.
      await expect(page.locator('[data-zone="stack"]'), 'World Breaker’s own spell is on the stack').toHaveAttribute('data-count', '1', { timeout: 5_000 });
      expect(await page.locator(`[data-board-card="${wb}"]`).count(), 'World Breaker has no board element while its trigger asks for a target').toBe(0);
      await expect(page.locator('[data-cast-ghost]'), 'the ghost has handed off').toHaveCount(0, { timeout: 5_000 });
      const stackBox = await boxOf(page, '[data-placed-spell]');
      expect(stackBox, 'the played card, standing in for its spell, has a real box').not.toBeNull();
      const stackC = centre(stackBox!);
      log.push(`played card centre ${JSON.stringify(stackC)}`);

      // Move the pointer somewhere neutral — not over any legal target — so
      // the click-targeting arrow draws from whatever it considers the
      // source, with nothing snapped at the tip.
      const neutral = await boxOf(page, '[data-zone="stack"]');
      expect(neutral).not.toBeNull();
      await page.mouse.move(neutral!.left + 4, neutral!.top + 4);
      await expect(page.getByTestId('targeter'), 'the click-targeting arrow is drawn').toHaveCount(1, { timeout: 5_000 });

      const tail = await arrowTail(page);
      expect(tail, 'the arrow has a tail').not.toBeNull();
      log.push(`tail ${JSON.stringify(tail)}`);

      // The tail is the played card's own box — never the overlay's own
      // corner (the ledger's "(0,0)-ish" description of the old bug) and
      // never the viewport's origin.
      expect(away(tail!, stackC), `the tail sits at the played card's own box (${JSON.stringify(tail)} vs ${JSON.stringify(stackC)})`).toBeLessThanOrEqual(30);
      expect(away(tail!, { x: 0, y: 0 }), 'the tail is nowhere near the viewport’s origin').toBeGreaterThan(50);
      const overlayBox = await boxOf(page, '[data-board-overlay]');
      expect(away(tail!, { x: overlayBox!.left, y: overlayBox!.top }), 'and nowhere near the overlay’s own top-left corner').toBeGreaterThan(50);
    } finally {
      console.log(`[arrows w17] ${log.join('\n[arrows w17] ')}`);
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  },
);

test(
  titled(
    'W5 — "if i bring something back to my hand and left click it, that should also put it back in the hand": a click-armed card, brought back over the hand and left-clicked there, returns and sends nothing',
  ),
  async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(2 * 60_000);

    const stack = await startPlayStack(forge);
    let seated: ScenarioMatch | null = null;
    const log: string[] = [];
    try {
      seated = await startScenarioMatch(browser, stack, 'own-spell');
      const page = seated.alice.page;

      const memnite = await handCardNamed(page, 'Memnite');
      expect(memnite, 'Memnite is in alice’s hand, as the scenario scripts').toBeDefined();
      await expect(page.locator(`[data-board-card="${memnite}"]`), 'Forge offers it to cast').toHaveAttribute('data-selectable', /.*/, { timeout: 30_000 });

      // The click lifts it (arms — no button held — rather than resolving).
      await page.locator(`[data-board-card="${memnite}"] button`).first().click();
      await expect(page.locator(`[data-board-card="${memnite}"]`), 'click-armed, following the pointer').toHaveAttribute('data-cast-lift', 'lifted');

      // Carry it out — "bring something back" — then back over the hand,
      // with no button held throughout.
      const bfBox = await boxOf(page, '.seat[data-viewer] [data-zone="battlefield"]');
      await page.mouse.move(centre(bfBox!).x, centre(bfBox!).y);
      const handBox = await boxOf(page, '.seat[data-viewer] [data-zone="hand"]');
      expect(handBox, "alice's own hand has a box").not.toBeNull();
      const handPt = centre(handBox!);
      await page.mouse.move(handPt.x, handPt.y);
      // Since wave 60 §H a lifted card over its own hand is a REORDER in progress, not a cancel:
      // the old cancel cue (`data-cancel-hint`) is not drawn there any more (`gestures.test.ts`
      // pins it, and `hand.test.ts` owns the reorder preview), and the release commits the card
      // wherever it landed — a same-spot release is a no-op commit, nothing floats back.
      await expect(page.locator('.seat[data-viewer] [data-zone="hand"]'), 'no cancel cue over the hand any more').not.toHaveAttribute(
        'data-cancel-hint',
        /.*/,
      );
      await expect(page.locator(`[data-board-card="${memnite}"]`), 'still lifted over the hand').toHaveAttribute('data-cast-lift', 'lifted');

      const before = await stackCount(page);
      // The LEFT CLICK that ends the gesture, over the hand.
      await page.mouse.down();
      await page.mouse.up();
      await expect(page.locator(`[data-board-card="${memnite}"]`), 'settled in the hand, not mid-cast').not.toHaveAttribute('data-cast-lift', /.*/, {
        timeout: 2_000,
      });
      log.push(`stack before ${before}, after ${await stackCount(page)}`);
      expect(await stackCount(page), 'nothing was cast').toBe(before);
      expect(await stackCount(page), 'and in particular not 1').toBe(0);
      await expect(page.locator(`[data-board-card="${memnite}"]`), 'Memnite is still in the hand, and still offered').toHaveAttribute(
        'data-selectable',
        /.*/,
      );
      expect(
        await page
          .locator('[data-zone="hand"][data-owner="you"] [data-board-card]')
          .evaluateAll((els) => els.map((e) => e.querySelector('.card__name')?.textContent?.trim())),
        'Memnite is back in the hand, by name',
      ).toContain('Memnite');
    } finally {
      console.log(`[arrows w5] ${log.join('\n[arrows w5] ')}`);
      await seated?.alice.context.close();
      await seated?.bob.context.close();
      await stack.stop();
    }
  },
);

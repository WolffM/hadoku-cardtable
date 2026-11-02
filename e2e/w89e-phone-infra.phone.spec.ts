/**
 * Lane E's own red-first spec: the phone e2e infrastructure itself (`play/phone.ts`'s `PHONE`,
 * `tapCard`, `pinch`, `noSideways`), proved against a real match rather than a unit of its own.
 *
 * `promo-valakut` is the review's own scenario (11 lands vs a Jund board, wmobile's measured
 * baseline). Checked directly against that base board before writing this:
 *   - `noSideways` already PASSES on the base board — measured `scrollWidth`/`clientWidth` both 390.
 *     This matches wmobile's own finding ("page-level horizontal scroll on 0 of 177 states"): the
 *     unplayable board is a squeeze, not a page overflow, so this assertion is a GUARD (it must stay
 *     true through every lane's work), never this file's red-before-green signal.
 *   - A hand card's own box IS the measured problem — 30.5×42.5 px here (wmobile: "20–35 px
 *     thumbnails"). Settled's own "≥ 100 px" bar is for LANE cards, not hand cards; the approved
 *     prototype's own hand card is 78 px (`.hc { width: 78px }`,
 *     `/home/hadoku/.cache/cardtable-manager/portrait/index.html`), so the bar here is ≥ 76 px (a
 *     couple of px for the frame). RED now, GREEN once A's portrait rearrangement lands a real card
 *     size.
 * `tapCard` and `pinch` are exercised as a smoke check on the infra itself (both dispatch real touch,
 * whatever the board does with them) — they assert nothing about A's zoom or D's card view, which are
 * those lanes' own specs.
 */
import { expect, test } from '@playwright/test';

import { makeTitled, offeredCard } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { PHONE, noSideways, pinch, tapCard } from './play/phone.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test.use(PHONE);

test(titled('the phone context is real touch, a hand card is a real size, and tapCard/pinch/noSideways run against a real match'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'promo-valakut');
    const page = alice.page;

    // The context itself: real touch, the review's own phone size.
    const ctx = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, maxTouchPoints: navigator.maxTouchPoints }));
    expect(ctx, 'the match page itself renders at the PHONE viewport with touch').toEqual({ width: 390, height: 844, maxTouchPoints: 1 });

    // The RED-before-green signal: a hand card's own box, against the prototype's own hand card width
    // (78 px, `.hc { width: 78px }`) minus a couple of px for the frame — Settled's "≥ 100 px" bar is
    // for LANE cards, not hand cards.
    // `promo-valakut.state`: alice's own hand holds Lightning Bolt.
    const bolt = await offeredCard(page, 'Lightning Bolt', { zone: 'hand' });
    const box = await page.locator(`[data-board-card="${bolt}"]`).boundingBox();
    expect(box?.width ?? 0, "a hand card is at least 76 px wide (the prototype's own hand card, 78 px, minus the frame)").toBeGreaterThanOrEqual(76);

    // tapCard: a real touch tap lands on a board card without throwing, whatever the board does with it.
    await tapCard(page, bolt);
    // Whatever that tap opened (D's card view), leave the board clean for the guard below.
    await page.keyboard.press('Escape');

    // pinch: a two-finger CDP touch gesture runs without throwing, whatever the board does with it.
    await pinch(page, { scale: 1.5 });

    // Settled 3, the page-level guard: must stay true through every lane's work (it already is).
    await noSideways(page);
  } finally {
    await stack.stop();
  }
});

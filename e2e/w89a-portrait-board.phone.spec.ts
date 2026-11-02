/**
 * Wave 89 §A, the board's own red-first phone spec: `promo-valakut`'s starting state (11 lands vs a
 * Jund board) is the review's own scenario — vs the Forge AI, so this spec needs only ALICE's page.
 *
 * `startScenarioVsAi` opens alice's context through `openFriend`, which creates a plain desktop
 * context (`browser.newContext({})`, `e2e/play/browser.ts` — unowned this wave, so this file does not
 * touch it). Most of §A's own assertions below need only the viewport's SHAPE — Settled 1's switch is
 * a `matchMedia` width/orientation check, not a touch-capability one — so this spec starts the match
 * on a reliable desktop context and resizes to `PHONE`'s own viewport, exactly as `e2e/play/board.ts`'s
 * `resizeWindow` already does for every other spec that changes a page's size mid-test.
 *
 * The pinch gesture is different: it needs REAL multi-touch, and that turns out to need `hasTouch`/
 * `isMobile` at CONTEXT CREATION, not mid-test. Measured directly (two throwaway scripts, not this
 * match): `Emulation.setTouchEmulationEnabled` plus `Emulation.setDeviceMetricsOverride({mobile:
 * true, ...})`, sent to an already-navigated desktop page, DO make `navigator.maxTouchPoints` read 5
 * — but a two-finger `Input.dispatchTouchEvent` to that same page still only ever delivers ONE touch
 * point to `touchstart`. The same two calls on a FRESH page (`setContent`, no navigation first)
 * deliver both. So the fix is not "tell the page it has a touchscreen" but "open the touchscreen
 * context before anything renders" — exactly what `hasTouch`/`isMobile` context options are for, and
 * why `e2e/tour/phone.ts`'s (unlanded this wave, 96baac227) `openPhone` builds its own phone context
 * rather than resizing a desktop one. `startScenarioVsAi` cannot take one (it always calls
 * `openFriend`, which creates `{}` — `scenario.ts` and `browser.ts` are both unowned this wave), so
 * the pinch section opens a SECOND context in `PHONE`'s own shape and reconnects it to the SAME match
 * `alice`'s desktop page already started, by the same session cookie — a second tab on the same
 * identity, not a second player.
 *
 * Chip-position acceptance is read relative to `.board`'s own top edge, not the viewport's: this
 * worktree has only lane A landed, so the room's own header chrome above the match (unowned here —
 * `RoomShell.tsx`/`live.css`, B's and C's files) still draws at its desktop height, which the
 * integrated post-land run should re-check against the viewport once every lane is in.
 */
import { expect, test } from '@playwright/test';

import { SESSION_COOKIE } from './identities.ts';
import { keepPrefsLocal, setPlayFastModeDefault } from './prefsLocal.ts';
import { makeTitled, resizeWindow } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { noSideways, pinch, PHONE } from './play/phone.ts';
import { matchUrl, startScenarioVsAi } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test.use(PHONE);

const LANE_IDS = ['lane-their-lands', 'lane-their-permanents', 'lane-my-permanents', 'lane-my-lands'] as const;

test(titled('promo-valakut in portrait: chips, four lanes, card width, no sideways scroll, lane-more, pinch zoom'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, matchId } = await startScenarioVsAi(browser, stack, 'promo-valakut');
    const page = alice.page;
    await resizeWindow(page, PHONE.viewport);
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'portrait', { timeout: 10_000 });

    // Both player chips, inside the top 100 px OF THE BOARD (see the file doc: this worktree's
    // room chrome above `.board` is unowned here and still desktop-height), life readable.
    const boardTop = (await page.locator('.board').first().boundingBox())!.y;
    const oppChip = page.getByTestId('seat-chip-opp');
    const meChip = page.getByTestId('seat-chip-me');
    await expect(oppChip).toBeVisible();
    await expect(meChip).toBeVisible();
    const oppBox = await oppChip.boundingBox();
    const meBox = await meChip.boundingBox();
    expect(oppBox, 'opponent chip has a box').not.toBeNull();
    expect(meBox, 'viewer chip has a box').not.toBeNull();
    expect.soft(oppBox!.y - boardTop, 'opponent chip starts at the board\'s own top').toBeLessThan(20);
    expect.soft(oppBox!.y + oppBox!.height - boardTop, 'opponent chip is inside the board\'s top 100px').toBeLessThanOrEqual(100);
    expect.soft(meBox!.y + meBox!.height - boardTop, 'viewer chip is inside the board\'s top 100px').toBeLessThanOrEqual(100);
    const oppLife = (await oppChip.getByTestId('life').textContent())?.trim();
    const meLife = (await meChip.getByTestId('life').textContent())?.trim();
    expect.soft(oppLife, 'opponent life reads 20 (the scenario\'s ailife)').toBe('20');
    expect.soft(meLife, 'viewer life reads 14 (the scenario\'s humanlife)').toBe('14');

    // Exactly 4 lane scrollers, one per the contract's id.
    for (const id of LANE_IDS) await expect.soft(page.getByTestId(id), `${id} exists exactly once`).toHaveCount(1);
    const laneCount = await page.locator('[data-testid^="lane-"]:not([data-testid="lane-more"])').count();
    expect.soft(laneCount, 'exactly 4 lane scrollers').toBe(4);

    // Card width floor and "no more than 3 whole cards at 1x", on the lane the scenario fills:
    // the viewer's own lands (11 lands grouped into several piles — plenty to overflow).
    const myLands = page.getByTestId('lane-my-lands');
    const cardBoxes = await myLands.locator(':scope > li.board-card').evaluateAll((els) =>
      els.map((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width };
      }),
    );
    expect.soft(cardBoxes.length, 'my-lands has more than 3 piles to prove the 3-wide cap').toBeGreaterThan(3);
    for (const box of cardBoxes) expect.soft(box.width, 'every lane card is at least 100px wide').toBeGreaterThanOrEqual(100);
    const laneBox = await myLands.boundingBox();
    const wholeCardsVisible = cardBoxes.filter((b) => b.left >= laneBox!.x - 1 && b.right <= laneBox!.x + laneBox!.width + 1).length;
    expect.soft(wholeCardsVisible, 'no more than 3 whole cards visible at 1x zoom').toBeLessThanOrEqual(3);

    // No lane shows more than 3 whole cards at 1x, checked on every lane (not just my-lands).
    for (const id of LANE_IDS) {
      const lane = page.getByTestId(id);
      const boxes = await lane.locator(':scope > li.board-card').evaluateAll((els) =>
        els.map((el) => (el as HTMLElement).getBoundingClientRect()),
      );
      const box = await lane.boundingBox();
      if (box === null) continue;
      const whole = boxes.filter((b) => b.left >= box.x - 1 && b.right <= box.x + box.width + 1).length;
      expect.soft(whole, `${id}: no more than 3 whole cards at 1x`).toBeLessThanOrEqual(3);
    }

    // The page body never scrolls sideways (Settled 3).
    await noSideways(page);

    // Scrolling a lane reveals its 4th card and lane-more counts it.
    const moreBefore = await myLands.locator('[data-testid="lane-more"][data-side="right"]').textContent().catch(() => null);
    expect.soft(moreBefore, 'my-lands starts with a lane-more count on the right').not.toBeNull();
    await myLands.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await page.waitForTimeout(150);
    const moreAfter = await myLands.locator('[data-testid="lane-more"][data-side="left"]').textContent().catch(() => null);
    expect.soft(moreAfter, 'scrolled to the end, lane-more now counts what is left of view on the left').not.toBeNull();
    const rightAfter = await myLands.locator('[data-testid="lane-more"][data-side="right"]').count();
    expect.soft(rightAfter, 'scrolled all the way, nothing more to the right').toBe(0);

    // Reset scroll for the zoom gesture below.
    await myLands.evaluate((el) => {
      el.scrollLeft = 0;
    });
    await page.waitForTimeout(150);

    // A pinch raises card width, through the cardtable:zoom contract — on a SECOND context, opened
    // in PHONE's own shape from the start (see the file doc for why resizing the desktop one cannot
    // carry real multi-touch), reconnected to the same match as alice's own session cookie.
    const widthBefore = cardBoxes[0]!.width;
    const phoneContext = await browser.newContext({ ...PHONE });
    try {
      await phoneContext.addCookies([{ name: SESSION_COOKIE, value: 'alice', domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
      await keepPrefsLocal(phoneContext, stack.origin);
      await setPlayFastModeDefault(phoneContext, true);
      const phonePage = await phoneContext.newPage();
      await phonePage.goto(matchUrl(stack.origin, matchId));
      await expect(phonePage.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 30_000 });
      await expect(phonePage.locator('html')).toHaveAttribute('data-layout', 'portrait', { timeout: 10_000 });
      const phoneMyLands = phonePage.getByTestId('lane-my-lands');
      await expect(phoneMyLands.locator(':scope > li.board-card').first()).toBeVisible({ timeout: 10_000 });

      await phonePage.evaluate(() => {
        const seen: number[] = [];
        (window as unknown as { __w89aZoom: number[] }).__w89aZoom = seen;
        window.addEventListener('cardtable:zoom', (ev) => seen.push((ev as CustomEvent<{ zoom: number }>).detail.zoom));
      });
      const board = phonePage.locator('.board').first();
      const boardBox = await board.boundingBox();
      await pinch(phonePage, { at: { x: boardBox!.x + boardBox!.width / 2, y: boardBox!.y + boardBox!.height / 2 }, scale: 1.6 });
      await phonePage.waitForTimeout(200);
      const afterZoomEvents = await phonePage.evaluate(() => (window as unknown as { __w89aZoom: number[] }).__w89aZoom ?? []);
      expect.soft(afterZoomEvents.length, 'cardtable:zoom fired at least once').toBeGreaterThan(0);
      expect.soft(afterZoomEvents.at(-1), 'the dispatched zoom is above 1').toBeGreaterThan(1);
      const widthAfter = await phoneMyLands.locator(':scope > li.board-card').first().evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
      expect.soft(widthAfter, 'pinch raised the card width').toBeGreaterThan(widthBefore);

      // The zoom pill (B's) returns it to 1x — pending B's own land, per the manager's note.
      const pill = phonePage.getByTestId('zoom-pill');
      if ((await pill.count()) === 0) {
        console.log('[w89a] zoom-pill not present yet (pending B) — skipping the "pill returns zoom to 1x" assertion');
      } else {
        await pill.click();
        await phonePage.waitForTimeout(200);
        const afterPill = await phonePage.evaluate(() => (window as unknown as { __w89aZoom: number[] }).__w89aZoom ?? []);
        expect.soft(afterPill.at(-1), 'the zoom pill returned zoom to 1').toBe(1);
      }
    } finally {
      await phoneContext.close();
    }
  } finally {
    await stack.stop();
  }
});

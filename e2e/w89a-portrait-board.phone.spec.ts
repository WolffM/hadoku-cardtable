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
 * identity, not a second player, so it answers the one-live-tab question with yes and takes the game.
 *
 * Chip-position acceptance is read relative to `.board`'s own top edge, not the viewport's: this
 * worktree has only lane A landed, so the room's own header chrome above the match (unowned here —
 * `RoomShell.tsx`/`live.css`, B's and C's files) still draws at its desktop height, which the
 * integrated post-land run should re-check against the viewport once every lane is in.
 */
import { expect, test, type Page } from '@playwright/test';

import { SESSION_COOKIE } from './identities.ts';
import { keepPrefsLocal, setPlayFastModeDefault } from './prefsLocal.ts';
import { clickHandCard, makeTitled, offeredNamed, pressPaymentAuto, resizeWindow, says } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { expectBarAnchored, inMore, laneCues, noSideways, pinch, PHONE, raiseHand } from './play/phone.ts';
import { answerPrompt } from './play/prompts.ts';
import { matchUrl, startScenarioVsAi } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test.use(PHONE);

const LANE_IDS = ['lane-their-lands', 'lane-their-permanents', 'lane-my-permanents', 'lane-my-lands'] as const;

test(titled('promo-valakut in portrait: chips, four lanes, card width, no sideways scroll, edge chevrons, pinch zoom'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, matchId } = await startScenarioVsAi(browser, stack, 'promo-valakut');
    const page = alice.page;
    await resizeWindow(page, PHONE.viewport);
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'portrait', { timeout: 10_000 });
    // Exactly one of the rail's two lists shows: portrait's five segments, never the desktop rows.
    await expect(page.getByTestId('live-phases').locator('.live__segments'), 'the portrait phase bar shows').toBeVisible();
    await expect(page.getByTestId('live-phases').locator('.live__steps'), 'the desktop rows stay hidden in portrait').toBeHidden();

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

    // Exactly 4 BOARD lane scrollers (the hand is a fifth, separate carousel — asserted further down).
    for (const id of LANE_IDS) await expect.soft(page.getByTestId(id), `${id} exists exactly once`).toHaveCount(1);
    const laneCount = await page.locator('[data-testid^="lane-"]:not([data-testid="lane-my-hand"])').count();
    expect.soft(laneCount, 'exactly 4 board lane scrollers').toBe(4);

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

    // my-lands' own bottom never sits under B's action bar: the hand is the row between them, and
    // the bar is on the bottom edge (`--portrait-bar-band`, the board's own bottom padding).
    // `action-bar` is B's own testid — asserted only when present, since this worktree may not have
    // B's land yet; the integrated post-land run is where this must hold.
    const actionBar = page.getByTestId('action-bar');
    if ((await actionBar.count()) > 0) {
      const barBox = await actionBar.boundingBox();
      expect.soft(laneBox!.y + laneBox!.height, 'my-lands bottom sits at or above the action bar top').toBeLessThanOrEqual(barBox!.y + 1);
    } else {
      console.log('[w89a] action-bar not present yet (pending B in this worktree) — skipping the lane/bar overlap assertion');
    }

    // The board column starts at --portrait-hud-h (the chip row plus the phase row B's bar fills):
    // their-lands' own top never sits under the phase bar. Gated on `action-bar` too (not just
    // `.live__phases` — that class already matches something unrelated on the desktop chrome still
    // showing in this worktree, a false positive this spec caught once): both are B's portrait
    // land, so one gates the other reliably.
    const theirLands = page.getByTestId('lane-their-lands');
    const phases = page.locator('.live__phases');
    if ((await actionBar.count()) > 0 && (await phases.count()) > 0) {
      const phasesBox = await phases.boundingBox();
      const theirLandsBox = await theirLands.boundingBox();
      expect.soft(theirLandsBox!.y, 'their-lands starts at or below the phase bar\'s own bottom').toBeGreaterThanOrEqual((phasesBox!.y + phasesBox!.height) - 1);
    } else {
      console.log('[w89a] B\'s portrait phase bar not present yet in this worktree — skipping the phase-bar/lane overlap assertion');
    }

    // No lane shows more than 3 whole cards at 1x, checked on every lane (not just my-lands).
    for (const id of LANE_IDS) {
      const lane = page.getByTestId(id);
      const boxes = await lane.locator(':scope > li.board-card').evaluateAll((els) =>
        els.map((el) => (el as HTMLElement).getBoundingClientRect()),
      );
      const box = await lane.boundingBox();
      if (box === null) continue;
      const whole = boxes.filter((b) => b.left >= box.x - 1 && b.right <= box.x + box.width + 1).length;
      // A crowded permanents lane wraps to two rows (Mockup 2): still no more than 3 whole cards a row.
      const rows = Number((await lane.getAttribute('data-rows')) ?? '1');
      expect.soft(whole, `${id}: no more than 3 whole cards a row at 1x`).toBeLessThanOrEqual(3 * rows);
    }

    // The hand is a carousel too (the operator, after the look artifact: "cards are too small in
    // hand, use a similar scrolling carousel") — lane-card size at 1x, scrolls to its 4th card
    // (promo-valakut's humanhand is exactly Scapeshift, Lightning Bolt, Search for Tomorrow,
    // Summoner's Pact — four), same edge chevrons as the board lanes above. Hand cards are
    // `CardOnBoard`'s own `li.board-card`, the same as every other card on the board.
    const myHand = page.getByTestId('lane-my-hand');
    await expect(myHand).toBeVisible();
    // It rests as a peek (Mockup 2); its cards are lane-card size once a tap raises it.
    await raiseHand(page);
    const handCardBoxes = await myHand.locator(':scope > li.board-card').evaluateAll((els) =>
      els.map((el) => (el as HTMLElement).getBoundingClientRect()),
    );
    expect.soft(handCardBoxes.length, 'promo-valakut deals a 4-card hand').toBe(4);
    for (const box of handCardBoxes) expect.soft(box.width, 'every hand card is at least 100px wide').toBeGreaterThanOrEqual(100);
    const handBefore = await laneCues(myHand);
    expect.soft(handBefore.right?.glyph, 'the hand starts with a › on the right (its 4th card is off the edge)').toBe('›');
    expect.soft(handBefore.left, 'nothing to the left of an unscrolled hand').toBeNull();
    await myHand.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await page.waitForTimeout(150);
    const handAfter = await laneCues(myHand);
    expect.soft(handAfter.right, 'scrolled all the way, nothing more to the right of the hand').toBeNull();
    expect.soft(handAfter.left?.glyph, 'scrolled all the way, a ‹ on the left of the hand').toBe('‹');

    // The page body never scrolls sideways (Settled 3).
    await noSideways(page);

    // The edge cue (the operator, 2026-11-02: "they are too big, and i would prefer if there was a
    // '>' or '<' for which direction the extra cards are"): a chevron the size of a glyph, not a
    // card-wide pill, pointing the way the lane scrolls, and it takes no room in the lane — the
    // first card does not move when a cue appears.
    const firstLand = myLands.locator(':scope > li.board-card').first();
    const before = await laneCues(myLands);
    expect.soft(before.right?.glyph, 'my-lands starts with a › on the right').toBe('›');
    expect.soft(before.right?.width ?? Infinity, 'the chevron is glyph-sized, not a card-wide pill').toBeLessThanOrEqual(24);
    expect.soft(before.left, 'nothing to the left of an unscrolled lane').toBeNull();
    const scrollWidthBefore = await myLands.evaluate((el) => el.scrollWidth);
    const firstLeftBefore = (await firstLand.boundingBox())!.x;
    const nudge = 8;
    await myLands.evaluate((el, by) => {
      el.scrollLeft = by;
    }, nudge);
    await page.waitForTimeout(150);
    expect.soft((await laneCues(myLands)).left?.glyph, 'scrolled a little, a ‹ appears on the left').toBe('‹');
    expect.soft((await firstLand.boundingBox())!.x, 'the left chevron appearing moves no card: only the scroll does').toBeCloseTo(firstLeftBefore - nudge, 0);
    expect.soft(await myLands.evaluate((el) => el.scrollWidth), 'the chevrons add no width to the lane').toBe(scrollWidthBefore);
    await myLands.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await page.waitForTimeout(150);
    const after = await laneCues(myLands);
    expect.soft(after.left?.glyph, 'scrolled to the end, a ‹ on the left').toBe('‹');
    expect.soft(after.right, 'scrolled all the way, nothing more to the right').toBeNull();

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
      // A second tab on alice's own identity while her desktop page still plays: one live tab per
      // player per room (`apps/ui/src/room/session.ts`) asks first, and yes takes the game here.
      await phonePage.getByTestId('session-ask-yes').click({ timeout: 30_000 });
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
      const pill = await inMore(phonePage, 'zoom-pill');
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

/* ── the stack chip opens the stack list (Settled 2) ──────────────────────────────────── */

/** The open sheet's card tiles, and the text each shows — `e2e/w87b-stack.spec.ts`'s own shape, reused. */
async function tiles(page: Page): Promise<{ id: number; text: string }[]> {
  return page
    .locator('[data-testid="live-selection-host"], [data-testid="live-prompt"]')
    .first()
    .locator('[data-testid="prompt-cards"] > li[data-card-id]')
    .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-card-id')), text: (e.textContent ?? '').replace(/\s+/g, ' ').trim() })));
}

/** Tick `ids` on the open sheet and submit it — `e2e/w87b-stack.spec.ts`'s own shape, reused. */
async function pick(page: Page, ids: readonly number[]): Promise<void> {
  const sheet = page.locator('[data-testid="live-selection-host"], [data-testid="live-prompt"]').first();
  for (const id of ids) await sheet.locator(`[data-testid="prompt-cards"] > li[data-card-id="${id}"]`).click({ timeout: 2_000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  if (ids.length === 0) return;
  const ours = page
    .locator('[data-testid="live-selection-host"], [data-testid="live-prompt"]')
    .filter({ has: page.locator(ids.map((id) => `[data-testid="prompt-cards"] > li[data-card-id="${id}"]`).join(', ')) });
  await ours.locator('[data-testid="selection-done"]:enabled, [data-testid="prompt-submit"]:enabled').first().click({ timeout: 2_000 }).catch(() => undefined);
}

async function pressIfThere(page: Page, selector: string): Promise<void> {
  const target = page.locator(selector);
  if ((await target.count()) > 0) await target.first().click({ timeout: 1_000 }).catch(() => undefined);
}

test(titled('promo-valakut in portrait: the stack chip opens the stack list, ten Valakut triggers grouped ×10'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioVsAi(browser, stack, 'promo-valakut');
    const page = alice.page;
    await resizeWindow(page, PHONE.viewport);
    await expect(page.locator('html')).toHaveAttribute('data-layout', 'portrait', { timeout: 10_000 });

    // Cast Scapeshift, pay by sacrificing all eleven lands, fetch Valakut and every Mountain — the
    // same sequence `e2e/w87b-stack.spec.ts` proves at 1920×1080, run here at 390×844 up to the
    // moment all ten Valakut triggers sit on the stack, none targeted yet.
    let scapeshift: number | undefined;
    await expect.poll(async () => (scapeshift = await offeredNamed(page, 'Scapeshift')), { timeout: 60_000, message: 'alice is offered Scapeshift' }).not.toBeUndefined();
    await clickHandCard(page, scapeshift!);

    let searched = false;
    await expect
      .poll(
        async () => {
          const text = await says(page);
          if (/Valakut, the Molten Pinnacle/.test(text) && !/^Priority|^Do you want to deal/.test(text)) return true;
          const sheet = await tiles(page);
          if (sheet.some((t) => /Valakut/.test(t.text))) {
            await pick(page, [...sheet.filter((t) => /Valakut/.test(t.text)), ...sheet.filter((t) => t.text.startsWith('Mountain'))].map((t) => t.id));
            searched = true;
          } else if (sheet.length >= 11 && !searched) {
            await pick(page, sheet.map((t) => t.id));
          } else if (!(await pressPaymentAuto(page))) {
            await pressIfThere(page, '[data-testid="prompt-confirm-yes"]:enabled');
            if (searched) await answerPrompt(page).catch(() => null);
          }
          return false;
        },
        { timeout: 120_000, intervals: [300], message: "alice's first Valakut target question is up, ten triggers on the stack" },
      )
      .toBe(true);
    await page.waitForTimeout(500); // every glide and bump settled

    const stackChip = page.getByTestId('stack-chip');
    await expect(stackChip).toBeVisible();
    expect.soft(await stackChip.textContent(), 'the chip counts all ten').toBe('10');

    // Tapping it opens the list.
    expect.soft(await page.getByTestId('stack-sheet').count(), 'closed before the tap').toBe(0);
    await stackChip.tap();
    const sheet = page.getByTestId('stack-sheet');
    await expect(sheet).toBeVisible();
    expect.soft(await stackChip.getAttribute('aria-expanded'), 'the chip says it is open').toBe('true');
    await expectBarAnchored(page, 'the stack list open');

    // Identical items group into one row with ×N: ten untargeted Valakut triggers are ONE row, ×10.
    const rows = sheet.getByTestId('stack-sheet-row');
    await expect.soft(rows).toHaveCount(1);
    const rowText = (await rows.first().textContent()) ?? '';
    expect.soft(rowText, 'names Valakut').toContain('Valakut');
    expect.soft(rowText, 'ten of them, grouped').toContain('10');

    // Tapping the chip again closes it.
    await stackChip.tap();
    await expect(sheet).toHaveCount(0);
    expect.soft(await stackChip.getAttribute('aria-expanded')).toBe('false');
  } finally {
    await stack.stop();
  }
});

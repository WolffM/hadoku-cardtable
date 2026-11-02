/**
 * w90 C rework, the fan — the operator's look-gate feedback on the first cut (2026-11-02):
 *
 *   4. *"the fan view should display properly one card in the middle and then two partial cards on
 *      the left and right side of the scrollable carousel"* — the reviewed shot showed one card
 *      filling the whole width, over the room header, not the carousel at rest.
 *
 * Cause, read from the DOM (not guessed): under phone width every pack slot carried a synthetic
 * `data-card-id="w<n>"` regardless of whether the fan was being PICKED or merely browsed —
 * `desktopFan === null`, the condition that gated it, is true for every phone card (the phone fan
 * never computes `desktopFan`, fan or grid alike), where before a phone existed it meant "this is the
 * grid". The shared inspector (`play/inspect/index.ts`, mounted once over the whole draft screen)
 * reads that id on ANY `pointerover`/long-press and enlarges the card full-screen — exactly the
 * "card focused too big" shot, triggered here by the stray hover a leftover pointer position crosses
 * onto the pack once it mounts. Fixed by gating the id on `!fanned` (true grid, phone or desktop)
 * instead, matching the pre-phone rule.
 *
 * A second, separate bug under the same symptom: sizing the carousel's card from `--phone-fan-w`'s own
 * `padding: 0 calc((100% - var(--phone-fan-w)) / 2)` fed `useBox` a CONTENT box that the padding had
 * already shrunk by the very value computed from it — a width-axis version of the grid's old
 * self-referential height. `phoneFanGeometry` now reads the row's real, un-padded width (the peek
 * is a MARGIN on the first/last card, never the row's own padding — `draft.css`'s header), the same
 * `useBox` the desktop fan already reads, now that `.draft__main > .pack`'s height is the page
 * layout's own instead of self-referential (the wgrid lane's own rework, landing alongside this one).
 *
 * Needs no Forge: a draft never touches it (`play/w32.ts`'s `startPlayStack` header says the same for
 * the heavier match stacks; this uses the plain draft server `playwright.config.ts` already starts).
 */
import { expect, test } from '@playwright/test';

import { PHONE } from './play/phone.ts';
import { noPageSideways, openIndex, soloDraftPack, swipe, withAlice } from './w90c-touch.ts';

test.use(PHONE);

test('the fan: the open card centres in the box, sized from the box — not the viewport', async ({ browser }) => {
  await withAlice(browser, async (page) => {
    await soloDraftPack(page);
    const pack = page.getByTestId('pack');
    await expect(pack).toHaveAttribute('data-layout', 'fan');
    await expect(pack).toHaveClass(/pack--fan/);

    const packBox = await pack.boundingBox();
    const open = pack.locator('.pack__slot[data-focused]');
    const openBox = await open.boundingBox();
    if (packBox === null || openBox === null) throw new Error('missing a box');

    // Sized from the pack's OWN box, a share of it well short of the whole thing — not a fixed
    // viewport fraction (the brief: "don't hardcode for 390") and not the "fills the screen" bug the
    // look shot caught either.
    expect(openBox.width, 'the open card is a healthy share of the box, not the whole thing').toBeGreaterThan(packBox.width * 0.5);
    expect(openBox.width, 'the open card leaves room for a peek on each side').toBeLessThan(packBox.width * 0.9);

    // Centred: its own centre within a few px of the box's.
    const openMid = openBox.x + openBox.width / 2;
    const packMid = packBox.x + packBox.width / 2;
    expect(Math.abs(openMid - packMid), 'the open card is centred in the box').toBeLessThan(4);

    // Exactly one card is open.
    await expect(pack.locator('.pack__slot[data-focused]')).toHaveCount(1);

    await noPageSideways(page);
  });
});

test('the fan: a neighbour peeks on each side once the open card is not at either end', async ({ browser }) => {
  await withAlice(browser, async (page) => {
    await soloDraftPack(page);
    const pack = page.getByTestId('pack');
    expect(await openIndex(page), 'the pack opens on its first card').toBe(0);

    // The first card has no LEFT neighbour to peek (the brief: "the first and last cards can also
    // centre") — scroll one over so both sides have one.
    const packBox = await pack.boundingBox();
    if (packBox === null) throw new Error('no pack box');
    const midY = packBox.y + packBox.height / 2;
    await swipe(page, { x: packBox.x + packBox.width * 0.85, y: midY }, { x: packBox.x + packBox.width * 0.15, y: midY });
    expect(await openIndex(page), 'the swipe moved the open card off the first').toBeGreaterThan(0);

    const rects = await pack.evaluate((el) => {
      const slots = [...el.querySelectorAll<HTMLElement>('.pack__slot')];
      const at = slots.findIndex((s) => s.hasAttribute('data-focused'));
      const rectOf = (s: HTMLElement | undefined) => (s === undefined ? null : s.getBoundingClientRect().toJSON());
      return { pack: el.getBoundingClientRect().toJSON(), prev: rectOf(slots[at - 1]), open: rectOf(slots[at]), next: rectOf(slots[at + 1]) };
    });
    if (rects.prev === null || rects.open === null || rects.next === null) throw new Error('missing a neighbour');

    // Each neighbour's own slice inside the pack's visible box is a real, tappable sliver — not a
    // sub-pixel edge and not the whole card (that would mean nothing is centred).
    const leftPeek = Math.min(rects.prev.right, rects.pack.right) - Math.max(rects.prev.left, rects.pack.left);
    const rightPeek = Math.min(rects.next.right, rects.pack.right) - Math.max(rects.next.left, rects.pack.left);
    expect(leftPeek, 'the previous card peeks in from the left').toBeGreaterThan(8);
    expect(leftPeek, 'the left peek is a sliver, not the whole card').toBeLessThan(rects.open.width * 0.5);
    expect(rightPeek, 'the next card peeks in from the right').toBeGreaterThan(8);
    expect(rightPeek, 'the right peek is a sliver, not the whole card').toBeLessThan(rects.open.width * 0.5);

    await noPageSideways(page);
  });
});

test('the fan: swiping snaps to the next card, never picks it, and the pool and pick count stay visible', async ({ browser }) => {
  await withAlice(browser, async (page) => {
    await soloDraftPack(page);
    const pack = page.getByTestId('pack');
    const before = await openIndex(page);
    expect(before).toBe(0);
    const countBefore = await pack.getAttribute('data-card-count');

    const box = await pack.boundingBox();
    if (box === null) throw new Error('no pack box');
    const midY = box.y + box.height / 2;
    // A right-to-left drag: the carousel scrolled forward, the open card moved along with it.
    await swipe(page, { x: box.x + box.width * 0.85, y: midY }, { x: box.x + box.width * 0.15, y: midY });

    const after = await openIndex(page);
    expect(after, 'the swipe moved the open card forward').toBeGreaterThan(before);
    expect(await pack.getAttribute('data-card-count'), 'a swipe never picks a card').toBe(countBefore);

    // The snap: the open slot sits centred in the row, not half-scrolled between two.
    const centred = await pack.evaluate((el) => {
      const focused = el.querySelector('.pack__slot[data-focused]');
      if (focused === null) return null;
      const r = focused.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      return Math.abs(r.left + r.width / 2 - (b.left + b.width / 2));
    });
    expect(centred, 'the open card snapped back to centre').not.toBeNull();
    expect(centred as number).toBeLessThan(4);

    await expect(page.getByTestId('pool'), 'the pool stays visible').toBeVisible();
    await expect(page.locator('.pool__title'), 'the pick count stays visible').toBeVisible();
    // Not covered by the pack: the two never overlap vertically.
    const packBox = await pack.boundingBox();
    const poolBox = await page.getByTestId('pool').boundingBox();
    if (packBox === null || poolBox === null) throw new Error('missing a box');
    expect(packBox.y + packBox.height, 'the pack ends above the pool').toBeLessThanOrEqual(poolBox.y + 1);

    await noPageSideways(page);
  });
});

test('the fan: the pick gesture is the desktop fan’s — tap opens, tap again picks', async ({ browser }) => {
  await withAlice(browser, async (page) => {
    await soloDraftPack(page);
    const pack = page.getByTestId('pack');
    const countBefore = Number(await pack.getAttribute('data-card-count'));

    // A card that is not open: tapping it opens it, and picks nothing. A `Locator.tap()` here would
    // auto-scroll the still-mostly-offscreen neighbour to centre FIRST (Playwright's own actionability,
    // more thorough than a real thumb), which already counts as opening it by the time the click lands —
    // one physical tap would then read as a SECOND tap on an already-open one and pick it outright, a
    // false red from the driver, not the product. A real finger taps whatever is already on screen: the
    // neighbour's own peeking sliver, at a coordinate `page.touchscreen` reaches with no scroll of its own.
    const packBox = await pack.boundingBox();
    if (packBox === null) throw new Error('no pack box');
    const peekX = packBox.x + packBox.width - 6;
    const peekY = packBox.y + packBox.height / 2;
    await page.touchscreen.tap(peekX, peekY);
    await expect.poll(() => openIndex(page), { message: 'a tap on an unopened card opens it' }).toBe(1);
    expect(Number(await pack.getAttribute('data-card-count')), 'opening a card never picks it').toBe(countBefore);

    // The now-open card: tapping it again picks it, and it leaves the pack.
    const openCard = pack.locator('.pack__slot[data-focused] button[data-testid="card"]');
    await openCard.tap();
    await expect(pack, 'the pick landed').toHaveAttribute('data-card-count', String(countBefore - 1), { timeout: 10_000 });
  });
});

test('the fan: no stray hover opens the shared inspector over the carousel at rest', async ({ browser }) => {
  await withAlice(browser, async (page) => {
    await soloDraftPack(page);
    // The exact shape of the look-gate bug: every phone fan slot carried the inspector's synthetic id
    // even while picking, so a pointer merely CROSSING the pack (never clicked, never held) could enlarge
    // a card full-screen over the room header. None of the taps above touch a card's own `data-card-id`
    // trigger path (a long press would; a plain tap or drag does not), so if the panel is open here, the
    // id leaked back onto a picking fan's cards.
    await expect(page.locator('.inspect'), 'no enlarged preview is open over the resting carousel').toHaveCount(0);
    const tagged = await page.getByTestId('pack').locator('.pack__slot[data-card-id]').count();
    expect(tagged, 'a picking fan’s cards carry no inspector trigger id').toBe(0);
  });
});

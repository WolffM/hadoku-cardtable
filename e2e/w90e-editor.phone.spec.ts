/**
 * The deck editor's pan and zoom, phone. Before: curve-column cards drew at ~30 CSS px. Now a card never
 * draws under the floor, a finger pans from anywhere (a swipe that starts on a card included, as on the
 * board) while a tap still moves a card, a pinch zooms, and the bars never move.
 */
import { expect, test } from '@playwright/test';

import { deckPileTop } from './deckBuilder.ts';
import { noSideways, pinch, PHONE, swipe } from './play/phone.ts';
import { cardPointIn, emptyPointIn, openSoloDeckEditor, surfaceTransform } from './w90e-editor.ts';

test.use(PHONE);

test('cards stay readable, a finger pans from a card or empty space, a pinch zooms, a tap still moves a card', async ({ page }) => {
  test.setTimeout(3 * 60_000);
  await openSoloDeckEditor(page);
  const pileTop = deckPileTop(page).first();
  await pileTop.tap();
  await expect(page.getByTestId('side-count')).toHaveText('1');

  const box = await pileTop.boundingBox();
  if (box === null) throw new Error('no pile card to measure');
  expect(box.width, 'a curve-column card is at least 70 CSS px wide').toBeGreaterThanOrEqual(70);
  await expect(page.getByTestId('deck-zoom-pill')).toHaveText('100%');
  await noSideways(page);

  // The pan is a viewport's only offset: the browser never scrolls one (bringing a tapped card into
  // view did, and the pile tops above it were then out of reach of any pan).
  for (const id of ['side-grid', 'main-grid']) {
    const scrolled = await page.getByTestId(id).evaluate((e) => {
      e.scrollTo(40, 40);
      return [e.scrollLeft, e.scrollTop];
    });
    expect(scrolled, `${id} never scrolls`).toEqual([0, 0]);
  }

  // A sideways swipe that starts ON a card pans the piles, and moves no card.
  const counts = async () => [await page.getByTestId('main-count').textContent(), await page.getByTestId('side-count').textContent()];
  const before = await counts();
  const from = await cardPointIn(page, 'main-grid');
  await swipe(page, from, { x: from.x - 140, y: from.y });
  const fromCard = await surfaceTransform(page, 'main-grid');
  expect(fromCard.x, 'a swipe from a card panned the piles').toBeLessThan(-60);
  expect(await counts(), 'a pan moves no card').toEqual(before);

  // So does one from empty space, back the other way.
  const empty = await emptyPointIn(page, 'main-grid');
  await swipe(page, empty, { x: empty.x + 60, y: empty.y });
  expect((await surfaceTransform(page, 'main-grid')).x, 'a swipe from empty space panned back').toBeGreaterThan(fromCard.x);
  expect(await counts()).toEqual(before);
  await noSideways(page);

  // A pinch zooms; the bars stay put.
  const grid = (await page.getByTestId('main-grid').boundingBox())!;
  await pinch(page, { at: { x: grid.x + grid.width / 2, y: grid.y + grid.height / 2 }, scale: 1.6 });
  await expect(page.getByTestId('deck-zoom-pill')).not.toHaveText('100%');
  for (const id of ['side-count', 'main-count', 'deck-zoom-pill']) await expect(page.getByTestId(id)).toBeInViewport();

  // A tap still moves a card, pinched in.
  const side = await page.getByTestId('side-count').textContent();
  const onCard = await cardPointIn(page, 'side-grid');
  await page.touchscreen.tap(onCard.x, onCard.y);
  await expect(page.getByTestId('side-count')).not.toHaveText(side ?? '');

  await page.getByTestId('deck-zoom-pill').tap();
  await expect(page.getByTestId('deck-zoom-pill')).toHaveText('100%');
  expect(await surfaceTransform(page, 'main-grid')).toEqual({ x: 0, y: 0, zoom: 1 });
});

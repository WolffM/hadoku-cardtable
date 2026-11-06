/**
 * The deck editor's pan and zoom, desktop. The operator: "sideboarding view is a mess. we need to allow
 * this to be zoom and draggable." At 100% the editor still fits everything; ctrl+wheel and the pill's
 * − and + zoom, a mouse drag on empty space pans, and a card keeps its own click and drag.
 *
 * The one-inspector rule inside the pod's sideboard step (the editor nested in `PodScreen`'s mount) is
 * proven by `deck.test.ts` with the real `mountInspector`; here the standalone editor shows one panel.
 */
import { expect, test } from '@playwright/test';

import { deckPileTop } from './deckBuilder.ts';
import { cardPointIn, emptyPointIn, openSoloDeckEditor, surfaceTransform } from './w90e-editor.ts';

test.use({ viewport: { width: 1440, height: 900 } });

test('one inspector, a zoom pill, ctrl+wheel and step zoom, a mouse pans only from empty space, and a card keeps its click', async ({ page }) => {
  test.setTimeout(3 * 60_000);
  await openSoloDeckEditor(page);
  const pileTop = deckPileTop(page).first();
  await pileTop.click();
  await expect(page.getByTestId('side-count')).toHaveText('1');
  await pileTop.click();
  await expect(page.getByTestId('side-count')).toHaveText('2');

  // At 100% the fit still holds: neither viewport clips its own cards (`dr-draft-picks.spec.ts`'s check).
  for (const id of ['side-grid', 'main-grid']) {
    const clip = await page.getByTestId(id).evaluate((e) => ({ w: e.scrollWidth - e.clientWidth, h: e.scrollHeight - e.clientHeight }));
    expect(clip, `${id} clips nothing at 100%`).toEqual({ w: 0, h: 0 });
  }

  await page.getByTestId('side-grid').getByTestId('card').first().hover();
  await expect(page.locator('[data-inspect]'), 'exactly one enlarged card').toHaveCount(1);
  await page.mouse.move(5, 5);
  await expect(page.locator('[data-inspect]')).toHaveCount(0);

  const pill = page.getByTestId('deck-zoom-pill');
  await expect(pill).toHaveText('100%');
  await expect(pill).toBeDisabled();
  await expect(page.getByTestId('deck-zoom-out')).toBeDisabled();

  // At 100% everything fits, so a drag has nothing to pan to.
  const rest = await emptyPointIn(page, 'main-grid');
  await page.mouse.move(rest.x, rest.y);
  await page.mouse.down();
  await page.mouse.move(rest.x - 120, rest.y - 60, { steps: 6 });
  await page.mouse.up();
  expect(await surfaceTransform(page, 'main-grid')).toEqual({ x: 0, y: 0, zoom: 1 });

  // ctrl+wheel zooms, and the card under the pointer stays under it.
  const before = await pileTop.boundingBox();
  if (before === null) throw new Error('no pile card to measure');
  const under = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
  const name = await pileTop.getAttribute('aria-label');
  await page.mouse.move(under.x, under.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -60);
  await page.keyboard.up('Control');
  await expect(pill).not.toHaveText('100%');
  await expect(pill).toBeEnabled();
  expect((await pileTop.boundingBox())!.width, 'the card drew bigger').toBeGreaterThan(before.width * 1.05);
  const stillUnder = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="card"]')?.getAttribute('aria-label') ?? null, under);
  expect(stillUnder, 'the zoom kept the card under the pointer').toBe(name);

  // The bars never zoom or pan.
  for (const id of ['side-count', 'main-count', 'deck-zoom-pill', 'filter-W']) await expect(page.getByTestId(id)).toBeInViewport();

  // A mouse drag on empty space pans the deck alone.
  const pool = await surfaceTransform(page, 'side-grid');
  const deck = await surfaceTransform(page, 'main-grid');
  const counts = [await page.getByTestId('main-count').textContent(), await page.getByTestId('side-count').textContent()];
  const empty = await emptyPointIn(page, 'main-grid');
  await page.mouse.move(empty.x, empty.y);
  await page.mouse.down();
  await page.mouse.move(empty.x - 40, empty.y - 30, { steps: 6 });
  await page.mouse.up();
  const panned = await surfaceTransform(page, 'main-grid');
  expect(panned.x + panned.y, 'the deck panned').toBeLessThan(deck.x + deck.y);
  expect(panned.zoom).toBe(deck.zoom);
  expect(await surfaceTransform(page, 'side-grid'), 'the pool did not move').toEqual(pool);
  expect([await page.getByTestId('main-count').textContent(), await page.getByTestId('side-count').textContent()], 'a pan moves no card').toEqual(counts);

  // A mouse drag that starts on a card is the card's, never a pan.
  const card = await cardPointIn(page, 'main-grid');
  await page.mouse.move(card.x, card.y);
  await page.mouse.down();
  await page.mouse.move(card.x + 50, card.y, { steps: 6 });
  await page.mouse.up();
  expect(await surfaceTransform(page, 'main-grid'), 'a drag from a card never pans').toEqual(panned);

  // A click still moves a card, zoomed in.
  const mainBefore = await page.getByTestId('main-count').textContent();
  const onCard = await cardPointIn(page, 'main-grid');
  await page.mouse.click(onCard.x, onCard.y);
  await expect(page.getByTestId('main-count')).not.toHaveText(mainBefore ?? '');

  // The pill's + and − step the zoom; the percentage resets it.
  const zoomed = await pill.textContent();
  await page.getByTestId('deck-zoom-in').click();
  await expect(pill).not.toHaveText(zoomed ?? '');
  await page.getByTestId('deck-zoom-out').click();
  await page.getByTestId('deck-zoom-out').click();
  await pill.click();
  await expect(pill).toHaveText('100%');
  expect(await surfaceTransform(page, 'main-grid')).toEqual({ x: 0, y: 0, zoom: 1 });
  expect(await surfaceTransform(page, 'side-grid')).toEqual({ x: 0, y: 0, zoom: 1 });
});

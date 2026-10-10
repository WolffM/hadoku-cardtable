/**
 * The operator, 2026-10-10: *"the expanded exile/graveyard views generally look good but it's a bit
 * awkward if theres currently an expanded card being shown. when expand graveyard/exile is clicked can
 * we dispose the currently expanded card being shown? and also make sure the cursor has to exit the
 * current expand trigger zone before it can trigger a new expand? that way it won't immediately block
 * the view again when the cursor moves slightly."*
 *
 * Alice hovers the top card of her graveyard (the inspector opens on it), clicks it (the pile view
 * opens) — the inspector is gone at once. A small move inside that card brings nothing back. A card in
 * the open view is read as usual, beside the view; and coming back onto the graveyard card after
 * leaving it reads that card again.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const view = (page: Page) => page.getByTestId('pile-view');
const inspector = (page: Page) => page.locator('[data-inspect]');
const pile = (page: Page) => page.locator('.seat [data-zone="graveyard"][data-owner="you"]');

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/** The graveyard card with the most of itself showing, not one Forge offers: its id, name and the middle of what shows. */
const topCard = (page: Page) =>
  page.evaluate(() => {
    const lis = Array.from(document.querySelectorAll<HTMLElement>('.seat [data-zone="graveyard"][data-owner="you"] li[data-card-id]'));
    let best: { id: string; name: string; x: number; y: number; px: number } | null = null;
    for (const li of lis) {
      if (li.querySelector('[data-selectable="true"]') !== null || li.getAttribute('data-selectable') === 'true') continue;
      const next = li.nextElementSibling as HTMLElement | null;
      const box = li.getBoundingClientRect();
      const px = next === null ? box.height : Math.max(0, next.getBoundingClientRect().top - box.top);
      if (best === null || px > best.px) {
        best = { id: li.getAttribute('data-card-id')!, name: li.querySelector('.card__name')?.textContent?.trim() ?? '', x: box.left + box.width / 2, y: box.top + px / 2, px };
      }
    }
    return best;
  });

test(titled('opening a graveyard view puts the inspector away, and it stays away until the pointer leaves the card'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'w67-piles');
    await alice.page.setViewportSize({ width: 1280, height: 800 });
    await expect(pile(alice.page)).toHaveAttribute('data-count', '31', { timeout: 60_000 });
    const top = (await topCard(alice.page))!;
    expect(top, 'a graveyard card shows enough of itself to point at').not.toBeNull();
    console.log(`[w69-pile] graveyard card ${top.name} #${top.id}: ${Math.round(top.px)}px showing, pointer at ${Math.round(top.x)},${Math.round(top.y)}`);

    // Hover: the one inspector reads it.
    await alice.page.mouse.move(top.x, top.y, { steps: 4 });
    await expect(inspector(alice.page).locator('.card__name'), 'hovering the graveyard card opens the inspector on it').toHaveText(top.name, { timeout: 3_000 });

    // Click: the pile view opens and the inspector is gone at once.
    await alice.page.mouse.click(top.x, top.y);
    await expect(view(alice.page), 'clicking the graveyard opens its pile view').toHaveCount(1, { timeout: 5_000 });
    const panel = (await view(alice.page).boundingBox())!;
    const still = await inspector(alice.page).count();
    const shown = still > 0 ? await inspector(alice.page).first().boundingBox() : null;
    console.log(
      `[w69-pile] pile view open at ${Math.round(panel.x)},${Math.round(panel.y)} ${Math.round(panel.width)}×${Math.round(panel.height)}; inspector panels ${still}` +
        (shown === null ? '' : `, covering ${Math.round(overlap(shown, panel))}px² of the view`),
    );
    await expect(inspector(alice.page), 'the inspector is put away the moment the pile view opens').toHaveCount(0, { timeout: 500 });

    // A small move inside the same card brings nothing back.
    for (const [dx, dy] of [
      [2, 0],
      [-3, 1],
      [4, -1],
    ] as const) {
      await alice.page.mouse.move(top.x + dx, top.y + dy);
      await alice.page.waitForTimeout(150);
    }
    const afterNudge = await inspector(alice.page).count();
    console.log(`[w69-pile] after three small moves inside ${top.name}: inspector panels ${afterNudge}`);
    expect(afterNudge, 'a small move inside the clicked card does not bring the inspector back').toBe(0);

    // A card in the open view is read as usual, beside the view.
    const inView = view(alice.page).locator('li[data-card-id]').nth(3);
    const vb = (await inView.boundingBox())!;
    const inViewName = ((await inView.locator('.card__name').first().textContent()) ?? '').trim();
    await alice.page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2, { steps: 6 });
    await expect(inspector(alice.page).locator('.card__name'), 'a card in the view is read in the inspector').toHaveText(inViewName, { timeout: 3_000 });
    const beside = (await inspector(alice.page).boundingBox())!;
    console.log(`[w69-pile] hovering ${inViewName} in the view: inspector covers ${Math.round(overlap(beside, panel))}px² of the view`);
    expect(overlap(beside, panel), 'the inspector stands beside the view').toBe(0);

    // Back onto the graveyard card after leaving it: read again.
    await alice.page.mouse.move(top.x, top.y, { steps: 6 });
    await expect(inspector(alice.page).locator('.card__name'), 'coming back onto the graveyard card reads it again').toHaveText(top.name, { timeout: 3_000 });
    console.log(`[w69-pile] back on ${top.name} after leaving it: inspector reads "${(await inspector(alice.page).locator('.card__name').textContent()) ?? ''}"`);
  } finally {
    await stack.stop();
  }
});

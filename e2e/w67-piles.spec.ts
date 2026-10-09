/**
 * The operator, 2026-10-09: *"i need some solution for when the graveyard and exile get very large. i
 * dont necessarily want to make them scrollable, but i do need a way to reach certain cards which is
 * currently impossible."*
 *
 * Alice's graveyard is 31 cards with Think Twice buried in the middle, and Forge offers its flashback.
 * In the pile on the board its name strip is squeezed to nothing, so it cannot be hovered or clicked.
 * Clicking the pile opens a view of every card in it: hovering Think Twice there opens the one
 * inspector, clicking it starts the flashback cast and closes the view. Esc and a click outside close
 * it; bob's pile opens the same way on alice's screen; nothing of it reaches bob's screen.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled, offeredNamed, says, stackCount } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

const view = (page: Page) => page.getByTestId('pile-view');
const inspector = (page: Page) => page.locator('[data-inspect]');
const pile = (page: Page, owner: 'you' | 'them') => page.locator(`.seat [data-zone="graveyard"][data-owner="${owner}"]`);

/** The page never scrolls: the document and the board both fit their boxes. */
const scrolls = (page: Page) =>
  page.evaluate(() => {
    const doc = document.scrollingElement!;
    const board = document.querySelector<HTMLElement>('.board')!;
    return {
      doc: doc.scrollWidth > doc.clientWidth || doc.scrollHeight > doc.clientHeight,
      board: board.scrollWidth > board.clientWidth || board.scrollHeight > board.clientHeight,
    };
  });

/** How much of a buried card the pile leaves visible, and whether the pointer at the middle of that strip is on it. */
const strip = (page: Page, id: number) =>
  page.evaluate((cardId) => {
    const li = document.querySelector<HTMLElement>(`.seat [data-zone="graveyard"] li[data-card-id="${cardId}"]`)!;
    const next = li.nextElementSibling as HTMLElement | null;
    const box = li.getBoundingClientRect();
    const px = next === null ? box.height : Math.max(0, next.getBoundingClientRect().top - box.top);
    const at = document.elementFromPoint(box.left + box.width / 2, box.top + px / 2);
    return { px: Math.round(px * 10) / 10, x: box.left + box.width / 2, y: box.top + px / 2, hit: at?.closest('li[data-card-id]')?.getAttribute('data-card-id') ?? null };
  }, id);

test(titled('a huge graveyard opens as a pile view: a buried flashback card can be read in the inspector and cast from it'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w67-piles');
    for (const p of [alice.page, bob.page]) await p.setViewportSize({ width: 1280, height: 800 });
    let twice: number | undefined;
    await expect
      .poll(async () => (twice = await offeredNamed(alice.page, 'Think Twice')), { timeout: 60_000, message: "alice is offered Think Twice's flashback from her graveyard" })
      .not.toBeUndefined();
    const id = twice!;
    await expect(pile(alice.page, 'you')).toHaveAttribute('data-count', '31');
    await expect(pile(alice.page, 'them')).toHaveAttribute('data-count', '20');

    // (a) On the board the buried card is out of reach: its strip is squeezed to a few px. (A pointer placed to
    // the pixel still finds it — the red on main, 2026-10-09, measured 3.5 px — but no hand does.)
    const s = await strip(alice.page, id);
    await alice.page.mouse.move(s.x, s.y);
    await alice.page.waitForTimeout(300);
    const seenOnBoard = (await inspector(alice.page).count()) > 0 ? ((await inspector(alice.page).locator('.card__name').first().textContent()) ?? '') : '';
    console.log(`[piles] board strip of Think Twice #${id}: ${s.px}px, pointer at its middle is on #${s.hit}, inspector shows "${seenOnBoard}"`);
    expect(s.px, 'the buried card is squeezed out of reach on the board').toBeLessThan(6);
    await alice.page.mouse.move(640, 400);

    // (d) Bob's pile, on alice's screen: every one of his cards, Llanowar Elves among them; nothing on bob's screen.
    const theirs = (await pile(alice.page, 'them').boundingBox())!;
    await alice.page.mouse.click(theirs.x + theirs.width / 2, theirs.y + 4);
    await expect(view(alice.page), "clicking bob's graveyard opens its pile view").toHaveCount(1, { timeout: 5_000 });
    await expect(view(alice.page).locator('li[data-card-id]')).toHaveCount(20);
    await expect(view(alice.page).locator('.card__name', { hasText: 'Llanowar Elves' })).toHaveCount(1);
    await expect(view(bob.page), "alice's pile view is hers alone").toHaveCount(0);
    console.log(`[piles] bob's pile view on alice's screen: ${await view(alice.page).locator('li[data-card-id]').count()} cards, bob's screen shows ${await view(bob.page).count()} views`);

    // (c) Esc closes it; so does a click outside.
    await alice.page.keyboard.press('Escape');
    await expect(view(alice.page), 'Esc closes the pile view').toHaveCount(0, { timeout: 2_000 });
    await alice.page.mouse.click(theirs.x + theirs.width / 2, theirs.y + 4);
    await expect(view(alice.page)).toHaveCount(1, { timeout: 5_000 });
    // Outside: a point of her own battlefield the panel does not cover.
    const open = (await view(alice.page).boundingBox())!;
    const field = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').boundingBox())!;
    const outside = [field.x + field.width - 8, field.x + 8, field.x + field.width / 2]
      .map((x) => ({ x, y: field.y + 8 }))
      .find((p) => p.x < open.x || p.x > open.x + open.width || p.y < open.y || p.y > open.y + open.height)!;
    console.log(`[piles] bob's pile view at ${Math.round(open.x)},${Math.round(open.y)} ${Math.round(open.width)}×${Math.round(open.height)}; clicking outside at ${Math.round(outside.x)},${Math.round(outside.y)}`);
    await alice.page.mouse.click(outside.x, outside.y);
    await expect(view(alice.page), 'a click outside closes the pile view').toHaveCount(0, { timeout: 2_000 });
    console.log('[piles] Esc and a click outside each close the view');

    // (b) Alice's own pile: every card at a readable size, nothing scrolls, Think Twice is hovered and cast.
    const mine = (await pile(alice.page, 'you')).locator('li[data-card-id]').first();
    const first = (await mine.boundingBox())!;
    await alice.page.mouse.click(first.x + first.width / 2, first.y + 3);
    await expect(view(alice.page), 'clicking her graveyard opens its pile view').toHaveCount(1, { timeout: 5_000 });
    await expect(view(alice.page).locator('li[data-card-id]')).toHaveCount(31);
    const inView = view(alice.page).locator(`li[data-card-id="${id}"]`);
    const box = (await inView.boundingBox())!;
    const panel = (await view(alice.page).boundingBox())!;
    const overflow = await scrolls(alice.page);
    console.log(`[piles] alice's pile view: 31 cards, Think Twice drawn ${Math.round(box.width)}×${Math.round(box.height)}px, panel ${Math.round(panel.width)}×${Math.round(panel.height)} at ${Math.round(panel.x)},${Math.round(panel.y)}, scrolls doc=${overflow.doc} board=${overflow.board}`);
    expect(box.width, 'the buried card is drawn whole in the view').toBeGreaterThanOrEqual(40);
    expect(overflow, 'the pile view makes nothing scroll').toEqual({ doc: false, board: false });
    await expect(inView, 'the offered card is offered in the view too').toHaveAttribute('data-selectable', 'true');

    await alice.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await expect(inspector(alice.page).locator('.card__name'), 'hovering it in the view opens the inspector on it').toHaveText('Think Twice', { timeout: 3_000 });
    console.log('[piles] hovering Think Twice in the view shows it in the inspector');

    await alice.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(view(alice.page), 'a selection closes the view').toHaveCount(0, { timeout: 3_000 });
    await expect
      .poll(
        async () => {
          const paying = await alice.page.getByTestId('live-payment-ok').count();
          const inYard = await alice.page.locator(`.seat [data-zone="graveyard"] li[data-card-id="${id}"]`).count();
          return paying > 0 || inYard === 0 || (await stackCount(alice.page)) > 0;
        },
        { timeout: 15_000, message: "Think Twice's flashback cast starts" },
      )
      .toBe(true);
    const exiled = await alice.page.locator('.seat[data-viewer] [data-zone="exile"] .card__name').allTextContents();
    console.log(
      `[piles] after the click: payment window ${await alice.page.getByTestId('live-payment-ok').count()}, stack ${await stackCount(alice.page)}, graveyard ${await pile(alice.page, 'you').getAttribute('data-count')}, exile [${exiled.join(', ')}], says "${(await says(alice.page)).replace(/\s+/g, ' ').trim()}"`,
    );
  } finally {
    await stack.stop();
  }
});

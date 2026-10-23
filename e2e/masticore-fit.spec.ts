/**
 * A question's card grid is the reveal's (the operator, 2026-10-23: *"lets not reinvent the wheel on
 * how to display card grids in decision windows"*, choosing the reveal's card size and a scroll over
 * shrinking cards to fit), in the question's own window, with its answers whole: *"decision windows
 * are centered differently on the page and need space for answers to questions like selecting cards
 * and clicking Ok … make sure this is tested properly"*.
 *
 * Two browsers, a real Forge match (`scenarios/masticore-upkeep.state`): alice holds seven cards
 * and Masticore, and her upkeep asks her to discard one or sacrifice it. At the default 1280×720:
 * - every card is a choice, drawn at a fail to find's reveal size (measured against a real
 *   `.reveal-notice__cards` tile on the same page, not a number copied here);
 * - the window grows to its grid, a row across before the next one starts (2026-10-23: *"first show a
 *   row until we've reached the horizontal limit, then start a new row"*), so seven cards fit with
 *   nothing scrolled; on the way, nothing in the question's column scrolls but its body (2026-10-22:
 *   never the words);
 * - its answers (OK) are wholly inside the column and the window;
 * - picking a card discards it (a one-pick selection answers on the pick; OK where the sheet has one).
 *
 * Serves the prebuilt dist (`e2e/play/harness.ts`); skips, with a title that says why, when Forge is
 * absent.
 */

import { expect, test, type Page } from '@playwright/test';

import { enabledOk, makeTitled } from './play/board.ts';
import { answerConfirm, confirmOpen } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface Sheet {
  /** The sheet's words, for the log. */
  text: string;
  /** Every box in the question's column whose content is taller than the box: a scroll bar. */
  scrollers: string[];
  tiles: number;
  /** A choice's card width, and a reveal's on the same page. */
  cardW: number;
  revealCardW: number;
  /** The answers' row lies wholly inside the column and the window. */
  answersWhole: boolean;
  /** Tiles per row, top to bottom. */
  rows: number[];
  /** How many more tiles the first row had room for. */
  roomLeft: number;
}

/** The open question's column, measured; null when none is open. */
async function measure(page: Page): Promise<Sheet | null> {
  return page.evaluate(() => {
    const column = document.querySelector<HTMLElement>('.live__prompt');
    if (column === null) return null;
    const name = (el: Element) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`;
    const scrollers = [column, ...column.querySelectorAll<HTMLElement>('*')]
      .filter((el) => el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY))
      .map((el) => `${name(el)} ${el.scrollHeight}>${el.clientHeight}`);
    const tiles = [...column.querySelectorAll<HTMLElement>('.prompt__cards > li')];
    // A reveal's grid, drawn off-screen with the page's own styles, for its card's width.
    const probe = document.createElement('div');
    probe.className = 'reveal-notice';
    probe.style.cssText = 'position:fixed;left:-9999px;top:0;max-width:none';
    probe.innerHTML = '<ul class="reveal-notice__cards"><li><div class="card"></div></li></ul>';
    document.body.append(probe);
    const revealCardW = probe.querySelector('.card')!.getBoundingClientRect().width;
    probe.remove();
    const col = column.getBoundingClientRect();
    const answers = column.querySelector('.prompt__actions')?.getBoundingClientRect();
    const answersWhole =
      answers !== undefined && answers.height > 0 && answers.top >= col.top && answers.bottom <= col.bottom && answers.top >= 0 && answers.bottom <= window.innerHeight;
    const tops = new Map<number, number>();
    for (const t of tiles) {
      const top = Math.round(t.getBoundingClientRect().top);
      tops.set(top, (tops.get(top) ?? 0) + 1);
    }
    const rows = [...tops.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
    const grid = column.querySelector<HTMLElement>('.prompt__cards');
    const lastInRow = tiles[(rows[0] ?? 1) - 1]?.getBoundingClientRect();
    const tileW = tiles[0]?.getBoundingClientRect().width ?? 1;
    const roomLeft = grid === null || lastInRow === undefined ? 0 : Math.floor((grid.getBoundingClientRect().right - lastInRow.right) / (tileW + 6));
    return {
      text: (column.textContent ?? '').trim().slice(0, 120),
      scrollers,
      tiles: tiles.length,
      cardW: tiles[0]?.querySelector('.card')?.getBoundingClientRect().width ?? 0,
      revealCardW,
      answersWhole,
      rows,
      roomLeft: rows.length > 1 ? roomLeft : 0,
    };
  });
}

test(titled('Masticore’s upkeep discard: the reveal’s card grid in the question’s own window, grown to its rows, OK whole, and a pick discards'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'masticore-upkeep');
    const sheets: Sheet[] = [];
    let grid: Sheet | null = null;
    await expect
      .poll(
        async () => {
          const sheet = await measure(alice.page);
          if (sheet !== null) {
            if (sheets.at(-1)?.text !== sheet.text) {
              console.log(`[masticore-fit] sheet ${JSON.stringify(sheet)}`);
              sheets.push(sheet);
            }
            if (sheet.tiles > 0) {
              grid = sheet;
              return true;
            }
          }
          if (await confirmOpen(alice.page)) {
            // The unless cost, asked as a yes/no first: pay it, so the discard is asked.
            await answerConfirm(alice.page, 'yes').catch(() => undefined);
            return false;
          }
          for (const page of [bob.page, alice.page]) {
            if ((await page.locator('.live__prompt').count()) > 0) continue;
            const ok = enabledOk(page).first();
            if ((await ok.count()) > 0) await ok.click({ timeout: 1_000 }).catch(() => undefined);
          }
          return false;
        },
        { timeout: 90_000, intervals: [400], message: 'alice is asked which card to discard' },
      )
      .toBe(true);
    // Settled: the tiles' art has had a frame to land.
    await alice.page.waitForTimeout(500);
    grid = (await measure(alice.page)) ?? grid;
    console.log(`[masticore-fit] grid ${JSON.stringify(grid)}`);
    const onlyTheBody = (s: Sheet) => s.scrollers.filter((x) => !x.startsWith('div.prompt__body '));
    expect(sheets.flatMap(onlyTheBody), 'no sheet on the way scrolled anything but its body').toEqual([]);
    expect(grid!.scrollers, 'the discard sheet grows to its seven cards: nothing scrolls').toEqual([]);
    expect(grid!.rows[0], 'a row runs across the room before the next starts').toBeGreaterThan(2);
    expect(grid!.roomLeft, 'the first row is full before the next starts').toBe(0);
    expect(grid!.tiles, 'every card in her hand is a choice').toBe(7);
    expect(grid!.revealCardW, 'the reveal grid draws cards').toBeGreaterThan(40);
    expect(Math.abs(grid!.cardW - grid!.revealCardW), 'a choice’s card is a reveal’s size').toBeLessThanOrEqual(1);
    expect(grid!.answersWhole, 'OK is wholly inside the window').toBe(true);

    // The answer works: the first card is discarded. A one-pick selection is answered by the pick itself
    // (`SelectionPrompt.tsx`); a sheet that still offers its OK after the pick takes it.
    const first = alice.page.locator('.live__prompt .prompt__cards > li').first();
    const picked = await first.getAttribute('data-card-id');
    await first.locator('label').click();
    const ok = alice.page.locator('.live__prompt').getByTestId(/^(selection-done|prompt-submit)$/);
    if (await ok.isEnabled({ timeout: 1_000 }).catch(() => false)) await ok.click({ timeout: 2_000 }).catch(() => undefined);
    await expect(alice.page.locator('.live__prompt .prompt__cards'), 'the question closes').toHaveCount(0, { timeout: 15_000 });
    // By id, not by count: her draw step follows the upkeep and puts a card back in.
    await expect(alice.page.locator(`[data-zone="hand"][data-owner="you"] [data-board-card="${picked}"]`), 'the picked card left her hand').toHaveCount(0, { timeout: 15_000 });
  } finally {
    await stack.stop();
  }
});

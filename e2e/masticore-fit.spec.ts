/**
 * A question's sheet never scrolls. The operator, 2026-10-22, on Masticore's upkeep trigger:
 *
 *   "i just got the masticore trigger and i see TWO scroll bars, there should be zero. one scroll
 *   bar for the top where it explains the effect. one scroll bar for the bottom where the cards are
 *   for selecting"
 *
 * Two browsers, a real Forge match (`scenarios/masticore-upkeep.state`): alice holds seven cards
 * and Masticore, and her upkeep asks her to discard one or sacrifice it. Every sheet she is shown on
 * the way is measured at the default 1280×720 viewport: no box in the question's column may have
 * more content than it shows, and the card grid draws all seven cards.
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
  /** How many card tiles the sheet draws, and how many of them lie wholly inside the window. */
  tiles: number;
  tilesInView: number;
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
    const inView = tiles.filter((li) => {
      const r = li.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0;
    });
    return { text: (column.textContent ?? '').trim().slice(0, 120), scrollers, tiles: tiles.length, tilesInView: inView.length };
  });
}

test(titled('Masticore’s upkeep discard: no part of the question scrolls, and all seven cards are on screen'), async ({ browser }) => {
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
    // Settled: the tiles' art and the fit have had a frame to land.
    await alice.page.waitForTimeout(500);
    grid = (await measure(alice.page)) ?? grid;
    console.log(`[masticore-fit] grid ${JSON.stringify(grid)}`);
    expect(sheets.flatMap((s) => s.scrollers), 'no sheet on the way scrolled').toEqual([]);
    expect(grid!.scrollers, 'the discard sheet scrolls nowhere').toEqual([]);
    expect(grid!.tiles, 'every card in her hand is a choice').toBe(7);
    expect(grid!.tilesInView, 'every card is on screen').toBe(7);
  } finally {
    await stack.stop();
  }
});

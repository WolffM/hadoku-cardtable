/**
 * The operator, 2026-10-13: *"let's squish cards a bit more before we make them take up another row"*.
 * Their match's log (`m-a58ab8a6bb79`, 01:05Z): thirteen permanents, the four-lane layout switched on,
 * and off again seven seconds later — thirteen columns had already taken the lanes to two rows of small
 * cards. A row now narrows to three quarters of the card a second row would draw before it takes one
 * (`board.css`, "When to add a row") — but never past `--card-min`, where names stop reading: a row
 * that cannot hold its columns at that width takes the second row instead.
 *
 * Scenario `row-squish`: twelve lone permanents (eight lands, four creatures). From 1366 up the lanes
 * stay one row; at 1280×800 (a 698px battlefield inside its gutter) the eight-land lane is 380px
 * against the 384px eight cards at `--card-min` need, so they draw two rows. At every width every
 * card is at least `--card-min` wide (its name readable), and no lane and no battlefield overflows.
 */
import { expect, test } from '@playwright/test';

import { makeTitled, resizeWindow } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';
import { chooseLanes } from './play/w32.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('twelve permanents in the four lanes squish into one row before they wrap, and every card stays readable'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(2 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'row-squish');
    const page = alice.page;
    await resizeWindow(page, { width: 1280, height: 800 });
    const cards = page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card');
    await expect(cards, 'twelve lone permanents').toHaveCount(12, { timeout: 30_000 });
    await chooseLanes(alice);
    for (const [width, height, want] of [
      [1280, 800, 2],
      [1366, 768, 1],
      [1440, 900, 1],
      [1920, 1080, 1],
    ] as const) {
      await resizeWindow(page, { width, height });
      await expect(cards).toHaveCount(12);
      const read = () =>
        page.evaluate(() => {
          const zone = document.querySelector('.seat[data-viewer] > .zone--battlefield') as HTMLElement;
          const boxes = Array.from(zone.querySelectorAll('.zone__cards > li.board-card')).map((li) => li.getBoundingClientRect());
          // Rows within each lane: the lanes stand side by side and need not share a top.
          const rows = Math.max(
            ...Array.from(zone.querySelectorAll('.zone__cards')).map(
              (list) => new Set(Array.from(list.querySelectorAll(':scope > li.board-card')).map((li) => Math.round(li.getBoundingClientRect().top))).size,
            ),
          );
          const lanes = zone.querySelector('.zone__rows') as HTMLElement;
          const cardMin = parseFloat(getComputedStyle(document.documentElement).fontSize) * 2.75;
          return {
            aspect: zone.dataset.zoneAspect ?? '',
            zone: `${Math.round(zone.getBoundingClientRect().width)}x${Math.round(zone.getBoundingClientRect().height)}`,
            cols: lanes.style.getPropertyValue('--cols'),
            rows,
            narrowest: Math.min(...boxes.map((b) => b.width)),
            cardMin,
            overflow: zone.scrollWidth - zone.clientWidth,
            laneOverflow: Math.max(...Array.from(zone.querySelectorAll<HTMLElement>('.zone__row')).map((lane) => lane.scrollWidth - lane.clientWidth)),
          };
        });
      // The lanes settle on their row count from a measured box: wait for it, then read it.
      await expect
        .poll(async () => (await read()).rows, { message: `${width}x${height}: the lanes draw ${want} row(s) — ${JSON.stringify(await read())}` })
        .toBe(want);
      const r = await read();
      console.log(`[row-squish] ${width}x${height} zone ${r.zone} aspect ${r.aspect}, ${r.cols} columns: ${r.rows} row(s), narrowest card ${r.narrowest.toFixed(1)}px (floor ${r.cardMin}px), overflow ${r.overflow}px, lanes ${r.laneOverflow}px`);
      expect(r.narrowest, `${width}x${height}: every card at least --card-min wide`).toBeGreaterThanOrEqual(r.cardMin - 0.5);
      expect(r.overflow, `${width}x${height}: nothing overflows the battlefield`).toBeLessThanOrEqual(0);
      expect(r.laneOverflow, `${width}x${height}: no lane's cards run past it`).toBeLessThanOrEqual(1);
    }
  } finally {
    await stack.stop();
  }
});

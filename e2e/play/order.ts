/**
 * The ordering prompts' rows (`apps/ui/src/play/prompts/row-drag.ts`), as a hand reaches for them: where a
 * person can press or drop, and when the rows have stopped sliding from the last drop.
 */
import type { Locator, Page } from '@playwright/test';

export type Point = { x: number; y: number };

/**
 * A point a person can see inside `l`: `at` is the fraction across and down its box, clamped into what every clipping
 * ancestor shows — and kept `CLEAR` px off that view's top and bottom where there is room, so a held pointer never sits
 * where the drag scrolls the box (`row-drag.ts`'s edge scroll is its own question, not this spec's).
 */
const CLEAR = 32;
export const pointIn = (l: Locator, at: Point = { x: 0.5, y: 0.5 }): Promise<Point> =>
  l.evaluate((el, { at, clear }) => {
    const box = el.getBoundingClientRect();
    let { left, top, right, bottom } = box;
    for (let a = el.parentElement; a !== null; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const r = a.getBoundingClientRect();
      left = Math.max(left, r.left);
      top = Math.max(top, r.top);
      right = Math.min(right, r.right);
      bottom = Math.min(bottom, r.bottom);
    }
    right = Math.min(right, window.innerWidth);
    bottom = Math.min(bottom, window.innerHeight);
    if (right - left < 4 || bottom - top < 4) throw new Error(`nothing of ${el.outerHTML.slice(0, 80)} is visible`);
    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo + 2), hi - 2);
    const inset = bottom - top > 2 * clear + 8 ? clear : (bottom - top) / 2 - 2;
    return {
      x: clamp(box.left + box.width * at.x, left, right),
      y: clamp(box.top + box.height * at.y, top + inset, bottom - inset),
    };
  }, { at, clear: CLEAR });

/** True when no ordering row moved across two animation frames. */
export const rowsSettled = (page: Page): Promise<boolean> =>
  page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const read = () =>
          Array.from(document.querySelectorAll('[data-testid="live-prompt"] li[data-card-id]'))
            .map((el) => {
              const r = el.getBoundingClientRect();
              return `${r.left},${r.top}`;
            })
            .join(';');
        const before = read();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(read() === before)));
      }),
  );

/**
 * A real press-drag of `row` onto `onto` (`at` across and down it), in small steps the way a hand drags, once
 * the rows have settled: a box measured mid-slide is where the row was, not where it is.
 */
export async function dragRowOnto(page: Page, row: Locator, onto: Locator, at: Point = { x: 0.5, y: 0.5 }): Promise<void> {
  await settle(page);
  await onto.scrollIntoViewIfNeeded();
  const shown = await pointIn(row).then(
    () => true,
    () => false,
  );
  if (!shown) await row.scrollIntoViewIfNeeded();
  await settle(page);
  const from = await pointIn(row);
  const to = await pointIn(onto, at);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

/** Until no ordering row moves across two animation frames. */
export async function settle(page: Page): Promise<void> {
  for (let i = 0; i < 100; i++) if (await rowsSettled(page)) return;
  throw new Error('the ordering rows never stopped moving');
}

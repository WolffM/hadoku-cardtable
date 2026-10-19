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

/**
 * A point on the part of `row` that shows, `f` of the way down it. A card list is a pile
 * (`MovePrompt.tsx`): each card's name strip peeks out above the card drawn in front of it, so a row
 * shows only from its own top down to the top of the next row drawn below it in its list.
 */
export const stripPoint = (row: Locator, f = 0.5): Promise<Point> =>
  row.evaluate((el, f) => {
    const r = el.getBoundingClientRect();
    const below = Array.from(el.parentElement?.children ?? [])
      .map((e) => e.getBoundingClientRect().top)
      .filter((top) => top > r.top + 1);
    const bottom = Math.min(r.bottom, ...below);
    if (bottom - r.top < 4 || r.width < 4) throw new Error(`nothing of ${el.outerHTML.slice(0, 80)} shows`);
    return { x: r.left + r.width / 2, y: r.top + (bottom - r.top) * f };
  }, f);

/**
 * Where a release puts a card just before `row` in the answer, the way a hand points at it: in a pile
 * (`data-pile`, first card in front at the foot) the lower part of its showing strip — between it and
 * the card drawn below it, which is the one before it — and in a list of words, its upper part.
 */
export const beforePoint = async (row: Locator): Promise<Point> =>
  stripPoint(row, (await row.evaluate((el) => el.parentElement?.hasAttribute('data-pile') === true)) ? 0.8 : 0.2);

/**
 * True when no ordering row moved across two animation frames and none is sliding: a drop's slide
 * (`lift.ts`'s `flip`) holds a row at its start for a frame before its transition runs, which two
 * frames of stillness alone read as settled.
 */
export const rowsSettled = (page: Page): Promise<boolean> =>
  page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="live-prompt"] li[data-card-id]'));
        const read = () =>
          rows()
            .map((el) => {
              const r = el.getBoundingClientRect();
              return `${r.left},${r.top}`;
            })
            .join(';');
        const sliding = () => rows().some((el) => el.style.transform !== '' || el.getAnimations().length > 0);
        const before = read();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(!sliding() && read() === before)));
      }),
  );

/**
 * A real press-drag of `row` onto `onto` — `at` across and down it, or `'before'` it (`beforePoint`) — in
 * small steps the way a hand drags, once the rows have settled: a box measured mid-slide is where the row was,
 * not where it is. The press lands on the part of the row that shows.
 */
export async function dragRowOnto(page: Page, row: Locator, onto: Locator, at: Point | 'before' = { x: 0.5, y: 0.5 }): Promise<void> {
  await settle(page);
  await onto.scrollIntoViewIfNeeded();
  const shown = await stripPoint(row).then(
    () => true,
    () => false,
  );
  if (!shown) await row.scrollIntoViewIfNeeded();
  await settle(page);
  const from = await stripPoint(row);
  const to = at === 'before' ? await beforePoint(onto) : await pointIn(onto, at);
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

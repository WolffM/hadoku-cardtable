/**
 * Clip: the shared stack drag (AF518). `promo-breakfast.state` again: the hero, holding priority, puts two
 * Nomads en-Kor activations on the stack at Cephalid Illusionist. Then the rival takes hold of the top chip
 * and carries it across the hero's screen, the hero grabs the same chip, the two hands pull it opposite
 * ways (it stands between them), and both let go. Filmed from the hero's screen; the press points are the
 * ones `e2e/stack-drag-shared.spec.ts` proves (a point where the chip is the topmost thing, once it is still).
 */
import { test, type Page } from '@playwright/test';

import { clickPermanent, isOffered, ownNamed, stackCount } from '../play/board.ts';
import { autoYield, humanMove, humanRest, restCursor, shootScenario, until, wrap, type Shoot } from './drive.ts';

type Point = { x: number; y: number };

/** A point of stack item `id` where it is the topmost thing and has not moved over two frames; null if none. */
function pickable(page: Page, id: string): Promise<Point | null> {
  return page.evaluate(async (item) => {
    const find = (): Element | null => document.querySelector(`[data-placed-spell="${item}"]:not([data-placed-leaving])`);
    const before = find()?.getBoundingClientRect();
    if (before === undefined) return null;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const el = find();
    const r = el?.getBoundingClientRect();
    if (el == null || r === undefined || Math.abs(r.left - before.left) > 1 || Math.abs(r.top - before.top) > 1) return null;
    for (const fy of [0.5, 0.3, 0.7])
      for (const fx of [0.5, 0.3, 0.7]) {
        const p = { x: r.left + r.width * fx, y: r.top + r.height * fy };
        if (document.elementFromPoint(p.x, p.y)?.closest('[data-placed-spell]') === el) return p;
      }
    return null;
  }, id);
}

/** Whether `id` is still the topmost thing at `at` once the hover's lift has been drawn. */
function underPointer(page: Page, at: Point, id: string): Promise<boolean> {
  return page.evaluate(async ([p, item]) => {
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    return document.elementFromPoint(p.x, p.y)?.closest('[data-placed-spell]')?.getAttribute('data-placed-spell') === item;
  }, [at, id] as const);
}

/** Onto stack item `id` and press, by `move` (the hero's human hand, or the rival's plain one). */
async function grab(page: Page, id: string, move: (p: Point) => Promise<void>): Promise<Point> {
  let at: Point | null = null;
  await until(`stack item ${id} is under the pointer`, async () => {
    at = await pickable(page, id);
    if (at === null) return false;
    await move(at);
    return underPointer(page, at, id);
  }, 15_000, 60, page);
  await page.mouse.down();
  return at!;
}

/** The rival's held pointer carried by (dx, dy) over `ms`, in small steps. */
async function pull(page: Page, from: Point, dx: number, dy: number, ms: number): Promise<Point> {
  const steps = Math.max(1, Math.round(ms / 30));
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + (dx * i) / steps, from.y + (dy * i) / steps);
    await page.waitForTimeout(30);
  }
  return { x: from.x + dx, y: from.y + dy };
}

test('tug: both players drag the same stack chip', async ({ browser }) => {
  let shoot: Shoot | undefined;
  try {
    shoot = await shootScenario(browser, 'tug', 'promo-breakfast');
    const { film, hero, rival } = shoot;
    const page = hero.page;
    const nomads = (await ownNamed(page, 'Nomads en-Kor'))[0]!;
    const illusionist = (await ownNamed(page, 'Cephalid Illusionist'))[0]!;
    await autoYield(rival.page);
    const full = page.getByTestId('live-full-control');
    if ((await full.getAttribute('aria-pressed')) !== 'true') await full.click();
    for (let n = 1; n <= 2; n++) {
      await until(`Nomads is offered (${n})`, async () => isOffered(page, nomads), 30_000, 60, page);
      await page.locator(`[data-board-card="${nomads}"] button`).first().evaluate((b) => (b as HTMLButtonElement).click());
      await until(`the Illusionist is targeted (${n})`, async () => {
        const list = page.locator('section[data-prompt="getChoices"] li', { hasText: 'Cephalid Illusionist' }).first();
        if ((await list.count()) > 0) {
          await list.locator('label').click();
          await page.locator('section[data-prompt="getChoices"] [data-testid="prompt-submit"]').click();
          return true;
        }
        return clickPermanent(page, illusionist, 500);
      }, 20_000, 60, page);
      await until(`activation ${n} is on the stack`, async () => (await stackCount(page)) >= n, 20_000, 60, page);
    }
    await restCursor(page);
    await film.beat(1_500);
    film.mark('stacked');

    const ids = await page.locator('[data-placed-spell]:not([data-placed-leaving])').evaluateAll((els) => els.map((e) => e.getAttribute('data-placed-spell') ?? ''));
    const chip = ids.at(-1)!;
    console.log(`[promo:tug] stack items ${ids.join(' ')}; tugging ${chip}`);

    // The rival takes it and carries it across.
    film.mark('rival-grab');
    let r = await grab(rival.page, chip, (p) => rival.page.mouse.move(p.x, p.y));
    r = await pull(rival.page, r, -260, 40, 900);
    await film.beat(500);

    // The hero takes hold of the same chip, and they pull opposite ways.
    film.mark('hero-grab');
    let h = await grab(page, chip, (p) => humanMove(page, p, 0.8));
    film.mark('tug');
    for (const [dr, dh] of [[-140, 160], [120, -90], [-160, 180]] as const) {
      const step = pull(rival.page, r, dr, 0, 700);
      await humanMove(page, { x: h.x + dh, y: h.y + 10 }, 1.2);
      h = { x: h.x + dh, y: h.y + 10 };
      r = await step;
      await film.beat(150);
    }
    film.mark('let-go');
    await rival.page.mouse.up();
    await humanRest(page, 500);
    await page.mouse.up();
    await film.beat(1_200);

    // Free again: the hero carries it home on both screens.
    film.mark('free');
    await grab(page, chip, (p) => humanMove(page, p, 0.8));
    await humanMove(page, { x: h.x - 120, y: h.y - 60 }, 1.1);
    await page.mouse.up();
    await restCursor(page);
    await film.beat(1_500);
    film.mark('end');
  } finally {
    await wrap(shoot ?? {});
  }
});

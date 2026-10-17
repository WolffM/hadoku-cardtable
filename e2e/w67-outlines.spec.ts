/**
 * Placement outlines (the operator, 2026-10-09): *"dashed outline of card placement sometimes shows
 * up on the opponents side of the board … dashed outline display is very inconsistent. sometimes it
 * only shows locations for cards on the current row, sometimes it shows on both rows. sometimes it
 * shows a dashed horizontal line."*
 *
 * Bob leaves a gap in his own row (an arrangement crosses the wire), then alice moves a card two
 * ways — rearranging one on her battlefield and carrying one from her hand — over each of her rows.
 * Every moment of either move draws the SAME thing: every column of every one of HER rows, and
 * nothing on bob's side, no outline of a whole row, no dashed battlefield.
 */
import { expect, test, type Page } from '@playwright/test';

import { makeTitled, resizeWindow } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

interface Dashed {
  seat: 'mine' | 'theirs' | 'none';
  zone: string | null;
  row: string | null;
  what: string;
  w: number;
  h: number;
}

/** Every element on the board drawn with a dashed outline or border right now, and the column marked as the release's. */
const dashed = (page: Page): Promise<Dashed[]> =>
  page.evaluate(() => {
    const out: Dashed[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.board *'))) {
      const cs = getComputedStyle(el);
      const outline = cs.outlineStyle === 'dashed' && cs.outlineWidth !== '0px';
      const border = cs.borderTopStyle === 'dashed' && cs.borderTopWidth !== '0px';
      const target = el.matches('li.zone__gap[data-arrange-target]');
      if (!outline && !border && !target) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const seat = el.closest('.seat');
      const row = el.closest('[data-tier], [data-board-row]');
      out.push({
        seat: seat === null ? 'none' : seat.hasAttribute('data-viewer') ? 'mine' : 'theirs',
        zone: el.closest('[data-zone]')?.getAttribute('data-zone') ?? null,
        row: row?.getAttribute('data-tier') ?? row?.getAttribute('data-board-row') ?? null,
        what: `${el.tagName.toLowerCase()}.${Array.from(el.classList).join('.')}${el.hasAttribute('data-presence-hint') ? '[hint]' : ''}${el.hasAttribute('data-virtual') ? '[virtual]' : ''}${target ? '[target]' : ''}`,
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
    return out;
  });

/** Her rows, and how many columns each one outlines. */
const rowsOf = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.seat[data-viewer] [data-zone="battlefield"] [data-tier], .seat[data-viewer] [data-zone="battlefield"] [data-board-row]')).map(
      (el) => el.getAttribute('data-tier') ?? el.getAttribute('data-board-row'),
    ),
  );

test(titled('a card on the move outlines every column of every one of HER rows — the same for a rearrange and a card from hand, nothing on his side'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w67-outlines');
    for (const p of [alice.page, bob.page]) await resizeWindow(p, { width: 1280, height: 800 });
    const hers = alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card');
    await expect(hers, 'alice has her three lands').toHaveCount(3, { timeout: 60_000 });
    await expect(bob.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card'), 'bob has his three').toHaveCount(3, { timeout: 30_000 });

    // Bob carries his first land to the far end of its row: the columns it leaves are gaps.
    const bobFirst = (await bob.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card').first().boundingBox())!;
    const bobRow = (await bob.page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-arrange-slot]').first().boundingBox())!;
    await bob.page.mouse.move(bobFirst.x + bobFirst.width / 2, bobFirst.y + bobFirst.height / 2);
    await bob.page.mouse.down();
    await bob.page.mouse.move(bobFirst.x + 20, bobFirst.y + 20, { steps: 3 });
    await bob.page.mouse.move(bobRow.x + bobRow.width - 30, bobFirst.y + bobFirst.height / 2, { steps: 12 });
    await bob.page.mouse.up();
    await expect
      .poll(() => alice.page.locator('.seat:not([data-viewer]) [data-zone="battlefield"] li.zone__gap').count(), { timeout: 10_000, message: 'his gap reaches her board' })
      .toBeGreaterThan(0);
    await bob.page.mouse.move(5, 5);

    const rows = await rowsOf(alice.page);
    const shots: { when: string; seen: Dashed[] }[] = [];
    const shoot = async (when: string) => {
      await alice.page.waitForTimeout(250);
      const seen = await dashed(alice.page);
      shots.push({ when, seen });
      console.log(`[outlines] ${when}: ${JSON.stringify(seen)}`);
    };
    const rowBox = async (row: string) =>
      (await alice.page.locator(`.seat[data-viewer] [data-zone="battlefield"] [data-tier="${row}"], .seat[data-viewer] [data-zone="battlefield"] [data-board-row="${row}"]`).boundingBox())!;

    // 1. A rearrange: one of her lands, held over each of her rows, then put back (Escape).
    const forest = (await hers.first().boundingBox())!;
    await alice.page.mouse.move(forest.x + forest.width / 2, forest.y + forest.height / 2);
    await alice.page.mouse.down();
    await alice.page.mouse.move(forest.x + 20, forest.y + 20, { steps: 3 });
    for (const row of rows) {
      const b = await rowBox(row!);
      await alice.page.mouse.move(b.x + b.width * 0.7, b.y + b.height / 2, { steps: 8 });
      await shoot(`rearrange over ${row}`);
    }
    await alice.page.keyboard.press('Escape');
    await alice.page.mouse.up();

    // 2. A card from her hand, carried over each of her rows, then back to the hand (no play).
    const island = (await alice.page.locator('.seat[data-viewer] [data-zone="hand"] li.board-card').first().boundingBox())!;
    await alice.page.mouse.move(island.x + island.width / 2, island.y + island.height / 2);
    await alice.page.mouse.down();
    for (const row of rows) {
      const b = await rowBox(row!);
      await alice.page.mouse.move(b.x + b.width * 0.7, b.y + b.height / 2, { steps: 10 });
      await shoot(`from hand over ${row}`);
    }
    await alice.page.mouse.move(island.x + island.width / 2, island.y + island.height / 2, { steps: 10 });
    await alice.page.mouse.up();

    // The same picture every time: columns in every one of her rows, and nothing else.
    for (const { when, seen } of shots) {
      expect(seen.filter((d) => d.seat !== 'mine' && !d.what.includes('[hint]')), `${when}: nothing dashed on his side or between the seats`).toEqual([]);
      expect(seen.filter((d) => !d.what.startsWith('li.zone__gap')), `${when}: no outline of a whole row, the battlefield, or anything but a column`).toEqual([]);
      for (const row of rows) {
        expect(seen.filter((d) => d.row === row).length, `${when}: ${row} shows its columns`).toBeGreaterThan(0);
      }
      expect(seen.filter((d) => d.h < d.w), `${when}: every column is card-shaped, never a line`).toEqual([]);
      expect(seen.filter((d) => d.what.includes('[target]')).length, `${when}: the column a release would fill is marked`).toBe(1);
      const shape = (s: Dashed[]) => rows.map((row) => s.filter((d) => d.row === row).length).join('/');
      expect(shape(seen), `${when}: the same columns as the first moment of the first move`).toBe(shape(shots[0]!.seen));
    }
  } finally {
    await stack.stop();
  }
});

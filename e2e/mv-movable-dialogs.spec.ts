/**
 * The operator, 2026-10-25: *"can we actually make all dialogs movable? within reason"*, and *"ideally we
 * remember where the user last moved the dialog and try to appear new dialogs there; if the dialog needs extra
 * space then we give it the default location"*.
 *
 * Each rule is measured on the real board against real Forge: `bolt-player.state` (Main 1, Lightning Bolt
 * and a Mountain), `masticore-upkeep.state` (a seven-card discard grid) and `w67-piles.state` (a graveyard to
 * open).
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one each test SKIPS and its
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */

import { expect, test, type Page } from '@playwright/test';

import { castUntilOnStack, enabledOk, makeTitled, nextPhaseLive, offeredNamed, resizeWindow } from './play/board.ts';
import { answerConfirm, confirmOpen } from './play/confirm.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** `movable.tsx`'s storage key: the one spot the player last put a dialog. */
const SPOT_KEY = 'cardtable:dialog-spot';

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

const intersects = (a: Box, b: Box): boolean => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
const inside = (a: Box, b: Box): boolean => a.left >= b.left - 1 && a.top >= b.top - 1 && a.right <= b.right + 1 && a.bottom <= b.bottom + 1;

/** The match's box and one sheet's, in client px. */
async function boxes(page: Page, sheet: string): Promise<{ live: Box; sheet: Box | null }> {
  return page.evaluate((sel) => {
    const box = (el: Element | null): Box | null => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    return { live: box(document.querySelector('.live'))!, sheet: box(document.querySelector(sel)) };
  }, sheet);
}

/** Drag `sheet` by `by`, pressing on its message (no control there). */
async function dragSheet(page: Page, sheet: string, by: { x: number; y: number }): Promise<void> {
  const grip = page.locator(`${sheet} .confirm__message`).first();
  const g = (await grip.boundingBox())!;
  const from = { x: g.x + Math.min(12, g.width / 2), y: g.y + g.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 10 });
  await page.mouse.up();
}

/** Every box on the table that must not move when a dialog does. */
const tableBoxes = (page: Page): Promise<string> =>
  page.evaluate(() =>
    JSON.stringify(
      Array.from(document.querySelectorAll('[data-testid="live-buttons"], [data-testid="live-phases"], .seat, [data-zone], [data-board-card]'), (el) => {
        const r = el.getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
      }),
    ),
  );

test(titled('a dialog moves where the player drags it, stays on the board, and the next one opens there unless it needs more room'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'bolt-player');
    const page = alice.page;
    await resizeWindow(page, { width: 1280, height: 800 });
    const sheet = '[data-testid="live-decision"]';
    await expect(nextPhaseLive(page), 'Main 1: the pop-up asks to proceed').toHaveCount(1, { timeout: 20_000 });
    // The table at rest first: the rail settles its height a moment after the match opens.
    let table = await tableBoxes(page);
    await expect
      .poll(
        async () => {
          await page.waitForTimeout(400);
          const now = await tableBoxes(page);
          const still = now === table;
          table = now;
          return still;
        },
        { timeout: 10_000, message: 'the table comes to rest' },
      )
      .toBe(true);
    const before = (await boxes(page, sheet)).sheet!;

    // A click on the body is still a click: under the threshold, nothing moves.
    await dragSheet(page, sheet, { x: 2, y: 1 });
    expect((await boxes(page, sheet)).sheet, 'a press that barely moves moves nothing').toEqual(before);

    // Dragged by its body, it follows the pointer.
    await dragSheet(page, sheet, { x: -420, y: 150 });
    const moved = (await boxes(page, sheet)).sheet!;
    expect(Math.round(moved.left - before.left), 'it moved left by the drag').toBe(-420);
    expect(Math.round(moved.top - before.top), 'and down by the drag').toBe(150);
    expect(await tableBoxes(page), 'nothing on the table moved with it').toBe(table);
    const spot = await page.evaluate((key) => window.localStorage.getItem(key), SPOT_KEY);
    expect(spot, 'the spot is remembered').not.toBeNull();

    // Never off the board: a drag far past its edge stops at the edge.
    await dragSheet(page, sheet, { x: -2000, y: 2000 });
    let b = await boxes(page, sheet);
    expect(inside(b.sheet!, b.live), `dragged past the edge, it stays on the board: ${JSON.stringify(b.sheet)} in ${JSON.stringify(b.live)}`).toBe(true);
    expect(Math.round(b.sheet!.left - b.live.left), 'held at the left edge').toBeLessThanOrEqual(8);
    // ...and stays on it when the window shrinks.
    await dragSheet(page, sheet, { x: 900, y: -100 });
    await resizeWindow(page, { width: 1000, height: 700 });
    await page.waitForTimeout(300);
    b = await boxes(page, sheet);
    expect(inside(b.sheet!, b.live), `the window shrank: still on the board: ${JSON.stringify(b.sheet)} in ${JSON.stringify(b.live)}`).toBe(true);
    await resizeWindow(page, { width: 1280, height: 800 });

    // Put it somewhere known, then open a NEW dialog: a reload draws the pop-up afresh, at that spot.
    await page.waitForTimeout(300);
    const home = (await boxes(page, sheet)).sheet!;
    await dragSheet(page, sheet, { x: before.left - 300 - home.left, y: before.top + 120 - home.top });
    const placed = (await boxes(page, sheet)).sheet!;
    await page.reload();
    await expect(nextPhaseLive(page), 'after the reload, the pop-up asks again').toHaveCount(1, { timeout: 30_000 });
    await page.waitForTimeout(300);
    const reopened = (await boxes(page, sheet)).sheet!;
    expect(Math.abs(reopened.left - placed.left), `a new dialog opens where the last was put: ${JSON.stringify(reopened)} vs ${JSON.stringify(placed)}`).toBeLessThanOrEqual(2);
    expect(Math.abs(reopened.top - placed.top), 'at the same height').toBeLessThanOrEqual(2);

    // Into the bottom-right corner: held there, a gap inside the board's edge.
    const corner = (await boxes(page, sheet)).live;
    await dragSheet(page, sheet, { x: 2000, y: 2000 });
    const cornered = (await boxes(page, sheet)).sheet!;
    expect(corner.right - cornered.right, 'parked in the corner').toBeLessThanOrEqual(8);
    expect(corner.bottom - cornered.bottom, 'parked in the corner').toBeLessThanOrEqual(8);
    // Storage that throws leaves the page working: the spot is simply not kept. Only the spot's own write throws: the rest of the page keeps its storage, so what is measured is the mover.
    await page.evaluate((key) => {
      const real = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k: string, v: string) {
        if (k === key) throw new Error('quota');
        real.call(this, k, v);
      };
    }, SPOT_KEY);
    // Pressed on its text while that text is selected: still a move, never the browser's own drag of the selection.
    await page.locator(`${sheet} .confirm__message`).selectText();
    await dragSheet(page, sheet, { x: -40, y: -40 });
    expect(Math.round((await boxes(page, sheet)).sheet!.left - cornered.left), 'storage that throws: the move still happens').toBe(-40);
  } finally {
    await stack.stop();
  }
});

test(titled('a small dialog opens at the remembered spot; one too big for it opens at its own default'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'masticore-upkeep');
    const page = alice.page;
    await resizeWindow(page, { width: 1280, height: 800 });
    // The remembered spot, right of centre: room for a yes/no, not for a seven-card grid.
    const spot = { x: 0.6, y: 0.4 };
    await page.evaluate(([key, value]) => window.localStorage.setItem(key!, value!), [SPOT_KEY, JSON.stringify(spot)]);
    // The upkeep's grid may already be open: a reload draws every question afresh, with the spot remembered.
    await page.reload();
    const grid = page.locator('.live__prompt:has(.prompt__cards)');
    await expect
      .poll(
        async () => {
          if ((await grid.count()) > 0) return true;
          if (await confirmOpen(page)) {
            await answerConfirm(page, 'yes').catch(() => undefined);
            return false;
          }
          for (const p of [bob.page, page]) {
            if ((await p.locator('.live__prompt').count()) > 0) continue;
            const ok = enabledOk(p).first();
            if ((await ok.count()) > 0) await ok.click({ timeout: 1_000 }).catch(() => undefined);
          }
          return false;
        },
        { timeout: 90_000, intervals: [400], message: 'alice is asked which card to discard' },
      )
      .toBe(true);
    await page.waitForTimeout(500);
    const moved = await grid.evaluate((el) => (el as HTMLElement).style.translate);
    expect(moved, 'the seven-card grid needs more room than the spot allows: its own default, not moved').toBe('');
    const g = await boxes(page, '.live__prompt:has(.prompt__cards) > .prompt');
    expect(inside(g.sheet!, g.live), 'and wholly on the board').toBe(true);

    // Answered, the next question is a small one (her turn's pass): it opens at the spot.
    await page.locator('.live__prompt .prompt__cards > li').first().locator('label').click();
    const ok = page.locator('.live__prompt').getByTestId(/^(selection-done|prompt-submit)$/);
    if (await ok.isEnabled({ timeout: 1_000 }).catch(() => false)) await ok.click({ timeout: 2_000 }).catch(() => undefined);
    await expect(grid, 'the grid closes').toHaveCount(0, { timeout: 15_000 });
    const next = page.locator('.live__prompt > *').first();
    await expect(next, 'the next question opens').toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(300);
    const small = await boxes(page, '.live__prompt > *');
    console.log(`[mv] the next question opened at ${JSON.stringify(small.sheet)} in ${JSON.stringify(small.live)}: ${await next.textContent()}`);
    expect(Math.abs(small.sheet!.left - (small.live.left + spot.x * small.live.width)), 'the small question opened at the remembered spot (across)').toBeLessThanOrEqual(2);
    expect(Math.abs(small.sheet!.top - (small.live.top + spot.y * small.live.height)), 'the small question opened at the remembered spot (down)').toBeLessThanOrEqual(2);
  } finally {
    await stack.stop();
  }
});

test(titled('an opened pile moves the same way, and keeps the remembered spot for the questions'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'w67-piles');
    const page = alice.page;
    await resizeWindow(page, { width: 1280, height: 800 });
    await page.locator('.seat [data-zone="graveyard"][data-owner="you"]').click();
    const view = page.getByTestId('pile-view');
    await expect(view, 'her graveyard opens').toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(300);
    const before = (await view.boundingBox())!;
    const head = (await view.locator('.pile-view__head').boundingBox())!;
    const from = { x: head.x + head.width / 2, y: head.y + head.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // Up and to the left: a pile opens beside its own pile at the board's left, and how far right
    // it reaches is how many columns its cards take, which a card-width change of a pixel or two
    // flips (the one-table seam took it from 8 columns to 11, leaving 27px to its right).
    await page.mouse.move(from.x - 40, from.y - 120, { steps: 8 });
    expect(await page.locator('[data-gesture-canvas][data-marquee]').count(), 'no board gesture starts under it').toBe(0);
    await page.mouse.up();
    await expect(view, 'moving it does not close it').toBeVisible();
    const after = (await view.boundingBox())!;
    expect(Math.round(after.x - before.x), 'it moved across by the drag').toBe(-40);
    expect(Math.round(after.y - before.y), 'and up by the drag').toBe(-120);
    expect(await page.evaluate((key) => window.localStorage.getItem(key), SPOT_KEY), 'a pile opens beside its pile: it writes no spot').toBeNull();
  } finally {
    await stack.stop();
  }
});

test(titled('the inspector stands beside a question the player moved, wherever it is'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice } = await startScenarioMatch(browser, stack, 'bolt-player');
    const page = alice.page;
    await resizeWindow(page, { width: 1280, height: 800 });
    await page.getByTestId('live-full-control').click();
    await expect(page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
    const bolt = await offeredNamed(page, 'Lightning Bolt');
    expect(bolt, 'the bolt is offered').toBeDefined();
    await castUntilOnStack(page, stack, bolt!, [page.locator('[data-player-face]:not([data-viewer])')]);
    const sheet = '[data-testid="live-decision"]';
    await expect(page.locator(sheet), 'a spell on the stack: the Resolve question').toContainText('Resolve Lightning Bolt?', { timeout: 15_000 });

    // Over the middle of the board, where the inspector would otherwise draw.
    const at = (await boxes(page, sheet)).sheet!;
    await dragSheet(page, sheet, { x: -380, y: 40 });
    const moved = (await boxes(page, sheet)).sheet!;
    expect(Math.round(moved.left - at.left), 'the question moved over the board').toBe(-380);
    const mountain = page.locator('.seat[data-viewer] [data-zone="battlefield"] [data-board-card]').first();
    await mountain.hover();
    const big = page.locator('[data-inspect]');
    await expect(big, 'the inspector opens').toBeVisible({ timeout: 10_000 });
    const b = (await big.boundingBox())!;
    const inspector = { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height, width: b.width, height: b.height };
    console.log(`[mv] moved question ${JSON.stringify(moved)}; inspector ${JSON.stringify(inspector)}`);
    expect(intersects(inspector, moved), 'the inspector never covers the moved question').toBe(false);
  } finally {
    await stack.stop();
  }
});

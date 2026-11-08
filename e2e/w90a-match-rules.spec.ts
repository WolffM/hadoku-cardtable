/**
 * Item 2, reworked after the look gate. The operator: (1) *"i don't like that 'Match rules Hand
 * smoothing' looks the same as the other options here. this feels like it should look different."*
 * (2) *"the popover looks good though. since we have the popover maybe just create a room settings
 * button and put it on the same row as the 'Close' button? that would be cleaner and would save us
 * one row in the settings selection card."*
 *
 * So the trigger moved off the chip rows (`.lobby__header` / `.lobby__modeline`) and onto the
 * title row, beside Close, as a plain "Room settings" button — Close's own button family, not a
 * chip, and with no "what's on" summary any more (the popover is the only way to read a rule
 * either way). Checked in the SAME room at both 390 and 1440 (a room's layout does not depend on
 * which width it was created at):
 *
 *  - Room settings sits on Close's row, their vertical centres a few px apart at most, and the
 *    button sits to the right of the room's title;
 *  - no `match-rules` element is left inside the chip rows below;
 *  - the popover still opens from it and still toggles hand smoothing;
 *  - at 390, an unusually long room title does not push the row's buttons off screen — the page
 *    never scrolls sideways.
 *
 * DOM rects and `document.scrollingElement`, never a screenshot (layout specs assert numbers).
 */
import { expect, test, type Page } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { resizeWindow } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { submitCreateRoom } from './play/rooms.ts';

const UI_TIMEOUT = 20_000;
const EPS = 4;

/** Near `ROOM_NAME_MAX` (60, `@hadoku/shared`), so the title row is under the exact pressure item
 * 2's phone case is about: a long title with the row's two buttons beside it. */
const LONG_TITLE = `e2e w90a2 ${Date.now()} a rather long constructed room title`.slice(0, 60);

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

async function rectOf(page: Page, selector: string): Promise<Rect | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }, selector);
}

function vCentre(r: Rect): number {
  return (r.top + r.bottom) / 2;
}

async function noSidewaysScroll(page: Page): Promise<{ scrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => {
    const doc = document.scrollingElement as HTMLElement;
    return { scrollWidth: doc.scrollWidth, innerWidth };
  });
}

test('Room settings sits on Close’s row, not among the chip rows, at both 390 and 1440 — and a long title never pushes the row off screen', async ({ browser }) => {
  test.setTimeout(60_000);
  const alice = await openFriend(browser, 'alice');
  try {
    await alice.page.goto(`${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: LONG_TITLE });
    await alice.page.waitForURL(/\/room\/[a-z0-9-]+$/, { timeout: UI_TIMEOUT });
    await expect(alice.page.getByTestId('match-rules'), 'a default Classic room offers Room settings').toBeVisible({ timeout: UI_TIMEOUT });

    for (const width of [390, 1440]) {
      await resizeWindow(alice.page, { width, height: width === 390 ? 844 : 900 });
      await expect(alice.page.getByTestId('match-rules'), `at ${width}px, Room settings is still on the page`).toBeVisible({ timeout: UI_TIMEOUT });
      await expect(alice.page.getByTestId('room-close'), `at ${width}px, Close is still on the page`).toBeVisible({ timeout: UI_TIMEOUT });

      const roomSettings = await rectOf(alice.page, '[data-testid="match-rules"]');
      const close = await rectOf(alice.page, '[data-testid="room-close"]');
      const title = await rectOf(alice.page, '[data-testid="room-name"]');
      if (roomSettings === null || close === null || title === null) throw new Error('match-rules, room-close or room-name is not on the page');

      expect(Math.abs(vCentre(roomSettings) - vCentre(close)), `at ${width}px, Room settings and Close share a row (centres ${vCentre(roomSettings)} vs ${vCentre(close)})`).toBeLessThanOrEqual(
        EPS,
      );
      // With this long a title, `.shell__head`'s own wrap can give the title the whole row to
      // itself at 390px (item 2's own ask: wrap the title rather than push the buttons off
      // screen) — the two are only beside each other when they share a row to begin with.
      const sameRow = roomSettings.top < title.bottom - EPS && title.top < roomSettings.bottom - EPS;
      if (sameRow) {
        expect(roomSettings.left, `at ${width}px, sharing a row: Room settings sits to the right of the room's title`).toBeGreaterThanOrEqual(title.right - EPS);
      } else {
        expect(roomSettings.top, `at ${width}px, the title wrapped onto its own row: Room settings should sit below it, not over it`).toBeGreaterThanOrEqual(title.bottom - EPS);
      }

      // Item 2's own cause: the trigger used to be one pill among `.lobby__header`'s and
      // `.lobby__modeline`'s chips. Neither holds a `match-rules` element any more.
      const strayInChips = await alice.page.evaluate(
        () => document.querySelectorAll('.lobby__header [data-testid="match-rules"], .lobby__modeline [data-testid="match-rules"]').length,
      );
      expect(strayInChips, `at ${width}px, no Match rules element remains inside the chip rows`).toBe(0);

      if (width === 390) {
        const { scrollWidth, innerWidth } = await noSidewaysScroll(alice.page);
        expect(scrollWidth, `at 390px, with a ${LONG_TITLE.length}-char title, the page should not scroll sideways (${scrollWidth} > ${innerWidth})`).toBeLessThanOrEqual(innerWidth + 1);
      }
    }

    // The popover still opens from the same trigger, and hand smoothing still toggles from it.
    await alice.page.getByTestId('match-rules').click();
    await expect(alice.page.getByTestId('match-rules-popover')).toBeVisible({ timeout: UI_TIMEOUT });
    const smoothing = alice.page.getByTestId('hand-smoothing');
    const before = await smoothing.getAttribute('aria-pressed');
    await smoothing.click();
    await expect(smoothing).not.toHaveAttribute('aria-pressed', before ?? '');
    await alice.page.getByTestId('match-rules-popover-close').click();
    await expect(alice.page.getByTestId('match-rules-popover')).toHaveCount(0);
  } finally {
    await alice.context.close();
  }
});

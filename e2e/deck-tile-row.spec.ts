/**
 * A deck tile's first row — name, play-style mark, colour pips — sits on one centre line (the operator,
 * 2026-10-23: "on deck cards the name of the deck and the type symbol don't exactly align to the same
 * height as the mana symbols"). In Firefox the pips rode their line box's baseline and sat ~1.2 px
 * below the mark and the name. Runs in Firefox, the operator's browser; `[deck-tile-row]` lines are the
 * evidence.
 */
import { expect, test } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { resizeWindow } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { submitCreateRoom } from './play/rooms.ts';

test('a deck tile’s name, style mark and colour pips share one centre line', async ({ browser }) => {
  const alice = await openFriend(browser, 'alice');
  try {
    await alice.page.goto(`${PREFIX}/`);
    await resizeWindow(alice.page, { width: 1950, height: 1212 });
    await submitCreateRoom(alice.page, { name: `e2e deck tile row ${Date.now()}`, mode: 'classic' });
    const page = alice.page;
    await expect(page.locator('.deckpick__option .deckcolors .ms').first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    const rows = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.deckpick__option')].flatMap((tile) => {
        const mid = (el: Element | null): number | null => {
          if (el === null) return null;
          const r = el.getBoundingClientRect();
          return Math.round((r.top + r.height / 2) * 10) / 10;
        };
        const pips = [...tile.querySelectorAll('.deckcolors .ms')].map(mid);
        if (pips.length === 0) return [];
        return [{ deck: tile.dataset.deckId, name: mid(tile.querySelector('.deckpick__name')), mark: mid(tile.querySelector('.decktag__mark')), pips }];
      }),
    );
    console.log(`[deck-tile-row] ${JSON.stringify(rows)}`);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const pip of row.pips) {
        expect(Math.abs(pip! - row.name!), `${row.deck}: pip against name`).toBeLessThanOrEqual(0.5);
        if (row.mark !== null) expect(Math.abs(pip! - row.mark), `${row.deck}: pip against mark`).toBeLessThanOrEqual(0.5);
      }
    }
  } finally {
    await alice.context.close();
  }
});

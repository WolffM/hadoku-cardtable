/**
 * Turnover inside the watchparty embed (2026-10-12, the party's own flow): two
 * play, one watches; the loser concedes; Main menu takes the loser AND the
 * watcher back to the bound room, unseated, where the watcher can sit.
 */
import { expect, test, type Page } from '@playwright/test';

import { twoLegalDecks } from './play/enter.ts';
import { makeTitled } from './play/board.ts';
import { chooseClassic, embedContext, embedHostUrl, mountEmbed } from './play/embed.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { TURN_TEXT } from './play/turn.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

test(titled('embed turnover: the loser and a watcher press Main menu and are back at the seats; the watcher sits'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  const roomKey = `turnover-${Date.now()}`;
  try {
    const pages: Record<string, Page> = {};
    for (const name of ['alice', 'bob', 'carol']) {
      const ctx = await embedContext(browser, name);
      const page = await ctx.newPage();
      await page.goto(embedHostUrl(stack.origin, roomKey));
      await page.waitForFunction(() => 'embedHost' in window);
      await mountEmbed(page);
      await expect(page.getByTestId('constructed'), `${name} is at the bound table`).toBeVisible({ timeout: 30_000 });
      pages[name] = page;
    }
    const { alice, bob, carol } = pages;
    // alice bound the room first, so she leads it and picks its mode.
    await chooseClassic(alice);
    const choice = await twoLegalDecks(alice.context().request, stack.origin);
    await alice.getByTestId('format').selectOption(choice.format);
    await expect(bob.getByTestId('format-fixed')).toHaveAttribute('data-format', choice.format);
    for (const [page, deck] of [[alice, choice.decks[0]], [bob, choice.decks[1]]] as const) {
      await expect(page.getByTestId('deck-mine')).toBeEnabled();
      await page.getByTestId('deck-mine').locator(`[data-deck-id="${deck}"]`).click();
      await expect(page.getByTestId('ready-toggle')).toBeEnabled();
    }
    await expect(carol.getByTestId('room-spectator'), 'carol: table full').toBeVisible({ timeout: 15_000 });
    await alice.getByTestId('ready-toggle').click();
    await bob.getByTestId('ready-toggle').click();
    for (const [name, page] of Object.entries(pages)) {
      await expect(page.locator('[aria-label="Game board"]'), `${name} reaches the board`).toBeVisible({ timeout: 120_000 });
    }
    await expect(alice.getByTestId('live-turn-n')).toHaveText(TURN_TEXT, { timeout: 60_000 });
    await expect(carol.locator('.live[data-role="watcher"]'), 'carol watches').toBeVisible({ timeout: 30_000 });

    // Alice concedes: everyone gets the result screen, including the watcher.
    await alice.getByTestId('live-concede').click();
    await alice.getByTestId('live-concede-yes').click();
    for (const [name, page] of Object.entries(pages)) {
      await expect(page.getByTestId('game-result-menu'), `${name} sees the result screen`).toBeVisible({ timeout: 30_000 });
    }
    await expect(carol.getByTestId('game-result-rematch'), 'a watcher cannot rematch').toBeDisabled();

    // The loser leaves to the menu: in the embed that is the bound room, and her seat is gone.
    await alice.getByTestId('game-result-menu').click();
    await expect(alice.getByTestId('constructed'), 'alice is back at the table').toBeVisible({ timeout: 30_000 });
    await expect(alice.getByTestId('seat-sit'), 'one seat is free again (bob still holds his)').toHaveCount(1, { timeout: 15_000 });
    await expect(alice.getByTestId('seat-sit')).toBeEnabled();

    // The watcher does the same and takes the free seat.
    await carol.getByTestId('game-result-menu').click();
    await expect(carol.getByTestId('constructed'), 'carol is back at the table').toBeVisible({ timeout: 30_000 });
    await expect(carol.getByTestId('seat-sit')).toHaveCount(1, { timeout: 15_000 });
    await carol.getByTestId('seat-sit').click();
    await expect(carol.getByTestId('seat-stand'), 'carol holds the seat').toBeVisible({ timeout: 15_000 });
    await expect(carol.getByTestId('deck-mine'), 'and may pick a deck').toBeVisible();
    await expect(alice.getByTestId('seat-sit'), 'alice sees no free seat now').toHaveCount(0, { timeout: 15_000 });
  } finally {
    await stack.stop();
  }
});

/**
 * The deck builder, driven the way a player drives it — one helper for every
 * spec that builds a drafted deck.
 *
 * The builder opens with every pick in the main deck (the operator,
 * 2026-10-21, Arena-style: *"while drafting, picks are the deck in progress;
 * the drafter drags the ones they won't play into a sideboard area; the deck
 * builder opens with picks = main deck and the dragged ones in the
 * sideboard"*), so building a deck of `n` is sideboarding the rest.
 */

import { expect, type Page } from '@playwright/test';

/** The card on top of a deck pile: the one whose whole face shows, so a click lands on it. */
export const deckPileTop = (page: Page) => page.locator('[data-testid="main-grid"] .deck-editor__stack > :last-child [data-testid="card"]');

/**
 * Sideboard cards out of the main deck, one click per card (the editor's own
 * gesture), until it holds `n`; then wait for the debounced save to land (the
 * editor's own `data-save` state, not a sleep).
 */
export async function trimMainDeck(page: Page, n: number, who: string, timeout = 30_000): Promise<void> {
  const mainCount = page.getByTestId('main-count');
  await expect(page.getByTestId('deck-editor'), `${who}: the builder is open`).toBeVisible({ timeout });
  for (let now = Number(await mainCount.textContent()); now > n; now -= 1) {
    await deckPileTop(page).first().click();
    await expect(mainCount, `${who}: one card sideboarded`).toHaveText(String(now - 1));
  }
  await expect(mainCount, `${who}: the maindeck is ${n}`).toHaveText(String(n));
  await expect(page.getByTestId('deck-editor'), `${who}: the build is saved`).toHaveAttribute('data-save', 'saved', { timeout });
}

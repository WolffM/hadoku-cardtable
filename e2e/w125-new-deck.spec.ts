/**
 * Wave 125 §D, the operator's "decks built from scratch", end to end in real Forge: a player opens
 * New deck (`#/decks/new`), searches the catalog (`GET /api/cards/search`, over this stack's fixture
 * catalog, never the host's), presses a card in four times, fills the rest with basics, names the
 * deck and saves it (`PUT /api/me/built/:id`). The address moves to the deck's own id. Then a room on
 * Free pick offers it under My decks, the player sits it against the AI, and the match reaches turn 1:
 * Forge played the deck that was built, so the player's own hand holds only its cards.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one the test SKIPS
 * and its title says why.
 */
import { expect, test } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { submitCreateRoom } from './play/rooms.ts';
import { pressIntoTurnOne } from './play/turn.ts';

const forge = forgeAvailability();
/** A one-mana creature in the fixture catalog (`e2e/fixtures/sets-catalog.json`). */
const CARD = 'Goblin Mountaineer';
const DECK_NAME = `w125 goblins ${Date.now()}`;

test(forge.ok ? 'a deck built from search is saved, offered under My decks, and played against the AI to turn 1' : `SKIPPED: ${forge.reason}`, async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);

  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const page = alice.page;

    // New deck: an empty build, the search over Any card.
    await page.goto(`${stack.origin}${PREFIX}/#/decks/new`);
    await expect(page.getByTestId('deck-editor')).toHaveAttribute('data-mode', 'build', { timeout: 30_000 });
    await expect(page.getByTestId('main-count')).toHaveText('0');

    await page.getByTestId('card-search').fill(CARD.slice(0, 10));
    const result = page.locator(`[data-testid="search-result"][data-name="${CARD}"]`);
    await expect(result, 'the search answers the card').toBeVisible({ timeout: 15_000 });
    for (let i = 0; i < 5; i += 1) await result.getByTestId('card').click();
    await expect(result.getByTestId('result-count'), 'four copies, and a fifth press adds none').toHaveText('×4');
    await expect(page.getByTestId('main-count')).toHaveText('4');

    // The rest is basics, from the editor's own suggestion.
    await page.getByTestId('basics-auto').click();
    await expect(page.getByTestId('main-count')).toHaveText('60');
    await expect(page.getByTestId('deck-fault'), 'nothing to say about a full Any-card deck').toHaveCount(0);

    // Named and saved: the address becomes the deck's id.
    await page.getByTestId('built-name').fill(DECK_NAME);
    await page.getByTestId('built-save').click();
    await page.waitForURL(/#\/decks\/built(:|%3A)[0-9a-f-]{36}$/, { timeout: 15_000 });
    const builtId = decodeURIComponent(/#\/decks\/(.+)$/.exec(page.url())![1]!);
    await expect(page.getByTestId('built-save')).toHaveText('Saved');

    // A reload opens the deck from the server.
    await page.reload();
    await expect(page.getByTestId('main-count')).toHaveText('60', { timeout: 30_000 });
    await expect(page.getByTestId('built-name')).toHaveValue(DECK_NAME);

    // A room on Free pick offers it under My decks.
    await page.goto(`${stack.origin}${PREFIX}/`);
    await submitCreateRoom(page, { name: `w125 new deck ${Date.now()}` });
    await page.waitForURL(/\/room\/r-[0-9a-f]{12}$/, { timeout: 30_000 });
    await page.getByTestId('match-rules').click();
    await page.getByTestId('free-pick').click();
    await expect(page.getByTestId('free-pick')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('match-rules-popover-close').click();
    await page.getByTestId('browse-tab-mine').click();
    const tile = page.getByTestId('deck-mine').locator(`[data-deck-id="mine:${builtId}"]`);
    await expect(tile, 'the built deck is one of My decks').toBeVisible({ timeout: 30_000 });
    await expect(tile).toContainText(DECK_NAME);
    await tile.click();
    await expect(page.getByTestId('ready-toggle'), 'the built deck is legal here').toBeEnabled({ timeout: 30_000 });

    // Against the AI, to turn 1.
    await expect(page.getByTestId('play-vs-bot')).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId('play-vs-bot').click();
    await page.waitForURL(/#\/match\/m-[0-9a-f]{12}$/, { timeout: 90_000 });
    await expect(page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 30_000 });
    await pressIntoTurnOne(page);

    // Forge dealt the deck that was built: every card in my hand is one of its two names.
    const hand = page.locator('.seat[data-viewer] [data-zone="hand"] .card__name');
    await expect.poll(() => hand.count(), { message: 'my hand is drawn' }).toBeGreaterThan(0);
    const names = (await hand.allTextContents()).map((n) => n.trim());
    console.log(`[w125-new-deck] built ${builtId}; my hand at turn 1: ${names.join(', ')}`);
    for (const name of names) expect([CARD, 'Mountain'], `${name} is from the built deck`).toContain(name);
  } finally {
    await stack.stop();
  }
});

/**
 * Wave 126, the Library's Cards tab end to end in real Forge: a player searches a card, opens its
 * printings (`GET /api/cards/printings`, oldest first), picks one that is neither the oldest nor the
 * default, and turns on "Always use oldest art" in Settings. Both are the server's (`/api/me/art`),
 * so both survive a reload. Then they sit a deck of that card against the AI, and the board draws
 * the card as the printing they picked: a hand pick beats "always use oldest" (the operator's
 * settled order, `docs/planning/wave125-2026-11-23.md`).
 *
 * The card is Mountain: this stack's fixture catalog (`e2e/fixtures/sets-catalog.json`) holds no
 * Lightning Bolt, and Mountain is the card it prints most often (ALA and ISD, seven printings).
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one the test SKIPS
 * and its title says why.
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

import { ART_ROUTE } from './art.ts';
import { PREFIX } from './identities.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { submitCreateRoom } from './play/rooms.ts';
import { pressIntoTurnOne } from './play/turn.ts';
import { closeSettings, openSettings } from './play/w32.ts';

const forge = forgeAvailability();
const CARD = 'Mountain';
const DECK_NAME = `w126 mountains ${Date.now()}`;
const DECK = `[metadata]\nName=${DECK_NAME}\n[Main]\n60 ${CARD}\n`;

/** Every art request answered at once with a stand-in: the claim is which id each tile asks for, not the CDN. */
const ART_STAND_IN = '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="#5a3a2a"/></svg>';

interface Printing {
  scryfallId: string;
}

/** The Cards tab with `CARD` searched and opened: its printings strip, in the order drawn. */
async function openPrintings(page: Page, origin: string): Promise<string[]> {
  await page.goto(`${origin}${PREFIX}/#/library`);
  await page.getByTestId('library-tab-cards').click();
  await page.getByTestId('library-cards-search').fill(CARD);
  const result = page.locator(`[data-testid="library-card"][data-name="${CARD}"]`);
  await expect(result, 'the search answers the card').toBeVisible({ timeout: 15_000 });
  await result.click();
  const strip = page.getByTestId('library-printing');
  await expect(strip.first()).toBeVisible({ timeout: 15_000 });
  return strip.evaluateAll((els) => els.map((el) => el.getAttribute('data-scryfall-id') ?? ''));
}

test(forge.ok ? 'a picked printing survives a reload, beats "always use oldest", and is what the board draws' : `SKIPPED: ${forge.reason}`, async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);

  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const page = alice.page;
    const api = alice.context.request;
    await page.route(ART_ROUTE, (route) => route.fulfill({ contentType: 'image/svg+xml', body: ART_STAND_IN }));

    const printings = ((await (await api.get(`${stack.origin}${PREFIX}/api/cards/printings?name=${CARD}`)).json()) as { printings: Printing[] }).printings.map((p) => p.scryfallId);
    const art = (await (await api.get(`${stack.origin}${PREFIX}/api/cards/art?n=${CARD}`)).json()) as { art: Record<string, { scryfallId: string }> };
    const defaultId = art.art[CARD]?.scryfallId;
    const picked = printings.findLast((id, i) => i > 0 && id !== defaultId);
    expect(picked, `${CARD} has a printing that is neither its oldest nor its default`).toBeDefined();
    console.log(`[w126-cards] ${CARD}: ${printings.length} printings, oldest ${printings[0]}, default ${String(defaultId)}, picking ${picked}`);

    // The strip is the server's order: oldest first, and the oldest is marked.
    expect(await openPrintings(page, stack.origin), 'the printings, oldest first').toEqual(printings);
    const strip = page.getByTestId('library-printing');
    await expect(strip.first()).toHaveAttribute('data-oldest', '');
    await expect(strip.locator('[aria-pressed="true"]'), 'no pick yet').toHaveCount(0);

    // A pick is pressed, and the server holds it.
    const tile = page.locator(`[data-testid="library-printing"][data-scryfall-id="${picked}"]`);
    await tile.click();
    await expect(tile).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => ((await (await api.get(`${stack.origin}${PREFIX}/api/me/art`)).json()) as { picks: Record<string, string> }).picks[CARD.toLowerCase()]).toBe(picked);

    // A reload reads it back.
    await page.reload();
    await openPrintings(page, stack.origin);
    await expect(tile, 'the pick survives a reload').toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });

    // Always use oldest art: on, and still on after a reload.
    const oldest = (await openSettings(page)).getByTestId('settings-art-oldest');
    await expect(oldest).toBeEnabled({ timeout: 15_000 });
    await expect(oldest).not.toBeChecked();
    await oldest.click();
    await expect(oldest).toBeChecked();
    await expect.poll(async () => ((await (await api.get(`${stack.origin}${PREFIX}/api/me/art`)).json()) as { oldest: boolean }).oldest).toBe(true);
    await closeSettings(page);
    await page.reload();
    await expect((await openSettings(page)).getByTestId('settings-art-oldest'), '"always use oldest" survives a reload').toBeChecked({ timeout: 15_000 });
    await closeSettings(page);

    // A deck of the card, built for Any card.
    const builtId = `built:${randomUUID()}`;
    const saved = await api.put(`${stack.origin}${PREFIX}/api/me/built/${encodeURIComponent(builtId)}`, { data: { name: DECK_NAME, format: 'free', dck: DECK } });
    expect(saved.status(), await saved.text()).toBe(200);

    // A room on Free pick, the deck, against the AI, to turn 1.
    await page.goto(`${stack.origin}${PREFIX}/`);
    await submitCreateRoom(page, { name: `w126 cards ${Date.now()}` });
    await page.waitForURL(/\/room\/r-[0-9a-f]{12}$/, { timeout: 30_000 });
    await page.getByTestId('match-rules').click();
    await page.getByTestId('free-pick').click();
    await expect(page.getByTestId('free-pick')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('match-rules-popover-close').click();
    await page.getByTestId('browse-tab-mine').click();
    const deckTile = page.getByTestId('deck-mine').locator(`[data-deck-id="mine:${builtId}"]`);
    await expect(deckTile, 'the built deck is one of My decks').toBeVisible({ timeout: 30_000 });
    await deckTile.click();
    await expect(page.getByTestId('ready-toggle'), 'the deck is legal here').toBeEnabled({ timeout: 30_000 });
    await expect(page.getByTestId('play-vs-bot')).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId('play-vs-bot').click();
    await page.waitForURL(/#\/match\/m-[0-9a-f]{12}$/, { timeout: 90_000 });
    await expect(page.locator('[aria-label="Game board"]')).toBeVisible({ timeout: 30_000 });
    await pressIntoTurnOne(page);

    // Every card in my hand is the card, drawn as the printing I picked, not the oldest.
    const hand = page.locator('.seat[data-viewer] [data-zone="hand"] img.card__art');
    await expect.poll(() => hand.count(), { message: 'my hand is drawn' }).toBeGreaterThan(0);
    const srcs = await hand.evaluateAll((els) => els.map((el) => el.getAttribute('src') ?? ''));
    console.log(`[w126-cards] my hand at turn 1 draws: ${srcs.join(', ')}`);
    for (const src of srcs) expect(src, `${CARD} is drawn as the picked printing`).toContain(`/api/art/${picked}`);
  } finally {
    await stack.stop();
  }
});

/*
 * The Gauntlet's reveal and its ban/pick board, end to end against the real built server
 * (`docs/planning/constructed-modes-plan.md`, "Gauntlet reveal"): a Gauntlet room against the AI,
 * one seat readied, and on that screen
 *
 *  - the era's title is drawn before any deck, and the ten decks follow;
 *  - a ban greys and crosses the tile where it lies, in the pool;
 *  - a pick moves the tile out of the pool into the picker's column.
 *
 * The order is recorded by a MutationObserver installed before the page loads, so it holds
 * whether the screen saw the reveal at its start or partway through. `[gauntlet-reveal]` lines
 * are the evidence: when the title, the coin and each tile first appeared.
 *
 * Ready, sit and the room's creation go through the API the room screen itself calls; the bans
 * and picks are pressed on the board, as a player does. The AI bans and picks at random on its
 * own turns, so the spec waits for the banner to name this seat before pressing.
 */
import { expect, test, type Page } from '@playwright/test';

import type { GauntletView } from '../packages/shared/src/gauntlet.ts';
import { makeTitled } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const PREFIX = '/cardtable';

/** Records, from before the first paint, when each Gauntlet part first appeared. */
function recordAppearances(): void {
  const seen: Record<string, number> = {};
  const t0 = performance.now();
  const note = (key: string): void => {
    if (!(key in seen)) seen[key] = Math.round(performance.now() - t0);
  };
  new MutationObserver(() => {
    if (document.querySelector('[data-testid="gauntlet-title"]')?.textContent) note('title');
    if (document.querySelector('[data-testid="gauntlet"] [data-testid="coin-toss"]')) note('coin');
    document.querySelectorAll<HTMLElement>('[data-testid="gauntlet-pool"] [data-testid="gauntlet-deck"]').forEach((el) => note(`deck:${el.dataset.deckId}`));
  }).observe(document, { subtree: true, childList: true, characterData: true });
  (window as unknown as { gauntletSeen: Record<string, number> }).gauntletSeen = seen;
}

const seenOn = (page: Page): Promise<Record<string, number>> => page.evaluate(() => (window as unknown as { gauntletSeen: Record<string, number> }).gauntletSeen);

/** Waits for this seat's turn to `act`, then presses the first open deck in the pool and returns its id. */
async function actOnOwnTurn(page: Page, act: 'Ban' | 'Pick'): Promise<string> {
  const banner = page.getByTestId('gauntlet-turn');
  await expect(banner).toHaveAttribute('data-you', 'true', { timeout: 30_000 });
  await expect(banner).toContainText(act);
  // The pointer still rests on the tile it last pressed, whose list opens beside it over the pool:
  // a player moves off it before reaching for the next, and so does this.
  await page.mouse.move(0, 0);
  await expect(page.getByTestId('deck-peek')).toHaveCount(0);
  const open = page.getByTestId('gauntlet-pool').locator('[data-testid="gauntlet-deck"][data-status="open"]:enabled').first();
  const id = (await open.getAttribute('data-deck-id'))!;
  await open.click();
  return id;
}

test(titled('Gauntlet reveal: the era title first, then ten decks; a ban greys and crosses its tile in the pool, a pick moves it to the picker’s column'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    await alice.page.addInitScript(recordAppearances);
    const made = await alice.context.request.post(`${stack.origin}${PREFIX}/api/rooms`, {
      data: { name: `gauntlet reveal ${Date.now()}`, gameType: 'constructed-1v1', mode: 'gauntlet', modeOptions: { family: 'modern' } },
    });
    expect(made.status()).toBe(201);
    const roomId = ((await made.json()) as { id: string }).id;
    await alice.page.goto(`${stack.origin}${PREFIX}/#/room/${roomId}`);
    await expect(alice.page.getByTestId('constructed')).toBeVisible({ timeout: 30_000 });
    const api = `${stack.origin}${PREFIX}/api/tables/rooms/${roomId}`;
    expect((await alice.context.request.post(`${api}/sit`, { data: {} })).ok()).toBe(true);
    const ready = await alice.context.request.post(`${api}/gauntlet/ready`, { data: { ready: true, ai: true } });
    expect(ready.ok(), await ready.text()).toBe(true);
    const view = (await ready.json()) as GauntletView;
    expect(view.era, 'the draw named its era').not.toBeNull();

    await expect(alice.page.getByTestId('gauntlet-title')).toHaveText(view.era!.title, { timeout: 30_000 });
    await expect(alice.page.getByTestId('gauntlet-pool').getByTestId('gauntlet-deck')).toHaveCount(10, { timeout: 30_000 });
    const seen = await seenOn(alice.page);
    console.log(`[gauntlet-reveal] first seen (ms): ${JSON.stringify(seen)}`);
    const decks = Object.entries(seen).filter(([k]) => k.startsWith('deck:'));
    expect(decks).toHaveLength(10);
    expect(seen.title, 'the title is drawn').toBeDefined();
    for (const [deck, at] of decks) expect(at, `${deck} came after the title`).toBeGreaterThanOrEqual(seen.title!);

    const banned = await actOnOwnTurn(alice.page, 'Ban');
    const bannedTile = alice.page.locator(`[data-deck-id="${banned}"]`);
    await expect(bannedTile).toHaveAttribute('data-status', 'banned');
    await expect(bannedTile.getByTestId('gauntlet-cross')).toBeVisible();
    await expect(alice.page.getByTestId('gauntlet-pool').locator(`[data-deck-id="${banned}"]`), 'a ban stays in the pool').toHaveCount(1);

    const picked = await actOnOwnTurn(alice.page, 'Pick');
    const column = alice.page.locator(`[data-testid="gauntlet-column"][data-seat="${view.you}"]`);
    await expect(column.locator(`[data-deck-id="${picked}"]`), 'the pick is in its picker’s column').toHaveCount(1);
    await expect(alice.page.getByTestId('gauntlet-pool').locator(`[data-deck-id="${picked}"]`), 'and no longer in the pool').toHaveCount(0);
  } finally {
    await stack.stop();
  }
});

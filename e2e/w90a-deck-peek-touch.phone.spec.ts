/**
 * Item 2c: the deck peek on touch. The operator: *"maybe 'long hold' can bring up the deck peek?
 * and when finger is released it disappears again?"*
 *
 * Cause: `DeckChooser`'s tile (`ConstructedScreen.tsx`) and `gauntlet/peek.tsx`'s `bind` both
 * returned early on `pointerType === 'touch'`, so the peek could not be reached on a phone at all.
 * Fixed with `DeckPeek.tsx`'s `useTouchPeek`, wired into both.
 *
 * Two pools, same three checks each (per the brief's item 13): the room's own deck picker
 * (`deck-mine`), and the Gauntlet's pool (`gauntlet-pool`, which needs the real built server AND a
 * real Forge — `forgeAvailability` skips it, named, when there is none).
 */
import { expect, test, type Page } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { PHONE } from './play/phone.ts';
import { submitCreateRoom } from './play/rooms.ts';
import { touchPressStart, touchTap } from './w90a-deck-peek-touch.ts';

test.use(PHONE);

const UI_TIMEOUT = 20_000;
/** Comfortably over `DeckPeek.tsx`'s `PEEK_DELAY_MS` (400ms). */
const HOLD_MS = 700;

/** A touch dispatched over CDP lands wherever `x,y` are, whether or not anything is actually
 *  there — unlike a real gesture, nothing re-targets it if the tile is below the fold. Scrolled
 *  into view first so the coordinate it returns is one the tile is actually drawn at. */
async function centerOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const locator = page.locator(selector).first();
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${selector} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('the room’s own deck picker: a long hold opens the peek and never chooses; a short tap chooses', async ({ browser }) => {
  test.setTimeout(60_000);
  const alice = await openFriend(browser, 'alice');
  try {
    await alice.page.goto(`${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: `e2e w90a deck peek touch ${Date.now()}` });
    await alice.page.waitForURL(/\/room\/[a-z0-9-]+$/, { timeout: UI_TIMEOUT });
    await expect(alice.page.getByTestId('deck-mine').getByTestId('deck-option').first()).toBeVisible({ timeout: UI_TIMEOUT });

    const at = await centerOf(alice.page, '[data-testid="deck-mine"] [data-testid="deck-option"]');

    /* ── a long hold: the peek shows while held, and releasing never chooses ── */
    const before = await alice.page.evaluate(() => document.querySelector('[data-testid="deck-mine"]')?.getAttribute('data-chosen'));
    const press = await touchPressStart(alice.page, at);
    await alice.page.waitForTimeout(HOLD_MS);
    await expect(alice.page.getByTestId('deck-peek'), 'held past the delay, the peek is up').toBeVisible({ timeout: UI_TIMEOUT });
    await press.release();
    await expect(alice.page.getByTestId('deck-peek'), 'the finger lifted — the peek is gone').toHaveCount(0, { timeout: UI_TIMEOUT });
    const afterHold = await alice.page.evaluate(() => document.querySelector('[data-testid="deck-mine"]')?.getAttribute('data-chosen'));
    expect(afterHold, 'the hold never chose the deck').toBe(before);

    /* ── a short tap: no peek, and it chooses ── */
    await touchTap(alice.page, at);
    await expect(alice.page.getByTestId('deck-peek'), 'a short tap never opened the peek').toHaveCount(0);
    await expect
      .poll(async () => alice.page.evaluate(() => document.querySelector('[data-testid="deck-mine"]')?.getAttribute('data-chosen')), {
        message: 'a short tap chose the deck',
        timeout: UI_TIMEOUT,
      })
      .not.toBe(before);
  } finally {
    await alice.context.close();
  }
});

test('the Gauntlet pool: a long hold opens the peek and never chooses; a short tap chooses (bans)', async ({ browser }) => {
  const forge = forgeAvailability();
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(3 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const alice = await openFriend(browser, 'alice');
    const made = await alice.context.request.post(`${stack.origin}${PREFIX}/api/rooms`, {
      data: { name: `e2e w90a gauntlet peek touch ${Date.now()}`, gameType: 'constructed-1v1', mode: 'gauntlet', modeOptions: { family: 'modern' } },
    });
    expect(made.status()).toBe(201);
    const roomId = ((await made.json()) as { id: string }).id;
    await alice.page.goto(`${stack.origin}${PREFIX}/#/room/${roomId}`);
    await expect(alice.page.getByTestId('constructed')).toBeVisible({ timeout: 30_000 });
    const api = `${stack.origin}${PREFIX}/api/tables/rooms/${roomId}`;
    expect((await alice.context.request.post(`${api}/sit`, { data: {} })).ok()).toBe(true);
    const ready = await alice.context.request.post(`${api}/gauntlet/ready`, { data: { ready: true, ai: true } });
    expect(ready.ok(), await ready.text()).toBe(true);
    await expect(alice.page.getByTestId('gauntlet-pool').getByTestId('gauntlet-deck')).toHaveCount(10, { timeout: 30_000 });
    await expect(alice.page.getByTestId('gauntlet')).not.toHaveAttribute('data-revealing', /.*/, { timeout: 30_000 });
    // This seat's own turn (Ban first): the AI may have already acted on an earlier turn, so wait
    // for the banner rather than assuming which open tile is still first.
    await expect(alice.page.getByTestId('gauntlet-turn')).toHaveAttribute('data-you', 'true', { timeout: 30_000 });

    const openTile = alice.page.getByTestId('gauntlet-pool').locator('[data-testid="gauntlet-deck"][data-status="open"]:enabled').first();
    const id = await openTile.getAttribute('data-deck-id');
    const at = await centerOf(alice.page, `[data-deck-id="${id}"]`);

    /* ── a long hold: the peek shows while held, and releasing never bans it ── */
    const press = await touchPressStart(alice.page, at);
    await alice.page.waitForTimeout(HOLD_MS);
    await expect(alice.page.getByTestId('deck-peek'), 'held past the delay, the peek is up').toBeVisible({ timeout: UI_TIMEOUT });
    await press.release();
    await expect(alice.page.getByTestId('deck-peek'), 'the finger lifted — the peek is gone').toHaveCount(0, { timeout: UI_TIMEOUT });
    await expect(alice.page.locator(`[data-deck-id="${id}"]`), 'the hold never banned the deck').toHaveAttribute('data-status', 'open');

    /* ── a short tap: no peek, and it bans ── */
    await touchTap(alice.page, at);
    await expect(alice.page.getByTestId('deck-peek'), 'a short tap never opened the peek').toHaveCount(0);
    await expect(alice.page.locator(`[data-deck-id="${id}"]`), 'a short tap banned the deck').toHaveAttribute('data-status', 'banned', { timeout: UI_TIMEOUT });
  } finally {
    await stack.stop();
  }
});

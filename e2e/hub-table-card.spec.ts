/**
 * A tournament hub's table cards, as the operator found them in the trailer (cut 2, 2026-10-30): *"i meant
 * the card view inside the standings room where all the links to all the rooms can be seen. those 'mini
 * cards' are poorly designed."* Then, of the match strip: *"this looks clean. ship that."*
 *
 * At 1920×1080 and at phone width: my table is one strip at most 64 px tall, inside the page's width; its
 * ways to resolve are behind one ⋯ (none drawn until asked for); my way in is a chip in the strip; and
 * the whole card is still the way in (AF372): a press on my own face, away from the chip, carries me to
 * my table.
 *
 * One browser, one AI entrant, as `tournament-table-page.spec.ts`. Needs a Forge build (the Gauntlet's
 * eras come from its decks); without one the test SKIPS with a title that says why.
 */

import { expect, test, type Page } from '@playwright/test';

import { resizeWindow } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';

const forge = forgeAvailability();
const titled = (t: string) => (forge.ok ? t : `${t} — SKIPPED: ${forge.reason}`);
const PREFIX = '/cardtable';
const UI_TIMEOUT = 30_000;
/** One line: faces, names with colours, the score with its state. */
const STRIP_MAX_HEIGHT = 64;

async function measure(page: Page, label: string, width: number): Promise<void> {
  const card = page.locator('[data-testid="pod-tables-row"][data-mine]');
  await expect(card, `${label}: my table's card`).toBeVisible();
  const b = (await card.boundingBox())!;
  const chip = (await page.getByTestId('pod-tables-play').boundingBox())!;
  const resolves = await card.locator('.table-card__resolve').count();
  console.log(`[hub-table-card] ${label}: card ${Math.round(b.width)}×${Math.round(b.height)} at x=${Math.round(b.x)}; chip inside=${chip.y >= b.y && chip.y + chip.height <= b.y + b.height}; resolves drawn ${resolves}`);
  expect(b.height, `${label}: one strip per table`).toBeLessThanOrEqual(STRIP_MAX_HEIGHT);
  expect(b.x + b.width, `${label}: inside the page's width`).toBeLessThanOrEqual(width);
  expect(chip.y >= b.y && chip.y + chip.height <= b.y + b.height, `${label}: my way in is in the strip`).toBe(true);
  expect(resolves, `${label}: no row of resolves under the card`).toBe(0);
  await expect(card.getByTestId('pod-tables-row-more'), `${label}: one ⋯ for them`).toBeVisible();
}

test(titled('a tournament hub draws each table as one strip, its resolves behind ⋯, the whole card the way in, at 1920×1080 and phone width'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(4 * 60_000);
  const stack = await startPlayStack(forge);
  const alice = await openFriend(browser, 'alice');
  try {
    await resizeWindow(alice.page, { width: 1920, height: 1080 });
    await alice.page.goto(`${stack.origin}${PREFIX}/`);
    const api = async <T>(method: 'POST' | 'PATCH', path: string, data?: unknown): Promise<{ status: number; body: T }> => {
      const res = await alice.context.request.fetch(`${stack.origin}${PREFIX}/api${path}`, { method, data: data ?? {} });
      return { status: res.status(), body: (await res.json()) as T };
    };
    const created = await api<{ id: string }>('POST', '/rooms', { name: `e2e hub table card ${Date.now()}`, gameType: 'constructed-1v1', mode: 'gauntlet', modeOptions: { family: 'modern' } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const roomId = created.body.id;
    expect((await api('PATCH', `/rooms/${roomId}`, { settings: { tournament: true, tournamentDecks: 'per-round' } })).status).toBe(200);
    expect((await api('POST', `/rooms/${roomId}/pod/sit`, { seat: 0 })).status).toBe(200);
    expect((await api('POST', `/rooms/${roomId}/pod/ai`, { seat: 1, on: true })).status).toBe(200);

    await alice.page.goto(`${stack.origin}${PREFIX}/#/room/${roomId}`);
    await expect(alice.page.getByTestId('pod-seat-1'), 'the lobby seats the AI').toHaveAttribute('data-ai', '', { timeout: UI_TIMEOUT });
    await alice.page.getByTestId('ready-toggle').click();
    await expect(alice.page.getByTestId('table-page'), 'paired: carried to my table').toBeVisible({ timeout: UI_TIMEOUT });
    await alice.page.getByTestId('table-hub').click();
    await expect(alice.page.getByTestId('pod-rounds'), 'the hub').toBeVisible({ timeout: UI_TIMEOUT });

    await measure(alice.page, '1920×1080', 1920);
    await resizeWindow(alice.page, { width: 390, height: 844 });
    await measure(alice.page, '390×844', 390);

    // The ⋯ opens my resolves under the strip; pressing it again puts them away.
    const card = alice.page.locator('[data-testid="pod-tables-row"][data-mine]');
    await card.getByTestId('pod-tables-row-more').click();
    await expect(alice.page.getByTestId('pod-tables-row-drop'), 'Drop match, behind ⋯').toBeVisible();
    await card.getByTestId('pod-tables-row-more').click();
    await expect(alice.page.getByTestId('pod-tables-row-drop')).toHaveCount(0);

    // The whole card is the way in: a press on my own face, away from the chip, carries me to my table.
    await card.click({ position: { x: 20, y: 20 } });
    await expect(alice.page.getByTestId('table-page'), 'the card took me to my table').toBeVisible({ timeout: UI_TIMEOUT });
  } finally {
    await alice.context.close();
    await stack.stop();
  }
});

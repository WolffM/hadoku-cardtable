/**
 * Shared rig for the deck editor's pan and zoom specs (`w90e-editor-desktop.spec.ts`,
 * `w90e-editor.phone.spec.ts`). The sideboard step, the draft's deck builder and `#/deck/<podId>` are
 * one `DeckEditor`; a solo draft against AI bots reaches it with no Forge match.
 */
import { expect, type Page } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { createRoomByApi } from './play/rooms.ts';
import { fillWithAi, readyPod } from './podSeats.ts';

const ENABLED_CARDS = '[data-testid="pack"] button[data-testid="card"]:not([disabled])';

/** alice drafts a solo pod against bots, first card every pick, until the pod hands her the editor. */
export async function openSoloDeckEditor(page: Page, timeoutMs = 120_000): Promise<void> {
  await page.context().addCookies([{ name: SESSION_COOKIE, value: 'alice', domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  await page.goto(`${EDGE_ORIGIN}${PREFIX}/`);
  await createRoomByApi(page, { name: `deck editor ${Date.now()}`, gameType: 'draft', clientMode: 'builtin' });
  await expect(page.getByTestId('ready-toggle')).toBeVisible({ timeout: 30_000 });
  await readyPod(page);
  await fillWithAi(page, 15_000);
  await expect(page.getByTestId('pod')).toBeVisible({ timeout: 30_000 });
  const deadline = Date.now() + timeoutMs;
  while (!page.url().includes('#/deck/')) {
    if (Date.now() > deadline) throw new Error('the solo draft never reached the deck editor');
    const enabled = page.locator(ENABLED_CARDS);
    const id = (await enabled.count()) === 0 ? null : await enabled.first().getAttribute('data-card-id');
    if (id === null) {
      await page.waitForTimeout(150);
      continue;
    }
    await enabled.first().click({ timeout: 2_000 }).catch(() => undefined);
    await expect
      .poll(async () => page.url().includes('#/deck/') || (await page.locator(`[data-testid="pack"] button[data-card-id="${id}"]`).count()) === 0, { timeout: 20_000 })
      .toBe(true);
  }
  await expect(page.getByTestId('deck-editor')).toBeVisible({ timeout: 30_000 });
}

/** A surface's live pan and zoom, read off the `translate()`/`scale()` its viewport (`side-grid`/`main-grid`) draws it at. */
export async function surfaceTransform(page: Page, viewportTestId: string): Promise<{ x: number; y: number; zoom: number }> {
  const style = await page.locator(`[data-testid="${viewportTestId}"] > .deck-editor__surface`).evaluate((el) => (el as HTMLElement).style.transform);
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(style);
  if (m === null) throw new Error(`unreadable transform: ${style}`);
  return { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) };
}

/** A point of a viewport where no card is drawn: scanned along its middle row, then its top row. */
export async function emptyPointIn(page: Page, viewportTestId: string): Promise<{ x: number; y: number }> {
  const p = await page.getByTestId(viewportTestId).evaluate((el) => {
    const r = el.getBoundingClientRect();
    for (const fy of [0.5, 0.15, 0.85]) {
      for (let x = r.right - 4; x > r.left + 4; x -= 6) {
        const y = r.top + r.height * fy;
        const hit = document.elementFromPoint(x, y);
        if (hit !== null && el.contains(hit) && hit.closest('.deck-editor__card') === null) return { x, y };
      }
    }
    return null;
  });
  if (p === null) throw new Error(`${viewportTestId} has no empty point to press`);
  return p;
}

/** A point on a card that is drawn inside its viewport and is what a finger there would press. */
export async function cardPointIn(page: Page, viewportTestId: string): Promise<{ x: number; y: number }> {
  const p = await page.getByTestId(viewportTestId).evaluate((el) => {
    const r = el.getBoundingClientRect();
    for (const fy of [0.5, 0.25, 0.75]) {
      for (let x = r.left + 8; x < r.right - 8; x += 6) {
        const y = r.top + r.height * fy;
        const hit = document.elementFromPoint(x, y);
        if (hit !== null && el.contains(hit) && hit.closest('.deck-editor__card') !== null) return { x, y };
      }
    }
    return null;
  });
  if (p === null) throw new Error(`${viewportTestId} draws no card to press`);
  return p;
}

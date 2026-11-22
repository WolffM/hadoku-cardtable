/**
 * Shared rig for the deck editor's pan and zoom specs (`w90e-editor-desktop.spec.ts`,
 * `w90e-editor.phone.spec.ts`). The sideboard step, the draft's deck builder and `#/deck/<podId>` are
 * one `DeckEditor`; a solo draft against AI bots reaches it with no Forge match.
 */
import { expect, type Locator, type Page } from '@playwright/test';

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
    // Clicked again until the pick takes: a click the pack's own redraw intercepts (a new pack
    // fanning in under the hovered card's inspector) is never sent, and one try left the pick
    // waiting on nothing (CI run 43082207703, pack 3 pick 1).
    const card = page.locator(`[data-testid="pack"] button[data-card-id="${id}"]`);
    const picked = async (): Promise<boolean> => page.url().includes('#/deck/') || (await card.count()) === 0;
    await expect
      .poll(
        async () => {
          if (await picked()) return true;
          await card.click({ timeout: 2_000 }).catch(() => undefined);
          return picked();
        },
        { timeout: 20_000, intervals: [500] },
      )
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

/**
 * The first of `cards` its viewport draws some of, and the middle of that drawn part, which
 * `elementFromPoint` answers with the card. A tall pile can run past its viewport at 100% (cards keep
 * their floor and the pan reaches the rest), so a pile's top card may be partly or wholly below it.
 */
export async function visibleCardIn(cards: Locator, viewportTestId: string): Promise<{ card: Locator; x: number; y: number }> {
  for (let i = 0; i < (await cards.count()); i++) {
    const card = cards.nth(i);
    const p = await card.evaluate((el, id) => {
      const view = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (view === undefined) return null;
      const top = Math.max(r.top, view.top);
      const bottom = Math.min(r.bottom, view.bottom);
      const left = Math.max(r.left, view.left);
      const right = Math.min(r.right, view.right);
      if (bottom - top < 4 || right - left < 4) return null;
      const point = { x: (left + right) / 2, y: (top + bottom) / 2 };
      const hit = document.elementFromPoint(point.x, point.y);
      return hit !== null && el.contains(hit) ? point : null;
    }, viewportTestId);
    if (p !== null) return { card, ...p };
  }
  throw new Error(`${viewportTestId} draws none of the cards`);
}

/**
 * A card, and the middle of the part of it a pile leaves drawn (a whole top card, or a lower card's
 * strip), that a zoom to `zoom` about that point keeps under it: one the pan's clamp leaves alone.
 * Where the clamp binds it wins over the anchor (`pan.ts`, "The zoom anchor"): a point low on a
 * deck that barely fills its viewport is pulled up off the pointer, and the first pile's top card,
 * the bottom of its pile, was that point in four CI reds of `w90e-editor-desktop.spec.ts`
 * (11-20..22, each landing on the card beneath it). A pile's top card is always its lowest, so
 * no top card may qualify; a strip higher up does. Names drawn twice (a basic land) are skipped,
 * so landing on the wrong copy can never pass. The point is measured from the viewport's content
 * box, where the surface's offset is.
 */
export async function anchorableCardIn(page: Page, viewportTestId: string, zoom: number): Promise<{ card: Locator; x: number; y: number }> {
  const found = await page.getByTestId(viewportTestId).evaluate((el, z) => {
    const surface = el.firstElementChild as HTMLElement;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const origin = { x: r.left + el.clientLeft + parseFloat(s.paddingLeft), y: r.top + el.clientTop + parseFloat(s.paddingTop) };
    const view = { w: el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight), h: el.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom) };
    // Zoomed from 1 with no pan, the anchor `a` lands its surface at `a - a·z`, which the clamp keeps in `[view - content·z, 0]`.
    const free = (a: number, viewLen: number, contentLen: number): boolean => a - a * z >= Math.min(0, viewLen - contentLen * z) + 1;
    const cards = [...el.querySelectorAll('[data-testid="card"]')];
    const names = cards.map((c) => c.getAttribute('aria-label'));
    for (const [i, card] of cards.entries()) {
      if (names.indexOf(names[i]!) !== names.lastIndexOf(names[i]!)) continue;
      const b = card.getBoundingClientRect();
      // A pile's next card covers this one from its own top down.
      const slot = card.closest('.pile__stack > *');
      const next = slot?.nextElementSibling?.getBoundingClientRect();
      const bottom = next === undefined ? b.bottom : Math.min(b.bottom, next.top);
      const p = { x: b.left + b.width / 2, y: (b.top + bottom) / 2 };
      if (bottom - b.top < 8 || p.y > r.bottom - 4) continue;
      if (document.elementFromPoint(p.x, p.y)?.closest('[data-testid="card"]') !== card) continue;
      if (free(p.x - origin.x, view.w, surface.offsetWidth) && free(p.y - origin.y, view.h, surface.offsetHeight)) return { i, ...p };
    }
    return null;
  }, zoom);
  if (found === null) throw new Error(`${viewportTestId}: every drawn card is where a zoom to ${zoom} is clamped`);
  return { card: page.getByTestId(viewportTestId).getByTestId('card').nth(found.i), x: found.x, y: found.y };
}

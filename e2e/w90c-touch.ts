/**
 * Shared rig for the w90 lane C phone specs (`w90c-pack-fan.phone.spec.ts`, `w90c-pack-grid.phone.spec.ts`):
 * a solo draft pod (one human, the rest bots — needs no Forge, a draft never touches it) dealt down to
 * its first pack, and a real-finger swipe/drag, dispatched over CDP the same way `e2e/play/w32.ts`'s
 * `touchDrag` does (that file is wave 89's board driver; this is its own copy, scoped to the pack).
 */
import { expect, type Browser, type Page } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { fillWithAi, readyPod, sitPodAt } from './podSeats.ts';
import { openFriend } from './play/browser.ts';
import { submitCreateRoom } from './play/rooms.ts';

/**
 * alice's own phone context (`openFriend`'s cookie is what makes her a member, not a public caller),
 * closed again once `fn` returns or throws — every spec in this file runs through this, never the bare
 * `page` fixture, which carries no session.
 */
export async function withAlice(browser: Browser, fn: (page: Page) => Promise<void>): Promise<void> {
  const alice = await openFriend(browser, 'alice');
  try {
    await fn(alice.page);
  } finally {
    await alice.context.close();
  }
}

/**
 * alice sits, readies, the rest fill with bots, and the first pack deals — the draft needs no Forge.
 * Waits past `useArtLoaded`'s hold (`PackView.tsx`'s header): a tap or a drag on a still-`disabled`
 * card is a no-op, not a red herring the next assertion would otherwise have to explain.
 */
export async function soloDraftPack(page: Page): Promise<void> {
  await page.goto(`${PREFIX}/`);
  await submitCreateRoom(page, { name: `w90c pack ${Date.now()}`, gameType: 'draft' });
  await page.waitForURL(/\/room\//, { timeout: 30_000 });
  await page.getByTestId('draft-lobby').waitFor({ timeout: 30_000 });
  // Making the room seated alice already (`room/lobby.ts`'s `#autoSeat`).
  await sitPodAt(page, 0);
  await readyPod(page);
  await fillWithAi(page, 30_000);
  const pack = page.getByTestId('pack');
  await pack.waitFor({ timeout: 30_000 });
  await pack.locator('button[data-testid="card"]').first().waitFor({ timeout: 30_000 });
  await expect(pack, 'every card’s art is in before a gesture is asked of one').not.toHaveAttribute('data-art-pending', /.*/, { timeout: 15_000 });
  await expect(pack.locator('button[data-testid="card"]').first(), 'the pack is pickable, not held').toBeEnabled({ timeout: 15_000 });
  // Sitting and readying scroll their own targets into view; a box measured from wherever that left
  // the page is not the pack's real one.
  await page.evaluate(() => window.scrollTo(0, 0));
}

/**
 * One finger, down at `from`, through `steps` real `touchMove` events to `to`, then up — what Chromium
 * turns into `pointerType: 'touch'` events, the same as a native scroll-snap or `overflow: auto` drag.
 * Settles on `settleMs` after lifting, past CSS `scroll-behavior: smooth`'s own travel. The touch
 * points all carry the SAME `id` (`w90a-pool-sets-scroll.phone.spec.ts`'s own swipe, the proven shape
 * for this exact gesture on this host) — without one Chromium does not always read a `touchMove` as the
 * same finger continuing, and the move is dropped rather than turned into a scroll.
 */
export async function swipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, opts: { steps?: number; settleMs?: number } = {}): Promise<void> {
  const steps = opts.steps ?? 12;
  const client = await page.context().newCDPSession(page);
  const point = (x: number, y: number) => ({ x, y, radiusX: 11, radiusY: 11, force: 1, id: 1 });
  try {
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(from.x, from.y)] });
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(x, y)] });
      await page.waitForTimeout(16);
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await client.detach().catch(() => undefined);
  }
  await page.waitForTimeout(opts.settleMs ?? 500);
}

/** The index of the fan's open card (`.pack__slot[data-focused]`), by counting slots before it. */
export async function openIndex(page: Page): Promise<number> {
  return page.locator('.pack__slot').evaluateAll((slots) => slots.findIndex((s) => s.hasAttribute('data-focused')));
}

/** Settled 3 (`play/phone.ts`'s own `noSideways`, re-read here so this file stays self-contained): the page's own scroller never scrolls sideways — a pack's own horizontal scroller is its own axis, not the page's. */
export async function noPageSideways(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => {
    const se = document.scrollingElement ?? document.documentElement;
    return { scrollWidth: se.scrollWidth, clientWidth: se.clientWidth };
  });
  expect(scrollWidth, 'the page body does not scroll sideways').toBe(clientWidth);
}

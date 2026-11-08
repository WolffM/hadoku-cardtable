/**
 * Wave 90 lane B, item 3 — the ready ring, at 1440×900 (desktop). Companion to
 * `w90b-ready-ring.phone.spec.ts`'s phone-width proof: above the 560px breakpoint `.pod-seats`
 * never becomes a scroller, so nothing should clip the ring there either, before or after the
 * fix. Kept as its own check (the brief: "Also check 1440") rather than an assumption.
 *
 * Same two scenes, same `ringFits` measure (every ready avatar's ring against whatever actually
 * clips it — the nearest ancestor with non-visible overflow, or the viewport). `[w90b-ready-ring]`
 * lines are the evidence.
 */
import { expect, test, type Page } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { resizeWindow, roomIdFromAddress } from './play/board.ts';
import { openFriend } from './play/browser.ts';
import { submitCreateRoom } from './play/rooms.ts';

const UI_TIMEOUT = 40_000;
/** `.pod-seats__avatar[data-ready='true']`'s own box-shadow width (`PodSeats.css`). */
const RING = 3;

interface RingReport {
  rows: string[];
  bad: string[];
}

/** Every ready avatar on the page: its ring, inflated by {@link RING}, against whatever actually clips it. */
async function ringFits(page: Page): Promise<RingReport> {
  return page.evaluate((ring) => {
    const clipRectOf = (el: Element) => {
      let left = -Infinity;
      let top = -Infinity;
      let right = Infinity;
      let bottom = Infinity;
      // Start at the PARENT: box-shadow paints outside the border box and is never clipped by the
      // element's own `overflow` (only an ancestor's) — the avatar itself is `overflow: hidden`
      // (it crops the circular image), which is unrelated to whether the RING is clipped.
      for (let node: Element | null = el.parentElement; node !== null; node = node.parentElement) {
        const cs = getComputedStyle(node);
        const clipsX = cs.overflowX !== 'visible';
        const clipsY = cs.overflowY !== 'visible';
        if (!clipsX && !clipsY) continue;
        const r = node.getBoundingClientRect();
        if (clipsX) {
          left = Math.max(left, r.left);
          right = Math.min(right, r.right);
        }
        if (clipsY) {
          top = Math.max(top, r.top);
          bottom = Math.min(bottom, r.bottom);
        }
      }
      return { left: Math.max(left, 0), top: Math.max(top, 0), right: Math.min(right, innerWidth), bottom: Math.min(bottom, innerHeight) };
    };
    // The nearest ancestor that actually scrolls horizontally — `scrollIntoView` proved
    // unreliable for a seat past the one already at max scroll (it left every later seat's
    // scrollLeft wherever the previous call's clamp left it, rather than bringing each into
    // view), so this scrolls that ancestor explicitly instead: the seat's own content-relative
    // position, centred, clamped to [0, scrollWidth - clientWidth].
    const scrollerOf = (el: Element): HTMLElement | null => {
      for (let node: Element | null = el.parentElement; node !== null; node = node.parentElement) {
        if (getComputedStyle(node).overflowX !== 'visible' && node.scrollWidth > node.clientWidth) return node as HTMLElement;
      }
      return null;
    };
    const EPS = 0.5;
    const rows: string[] = [];
    const bad: string[] = [];
    for (const avatar of Array.from(document.querySelectorAll<HTMLElement>('.pod-seats__avatar[data-ready="true"]'))) {
      const scroller = scrollerOf(avatar);
      if (scroller !== null) {
        const s = scroller.getBoundingClientRect();
        const a0 = avatar.getBoundingClientRect();
        const contentLeft = a0.left - s.left + scroller.scrollLeft;
        const max = scroller.scrollWidth - scroller.clientWidth;
        scroller.scrollLeft = Math.max(0, Math.min(max, contentLeft - (scroller.clientWidth - a0.width) / 2));
      }
      const a = avatar.getBoundingClientRect();
      const box = { left: a.left - ring, top: a.top - ring, right: a.right + ring, bottom: a.bottom + ring };
      const clip = clipRectOf(avatar);
      const ok = box.left >= clip.left - EPS && box.top >= clip.top - EPS && box.right <= clip.right + EPS && box.bottom <= clip.bottom + EPS;
      const seat = avatar.closest('[data-testid]')?.getAttribute('data-testid') ?? '?';
      const row = `${seat}: ring ${Math.round(box.left)},${Math.round(box.top)}..${Math.round(box.right)},${Math.round(box.bottom)} clip ${Math.round(clip.left)},${Math.round(clip.top)}..${Math.round(clip.right)},${Math.round(clip.bottom)} ${ok ? 'OK' : 'CLIPPED'}`;
      rows.push(row);
      if (!ok) bad.push(seat);
    }
    return { rows, bad };
  }, RING);
}

async function postJson(context: import('@playwright/test').BrowserContext, path: string, data: unknown): Promise<void> {
  const res = await context.request.post(`${EDGE_ORIGIN}${PREFIX}/api${path}`, { data });
  expect(res.status(), `${path}: ${await res.text()}`).toBe(200);
}

test('a nine-seat draft pod, seven of eight humans ready: the ring is not clipped at 1440×900', async ({ browser }) => {
  test.setTimeout(60_000);
  const alice = await openFriend(browser, 'alice');
  const extra: import('@playwright/test').BrowserContext[] = [];
  try {
    await resizeWindow(alice.page, { width: 1440, height: 900 });
    await alice.page.goto(`${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: `e2e w90b ready ring 1440 ${Date.now()}`, gameType: 'draft' });
    const roomId = await roomIdFromAddress(alice.page);

    await postJson(alice.context, `/rooms/${roomId}/pod/sit`, { seat: 0 });
    await postJson(alice.context, `/rooms/${roomId}/ready`, { ready: true });
    const others = ['bob', 'drafter3', 'drafter4', 'drafter5', 'drafter6', 'drafter7', 'drafter8'];
    for (let i = 0; i < others.length; i++) {
      const context = await browser.newContext();
      extra.push(context);
      await context.addCookies([{ name: SESSION_COOKIE, value: others[i]!, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
      await postJson(context, `/rooms/${roomId}/join`, {});
      await postJson(context, `/rooms/${roomId}/pod/sit`, { seat: i + 1 });
      // drafter8 stays seated but not ready: readying every base seat makes the room deal the draft
      // (`ConstructedScreen`'s all-ready effect), and the seat strip is gone before it is measured.
      if (others[i] !== 'drafter8') await postJson(context, `/rooms/${roomId}/ready`, { ready: true });
    }

    await alice.page.goto(`${EDGE_ORIGIN}${PREFIX}/#/room/${roomId}`);
    await resizeWindow(alice.page, { width: 1440, height: 900 });
    await expect(alice.page.getByTestId('pod-seat-8'), 'the ninth (growth) seat shows once all 8 are filled').toBeVisible({ timeout: UI_TIMEOUT });
    await expect(alice.page.locator('.pod-seats__avatar[data-ready="true"]'), 'seven ready rings (drafter8 stays unready)').toHaveCount(7, { timeout: UI_TIMEOUT });

    const report = await ringFits(alice.page);
    console.log(`[w90b-ready-ring] draft pod @1440: ${report.rows.join(' | ')}`);
    expect(report.bad, `clipped rings: ${report.rows.filter((r) => r.includes('CLIPPED')).join(' | ')}`).toEqual([]);
  } finally {
    await alice.context.close();
    for (const context of extra) await context.close();
  }
});

test('the constructed table’s two seats share the same ring CSS: not clipped at 1440×900', async ({ browser }) => {
  test.setTimeout(60_000);
  const alice = await openFriend(browser, 'alice');
  try {
    await resizeWindow(alice.page, { width: 1440, height: 900 });
    await alice.page.goto(`${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: `e2e w90b ready ring table 1440 ${Date.now()}`, mode: 'classic' });
    await alice.page.getByTestId('deck-random').click();
    await expect(alice.page.getByTestId('ready-toggle'), 'a random deck enables Ready').toBeEnabled({ timeout: UI_TIMEOUT });
    // My own pill says the state it is in, as everyone else's does (the operator, 2026-11-05).
    await expect(alice.page.getByTestId('ready-toggle'), 'my pill before the press').toHaveText('not ready');
    await alice.page.getByTestId('ready-toggle').click();
    await expect(alice.page.getByTestId('ready-toggle'), 'ready').toHaveAttribute('data-state', 'yes', { timeout: UI_TIMEOUT });
    await expect(alice.page.getByTestId('ready-toggle'), 'my pill after the press').toHaveText('ready');
    await expect(alice.page.locator('.pod-seats--table .pod-seats__avatar[data-ready="true"]'), 'one ready ring at the table').toHaveCount(1);

    const report = await ringFits(alice.page);
    console.log(`[w90b-ready-ring] table @1440: ${report.rows.join(' | ')}`);
    expect(report.bad, `clipped rings: ${report.rows.filter((r) => r.includes('CLIPPED')).join(' | ')}`).toEqual([]);
  } finally {
    await alice.context.close();
  }
});

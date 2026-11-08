/**
 * Wave 90 lane B, item 3 — the ready ring, at phone width. The operator: "i notice the circles
 * around the ready players is cutoff, let's make sure that circle outline renders properly."
 *
 * Cause (`PodSeats.css`): the ring is `box-shadow: 0 0 0 3px var(--success)`, painted OUTSIDE the
 * 44px avatar box. Under 560px wide, `.pod-seats` becomes a horizontally-scrolling strip
 * (`overflow-x: auto; overflow-y: hidden`) with padding only on its bottom edge, so the scroller's
 * own clip rect cuts the ring's top on every seat, and the first seat's left edge too.
 *
 * Two scenes, both at phone width (390×844):
 *  - a draft room's own lobby, nine seats: all 8 base seats filled (the ninth is the room's own
 *    growth seat, shown once every seat has an OCCUPANT — `PodSeats.tsx`'s `seats.every((s) => s
 *    !== null)`, occupancy only, not readiness), seven of the eight ready. The eighth stays
 *    SEATED but not ready on purpose: `ConstructedScreen.tsx` has its own effect ("Every member
 *    ready: deal the draft") that calls `rooms.start()` from ANY open tab — including alice's,
 *    mounted on the room since `submitCreateRoom` — the instant `allReady` goes true, racing this
 *    test's own `page.goto()` reload. An early version readied all 8 and hit exactly that race
 *    (`pod` appeared, not the lobby, depending on which finished first); the growth seat's own
 *    gate is occupancy, not readiness, so leaving one seat merely unready keeps the lobby up
 *    without leaving any BASE seat open (which `dealGate`'s `not-ready` already refuses on its
 *    own) and needs no Forge build either way.
 *  - the constructed table's two seats (`pod-seats--table`, `ConstructedScreen.tsx`), which share
 *    the same CSS and the same `@media (max-width: 560px)` rule.
 *
 * For every ready avatar, the ring (the avatar's own rect inflated by its 3px box-shadow) must lie
 * inside whatever actually clips it — the nearest ancestor with non-visible overflow, or the
 * viewport if none does. `[w90b-ready-ring]` lines are the evidence.
 */
import { expect, test, type Page } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from './identities.ts';
import { openFriend } from './play/browser.ts';
import { PHONE } from './play/phone.ts';
import { submitCreateRoom } from './play/rooms.ts';
import { roomIdFromAddress } from './play/board.ts';

test.use(PHONE);

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
    const chain: string[] = [];
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
        chain.push(`${node.tagName.toLowerCase()}.${Array.from(node.classList).join('.')} ovf=${cs.overflowX}/${cs.overflowY} rect=${Math.round(r.left)},${Math.round(r.top)}..${Math.round(r.right)},${Math.round(r.bottom)}`);
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
      const row = `${seat}: ring ${Math.round(box.left)},${Math.round(box.top)}..${Math.round(box.right)},${Math.round(box.bottom)} clip ${Math.round(clip.left)},${Math.round(clip.top)}..${Math.round(clip.right)},${Math.round(clip.bottom)} ${ok ? 'OK' : 'CLIPPED'} | chain: ${chain.join(' ; ')}`;
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

/**
 * Waits until every `.pod-seats`'s own top edge stops moving (two reads a frame apart agree).
 * A CI run (41428988383) caught the ring 1px past its OWN scroller's clip — the scroller's own
 * 6px top padding was intact (the avatar sat exactly 6px under `.pod-seats`'s own top, in both
 * that run's numbers and every local one), but `.pod-seats` itself sat only ~4px under the room
 * chrome's outer frame (`.wp-room-chrome-frame`, `screens.css`/chrome — not this file), which also
 * clips and is normally never the tighter bound (its own top sits well above `.pod-seats`'s,
 * leaving `.pod-seats`'s own padding as the binding constraint) — until the content ABOVE the
 * seats (the room header, loaded async on a slower run) hadn't finished laying out yet, pushing
 * `.pod-seats` higher than usual and briefly making that OUTER frame the tighter one instead.
 * Settling here before measuring is the fix: a real visitor never sees a ring mid-layout either.
 */
async function waitForSettledSeats(page: Page): Promise<void> {
  // The room is drawn inside a scrolling shell (`.shell--fit`): a seat row partly scrolled out of its top is
  // hidden like any scrolled-off content, which is not the ring's clip (CI 41431333605: row top 77, shell's
  // visible top 81). Bring every seat row fully into the shell's view first, then wait for it to hold still.
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll('.pod-seats'))) el.scrollIntoView({ block: 'center', inline: 'nearest' });
  });
  await page.waitForFunction(() => {
    const w = window as unknown as { __seatsTopSample?: number };
    const el = document.querySelector('.pod-seats');
    if (el === null) return false;
    const top = el.getBoundingClientRect().top;
    const stable = w.__seatsTopSample === top;
    w.__seatsTopSample = top;
    return stable;
  }, null, { timeout: 10_000, polling: 100 });
}

test('a nine-seat draft pod, eight humans ready: the ring never spills past the scroller’s own clip, at phone width', async ({ browser }) => {
  test.setTimeout(60_000);
  const alice = await openFriend(browser, 'alice');
  const extra: import('@playwright/test').BrowserContext[] = [];
  try {
    await alice.page.goto(`${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: `e2e w90b ready ring ${Date.now()}`, gameType: 'draft' });
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
      // drafter8 (the last seat) stays seated but NOT ready — see the header: readying every
      // seated member fires `ConstructedScreen.tsx`'s own auto-deal effect from ANY open tab.
      if (others[i] !== 'drafter8') await postJson(context, `/rooms/${roomId}/ready`, { ready: true });
    }

    await alice.page.goto(`${EDGE_ORIGIN}${PREFIX}/#/room/${roomId}`);
    // All 8 BASE seats filled (occupancy, not readiness): the growth seat shows on its own.
    await expect(alice.page.getByTestId('pod-seat-8'), 'the ninth (growth) seat shows once all 8 are filled').toBeVisible({ timeout: UI_TIMEOUT });
    await expect(alice.page.locator('.pod-seats__avatar[data-ready="true"]'), 'seven ready rings (drafter8 stays unready)').toHaveCount(7, { timeout: UI_TIMEOUT });
    await expect(alice.page.getByTestId('pod-seat-7').locator('.pod-seats__avatar'), 'drafter8’s own seat (index 7) is not ready').toHaveAttribute('data-ready', 'false');
    // Nobody is ready: no draft dealt, so this needs no Forge build.
    await expect(alice.page.getByTestId('pod')).toHaveCount(0);

    await waitForSettledSeats(alice.page);
    const report = await ringFits(alice.page);
    console.log(`[w90b-ready-ring] draft pod @390: ${report.rows.join(' | ')}`);
    expect(report.bad, `clipped rings: ${report.rows.filter((r) => r.includes('CLIPPED')).join(' | ')}`).toEqual([]);
  } finally {
    await alice.context.close();
    for (const context of extra) await context.close();
  }
});

test('the constructed table’s two seats share the same ring CSS: not clipped at phone width', async ({ browser }) => {
  test.setTimeout(60_000);
  const alice = await openFriend(browser, 'alice');
  try {
    await alice.page.goto(`${PREFIX}/`);
    await submitCreateRoom(alice.page, { name: `e2e w90b ready ring table ${Date.now()}`, mode: 'classic' });
    await alice.page.getByTestId('deck-random').click();
    await expect(alice.page.getByTestId('ready-toggle'), 'a random deck enables Ready').toBeEnabled({ timeout: UI_TIMEOUT });
    await alice.page.getByTestId('ready-toggle').click();
    await expect(alice.page.getByTestId('ready-toggle'), 'ready').toHaveAttribute('data-state', 'yes', { timeout: UI_TIMEOUT });
    await expect(alice.page.locator('.pod-seats--table .pod-seats__avatar[data-ready="true"]'), 'one ready ring at the table').toHaveCount(1);

    await waitForSettledSeats(alice.page);
    const report = await ringFits(alice.page);
    console.log(`[w90b-ready-ring] table @390: ${report.rows.join(' | ')}`);
    expect(report.bad, `clipped rings: ${report.rows.filter((r) => r.includes('CLIPPED')).join(' | ')}`).toEqual([]);
  } finally {
    await alice.context.close();
  }
});

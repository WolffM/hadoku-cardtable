/**
 * How smoothly the front page's room list scrolls with 40 rooms open, in Firefox and Chromium — the
 * operator, 2026-10-28, of Firefox dropping frames there: *"please measure this properly with e2e tests
 * and telemetry not just guessing"*.
 *
 * The page scrolls its room list at a steady 1.1 px/ms, driven one frame at a time, bouncing at the
 * ends; the numbers are the app's own (`apps/ui/src/rooms/scroll-watch.ts`): the `perf` page event it
 * sends to `/api/client-events` as each burst ends, read off the wire here exactly as the server logs
 * it. `[scroll-perf]` lines are the evidence: each burst's frames, median and p95 gap and dropped-frame
 * share, then the median of the bursts per theme.
 *
 * Not a timing gate: a runner's load moves these numbers more than any one change does (headless
 * Chromium dropped 97% of its frames here on a host at load 48). What is asserted is that the
 * telemetry arrives, once per burst, in the schema the server logs; the numbers are the report.
 * Each theme's first scroll is a warm-up, not reported: it pays for the list's first raster.
 */
import { expect, test, type Page, type Request } from '@playwright/test';

import { PREFIX } from './identities.ts';
import { resizeWindow } from './play/board.ts';
import { openFriend } from './play/browser.ts';

/** The room count the Firefox report was measured at: at least this many are open. */
const ROOMS = 40;
/** Bursts per theme: the median of three is what is compared. */
const BURSTS = 3;
const BURST_MS = 2_500;
const SIZE = { width: 1920, height: 1080 };

/** Scroll the list's scroller at a steady speed for `ms`, one step per frame, bouncing at the ends. */
async function steadyScroll(page: Page, ms: number): Promise<void> {
  await page.evaluate(async (durationMs) => {
    const rooms = document.querySelector('[data-testid="rooms"]')!;
    let box: Element | null = rooms.parentElement;
    while (box !== null && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    if (box === null) throw new Error('nothing scrolls the room list');
    const el = box;
    const maxScroll = el.scrollHeight - el.clientHeight;
    el.scrollTop = 0;
    await new Promise<void>((done) => {
      let last = 0;
      let start = 0;
      let direction = 1;
      const frame = (now: number): void => {
        if (start === 0) start = now;
        else el.scrollTop += direction * 1.1 * (now - last);
        last = now;
        if (el.scrollTop >= maxScroll - 2) direction = -1;
        if (el.scrollTop <= 2) direction = 1;
        if (now - start < durationMs) requestAnimationFrame(frame);
        else done();
      };
      requestAnimationFrame(frame);
    });
  }, ms);
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

test('the front page’s room list scrolls at 40 rooms, measured by its own telemetry', async ({ browser, browserName }) => {
  test.setTimeout(3 * 60_000);
  const alice = await openFriend(browser, 'alice');
  const bob = await openFriend(browser, 'bob');
  try {
    // Topped up to ROOMS: the harness's server keeps the rooms earlier specs opened.
    const open = (await (await bob.context.request.get(`${PREFIX}/api/rooms`)).json()) as { rooms: unknown[] };
    for (let i = open.rooms.length + 1; i <= ROOMS; i++) {
      const made = await bob.context.request.post(`${PREFIX}/api/rooms`, {
        data: { name: `scroll ${i}`, gameType: i % 3 === 0 ? 'draft' : 'constructed-1v1' },
      });
      expect(made.status()).toBe(201);
    }
    const page = alice.page;
    for (const theme of ['dark', 'light'] as const) {
      await page.addInitScript((t) => localStorage.setItem('hadoku-theme', t), theme);
      await page.goto(`${PREFIX}/`);
      await resizeWindow(page, SIZE);
      await expect(page.getByTestId('room-row').nth(ROOMS - 1)).toBeAttached({ timeout: 30_000 });
      const dropped: number[] = [];
      const p50s: number[] = [];
      const p95s: number[] = [];
      for (let b = 0; b <= BURSTS; b++) {
        const sent = page.waitForRequest((r: Request) => r.url().endsWith('/api/client-events') && r.method() === 'POST');
        await steadyScroll(page, BURST_MS);
        const event = (await sent).postDataJSON() as { page: string; kind: string; data: Record<string, number | string> };
        expect(event).toMatchObject({ page: 'front', kind: 'perf', data: { what: 'scroll' } });
        if (b === 0) continue;
        const d = event.data;
        const frames = Number(d.frames);
        const share = Number(d.over25) / frames;
        dropped.push(share);
        p50s.push(Number(d.p50));
        p95s.push(Number(d.p95));
        console.log(
          `[scroll-perf] ${browserName} ${theme} burst=${b} frames=${frames} p50=${d.p50} p95=${d.p95} max=${d.max} over25=${d.over25} over50=${d.over50} dropped=${(100 * share).toFixed(1)}% rooms=${d.rooms} browser=${d.browser}/${d.version} dpr=${d.dpr} vw=${d.vw}x${d.vh}`,
        );
      }
      console.log(
        `[scroll-perf] ${browserName} ${theme} median p50=${median(p50s)} p95=${median(p95s)} dropped=${(100 * median(dropped)).toFixed(1)}%`,
      );
    }
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
});

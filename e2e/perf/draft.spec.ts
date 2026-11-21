/**
 * A draft, as a drafter's browser meets it (the operator, 2026-11-20: *"some parts of the site feel laggy
 * including drafting"*). One player and seven AI seats in a real room, on prod's common screen (1664×950 at
 * a 1.5 device pixel ratio) with real JPEG art (`real-art.ts`), the default fan layout, and four windows:
 *
 *   deal    the last AI seat taken, to the first pack drawn and settled
 *   read    a pack in front of the drafter, the pointer still: the state a drafter spends most time in
 *   scan    the pointer swept across the fan, card by card, as a drafter reads a pack
 *   picks   eight picks, each a sweep and a click: every frame, task, message and React commit
 *           (`measure.ts`), and per pick the click to the next pack drawn, split at the message that
 *           brought it: the server and the bots before it, our own drawing after it
 *
 * `[draft-perf]` lines and `e2e/.run/perf/draft-*.json` are the evidence. Asserts only that each window
 * measured something: a CI runner rasters in software on a shared CPU, so compare runs on one runner.
 *
 * `[nightly]`: too slow for `ci.yml`'s check; `forge.yml` runs it nightly, and on a claw on purpose with
 * `-f only=e2e -f specs='perf/draft.spec.ts'`. Needs no Forge: the harness passes a plan unchecked.
 */
import { expect, test, type Page } from '@playwright/test';

import { EDGE_ORIGIN, PREFIX, SESSION_COOKIE } from '../identities.ts';
import { keepPrefsLocal } from '../prefsLocal.ts';
import { roomIdFromAddress } from '../play/board.ts';
import { openCreateRoom, submitCreateRoom } from '../play/rooms.ts';
import { fillWithAi, readyPod } from '../podSeats.ts';
import { instrument, logReports, measure } from './measure.ts';
import { serveRealArt } from './real-art.ts';
import { logThreads, runningAnimations, traceThreads } from './threads.ts';

const SCREEN = { width: 1664, height: 950 };
const DPR = 1.5;
const PICKS = 8;
const READ_MS = 5_000;
/** One sweep across the fan: a step per card-width, about a frame and a half each. */
const SWEEP_STEPS = 30;
const SWEEP_MS = 1_500;
/** The server's pick rate limit is one per 250 ms after a burst (`draft.spec.ts`'s `PICK_INTERVAL_MS`). */
const PICK_GAP_MS = 400;
const ENABLED = '[data-testid="pack"] button[data-testid="card"]:not([disabled])';

declare global {
  interface Window {
    draftPerf: { downs: number[]; drawn: { at: number; cards: number }[] };
  }
}

/** In the page before its own code: each pointer press on the pack, and each new pack drawn (the frame after the change). */
function watchPacks(sel: string): void {
  const rec = { downs: [] as number[], drawn: [] as { at: number; cards: number }[] };
  window.draftPerf = rec;
  addEventListener('pointerdown', (e) => {
    if ((e.target as Element | null)?.closest?.('[data-testid="pack"]')) rec.downs.push(e.timeStamp);
  }, true);
  let last = '';
  const check = (): void => {
    const cards = document.querySelectorAll(sel);
    const sig = [...cards].map((c) => c.getAttribute('data-card-id')).join(',');
    if (sig === last) return;
    last = sig;
    if (cards.length > 0) requestAnimationFrame(() => rec.drawn.push({ at: performance.now(), cards: cards.length }));
  };
  document.addEventListener('DOMContentLoaded', () => new MutationObserver(check).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'data-card-id'] }));
}

/** Sweep the pointer across the pack's fan from left to right, then (for a pick) press where it stopped. */
async function sweep(page: Page, press: boolean): Promise<void> {
  const box = (await page.getByTestId('pack').boundingBox())!;
  const y = box.y + box.height * 0.55;
  await page.mouse.move(box.x + 8, y);
  for (let i = 1; i <= SWEEP_STEPS; i++) {
    await page.mouse.move(box.x + 8 + ((box.width - 16) * i) / SWEEP_STEPS, y);
    await page.waitForTimeout(SWEEP_MS / SWEEP_STEPS);
  }
  if (!press) return;
  // A pick: back to a card near the middle, as a drafter settles on one. A press on a card the fan has not
  // opened opens it (`PackView`'s `pick`), and the next press takes it, so press again only if the pack is
  // still the one it was.
  await page.mouse.move(box.x + box.width * 0.5, y, { steps: 5 });
  const was = await packSignature(page);
  await page.mouse.click(box.x + box.width * 0.5, y);
  await page.waitForTimeout(300);
  if ((await packSignature(page)) === was) await page.mouse.click(box.x + box.width * 0.5, y);
}

const packSignature = (page: Page): Promise<string> =>
  page.evaluate((sel) => [...document.querySelectorAll(sel)].map((c) => c.getAttribute('data-card-id')).join(','), ENABLED);

const median = (xs: number[]): number => (xs.length === 0 ? NaN : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!);

test('[nightly] perf: a draft — the deal, a pack read and scanned, and eight picks', async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  const context = await browser.newContext({ viewport: SCREEN, deviceScaleFactor: DPR, colorScheme: 'dark' });
  try {
    await context.addCookies([{ name: SESSION_COOKIE, value: 'alice', domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
    await keepPrefsLocal(context, EDGE_ORIGIN);
    await context.route('**/*', (route) => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort('blockedbyclient')));
    const page = await context.newPage();
    await page.addInitScript(instrument);
    await page.addInitScript(watchPacks, ENABLED);
    await serveRealArt(page);

    await page.goto(`${EDGE_ORIGIN}${PREFIX}/`);
    await openCreateRoom(page);
    await submitCreateRoom(page, { name: `perf draft ${Date.now()}`, gameType: 'draft' });
    await roomIdFromAddress(page);
    await readyPod(page);

    // deal: the trace runs from before the last seat fills to the first pack settled.
    const dealt = await traceThreads(browser, page);
    await fillWithAi(page);
    await expect(page.locator(ENABLED).first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(2_000);
    logThreads('draft-perf', 'deal..first pack+2s', await dealt.stop());

    // read: a pack waiting on the drafter, nobody moving.
    await page.mouse.move(5, 5);
    const animating = await runningAnimations(page);
    const read = await traceThreads(browser, page);
    await page.waitForTimeout(READ_MS);
    const readReport = await read.stop();
    logThreads('draft-perf', 'read (pack open, pointer still)', readReport);
    console.log(`[draft-perf] read: animating ${animating.map(([n, c]) => `${n}×${c}`).join(', ') || 'nothing'}`);

    // scan: the pointer across the fan, no pick.
    const scan = await traceThreads(browser, page);
    await sweep(page, false);
    const scanReport = await scan.stop();
    logThreads('draft-perf', 'scan (pointer across the fan)', scanReport);

    // picks: the whole of eight picks, measured and attributed.
    const m = measure(browser, 'draft-picks', [{ name: 'alice', page }]);
    await m.start();
    /** Each pick's taking press: the last press before its next pack (a pick may take two presses). */
    const presses: number[] = [];
    for (let i = 0; i < PICKS; i++) {
      await expect(page.locator(ENABLED).first()).toBeVisible({ timeout: 60_000 });
      const before = await page.evaluate(() => window.draftPerf.drawn.length);
      await sweep(page, true);
      await expect.poll(() => page.evaluate(() => window.draftPerf.drawn.length), { message: `pick ${i + 1}: the next pack is drawn`, timeout: 60_000 }).toBeGreaterThan(before);
      presses.push(await page.evaluate(() => window.draftPerf.downs.at(-1)!));
      await page.waitForTimeout(PICK_GAP_MS);
    }
    const reports = await m.stop();
    logReports(reports);

    // Per pick: the press, the next pack drawn after it, and the last message before that draw.
    const { drawn, messages } = await page.evaluate(() => ({ drawn: window.draftPerf.drawn, messages: window.perfBench.messages.map((x) => x.at) }));
    const waits: number[] = [];
    const ours: number[] = [];
    for (const [i, down] of presses.entries()) {
      const next = drawn.find((d) => d.at > down);
      if (next === undefined) continue;
      const msg = messages.filter((t) => t > down && t <= next.at).pop();
      waits.push(next.at - down);
      if (msg !== undefined) ours.push(next.at - msg);
      console.log(`[draft-perf] pick ${i + 1}: press → next pack drawn ${Math.round(next.at - down)} ms (${next.cards} cards); its message → drawn ${msg === undefined ? '?' : Math.round(next.at - msg)} ms`);
    }
    console.log(`[draft-perf] picks: median press → next pack ${Math.round(median(waits))} ms; median message → drawn ${Math.round(median(ours))} ms`);
    expect(waits.length, 'every pick drew a next pack').toBe(PICKS);
    expect(scanReport.threads.length, 'the scan trace saw the page').toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

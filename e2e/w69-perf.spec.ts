/**
 * The operator, 2026-10-10: "the game has become a bit more laggy since i last checked … i notice
 * it mostly when draging cards around. this needs to be buttery smooth, i expect to get at least
 * ~250fps at all times."
 *
 * 250 fps is a budget of 4 ms of main-thread work per frame (script + style + layout + paint), on
 * BOTH screens: the one dragging and the one mirroring the drag through presence. Two real browsers
 * on a real match (scenario `w69-perf`, a mid-game board) drive the operator's drags with real
 * pointer gestures while a Chrome trace and a CPU profile record both renderers:
 *
 *   hand    alice lifts a hand card and carries it round the board without letting go
 *   arrange alice drags one of her battlefield cards round her battlefield and puts it back
 *   chip    alice drags her Eternal Witness trigger's ability chip round the board
 *   idle    nobody moves: the floor every scenario is measured against
 *
 * Every scenario prints one `[w69-perf]` line per screen: frames, frame interval p50/p95/max, main
 * thread work per frame p50/p95/max split into script / style / layout / paint, forced (script
 * driven) layouts, React commits per second, DOM nodes, and the top self-time functions mapped
 * through the UI build's source map.
 *
 * What it asserts, and why no milliseconds: a CI runner draws in software on a shared CPU — an idle frame
 * of this board is ~0.9 ms there, a drag 9–12 ms p95 once nothing on the board lays all of it out,
 * and the same drag 17+ ms when three e2e shards share the node. Measured on CI runner-8 before the fix
 * (main dc06571): hand 29 / 21 ms, arrange 14 / 12, chip 23 / 21 (dragger / other screen), most of it
 * one or more whole-board layouts a frame (17–35 ms each). What regressed is the SHARE of a drag's
 * main-thread work that is layout, and how much of the page each layout touches — both ratios on
 * the runner's own clock, so a loaded CI runner slows the layout and the rest alike. The milliseconds
 * (and the 4 ms budget, `over4ms=`) are printed as evidence, never gated.
 */
import { expect, test, type Browser, type CDPSession, type Page } from '@playwright/test';

import { clickHandCard, makeTitled, pressPaymentAuto, resizeWindow } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { CATEGORIES, f1, f2, framesOf, pct, tickEveryFrame, topSelf, worstFrames, type CpuProfile, type Kind, type Seen, type TraceEvent } from './play/perf-trace.ts';
import { answerPrompt } from './play/prompts.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);

/** The offered card named `name` (`board.ts`'s own `offeredNamed`, here so this spec runs on older mains too). */
async function offeredNamed(page: Page, name: string): Promise<number | undefined> {
  const cards = await page
    .locator('[data-board-card][data-selectable]')
    .evaluateAll((els) => els.map((e) => ({ id: Number(e.getAttribute('data-board-card')), name: e.querySelector('.card__name')?.textContent?.trim() ?? '' })));
  return cards.find((c) => c.name === name)?.id;
}

/** The operator's budget: 250 fps. Printed per scenario (`over4ms=`), not asserted — see the top. */
const BUDGET_MS = 4;
/** Layout's share of a drag's main-thread work: a whole-board layout a frame made it most of it (17–35 of 21–29 ms), a local one is ~1 ms of 9–12. */
const LAYOUT_SHARE = 0.3;
/** The share of the page's layout objects one frame's layouts may dirty, p95: a drag's own are 11–44 of ~1,100 (at most 4 %). */
const DIRTY_SHARE_P95 = 0.15;

/** Count React commits: a stand-in DevTools hook, installed before the app loads. */
const COMMIT_HOOK = `(() => {
  window.__w69commits = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, isDisabled: false, renderers: new Map(),
    inject() { return 1; }, checkDCE() {}, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot() { window.__w69commits += 1; },
  };
})();`;
function hookContexts(browser: Browser): () => void {
  const original = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const context = await original(options);
    await context.addInitScript(COMMIT_HOOK);
    return context;
  };
  return () => {
    browser.newContext = original;
  };
}

interface Screen {
  name: string;
  page: Page;
  cdp: CDPSession;
}

interface Result {
  scenario: string;
  screen: string;
  /** All the drag's layout time over all its main-thread work. */
  layoutShare: number;
  /** Per frame, the layout objects its layouts dirtied over the page's total, at p95. */
  dirtyP95: number;
  line: string;
}

/**
 * Per frame of `seen`, the layout objects that frame's `Layout` events dirtied, as a share of the
 * page: the largest layout tree in the window. A layout of a small tree of its own (the stack
 * card's, measured whole) dirties all of ITS objects and a few of the page's.
 */
function dirtyShares(thread: TraceEvent[], seen: Seen): number[] {
  const from = seen.starts[0] ?? 0;
  const to = seen.starts.at(-1) ?? 0;
  const layouts = thread.filter((e) => e.name === 'Layout' && (e.ph === 'X' || e.ph === 'B') && e.args?.beginData?.totalObjects !== undefined && e.ts >= from && e.ts < to);
  const page = Math.max(0, ...layouts.map((e) => e.args!.beginData!.totalObjects!));
  const shares: number[] = [];
  for (let i = 1; i < seen.starts.length; i += 1) {
    let dirty = 0;
    for (const e of layouts) if (e.ts >= seen.starts[i - 1]! && e.ts < seen.starts[i]!) dirty += e.args!.beginData!.dirtyObjects ?? 0;
    shares.push(page === 0 ? 0 : dirty / page);
  }
  return shares;
}

async function measure(browserCdp: CDPSession, screens: Screen[], scenario: string, gesture: () => Promise<void>): Promise<Result[]> {
  const events: TraceEvent[] = [];
  const onData = (p: { value: object[] }): void => {
    events.push(...(p.value as TraceEvent[]));
  };
  browserCdp.on('Tracing.dataCollected', onData);
  const done = new Promise<void>((r) => browserCdp.once('Tracing.tracingComplete', () => r()));
  await browserCdp.send('Tracing.start', { traceConfig: { includedCategories: CATEGORIES, recordMode: 'recordAsMuchAsPossible' }, transferMode: 'ReportEvents' });
  for (const s of screens) {
    await s.cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await s.cdp.send('Profiler.start');
  }
  const before = await Promise.all(screens.map((s) => s.page.evaluate(() => (window as unknown as { __w69commits?: number }).__w69commits ?? -1)));
  for (const s of screens) await s.page.evaluate((m) => console.timeStamp(m), `w69:${s.name}:start`);
  const t0 = Date.now();
  await gesture();
  const seconds = (Date.now() - t0) / 1000;
  for (const s of screens) await s.page.evaluate((m) => console.timeStamp(m), `w69:${s.name}:end`);
  const after = await Promise.all(screens.map((s) => s.page.evaluate(() => (window as unknown as { __w69commits?: number }).__w69commits ?? -1)));
  const nodes = await Promise.all(screens.map((s) => s.page.evaluate(() => document.querySelectorAll('*').length)));
  const profiles = await Promise.all(screens.map(async (s) => ((await s.cdp.send('Profiler.stop')) as { profile: CpuProfile }).profile));
  await browserCdp.send('Tracing.end');
  await done;
  browserCdp.off('Tracing.dataCollected', onData);

  const results: Result[] = [];
  screens.forEach((s, i) => {
    const marks = events.filter((e) => e.name === 'TimeStamp' && (e.args?.data?.message ?? '').startsWith(`w69:${s.name}:`));
    const start = marks.find((e) => e.args!.data!.message!.endsWith(':start'));
    const end = marks.find((e) => e.args!.data!.message!.endsWith(':end'));
    if (start === undefined || end === undefined) throw new Error(`${scenario}/${s.name}: no timestamp marks in the trace (${events.length} events)`);
    const thread = events.filter((e) => e.pid === start.pid && e.tid === start.tid);
    const seen = framesOf(thread, start.ts, end.ts);
    const totals = seen.work.map((w) => w.total);
    const of = (k: Kind): string => `${f2(pct(seen.work.map((w) => w.by[k]), 95))}/${f2(Math.max(0, ...seen.work.map((w) => w.by[k])))}`;
    const over = totals.filter((t) => t > BUDGET_MS).length;
    const forced = seen.work.reduce((a, w) => a + w.forced, 0);
    const commits = before[i]! < 0 ? 'n/a' : f1((after[i]! - before[i]!) / seconds);
    const sum = (k: Kind | 'total'): number => seen.work.reduce((a, w) => a + (k === 'total' ? w.total : w.by[k]), 0);
    const layoutShare = sum('layout') / Math.max(1e-9, sum('total'));
    const dirty = dirtyShares(thread, seen);
    const line =
      `${scenario} ${s.name}: frames=${seen.frames} interval p50/p95/max=${f1(pct(seen.interval, 50))}/${f1(pct(seen.interval, 95))}/${f1(Math.max(0, ...seen.interval))}ms` +
      ` work p50/p95/max=${f2(pct(totals, 50))}/${f2(pct(totals, 95))}/${f2(Math.max(0, ...totals))}ms over${BUDGET_MS}ms=${over}/${totals.length}` +
      ` p95/max script=${of('script')} style=${of('style')} layout=${of('layout')} paint=${of('paint')} other=${of('other')}` +
      ` forcedLayouts=${forced} (${f1(forced / Math.max(1, seen.frames))}/frame) reactCommits/s=${commits} dom=${nodes[i]}` +
      ` layoutShare=${f2(layoutShare)} dirtyShare p95/max=${f2(pct(dirty, 95))}/${f2(Math.max(0, ...dirty))}`;
    console.log(`[w69-perf] ${line}`);
    console.log(`[w69-perf] ${scenario} ${s.name} top: ${topSelf(profiles[i]!, 12)}`);
    console.log(`[w69-perf] ${scenario} ${s.name} app: ${topSelf(profiles[i]!, 14, true)}`);
    console.log(`[w69-perf] ${scenario} ${s.name} worst: ${worstFrames(thread, seen, 4)}`);
    results.push({ scenario, screen: s.name, layoutShare, dirtyP95: pct(dirty, 95), line });
  });
  return results;
}

/** A loop round `centre`, radius `r`, one step a frame: the operator waving a card about. */
async function wave(page: Page, centre: { x: number; y: number }, r: { x: number; y: number }, steps: number): Promise<void> {
  for (let i = 0; i <= steps; i += 1) {
    const a = (i / steps) * 2 * Math.PI;
    await page.mouse.move(centre.x + r.x * Math.sin(a), centre.y - r.y * (1 - Math.cos(a)) / 2);
    await page.waitForTimeout(16);
  }
}

test(titled('dragging a hand card, a battlefield card and an ability chip never lays the board out again, on either screen'), async ({ browser }) => {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const unhook = hookContexts(browser);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w69-perf');
    unhook();
    // The zones' measures are written from a ResizeObserver (`zone-box.ts`): it must never loop.
    const observerErrors: string[] = [];
    for (const page of [alice.page, bob.page]) {
      page.on('pageerror', (err) => {
        if (/ResizeObserver/.test(err.message)) observerErrors.push(err.message);
      });
      page.on('console', (msg) => {
        if (/ResizeObserver/.test(msg.text())) observerErrors.push(msg.text());
      });
    }
    await bob.page.getByTestId('live-full-control').click();
    await expect(bob.page.getByTestId('live-full-control')).toHaveAttribute('aria-pressed', 'true');
    // Every card size at the table-fit sizes: the speed may not cost a pixel of the layout.
    for (const size of [
      { width: 1280, height: 800 },
      { width: 1366, height: 768 },
      { width: 1024, height: 700 },
      { width: 1920, height: 1080 },
    ]) {
      await resizeWindow(alice.page, size);
      const sizes = await alice.page.evaluate(() => {
        const w = (sel: string): string =>
          Array.from(document.querySelectorAll(sel)).map((e) => e.getBoundingClientRect().width.toFixed(1)).filter((v, i, a) => a.indexOf(v) === i).join(',') || '-';
        return [
          `bf=${w('.seat[data-viewer] [data-zone="battlefield"] li.board-card')}`,
          `theirBf=${w('.seat:not([data-viewer]) [data-zone="battlefield"] li.board-card')}`,
          `hand=${w('[data-zone="hand"][data-owner="you"] li.board-card')}`,
          `backs=${w('[data-zone="hand"][data-owner="them"] .card-back')}`,
          `piles=${w('.zone--graveyard li.board-card, .zone--exile li.board-card')}`,
          `lanes=${w('.seat[data-viewer] .zone__row')}`,
        ].join(' ');
      });
      console.log(`[w69-perf] sizes ${size.width}x${size.height}: ${sizes}`);
    }
    await resizeWindow(alice.page, { width: 1600, height: 900 });
    await resizeWindow(bob.page, { width: 1600, height: 900 });
    const browserCdp = await browser.newBrowserCDPSession();
    const screens: Screen[] = [
      { name: 'alice', page: alice.page, cdp: await alice.page.context().newCDPSession(alice.page) },
      { name: 'bob', page: bob.page, cdp: await bob.page.context().newCDPSession(bob.page) },
    ];
    for (const s of screens) {
      await s.cdp.send('Profiler.enable');
      await tickEveryFrame(s.page);
    }
    await expect.poll(async () => offeredNamed(alice.page, 'Eternal Witness'), { timeout: 60_000, message: 'alice is offered Eternal Witness' }).not.toBeUndefined();
    await alice.page.waitForTimeout(1500);
    const results: Result[] = [];

    results.push(...(await measure(browserCdp, screens, 'idle', () => alice.page.waitForTimeout(1500))));

    // (a) A hand card lifted and carried round the board, then back over the hand and let go: nothing is cast.
    const bears = alice.page.locator('[data-zone="hand"][data-owner="you"] [data-board-card]').filter({ hasText: 'Grizzly Bears' }).first();
    const hb = (await bears.boundingBox())!;
    const board = (await alice.page.locator('.board').first().boundingBox())!;
    const boardMid = { x: board.x + board.width / 2, y: board.y + board.height * 0.55 };
    results.push(
      ...(await measure(browserCdp, screens, 'hand', async () => {
        await alice.page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
        await alice.page.mouse.down();
        await alice.page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 - 12, { steps: 3 });
        await alice.page.mouse.move(boardMid.x, boardMid.y, { steps: 20 });
        await wave(alice.page, boardMid, { x: board.width * 0.3, y: board.height * 0.4 }, 120);
        await alice.page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2, { steps: 20 });
        await alice.page.mouse.up();
      })),
    );
    await alice.page.waitForTimeout(800);

    // (b) One of her battlefield cards dragged round her battlefield and put back where it was.
    const forest = alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card[data-card-id]').first();
    const fb = (await forest.boundingBox())!;
    const home = { x: fb.x + fb.width / 2, y: fb.y + fb.height / 2 };
    const own = (await alice.page.locator('.seat[data-viewer] [data-zone="battlefield"]').first().boundingBox())!;
    const ownMid = { x: own.x + own.width / 2, y: own.y + own.height * 0.6 };
    results.push(
      ...(await measure(browserCdp, screens, 'arrange', async () => {
        await alice.page.mouse.move(home.x, home.y);
        await alice.page.mouse.down();
        await alice.page.mouse.move(home.x + 10, home.y + 10, { steps: 3 });
        await alice.page.mouse.move(ownMid.x, ownMid.y, { steps: 20 });
        await wave(alice.page, ownMid, { x: own.width * 0.3, y: own.height * 0.4 }, 120);
        await alice.page.mouse.move(home.x, home.y, { steps: 20 });
        await alice.page.mouse.up();
      })),
    );
    await alice.page.waitForTimeout(800);

    // (c) Eternal Witness cast; its trigger's chip dragged round the board.
    const chip = (page: Page) => page.locator('[data-placed-spell]:has([data-ability-chip])');
    const witness = await offeredNamed(alice.page, 'Eternal Witness');
    if (witness !== undefined) {
      await clickHandCard(alice.page, witness);
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline && (await chip(alice.page).count()) === 0) {
        await pressPaymentAuto(alice.page);
        await answerPrompt(alice.page);
        const bobOk = bob.page.locator('[data-testid="live-decision-ok"]:enabled');
        if ((await bobOk.count()) > 0 && (await chip(bob.page).count()) === 0) await bobOk.click().catch(() => undefined);
        await alice.page.waitForTimeout(150);
      }
    }
    if ((await chip(alice.page).count()) > 0 && (await chip(bob.page).count()) > 0) {
      await alice.page.waitForTimeout(1500);
      const c = (await chip(alice.page).boundingBox())!;
      const from = { x: c.x + c.width / 2, y: c.y + c.height / 2 };
      results.push(
        ...(await measure(browserCdp, screens, 'chip', async () => {
          await alice.page.mouse.move(from.x, from.y);
          await alice.page.mouse.down();
          await alice.page.mouse.move(from.x - 10, from.y + 10, { steps: 3 });
          await alice.page.mouse.move(boardMid.x, boardMid.y, { steps: 20 });
          await wave(alice.page, boardMid, { x: board.width * 0.3, y: board.height * 0.4 }, 120);
          await alice.page.mouse.up();
        })),
      );
    } else console.log('[w69-perf] chip: never reached (no chip on both screens) — scenario not measured');

    console.log(`[w69-perf] summary layout share / dirty p95: ${results.map((r) => `${r.scenario}/${r.screen}=${f2(r.layoutShare)}/${f2(r.dirtyP95)}`).join(' ')}`);
    const drags = results.filter((r) => r.scenario !== 'idle');
    expect(observerErrors, 'no ResizeObserver loop on either screen').toEqual([]);
    expect(drags.length, 'the hand and arrange drags were measured').toBeGreaterThanOrEqual(4);
    for (const r of drags) {
      expect(r.layoutShare, `${r.scenario} on ${r.screen}'s screen: layout's share of the drag's main-thread work (${r.line})`).toBeLessThanOrEqual(LAYOUT_SHARE);
      expect(r.dirtyP95, `${r.scenario} on ${r.screen}'s screen: the share of the page one frame's layouts dirty, p95 (${r.line})`).toBeLessThanOrEqual(DIRTY_SHARE_P95);
    }
  } finally {
    unhook();
    await stack.stop();
  }
});

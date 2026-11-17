/**
 * Wave 121 lane D (frame rate). The operator's own screen ran 79 fps (p95 36 ms, worst 222 ms, 35 bad
 * stretches) on a 12-vs-8-permanent board with five to nine flying creatures animating at once
 * (`fly-figure`/`fly-tilt`/`fly-shadow`, `play/card.css`), while the SAME board ran 151 fps on the
 * other seat's screen the whole match; the game-over screen then sat at 25 fps, idle, with the same
 * flyers still in `animTop`. `frame-watch.ts`'s own `work` telemetry put our JS at 1–3 % of the
 * window on both reports — the rest is the browser's style/layout/paint/raster, which this spec
 * traces directly (`e2e/combat-perf.spec.ts`'s compositor-and-raster method, `docs/spikes/browser-
 * fps.md`'s "flyers at idle" cost, left ASSUMED there as a headless artefact).
 *
 * `scenarios/w121d-frame-rate.state`: alice holds 12 permanents (five flying) and four cards; bob
 * holds eight lands and nothing to block with, so one unblocked attack both runs COMBAT_DAMAGE with
 * every flyer moving and is lethal (24 power into 20 life) — the SAME board sits behind the result
 * screen for the idle-after-game-over half.
 *
 * `budget` traces the attack's COMBAT_DAMAGE window and the settled result screen. It logs the
 * combat numbers (not gated: a CI runner's software compositor pays a cost this product code does
 * not cause, same as `browser-fps.md`'s own idle finding) and HARD GATES the idle half on one fact
 * that is never environment-dependent: a truly idle screen runs no animation. `document.getAnimations()`
 * must be empty once the result screen has sat still for `IDLE_SETTLE_MS`.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one the test SKIPs.
 * Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Browser, type CDPSession, type Page } from '@playwright/test';

import { enabledOk, makeTitled, resizeWindow, says } from './play/board.ts';
import { passToDeclareAttackers } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { CATEGORIES, f1, f2, framesOf, pct, spansOf, type Kind, type Span, type TraceEvent } from './play/perf-trace.ts';
import { turnFastModeOff } from './play/prefs.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (line: string): void => console.log(`[w121d] ${line}`);

/** Compositor, raster and GPU on top of the main-thread categories (`e2e/combat-perf.spec.ts`'s own set). */
const TRACE = [...CATEGORIES, 'viz', 'benchmark', 'disabled-by-default-gpu.service', 'disabled-by-default-viz.gpu_composite_time'];

/** How long the result screen must sit before "idle" means anything: past its own entrance motion. */
const IDLE_SETTLE_MS = 2_000;
/** How long the idle window is measured, once settled. */
const IDLE_WINDOW_MS = 4_000;

interface Threads {
  names: Map<string, string>;
  procs: Map<number, string>;
}

function threadsOf(events: TraceEvent[]): Threads {
  const names = new Map<string, string>();
  const procs = new Map<number, string>();
  for (const e of events) {
    if (e.ph !== 'M') continue;
    const n = (e.args as { name?: string } | undefined)?.name ?? '';
    if (e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, n);
    if (e.name === 'process_name') procs.set(e.pid, n);
  }
  return { names, procs };
}

/** Self time per event name of `roots` inside [from, to), ms. */
function selfByName(roots: Span[], from: number, to: number): { busy: number; by: Map<string, number> } {
  const by = new Map<string, number>();
  let busy = 0;
  const clip = (s: Span): number => Math.max(0, Math.min(s.end, to) - Math.max(s.ts, from));
  const walk = (s: Span): void => {
    let self = clip(s);
    for (const c of s.children) self -= clip(c);
    by.set(s.name, (by.get(s.name) ?? 0) + Math.max(0, self) / 1000);
    for (const c of s.children) if (c.end > from && c.ts < to) walk(c);
  };
  for (const r of roots)
    if (r.end > from && r.ts < to) {
      busy += clip(r) / 1000;
      walk(r);
    }
  return { busy, by };
}

const topOf = (by: Map<string, number>, n: number): string =>
  [...by]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, ms]) => `${k}=${f1(ms)}`)
    .join(',');

/** Busy ms of every thread in `pids` whose name matches `pattern` (never the renderer's own main thread), inside [from, to). */
function otherThreadBusy(events: TraceEvent[], threads: Threads, pids: number[], pattern: RegExp, mainTid: number, from: number, to: number): { busy: number; top: string } {
  const byThread = new Map<string, TraceEvent[]>();
  for (const e of events) {
    if (!pids.includes(e.pid) || e.tid === mainTid || e.ph === 'M' || e.ph === 'I' || e.ph === 'i') continue;
    const name = threads.names.get(`${e.pid}:${e.tid}`) ?? '';
    if (!pattern.test(name)) continue;
    const k = `${e.pid}:${e.tid}`;
    if (!byThread.has(k)) byThread.set(k, []);
    byThread.get(k)!.push(e);
  }
  let busy = 0;
  const by = new Map<string, number>();
  for (const evs of byThread.values()) {
    const { busy: b, by: names } = selfByName(spansOf(evs), from, to);
    busy += b;
    for (const [k, v] of names) by.set(k, (by.get(k) ?? 0) + v);
  }
  return { busy, top: topOf(by, 4) };
}

/** The GPU WebGL names back, the same probe `frame-watch.ts`'s `gpuRenderer` runs in the product. */
async function gpuOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    if (gl === null) return 'no webgl';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return `${String(gl.getParameter(ext === null ? gl.RENDERER : ext.UNMASKED_RENDERER_WEBGL))} dpr=${window.devicePixelRatio}`;
  });
}

/** Every running animation, by name, most first — `frame-watch.ts`'s own `animationTop`, read back here for the trace's own evidence. */
async function animsOf(page: Page): Promise<{ n: number; top: string }> {
  return page.evaluate(() => {
    const anims = document.getAnimations().filter((a) => a.playState === 'running');
    const counts = new Map<string, number>();
    for (const a of anims) {
      const named = a as Animation & { animationName?: string };
      const label = named.animationName ?? 'js';
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return {
      n: anims.length,
      top: [...counts]
        .sort((x, y) => y[1] - x[1])
        .map(([k, v]) => `${k}x${v}`)
        .join(','),
    };
  });
}

interface Report {
  label: string;
  mainMs: number;
  rasterMs: number;
  compositorMs: number;
  gpuMs: number;
  secs: number;
  anims: { n: number; top: string };
}

/** Traces `page` through `run`: main-thread work, raster-worker and compositor-thread busy time, and the animations running when it ends. */
async function trace(browserCdp: CDPSession, page: Page, threadsHint: Threads | null, label: string, run: () => Promise<void>): Promise<{ report: Report; threads: Threads; events: TraceEvent[] }> {
  const events: TraceEvent[] = [];
  const onData = (p: { value: object[] }): void => {
    events.push(...(p.value as TraceEvent[]));
  };
  browserCdp.on('Tracing.dataCollected', onData);
  const done = new Promise<void>((r) => browserCdp.once('Tracing.tracingComplete', () => r()));
  await browserCdp.send('Tracing.start', { traceConfig: { includedCategories: TRACE, recordMode: 'recordAsMuchAsPossible' }, transferMode: 'ReportEvents' });
  await page.evaluate((m) => console.timeStamp(m), `w121d:${label}:start`);
  const t0 = Date.now();
  await run();
  const secs = (Date.now() - t0) / 1000;
  await page.evaluate((m) => console.timeStamp(m), `w121d:${label}:end`);
  const anims = await animsOf(page);
  await browserCdp.send('Tracing.end');
  await done;
  browserCdp.off('Tracing.dataCollected', onData);

  const threads = threadsHint ?? threadsOf(events);
  const mark = (suffix: string): TraceEvent | undefined => events.find((e) => e.name === 'TimeStamp' && e.args?.data?.message === `w121d:${label}:${suffix}`);
  const start = mark('start');
  const end = mark('end');
  if (start === undefined || end === undefined) throw new Error(`${label}: no timestamp marks in the trace (${events.length} events)`);
  const main = events.filter((e) => e.pid === start.pid && e.tid === start.tid);
  const seen = framesOf(main, start.ts, end.ts);
  const totals = seen.work.map((w) => w.total);
  const of = (k: Kind): string => `${f2(pct(seen.work.map((w) => w.by[k]), 95))}/${f2(Math.max(0, ...seen.work.map((w) => w.by[k])))}`;
  const gpuPids = [...threads.procs].filter(([, n]) => /gpu/i.test(n)).map(([pid]) => pid);
  const raster = otherThreadBusy(events, threads, [start.pid], /CompositorTileWorker|Raster/i, start.tid, start.ts, end.ts);
  const compositor = otherThreadBusy(events, threads, [start.pid], /^Compositor$/i, start.tid, start.ts, end.ts);
  const gpu = otherThreadBusy(events, threads, gpuPids, /./, -1, start.ts, end.ts);
  const mainBusy = totals.reduce((a, b) => a + b, 0);
  log(
    `${label}: ${secs.toFixed(1)}s rafFrames=${seen.frames} work p50/p95/max=${f2(pct(totals, 50))}/${f2(pct(totals, 95))}/${f2(Math.max(0, ...totals))}ms` +
      ` p95/max script=${of('script')} style=${of('style')} layout=${of('layout')} paint=${of('paint')}` +
      ` main=${f1(mainBusy / secs)}ms/s raster=${f1(raster.busy / secs)}ms/s[${raster.top}] compositor=${f1(compositor.busy / secs)}ms/s gpu=${f1(gpu.busy / secs)}ms/s[${gpu.top}]` +
      ` anims=${anims.n}[${anims.top}]`,
  );
  return {
    report: { label, mainMs: mainBusy / secs, rasterMs: raster.busy / secs, compositorMs: compositor.busy / secs, gpuMs: gpu.busy / secs, secs, anims },
    threads,
    events,
  };
}

interface Table {
  browser: Browser;
  alice: Page;
  bob: Page;
  browserCdp: CDPSession;
}

/** Scenario up, both screens real-paced and sized, the board settled before anything is measured. */
async function sit(browser: Browser, run: (t: Table) => Promise<void>): Promise<void> {
  test.skip(!forge.ok, forge.ok ? '' : forge.reason);
  if (!forge.ok) return;
  test.setTimeout(5 * 60_000);
  const stack = await startPlayStack(forge);
  try {
    const { alice, bob } = await startScenarioMatch(browser, stack, 'w121d-frame-rate');
    await turnFastModeOff(alice.page, stack, 0);
    await turnFastModeOff(bob.page, stack, 1);
    await resizeWindow(alice.page, { width: 1863, height: 1324 }); // the operator's own window
    await resizeWindow(bob.page, { width: 1600, height: 900 });
    log(`alice gpu: ${await gpuOf(alice.page)}`);
    const browserCdp = await browser.newBrowserCDPSession();
    await alice.page.context().newCDPSession(alice.page).then((cdp) => cdp.send('Profiler.enable').catch(() => undefined));
    await run({ browser, alice: alice.page, bob: bob.page, browserCdp });
  } finally {
    await stack.stop();
  }
}

/**
 * Alice declares attack with everyone (12 permanents, 5 flying). Returns with combat still LIVE —
 * attackers marked `[data-attacking]`, nobody has passed Declare Attackers Step yet — so the flyers
 * (and the attacking ring their comment in `card.css` names) are still animating well before the
 * lethal blow that ends the game: sampling here, not after the result screen shows, is the only way
 * to read "animating during combat" apart from "never stops once the game is over".
 */
async function declareAttack(t: Table): Promise<void> {
  await passToDeclareAttackers(t.alice);
  await t.alice.getByTestId('live-attack-all').first().click();
  await t.alice.locator('[data-testid="live-decision-ok"]:enabled').first().click();
  // All 9 of alice's creatures attack (5 flying — the two Serra Angel, the three Narcomoeba — plus
  // the two Grizzly Bears and two Hill Giant grounded); only the flyers are this spec's own concern.
  await expect(t.alice.locator('li.board-card[data-attacking]')).toHaveCount(9, { timeout: 10_000 });
}

/** From a live Declare Attackers Step to the result screen: bob has nothing to block with, so every stop left is a priority pass, on either seat. */
async function passToGameOver(t: Table): Promise<void> {
  await expect
    .poll(
      async () => {
        if ((await t.alice.getByTestId('game-result').count()) > 0) return true;
        for (const page of [t.alice, t.bob]) if ((await enabledOk(page).count()) > 0) await enabledOk(page).click({ timeout: 1_000 }).catch(() => undefined);
        return false;
      },
      { timeout: 60_000, intervals: [100], message: `combat resolves to the result screen — alice says "${await says(t.alice)}"` },
    )
    .toBe(true);
}

test(titled('AF638 budget: 12-vs-8 combat damage, five flyers, then the result screen idle'), async ({ browser }) => {
  await sit(browser, async (t) => {
    const { report: combat } = await trace(t.browserCdp, t.alice, null, 'combat', async () => {
      await declareAttack(t);
      // Held here: nobody has passed priority yet, so nothing moves the game toward the lethal blow —
      // a clean window to sample "mid-combat", not racing the pass loop below.
      await t.alice.waitForTimeout(1_000);
    });
    expect(combat.anims.n, 'five Serra Angel/Narcomoeba flyers are still animating mid-combat, before the lethal blow').toBeGreaterThanOrEqual(5);

    await passToGameOver(t);
    await t.alice.waitForTimeout(IDLE_SETTLE_MS);
    const { report: idle } = await trace(t.browserCdp, t.alice, null, 'idle-after-gameover', () => t.alice.waitForTimeout(IDLE_WINDOW_MS));
    // Never gated on milliseconds (a CI runner draws in software — `docs/spikes/browser-fps.md`); this
    // is the one fact a truly idle screen can never fail: it runs no animation.
    expect(idle.anims.n, `the result screen, settled ${IDLE_SETTLE_MS} ms, runs no animation (saw [${idle.anims.top}])`).toBe(0);
  });
});

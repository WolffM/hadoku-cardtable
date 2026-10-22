/**
 * The operator, 2026-10-22: "i'm still noticing some performance lag in combat. when cards start moving
 * out to attack, i notice framerate drops."
 *
 * A full attack on a real match (`combat-perf.state`), on both screens: alice declares six attackers by
 * hand (they turn), bob blocks two, and the other four charge his avatar — the ram (`ram.ts`), the crash
 * and the table shake (`crash.ts`). A Chrome trace with the compositor, raster and GPU categories and a
 * CPU profile record both renderers through:
 *
 *   idle     nobody moves: the floor
 *   declare  alice clicks her six creatures and Done: each one turns, on both screens
 *   ram      bob's Done blocking through every copy's way home
 *
 * Each window prints `[combat-perf]` lines per screen: the page's own frame intervals (a rAF on every
 * frame, the clock frame-watch.ts reads) split by what was moving (a ram copy out, the table shaking);
 * the compositor's drawn frames; main-thread work per frame by kind; every thread's busy time (renderer
 * main, compositor, raster workers, GPU process) and its heaviest events; the slowest frames with what
 * each thread did in them; and the top self-time functions.
 *
 * Three variants, one match each, so a cost can be put on a suspect: `as-is`; `no-shake` (the board's
 * `composite: 'add'` shake runs for 0 ms); `flat-copies` (every ram copy without shadow, outline or
 * filter). Nothing is asserted on milliseconds — a CI runner draws in software; the lines are the
 * evidence.
 *
 * Needs a Forge build (`CARDTABLE_FORGE_JAR` + `CARDTABLE_FORGE_RES`); without one the test SKIPS and its
 * title says why. Serves the prebuilt `apps/ui/dist` — rebuild before running.
 */
import { expect, test, type Browser, type CDPSession, type Page } from '@playwright/test';

import { enabledOk, makeTitled, ownNamed, resizeWindow, says } from './play/board.ts';
import { assignBlock, attackingCards, passToDeclareAttackers } from './play/combat.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
import { CATEGORIES, f1, f2, framesOf, pct, spansOf, tickEveryFrame, topSelf, worstFrames, type CpuProfile, type Kind, type Span, type TraceEvent } from './play/perf-trace.ts';
import { turnFastModeOff } from './play/prefs.ts';
import { startScenarioMatch } from './play/scenario.ts';

const forge = forgeAvailability();
const titled = makeTitled(forge);
const log = (line: string): void => console.log(`[combat-perf] ${line}`);

/** Compositor, raster and GPU on top of the main-thread categories: the main thread may be idle while raster is not. */
const TRACE = [...CATEGORIES, 'viz', 'benchmark', 'disabled-by-default-devtools.timeline.frame', 'disabled-by-default-gpu.service', 'disabled-by-default-viz.gpu_composite_time'];

type Variant = 'as-is' | 'no-shake' | 'flat-copies';

interface Screen {
  name: 'alice' | 'bob';
  page: Page;
  cdp: CDPSession;
}

/** One page frame, as the page's own rAF saw it, with what was moving on it. */
interface PageFrame {
  t: number;
  dt: number;
  ram: number;
  shake: boolean;
  crash: boolean;
}

/**
 * A rAF on every frame recording its interval and what was moving, and a `console.timeStamp` when the
 * first ram copy appears (`cperf:ram-start`) and when the last is gone (`cperf:ram-end`): the trace's
 * motion window.
 */
function installRecorder(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = window as unknown as { __cperf?: { frames: PageFrame[]; on: boolean; ramStart?: number; ramEnd?: number } };
    if (w.__cperf !== undefined) return;
    const rec = { frames: [] as PageFrame[], on: false, ramStart: undefined as number | undefined, ramEnd: undefined as number | undefined };
    w.__cperf = rec;
    let last = performance.now();
    const tick = (t: number): void => {
      const ram = document.querySelectorAll('.board-ram').length;
      if (ram > 0 && rec.ramStart === undefined) {
        rec.ramStart = t;
        console.timeStamp('cperf:ram-start');
      }
      if (ram === 0 && rec.ramStart !== undefined && rec.ramEnd === undefined) {
        rec.ramEnd = t;
        console.timeStamp('cperf:ram-end');
      }
      if (rec.on) rec.frames.push({ t, dt: t - last, ram, shake: document.querySelector('[data-shaking]') !== null, crash: document.querySelector('.effect-crash') !== null });
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function pageFrames(page: Page, on: boolean): Promise<PageFrame[]> {
  return page.evaluate((flag) => {
    const rec = (window as unknown as { __cperf: { frames: PageFrame[]; on: boolean } }).__cperf;
    const out = rec.frames;
    rec.frames = [];
    rec.on = flag;
    return out;
  }, on);
}

const ramDone = (page: Page): Promise<boolean> => page.evaluate(() => (window as unknown as { __cperf: { ramEnd?: number } }).__cperf.ramEnd !== undefined);

function intervals(label: string, dts: number[]): string {
  if (dts.length === 0) return `${label}: none`;
  const total = dts.reduce((a, b) => a + b, 0);
  return (
    `${label}: n=${dts.length} fps=${f1((1000 * dts.length) / total)} p50/p95/p99/max=${f1(pct(dts, 50))}/${f1(pct(dts, 95))}/${f1(pct(dts, 99))}/${f1(Math.max(...dts))}ms` +
    ` >20ms=${dts.filter((d) => d > 20).length} >33ms=${dts.filter((d) => d > 33.4).length} >50ms=${dts.filter((d) => d > 50).length}`
  );
}

/** The page's own frame intervals, split by what was moving. */
function pageLines(window: string, screen: string, frames: PageFrame[]): void {
  const dt = (pick: (f: PageFrame) => boolean): number[] => frames.filter(pick).map((f) => f.dt);
  log(`${window} ${screen} page ${intervals('all', dt(() => true))}`);
  if (frames.some((f) => f.ram > 0)) {
    log(`${window} ${screen} page ${intervals('ram-out', dt((f) => f.ram > 0))}`);
    log(`${window} ${screen} page ${intervals('ram-out+shake', dt((f) => f.ram > 0 && f.shake))}`);
    log(`${window} ${screen} page ${intervals('ram-out-no-shake', dt((f) => f.ram > 0 && !f.shake))}`);
    log(`${window} ${screen} page ${intervals('crash-fx', dt((f) => f.crash))}`);
    log(`${window} ${screen} page ${intervals('nothing-moving', dt((f) => f.ram === 0 && !f.shake && !f.crash))}`);
    // The whole run, 100 ms buckets: the shape of the drop against what was out.
    const t0 = frames[0]!.t;
    const buckets = new Map<number, PageFrame[]>();
    for (const f of frames) {
      const k = Math.floor((f.t - t0) / 100);
      buckets.set(k, [...(buckets.get(k) ?? []), f]);
    }
    log(
      `${window} ${screen} page timeline(100ms: maxDt/ramCopies/shake): ${[...buckets]
        .map(([k, fs]) => `${k}:${f1(Math.max(...fs.map((f) => f.dt)))}/${Math.max(...fs.map((f) => f.ram))}${fs.some((f) => f.shake) ? 'S' : ''}${fs.some((f) => f.crash) ? 'C' : ''}`)
        .join(' ')}`,
    );
  }
}

interface Threads {
  /** `pid:tid` → thread name. */
  names: Map<string, string>;
  /** pid → process name. */
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

/** Every thread of `pids` with work in the window: busy ms per second of window, and its heaviest events. */
function threadLines(window: string, screen: string, events: TraceEvent[], threads: Threads, pids: number[], from: number, to: number): Map<string, Span[]> {
  const byThread = new Map<string, TraceEvent[]>();
  for (const e of events) {
    if (!pids.includes(e.pid) || e.ph === 'M' || e.ph === 'I' || e.ph === 'i') continue;
    const k = `${e.pid}:${e.tid}`;
    if (!byThread.has(k)) byThread.set(k, []);
    byThread.get(k)!.push(e);
  }
  const rootsBy = new Map<string, Span[]>();
  const secs = (to - from) / 1e6;
  const rows: { line: string; busy: number }[] = [];
  for (const [k, evs] of byThread) {
    const roots = spansOf(evs);
    rootsBy.set(k, roots);
    const { busy, by } = selfByName(roots, from, to);
    if (busy < 1) continue;
    const pid = Number(k.split(':')[0]);
    rows.push({ busy, line: `${threads.procs.get(pid) ?? pid}/${threads.names.get(k) ?? k} busy=${f1(busy / secs)}ms/s (${f1((busy / secs) / 10)}%) top: ${topOf(by, 6)}` });
  }
  rows.sort((a, b) => b.busy - a.busy);
  log(`${window} ${screen} threads over ${f2(secs)}s: ${rows.map((r) => r.line).join(' || ')}`);
  return rootsBy;
}

/** The compositor's frames in the window: what the screen was actually shown. */
function compositorLines(window: string, screen: string, events: TraceEvent[], pid: number, from: number, to: number): void {
  const counts = new Map<string, number>();
  const draws: number[] = [];
  for (const e of events) {
    if (e.pid !== pid || e.ts < from || e.ts >= to) continue;
    if (!['BeginFrame', 'DrawFrame', 'DroppedFrame', 'ActivateLayerTree', 'BeginMainThreadFrame', 'Commit', 'NeedsBeginFrameChanged', 'PipelineReporter', 'Graphics.Pipeline'].includes(e.name)) continue;
    if (e.ph === 'e' || e.ph === 'E') continue;
    counts.set(`${e.name}/${e.ph}`, (counts.get(`${e.name}/${e.ph}`) ?? 0) + 1);
    if (e.name === 'DrawFrame') draws.push(e.ts);
  }
  const uniq = [...new Set(draws)].sort((a, b) => a - b);
  const gaps = uniq.slice(1).map((t, i) => (t - uniq[i]!) / 1000);
  log(`${window} ${screen} compositor ${[...counts].map(([k, n]) => `${k}=${n}`).join(' ')} ${intervals('drawFrame', gaps)}`);
}

async function measure(browserCdp: CDPSession, screens: Screen[], window: string, gesture: () => Promise<void>): Promise<void> {
  const events: TraceEvent[] = [];
  const onData = (p: { value: object[] }): void => {
    events.push(...(p.value as TraceEvent[]));
  };
  browserCdp.on('Tracing.dataCollected', onData);
  const done = new Promise<void>((r) => browserCdp.once('Tracing.tracingComplete', () => r()));
  await browserCdp.send('Tracing.start', { traceConfig: { includedCategories: TRACE, recordMode: 'recordAsMuchAsPossible' }, transferMode: 'ReportEvents' });
  for (const s of screens) {
    await s.cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await s.cdp.send('Profiler.start');
    await pageFrames(s.page, true);
    await s.page.evaluate((m) => console.timeStamp(m), `cperf:${s.name}:start`);
  }
  await gesture();
  const frames: PageFrame[][] = [];
  for (const s of screens) {
    await s.page.evaluate((m) => console.timeStamp(m), `cperf:${s.name}:end`);
    frames.push(await pageFrames(s.page, false));
  }
  const profiles = await Promise.all(screens.map(async (s) => ((await s.cdp.send('Profiler.stop')) as { profile: CpuProfile }).profile));
  await browserCdp.send('Tracing.end');
  await done;
  browserCdp.off('Tracing.dataCollected', onData);

  const threads = threadsOf(events);
  const gpu = [...threads.procs].filter(([, n]) => /gpu/i.test(n)).map(([pid]) => pid);
  log(`${window} trace: ${events.length} events, processes ${[...threads.procs].map(([p, n]) => `${p}=${n}`).join(' ')}`);
  screens.forEach((s, i) => {
    pageLines(window, s.name, frames[i]!);
    const mark = (suffix: string): TraceEvent | undefined => events.find((e) => e.name === 'TimeStamp' && e.args?.data?.message === `cperf:${s.name}:${suffix}`);
    const start = mark('start');
    const end = mark('end');
    if (start === undefined || end === undefined) {
      log(`${window} ${s.name}: no timestamp marks in the trace`);
      return;
    }
    const main = events.filter((e) => e.pid === start.pid && e.tid === start.tid);
    // The motion window: the first ram copy out to the last one gone, when this window has one.
    const ramStart = main.find((e) => e.name === 'TimeStamp' && e.args?.data?.message === 'cperf:ram-start' && e.ts >= start.ts && e.ts <= end.ts);
    const ramEnd = main.find((e) => e.name === 'TimeStamp' && e.args?.data?.message === 'cperf:ram-end' && e.ts >= start.ts && e.ts <= end.ts);
    const spans: [string, number, number][] = [[window, start.ts, end.ts]];
    if (ramStart !== undefined) spans.push([`${window}:motion`, ramStart.ts, ramEnd?.ts ?? end.ts]);
    for (const [name, from, to] of spans) {
      const seen = framesOf(main, from, to);
      const totals = seen.work.map((w) => w.total);
      const of = (k: Kind): string => `${f2(pct(seen.work.map((w) => w.by[k]), 95))}/${f2(Math.max(0, ...seen.work.map((w) => w.by[k])))}`;
      log(
        `${name} ${s.name} main: rafFrames=${seen.frames} ${intervals('rafInterval', seen.interval)} work p50/p95/max=${f2(pct(totals, 50))}/${f2(pct(totals, 95))}/${f2(Math.max(0, ...totals))}ms` +
          ` p95/max script=${of('script')} style=${of('style')} layout=${of('layout')} paint=${of('paint')} other=${of('other')}`,
      );
      compositorLines(name, s.name, events, start.pid, from, to);
      const roots = threadLines(name, s.name, events, threads, [start.pid, ...gpu], from, to);
      log(`${name} ${s.name} worst main: ${worstFrames(main, seen, 4)}`);
      // The slowest rAF intervals: what every thread did in each.
      const slow = seen.interval
        .map((d, j) => ({ d, j }))
        .sort((a, b) => b.d - a.d)
        .slice(0, 4);
      for (const { d, j } of slow) {
        const a = seen.starts[j]!;
        const b = seen.starts[j + 1]!;
        const per = [...roots]
          .map(([k, r]) => ({ k, ...selfByName(r, a, b) }))
          .filter((x) => x.busy >= 2)
          .sort((x, y) => y.busy - x.busy)
          .map((x) => `${threads.names.get(x.k) ?? x.k}=${f1(x.busy)}[${topOf(x.by, 3)}]`);
        log(`${name} ${s.name} slow frame +${f1((a - from) / 1000)}ms ${f1(d)}ms: ${per.join(' ')}`);
      }
    }
    log(`${window} ${s.name} top: ${topSelf(profiles[i]!, 12)}`);
    log(`${window} ${s.name} app: ${topSelf(profiles[i]!, 12, true)}`);
  });
}

/** Turn a suspect off on `page`, so its share of the cost shows against `as-is`. */
async function applyVariant(page: Page, variant: Variant): Promise<void> {
  if (variant === 'no-shake')
    await page.evaluate(() => {
      const original = Element.prototype.animate;
      Element.prototype.animate = function (this: Element, frames: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
        const add = typeof options === 'object' && options.composite === 'add';
        return original.call(this, frames, add ? { ...options, duration: 0 } : options);
      };
    });
  if (variant === 'flat-copies') await page.addStyleTag({ content: '.board-ram, .board-ram * { box-shadow: none !important; outline: none !important; filter: none !important; }' });
}

async function gpuOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    if (gl === null) return 'no webgl';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return `${String(gl.getParameter(ext === null ? gl.RENDERER : ext.UNMASKED_RENDERER_WEBGL))} dpr=${window.devicePixelRatio}`;
  });
}

async function attack(browser: Browser, jar: Extract<ReturnType<typeof forgeAvailability>, { ok: true }>, variant: Variant): Promise<void> {
  const stack = await startPlayStack(jar);
  let seated: Awaited<ReturnType<typeof startScenarioMatch>> | null = null;
  try {
    seated = await startScenarioMatch(browser, stack, 'combat-perf');
    const { alice, bob } = seated;
    await turnFastModeOff(alice.page, stack, 0);
    await turnFastModeOff(bob.page, stack, 1);
    for (const p of [alice.page, bob.page]) {
      await resizeWindow(p, { width: 1920, height: 1080 });
      await applyVariant(p, variant);
      await installRecorder(p);
      await tickEveryFrame(p);
    }
    log(`${variant} gpu: ${await gpuOf(alice.page)}`);
    const browserCdp = await browser.newBrowserCDPSession();
    const screens: Screen[] = [];
    for (const [name, page] of [['alice', alice.page], ['bob', bob.page]] as const) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Profiler.enable');
      screens.push({ name, page, cdp });
    }

    await passToDeclareAttackers(alice.page);
    const creatures = alice.page.locator('.seat[data-viewer] [data-zone="battlefield"] li.board-card[data-selectable]');
    await expect(creatures, 'every creature is offered to attack').toHaveCount(6, { timeout: 10_000 });
    await alice.page.waitForTimeout(1000);
    await measure(browserCdp, screens, `${variant}/idle`, () => alice.page.waitForTimeout(2000));

    await measure(browserCdp, screens, `${variant}/declare`, async () => {
      for (const id of await creatures.evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-board-card'))))) {
        const card = alice.page.locator(`[data-board-card="${id}"]`);
        const box = (await card.boundingBox())!;
        await alice.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await expect(card, `Forge declared ${id} attacking`).toHaveAttribute('data-attacking', 'true', { timeout: 10_000 });
      }
      await alice.page.locator('[data-testid="live-decision-ok"]:enabled').click();
      await alice.page.waitForTimeout(1200);
    });

    // bob's block window: past alice's own priority at Declare Attackers, if she keeps one.
    await expect
      .poll(
        async () => {
          if (/select creatures to block/i.test(await says(bob.page))) return 'open';
          if ((await enabledOk(alice.page).count()) > 0) await enabledOk(alice.page).click().catch(() => undefined);
          return await says(bob.page);
        },
        { timeout: 60_000, intervals: [200], message: "bob's block window opens" },
      )
      .toBe('open');
    const attacker = async (name: string): Promise<number> => {
      const ids = await attackingCards(bob.page).evaluateAll((els, want) => els.filter((e) => e.querySelector('.card__name')?.textContent?.trim() === want).map((e) => Number(e.getAttribute('data-board-card'))), name);
      expect(ids.length, `alice's ${name} attacks`).toBeGreaterThan(0);
      return ids[0]!;
    };
    await assignBlock(bob.page, (await ownNamed(bob.page, 'Runeclaw Bear'))[0]!, await attacker('Grizzly Bears'));
    await assignBlock(bob.page, (await ownNamed(bob.page, 'Balduvian Bears'))[0]!, await attacker('Hill Giant'));
    await expect(bob.page.locator('li.board-card[data-blocking]'), 'both bears block').toHaveCount(2, { timeout: 10_000 });
    await bob.page.waitForTimeout(800);

    await measure(browserCdp, screens, `${variant}/ram`, async () => {
      await enabledOk(bob.page).click(); // Done blocking.
      await expect
        .poll(
          async () => {
            const ended = await Promise.all([alice.page, bob.page].map(ramDone));
            if (ended.every(Boolean)) return true;
            const out = await Promise.all([alice.page, bob.page].map((p) => p.evaluate(() => (window as unknown as { __cperf: { ramStart?: number } }).__cperf.ramStart !== undefined)));
            // Press through priority only until the blows start: nothing then may add work to the window.
            if (!out.some(Boolean)) for (const p of [alice.page, bob.page]) if ((await enabledOk(p).count()) > 0) await enabledOk(p).click().catch(() => undefined);
            return false;
          },
          { timeout: 45_000, intervals: [100], message: 'every ram copy went out and came home on both screens' },
        )
        .toBe(true);
      await alice.page.waitForTimeout(600);
    });
    log(`${variant} life: bob ${await alice.page.locator('[data-player-face]:not([data-viewer]) [data-testid="life"]').textContent()}`);
  } finally {
    await seated?.alice.context.close();
    await seated?.bob.context.close();
    await stack.stop();
  }
}

for (const variant of ['as-is', 'no-shake', 'flat-copies'] as const) {
  test(titled(`combat perf (${variant}): six attackers declared, two blocked, four charge — frame intervals and where each frame goes, on both screens`), async ({ browser }) => {
    test.skip(!forge.ok, forge.ok ? '' : forge.reason);
    if (!forge.ok) return;
    test.setTimeout(4 * 60_000);
    await attack(browser, forge, variant);
  });
}

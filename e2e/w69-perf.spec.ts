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
 * What it asserts, and why not 4 ms: a claw draws in software on a shared CPU — an idle frame of
 * this board is ~0.9 ms there, a drag 9–12 ms p95 once nothing on the board lays all of it out.
 * Measured on claw-8 before that (main dc06571): hand 29 / 21 ms, arrange 14 / 12, chip 23 / 21
 * (dragger / other screen), most of it one or more whole-board layouts a frame (17–35 ms each).
 * So it holds the two things that regressed: no frame's layout over `LAYOUT_P95_MS` at p95, and no
 * drag over one 60 Hz frame of work at p95 on the claw.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { SourceMap } from 'node:module';
import { resolve } from 'node:path';

import { expect, test, type Browser, type CDPSession, type Page } from '@playwright/test';

import { clickHandCard, makeTitled, pressPaymentAuto } from './play/board.ts';
import { forgeAvailability, startPlayStack } from './play/harness.ts';
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
/** Layout per frame, p95, during a drag: a whole-board layout is 17–35 ms on a claw, a local one ~1. */
const LAYOUT_P95_MS = 3;
/**
 * Main-thread work per frame, p95, during a drag on a claw: one 60 Hz frame. Not asserted while the
 * run records video (`CARDTABLE_E2E_VIDEO=1`): the screencast's own capture work lands in the same
 * frames (measured, claw-9: frames 40 ms apart instead of 16.7, 14–27 ms of work against 8–12 ms
 * unrecorded) — the layout bound, which is what regressed, holds either way.
 */
const CLAW_FRAME_MS = 16;
const RECORDING = process.env.CARDTABLE_E2E_VIDEO === '1';

const CATEGORIES = [
  'toplevel',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.stack',
  // What dirtied each layout (`LayoutInvalidationTracking`): costly, so only on request.
  ...(process.env.W69_PERF_INVALIDATIONS === '1' ? ['disabled-by-default-devtools.timeline.invalidationTracking'] : []),
  'v8',
  'v8.execute',
  'blink',
  'cc',
  'gpu',
];

type Kind = 'script' | 'style' | 'layout' | 'paint' | 'other';
const KIND: Record<string, Kind> = {
  FunctionCall: 'script',
  EvaluateScript: 'script',
  EventDispatch: 'script',
  TimerFire: 'script',
  FireAnimationFrame: 'script',
  FireIdleCallback: 'script',
  RunMicrotasks: 'script',
  'V8.Execute': 'script',
  'v8.callFunction': 'script',
  'v8.run': 'script',
  'v8.compile': 'script',
  'V8.CompileCode': 'script',
  MinorGC: 'script',
  MajorGC: 'script',
  'V8.GC_SCAVENGER': 'script',
  'V8.GC_MC_BACKGROUND_MARKING': 'script',
  'BlinkGC.AtomicPhase': 'script',
  XHRReadyStateChange: 'script',
  UpdateLayoutTree: 'style',
  RecalculateStyles: 'style',
  ParseAuthorStyleSheet: 'style',
  Layout: 'layout',
  PrePaint: 'paint',
  Paint: 'paint',
  PaintImage: 'paint',
  Layerize: 'paint',
  UpdateLayer: 'paint',
  UpdateLayerTree: 'paint',
  CompositeLayers: 'paint',
  Commit: 'paint',
  'Decode Image': 'paint',
};
const SCRIPT_ROOTS = new Set(['FunctionCall', 'EvaluateScript', 'EventDispatch', 'TimerFire', 'FireAnimationFrame', 'RunMicrotasks', 'v8.callFunction', 'V8.Execute']);
const TOP = new Set(['RunTask', 'ThreadControllerImpl::RunTask', 'ThreadPool_RunTask']);

interface TraceEvent {
  name: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: {
    data?: { message?: string; stackTrace?: StackFrame[]; nodeName?: string; reason?: string };
    beginData?: { dirtyObjects?: number; totalObjects?: number; stackTrace?: StackFrame[] };
  };
}
interface StackFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}
interface Span {
  name: string;
  ts: number;
  end: number;
  children: Span[];
}

const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const f1 = (n: number): string => n.toFixed(1);
const f2 = (n: number): string => n.toFixed(2);

/** The spans on one thread, nested, built from complete (`X`) and begin/end (`B`/`E`) events. */
function spansOf(events: TraceEvent[]): Span[] {
  const flat: Span[] = [];
  const open: TraceEvent[] = [];
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    if (e.ph === 'X' && e.dur !== undefined) flat.push({ name: e.name, ts: e.ts, end: e.ts + e.dur, children: [] });
    else if (e.ph === 'B') open.push(e);
    else if (e.ph === 'E') {
      const b = open.pop();
      if (b !== undefined) flat.push({ name: b.name, ts: b.ts, end: e.ts, children: [] });
    }
  }
  flat.sort((a, b) => a.ts - b.ts || b.end - a.end);
  const roots: Span[] = [];
  const stack: Span[] = [];
  for (const s of flat) {
    while (stack.length > 0 && stack[stack.length - 1]!.end <= s.ts) stack.pop();
    if (stack.length === 0) roots.push(s);
    else stack[stack.length - 1]!.children.push(s);
    stack.push(s);
  }
  return roots;
}

interface FrameWork {
  total: number;
  by: Record<Kind, number>;
  forced: number;
}

/** Main-thread work, in ms, inside [from, to), by kind; a forced layout is one under script. */
function workIn(roots: Span[], from: number, to: number): FrameWork {
  const by: Record<Kind, number> = { script: 0, style: 0, layout: 0, paint: 0, other: 0 };
  let forced = 0;
  const clip = (s: Span): number => Math.max(0, Math.min(s.end, to) - Math.max(s.ts, from));
  const walk = (s: Span, kind: Kind, underScript: boolean): void => {
    const own = KIND[s.name] ?? kind;
    const script = underScript || SCRIPT_ROOTS.has(s.name);
    if (underScript && (s.name === 'Layout' || s.name === 'UpdateLayoutTree') && s.ts >= from && s.ts < to) forced += 1;
    let self = clip(s);
    for (const c of s.children) self -= clip(c);
    by[own] += Math.max(0, self) / 1000;
    for (const c of s.children) if (c.end > from && c.ts < to) walk(c, own, script);
  };
  for (const r of roots) if (r.end > from && r.ts < to && TOP.has(r.name)) walk(r, 'other', false);
  const total = by.script + by.style + by.layout + by.paint + by.other;
  return { total, by, forced };
}

interface Seen {
  starts: number[];
  frames: number;
  interval: number[];
  work: FrameWork[];
}

function framesOf(events: TraceEvent[], from: number, to: number): Seen {
  const roots = spansOf(events.filter((e) => e.ph !== 'I' && e.ph !== 'M'));
  // A frame starts with the task that runs its animation frame callbacks (several callbacks, one task).
  const tasks = roots.filter((r) => TOP.has(r.name));
  const starts = new Set<number>();
  for (const e of events) {
    if (e.name !== 'FireAnimationFrame' || e.ts < from || e.ts >= to) continue;
    starts.add(tasks.find((t) => t.ts <= e.ts && e.ts < t.end)?.ts ?? e.ts);
  }
  const rafs = [...starts].sort((a, b) => a - b);
  const interval: number[] = [];
  const work: FrameWork[] = [];
  for (let i = 1; i < rafs.length; i += 1) {
    interval.push((rafs[i]! - rafs[i - 1]!) / 1000);
    work.push(workIn(roots, rafs[i - 1]!, rafs[i]!));
  }
  return { frames: rafs.length, interval, work, starts: rafs };
}

/** The `n` heaviest frames: each one's layout, style and paint events over 1 ms, a forced one with the script that forced it. */
function worstFrames(thread: TraceEvent[], seen: Seen, n: number): string {
  const order = seen.work.map((w, i) => ({ w, i })).sort((a, b) => b.w.total - a.w.total).slice(0, n);
  return order
    .map(({ w, i }) => {
      const from = seen.starts[i]!;
      const to = seen.starts[i + 1]!;
      const heavy = thread
        .filter((e) => e.ts >= from && e.ts < to && (e.dur ?? 0) >= 1000 && ['Layout', 'UpdateLayoutTree', 'Paint', 'PrePaint', 'Layerize', 'Commit', 'FunctionCall', 'EventDispatch', 'TimerFire', 'FireAnimationFrame', 'RunMicrotasks'].includes(e.name))
        .map((e) => {
          const stack = e.args?.beginData?.stackTrace ?? e.args?.data?.stackTrace ?? [];
          const where = stack
            .slice(0, 3)
            .map((f) => mapped(f.url, Math.max(0, f.lineNumber - 1), Math.max(0, f.columnNumber - 1)).replace(/^\.\.\/\.\.\/src\//, ''))
            .join('<');
          const objs = e.args?.beginData?.totalObjects === undefined ? '' : ` ${e.args.beginData.dirtyObjects ?? '?'}/${e.args.beginData.totalObjects}obj`;
          let why = '';
          if (e.name === 'Layout' && (e.dur ?? 0) >= 5000) {
            const before = thread.filter((x) => x.name === 'Layout' && x.ts < e.ts).reduce((a, x) => Math.max(a, x.ts + (x.dur ?? 0)), from);
            const reasons = new Map<string, number>();
            for (const x of thread) {
              if (x.name !== 'LayoutInvalidationTracking' || x.ts < before || x.ts > e.ts) continue;
              const d = (x.args?.data ?? {}) as { nodeName?: string; reason?: string; stackTrace?: StackFrame[] };
              const top = d.stackTrace?.[0];
              const at = top === undefined ? '' : `@${mapped(top.url, Math.max(0, top.lineNumber - 1), Math.max(0, top.columnNumber - 1)).replace(/^\.\.\/\.\.\/src\//, '')}`;
              const k = `${d.reason ?? '?'}:${(d.nodeName ?? '?').slice(0, 60)}${at}`;
              reasons.set(k, (reasons.get(k) ?? 0) + 1);
            }
            if (reasons.size > 0) why = ` {${[...reasons].slice(0, 6).map(([k, c]) => `${c}x ${k}`).join('; ')}}`;
          }
          return `${e.name}=${f1((e.dur ?? 0) / 1000)}${objs}${where === '' ? '' : ` @${where}`}${why}`;
        });
      return `#${i} ${f1(w.total)}ms [${heavy.join(', ')}]`;
    })
    .join(' || ');
}

/** The dist's source maps, by served file name. */
const MAPS = new Map<string, SourceMap | null>();
function mapped(url: string, line: number, col: number): string {
  const file = url.split('/').pop() ?? '';
  if (!file.endsWith('.js')) return `${file}:${line + 1}:${col + 1}`;
  if (!MAPS.has(file)) {
    const dir = resolve(import.meta.dirname, '..', 'apps/ui/dist/assets');
    const path = readdirSync(dir).includes(`${file}.map`) ? resolve(dir, `${file}.map`) : null;
    MAPS.set(file, path === null ? null : new SourceMap(JSON.parse(readFileSync(path, 'utf8'))));
  }
  const map = MAPS.get(file);
  if (map === null || map === undefined) return `${file}:${line + 1}:${col + 1}`;
  const e = map.findEntry(line, col) as { originalSource?: string; originalLine?: number; originalColumn?: number; name?: string };
  if (e.originalSource === undefined) return `${file}:${line + 1}:${col + 1}`;
  const src = e.originalSource.replace(/^.*?(apps\/ui\/src\/|node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?)/, '');
  return `${src}:${(e.originalLine ?? 0) + 1}${e.name !== undefined ? ` ${e.name}` : ''}`;
}

interface CpuProfile {
  nodes: { id: number; children?: number[]; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number } }[];
  samples: number[];
  timeDeltas: number[];
}
/**
 * Self time per function, top `n`, ms over the whole profile. `inApp`: a browser built-in's own time
 * (a forced layout inside `getBoundingClientRect`, say) is charged to the nearest app function that
 * called it, with the built-in's name after it — the line to read for what to change.
 */
function topSelf(profile: CpuProfile, n: number, inApp = false): string {
  const byNode = new Map<number, number>();
  for (let i = 0; i < profile.samples.length; i += 1) byNode.set(profile.samples[i]!, (byNode.get(profile.samples[i]!) ?? 0) + (profile.timeDeltas[i + 1] ?? 0));
  const parent = new Map<number, number>();
  for (const node of profile.nodes) for (const c of node.children ?? []) parent.set(c, node.id);
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const byFn = new Map<string, number>();
  for (const node of profile.nodes) {
    const us = byNode.get(node.id) ?? 0;
    if (us === 0) continue;
    const cf = node.callFrame;
    if (cf.functionName === '(idle)') continue;
    let key = cf.url === '' ? cf.functionName : `${cf.functionName || '(anon)'}@${mapped(cf.url, cf.lineNumber, cf.columnNumber)}`;
    if (inApp) {
      // The three nearest app frames, innermost first: `dom.ts:56 < presence.ts:265 < …`.
      const chain: string[] = [];
      for (let up: number | undefined = node.id; up !== undefined && chain.length < 3; up = parent.get(up)) {
        const a = byId.get(up)!.callFrame;
        const at = a.url.includes('/assets/') ? mapped(a.url, a.lineNumber, a.columnNumber) : '';
        if (at.startsWith('../../src/')) chain.push(at.slice('../../src/'.length));
      }
      if (chain.length === 0) continue;
      key = `${cf.url.includes('/assets/') ? '' : `${cf.functionName} < `}${chain.join(' < ')}`;
    }
    byFn.set(key, (byFn.get(key) ?? 0) + us);
  }
  return [...byFn.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, us]) => `${f1(us / 1000)}ms ${k}`)
    .join(' | ');
}

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

/** A rAF on every frame: makes every frame a `FireAnimationFrame` in the trace, which bounds it. */
const tickEveryFrame = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const w = window as unknown as { __w69tick?: boolean };
    if (w.__w69tick === true) return;
    w.__w69tick = true;
    const tick = (): void => {
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

interface Screen {
  name: string;
  page: Page;
  cdp: CDPSession;
}

interface Result {
  scenario: string;
  screen: string;
  p95: number;
  layoutP95: number;
  line: string;
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
    const line =
      `${scenario} ${s.name}: frames=${seen.frames} interval p50/p95/max=${f1(pct(seen.interval, 50))}/${f1(pct(seen.interval, 95))}/${f1(Math.max(0, ...seen.interval))}ms` +
      ` work p50/p95/max=${f2(pct(totals, 50))}/${f2(pct(totals, 95))}/${f2(Math.max(0, ...totals))}ms over${BUDGET_MS}ms=${over}/${totals.length}` +
      ` p95/max script=${of('script')} style=${of('style')} layout=${of('layout')} paint=${of('paint')} other=${of('other')}` +
      ` forcedLayouts=${forced} (${f1(forced / Math.max(1, seen.frames))}/frame) reactCommits/s=${commits} dom=${nodes[i]}`;
    console.log(`[w69-perf] ${line}`);
    console.log(`[w69-perf] ${scenario} ${s.name} top: ${topSelf(profiles[i]!, 12)}`);
    console.log(`[w69-perf] ${scenario} ${s.name} app: ${topSelf(profiles[i]!, 14, true)}`);
    console.log(`[w69-perf] ${scenario} ${s.name} worst: ${worstFrames(thread, seen, 4)}`);
    results.push({ scenario, screen: s.name, p95: pct(totals, 95), layoutP95: pct(seen.work.map((w) => w.by.layout), 95), line });
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
      await alice.page.setViewportSize(size);
      await alice.page.waitForTimeout(400);
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
    await alice.page.setViewportSize({ width: 1600, height: 900 });
    await bob.page.setViewportSize({ width: 1600, height: 900 });
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

    console.log(`[w69-perf] summary p95 work/frame: ${results.map((r) => `${r.scenario}/${r.screen}=${f2(r.p95)}ms`).join(' ')}`);
    const drags = results.filter((r) => r.scenario !== 'idle');
    expect(observerErrors, 'no ResizeObserver loop on either screen').toEqual([]);
    expect(drags.length, 'the hand and arrange drags were measured').toBeGreaterThanOrEqual(4);
    for (const r of drags) {
      expect(r.layoutP95, `${r.scenario} on ${r.screen}'s screen: p95 layout per frame (${r.line})`).toBeLessThanOrEqual(LAYOUT_P95_MS);
      if (!RECORDING) expect(r.p95, `${r.scenario} on ${r.screen}'s screen: p95 main-thread work per frame (${r.line})`).toBeLessThanOrEqual(CLAW_FRAME_MS);
    }
  } finally {
    unhook();
    await stack.stop();
  }
});

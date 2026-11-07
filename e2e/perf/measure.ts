/**
 * The perf bench's measuring: what one screen did during one intense moment, and why each long frame was
 * long. `bench.spec.ts` drives the moments; this file records them and attributes the time.
 *
 * In the page (`instrument`, an init script, so it is in place before the app's own code):
 * - every long animation frame (over 50 ms): its rendering, its style and layout, its scripts;
 * - every `requestAnimationFrame` tick, so the time the screen skipped is measured, not inferred;
 * - every WebSocket message, by kind, with its handler's time;
 * - every list of the board's animations (each brings the page's style up to date first);
 * - every React commit, through the devtools hook React calls in a production build too: how many
 *   components rendered, and of those how many got props equal to the last ones (a re-render that only
 *   happened because a parent did — what memoising would skip).
 *
 * Outside the page, while the moment plays (`attribute: true`):
 * - a sampled CPU profile of each screen, every sample mapped through the bundle's source map;
 * - one browser trace: style recalcs, layouts, paints, garbage collection, rasterising, which script
 *   forced each recalc or layout, and the animations Chromium could not run on the compositor.
 * Each long frame is then split by mechanism: React (`react:ours`: our components' renders and effects as
 * React runs them, with what they call; `react:internals`: React's own reconcile and commit), our modules' own JS, libraries, style, layout, paint, GC. Profiling and tracing cost time
 * themselves, so a bench run without them (`CARDTABLE_PERF_ATTRIBUTE=0`) gives the clean frame numbers.
 *
 * Every run, clean or not, traces each task's thread-CPU time (`toplevel`, cheap) and samples the CPU speed right
 * before and right after the moment (`cpu-speed.ts`): the longest task, scaled to hokon by that moment's speed, is
 * what a budget judges.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Browser, CDPSession, Page } from '@playwright/test';

import { cpuSpeedAround, describeCpu, tasksOn, type CpuSpeed } from '../cpu-speed.ts';

/** A long frame as the page saw it. */
interface Frame {
  start: number;
  ms: number;
  render: number;
  styleLayout: number;
  blocking: number;
  scripts: {
    invoker: string;
    fn: string;
    src: string;
    at: number;
    ms: number;
    forced: number;
  }[];
}

interface Commit {
  at: number;
  ms: number;
  fibers: number;
  rendered: number;
  /** Rendered with props shallow-equal to the last render's, and their own state unchanged. */
  sameProps: number;
  byName: Record<string, [rendered: number, sameProps: number]>;
}

interface PageRecord {
  recording: boolean;
  messages: { at: number; kind: string; ms: number }[];
  lists: number;
  listMs: number;
  frames: Frame[];
  raf: number[];
  commits: Commit[];
  sync: number;
}

declare global {
  interface Window {
    perfBench: PageRecord;
    __perfSyncMark: (label: string) => number;
  }
}

/** The init script. Plain browser code: it is serialised into the page, so it closes over nothing. */
export function instrument(): void {
  const rec: PageRecord = {
    recording: false,
    messages: [],
    lists: 0,
    listMs: 0,
    frames: [],
    raf: [],
    commits: [],
    sync: 0,
  };
  window.perfBench = rec;
  // A named, busy few milliseconds: its samples in the CPU profile line the profile's clock up with the page's.
  window.__perfSyncMark = function __perfSyncMark(label: string): number {
    const t = performance.now();
    console.timeStamp(`perf-sync ${label}`);
    while (performance.now() - t < 8) {
      /* spin */
    }
    rec.sync = t;
    return t;
  };
  const list = Element.prototype.getAnimations;
  Element.prototype.getAnimations = function (this: Element, options?: GetAnimationsOptions) {
    if (!rec.recording) return list.call(this, options);
    const t = performance.now();
    try {
      return list.call(this, options);
    } finally {
      rec.lists += 1;
      rec.listMs += performance.now() - t;
    }
  };
  const timed = (fn: (this: WebSocket, ev: MessageEvent) => unknown) =>
    function (this: WebSocket, ev: MessageEvent) {
      if (!rec.recording) return fn.call(this, ev);
      const data = typeof ev.data === 'string' ? ev.data : '';
      const kind = `${/^\d+(?:\["([^"]+)")?/.exec(data)?.[1] ?? data.slice(0, 2)} ${/"method":"(\w+)"/.exec(data.slice(0, 400))?.[1] ?? ''}`.trim();
      const t = performance.now();
      try {
        return fn.call(this, ev);
      } finally {
        rec.messages.push({ at: t, kind, ms: performance.now() - t });
      }
    };
  const desc = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage')!;
  Object.defineProperty(WebSocket.prototype, 'onmessage', {
    configurable: true,
    get: desc.get,
    set(fn) {
      desc.set!.call(this, typeof fn === 'function' ? timed(fn) : fn);
    },
  });
  const add = WebSocket.prototype.addEventListener;
  WebSocket.prototype.addEventListener = function (this: WebSocket, type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) {
    const listener = type === 'message' && typeof fn === 'function' ? (timed(fn as (this: WebSocket, ev: MessageEvent) => unknown) as EventListener) : fn;
    return listener === null ? undefined : add.call(this, type, listener, opts);
  } as typeof add;
  const tick = (t: number): void => {
    if (rec.recording) rec.raf.push(t);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  type Script = PerformanceEntry & {
    invoker: string;
    sourceURL: string;
    sourceFunctionName: string;
    sourceCharPosition: number;
    forcedStyleAndLayoutDuration: number;
  };
  type Loaf = PerformanceEntry & {
    renderStart: number;
    styleAndLayoutStart: number;
    blockingDuration: number;
    scripts: Script[];
  };
  new PerformanceObserver((entries) => {
    if (!rec.recording) return;
    for (const e of entries.getEntries() as Loaf[]) {
      const end = e.startTime + e.duration;
      rec.frames.push({
        start: e.startTime,
        ms: e.duration,
        render: e.renderStart > 0 ? end - e.renderStart : 0,
        styleLayout: e.styleAndLayoutStart > 0 ? end - e.styleAndLayoutStart : 0,
        blocking: e.blockingDuration,
        scripts: e.scripts.map((s) => ({
          invoker: s.invoker,
          fn: s.sourceFunctionName,
          src: s.sourceURL.split('/').pop() ?? '',
          at: s.sourceCharPosition,
          ms: s.duration,
          forced: s.forcedStyleAndLayoutDuration,
        })),
      });
    }
  }).observe({ type: 'long-animation-frame', buffered: false });

  // React's devtools hook. React (production builds too) hands every commit's root to `onCommitFiberRoot`.
  // A subtree whose child list is the same object as last commit's was not re-rendered at all, so the walk
  // skips it; a component fiber inside a re-rendered subtree rendered if it is new or did work this pass.
  type Fiber = {
    tag: number;
    type: unknown;
    child: Fiber | null;
    sibling: Fiber | null;
    alternate: Fiber | null;
    flags: number;
    memoizedProps: unknown;
    memoizedState: unknown;
  };
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
  const nameOf = (f: Fiber): string => {
    const t = f.type as {
      displayName?: string;
      name?: string;
      render?: { name?: string };
      type?: { name?: string };
    } | null;
    return t?.displayName ?? t?.name ?? t?.render?.name ?? t?.type?.name ?? `tag${f.tag}`;
  };
  const shallowEqual = (a: unknown, b: unknown): boolean => {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
  };
  const hook = {
    supportsFiber: true,
    renderers: new Map(),
    inject: (): number => 1,
    checkDCE: (): void => undefined,
    onScheduleFiberRoot: (): void => undefined,
    onCommitFiberUnmount: (): void => undefined,
    onPostCommitFiberRoot: (): void => undefined,
    onCommitFiberRoot(_id: number, root: { current: Fiber }): void {
      if (!rec.recording) return;
      const t = performance.now();
      const c: Commit = {
        at: t,
        ms: 0,
        fibers: 0,
        rendered: 0,
        sameProps: 0,
        byName: {},
      };
      const stack: Fiber[] = [root.current];
      while (stack.length > 0) {
        const f = stack.pop()!;
        c.fibers += 1;
        const prev = f.alternate;
        if (COMPONENT_TAGS.has(f.tag) && (prev === null || (f.flags & 1) === 1)) {
          const same = prev !== null && shallowEqual(prev.memoizedProps, f.memoizedProps) && prev.memoizedState === f.memoizedState;
          c.rendered += 1;
          if (same) c.sameProps += 1;
          const n = nameOf(f);
          const row = (c.byName[n] ??= [0, 0]);
          row[0] += 1;
          if (same) row[1] += 1;
        }
        if (f.sibling !== null) stack.push(f.sibling);
        if (f.child !== null && (prev === null || prev.child !== f.child)) stack.push(f.child);
      }
      c.ms = performance.now() - t;
      rec.commits.push(c);
    },
  };
  Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
    value: hook,
    configurable: true,
  });
}

/* ── node side ─────────────────────────────────────────────────────────── */

interface ProfileNode {
  id: number;
  children?: number[];
  callFrame: {
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
}
interface Profile {
  nodes: ProfileNode[];
  startTime: number;
  samples: number[];
  timeDeltas: number[];
}
interface TraceEvent {
  name: string;
  cat: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  id?: string;
  id2?: { local?: string };
  args?: {
    data?: Record<string, unknown>;
    beginData?: {
      stackTrace?: {
        functionName: string;
        url: string;
        lineNumber: number;
        columnNumber: number;
      }[];
    };
  };
}

/** Where a sample's or a forcing stack's time goes. */
type Bucket = 'react:ours' | 'react:internals' | 'app' | 'lib' | 'style' | 'layout' | 'paint' | 'gc' | 'native' | 'other';

const SCRIPT_EVENTS = new Set([
  'FunctionCall',
  'EvaluateScript',
  'v8.compile',
  'TimerFire',
  'FireAnimationFrame',
  'EventDispatch',
  'RunMicrotasks',
  'v8.execute',
  'V8.Execute',
  'v8.run',
  'FireIdleCallback',
]);
const STYLE_EVENTS = new Set(['UpdateLayoutTree', 'RecalculateStyles', 'ParseAuthorStyleSheet', 'ScheduleStyleRecalculation']);
const LAYOUT_EVENTS = new Set(['Layout', 'UpdateLayout']);
const PAINT_EVENTS = new Set([
  'PrePaint',
  'Paint',
  'PaintImage',
  'Layerize',
  'UpdateLayer',
  'UpdateLayerTree',
  'Commit',
  'CompositeLayers',
  'Decode Image',
  'Decode LazyPixelRef',
  'Draw LazyPixelRef',
  'ImageDecodeTask',
  'IntersectionObserverController::computeIntersections',
  'HitTest',
]);
const GC_EVENTS = /^(MinorGC|MajorGC|V8\.GC|BlinkGC|ThreadState::|CppGC|V8\.GC_)/;

function traceBucket(name: string): 'script' | 'style' | 'layout' | 'paint' | 'gc' | 'other' {
  if (SCRIPT_EVENTS.has(name)) return 'script';
  if (STYLE_EVENTS.has(name)) return 'style';
  if (LAYOUT_EVENTS.has(name)) return 'layout';
  if (PAINT_EVENTS.has(name)) return 'paint';
  if (GC_EVENTS.test(name)) return 'gc';
  return 'other';
}

type SourceMap = {
  originalPositionFor(p: { line: number; column: number }): {
    source: string | null;
    line: number | null;
    name: string | null;
  };
};

/** Maps bundle positions to source positions, fetching each bundle's map once. */
class Mapper {
  private readonly maps = new Map<string, SourceMap | null>();
  private readonly Consumer: new (map: unknown) => SourceMap;
  private readonly page: Page;
  constructor(page: Page) {
    this.page = page;
    const ui = resolve(import.meta.dirname, '../../apps/ui');
    const viteEntry = createRequire(resolve(ui, 'package.json')).resolve('vite');
    this.Consumer = (createRequire(createRequire(viteEntry).resolve('postcss'))('source-map-js') as { SourceMapConsumer: new (map: unknown) => SourceMap }).SourceMapConsumer;
  }
  async load(urls: Iterable<string>): Promise<void> {
    for (const url of urls) {
      if (this.maps.has(url) || !url.endsWith('.js')) continue;
      this.maps.set(
        url,
        await this.page.request
          .get(`${url}.map`)
          .then(async (r) => (r.ok() ? new this.Consumer(await r.json()) : null))
          .catch(() => null),
      );
    }
  }
  /** `{file, line, name}` for a bundle position (0-based line and column, as CDP gives them). */
  at(url: string, line: number, col: number): { file: string; line: number; name: string | null } {
    const pos = this.maps.get(url)?.originalPositionFor({ line: line + 1, column: col });
    if (pos?.source == null)
      return {
        file: url === '' ? '' : (url.split('/').pop() ?? ''),
        line,
        name: null,
      };
    return {
      file: pos.source.replace(/^(\.\.\/)+/, ''),
      line: pos.line ?? 0,
      name: pos.name,
    };
  }
}

/** A source path, short: the package for a library, the path under `src/` for ours. */
function shortFile(file: string): string {
  const pkg = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(file);
  if (pkg !== null) return pkg[1]!;
  const src = /(?:apps\/ui\/src|packages\/[^/]+\/src|src)\/(.*)$/.exec(file);
  return src !== null ? src[1]! : file;
}
const isLib = (file: string): boolean => file.includes('node_modules/');
const isReact = (file: string): boolean => /node_modules\/.*\/(react-dom|react|scheduler)\//.test(file) || /node_modules\/(react-dom|react|scheduler)\//.test(file);
const isApp = (file: string): boolean => file !== '' && !isLib(file) && !file.endsWith('.js');

/** One screen's whole moment, measured and attributed. */
export interface SeatReport {
  seat: string;
  moment: string;
  ms: number;
  /** The CPU speed sampled right before the moment and right after it (`cpu-speed.ts`). */
  cpu: CpuSpeed;
  frames: {
    long: number;
    over100: number;
    worst: number;
    totalMs: number;
    blockingMs: number;
  };
  /**
   * The page's longest main-thread task in the moment, on the thread's CPU clock and on the wall, and its CPU scaled to
   * hokon by the moment's own CPU speed: the number a budget judges, both sides on one clock (`cpu-speed.ts`). Null
   * when the trace did not name the page's thread.
   */
  longestTask: { cpuMs: number; wallMs: number; norm: number } | null;
  raf: { ticks: number; skippedMs: number; worstGapMs: number };
  messages: {
    count: number;
    kinds: Record<string, number>;
    handlerMs: number;
    perMessageBusyMs: number | null;
    perMessageScriptMs: number | null;
    maxPerFrame: number;
    framesWithSeveral: number;
  };
  lists: { count: number; ms: number };
  react: {
    commits: number;
    commitWalkMs: number;
    renderedAvg: number;
    renderedMax: number;
    sameProps: number;
    rendered: number;
    fibersMax: number;
    top: [string, number, number][];
  };
  /** Long frames' time by mechanism (attributed runs only), ms. */
  mechanisms: Record<string, number>;
  /** The top sources inside long frames: `bucket  function file:line` → ms. */
  hot: [string, number][];
  /** Which script forced style or layout inside long frames, ms. */
  forced: [string, number][];
  animations: {
    started: number;
    byName: [string, number][];
    notComposited: [string, string, number][];
  };
  rasterMs: number;
  /** The trace's own names for what `other` holds, ms; and the fields an Animation event carries. */
  others: [string, number][];
  animKeys: string[];
  worstFrames: {
    ms: number;
    render: number;
    styleLayout: number;
    mech: Record<string, number>;
    scripts: string[];
    hot: [string, number][];
  }[];
}

export interface Measure {
  start(): Promise<void>;
  stop(): Promise<SeatReport[]>;
}

/**
 * Measure `seats` (each a page with `instrument` installed) from `start()` to `stop()`. With `attribute`,
 * each page is CPU-profiled and the browser traced.
 */
export function measure(browser: Browser, moment: string, seats: { name: string; page: Page }[], attribute = process.env.CARDTABLE_PERF_ATTRIBUTE !== '0'): Measure {
  let cdps: CDPSession[] = [];
  let tracer: CDPSession | null = null;
  let started = 0;
  let speeds: { after: () => Promise<CpuSpeed> }[] = [];
  const trace: TraceEvent[] = [];
  return {
    async start() {
      trace.length = 0;
      speeds = [];
      for (const s of seats) speeds.push(await cpuSpeedAround(s.page));
      if (attribute) {
        cdps = await Promise.all(seats.map((s) => s.page.context().newCDPSession(s.page)));
        for (const c of cdps) {
          await c.send('Profiler.enable');
          await c.send('Profiler.setSamplingInterval', { interval: 250 });
        }
      }
      // Always traced: every task's thread-CPU time (`toplevel`) is what a budget judges. A clean run records only that
      // and the seats' start marks; an attributed one, what each long frame went on too.
      tracer = await browser.newBrowserCDPSession();
      tracer.on('Tracing.dataCollected', ({ value }) => trace.push(...(value as unknown as TraceEvent[])));
      await tracer.send('Tracing.start', {
        traceConfig: {
          recordMode: 'recordAsMuchAsPossible',
          includedCategories: attribute
            ? ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.stack', 'blink.console', 'v8', 'blink_gc', 'cc']
            : ['toplevel', 'blink.console', 'devtools.timeline', '__metadata'],
        },
        transferMode: 'ReportEvents',
      });
      if (attribute) for (const c of cdps) await c.send('Profiler.start');
      for (const s of seats) {
        await s.page.evaluate((label) => {
          const r = window.perfBench;
          r.messages = [];
          r.frames = [];
          r.raf = [];
          r.commits = [];
          r.lists = 0;
          r.listMs = 0;
          r.recording = true;
          window.__perfSyncMark(label);
        }, s.name);
      }
      started = Date.now();
    },
    async stop() {
      const ms = Date.now() - started;
      const recs: PageRecord[] = [];
      for (const s of seats) {
        recs.push(
          await s.page.evaluate((label) => {
            const r = window.perfBench;
            const start = r.sync;
            window.__perfSyncMark(`${label} end`);
            r.sync = start;
            r.recording = false;
            return r;
          }, s.name),
        );
      }
      const profiles: (Profile | null)[] = seats.map(() => null);
      if (attribute) for (const [i, c] of cdps.entries()) profiles[i] = ((await c.send('Profiler.stop')) as { profile: Profile }).profile;
      const done = new Promise<void>((ok) => tracer!.once('Tracing.tracingComplete', () => ok()));
      await tracer!.send('Tracing.end');
      await done;
      await tracer!.detach();
      for (const c of cdps) await c.detach().catch(() => undefined);
      cdps = [];
      // After the trace: each sample is a task of its own, and must not be the moment's longest.
      const cpu: CpuSpeed[] = [];
      for (const s of speeds) cpu.push(await s.after());
      const reports: SeatReport[] = [];
      for (const [i, s] of seats.entries()) reports.push(await report(s.page, s.name, moment, ms, cpu[i]!, recs[i]!, profiles[i] ?? null, trace, attribute));
      const dir = resolve(import.meta.dirname, '../.run/perf');
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, `${moment}.json`), JSON.stringify(reports, null, 1));
      return reports;
    },
  };
}

/** Sum into a map. */
function add<K>(m: Map<K, number>, k: K, v: number): void {
  m.set(k, (m.get(k) ?? 0) + v);
}
const top = <K>(m: Map<K, number>, n: number): [K, number][] =>
  [...m]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => [k, Math.round(v * 10) / 10]);
const round = (o: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]));

async function report(
  page: Page,
  seat: string,
  moment: string,
  ms: number,
  cpu: CpuSpeed,
  rec: PageRecord,
  profile: Profile | null,
  trace: TraceEvent[],
  attribute: boolean,
): Promise<SeatReport> {
  const frames = rec.frames;
  const worst = Math.max(0, ...frames.map((f) => f.ms));
  // rAF: a gap of more than 1.5 frames skipped everything past the first frame.
  let skipped = 0;
  let worstGap = 0;
  for (let i = 1; i < rec.raf.length; i++) {
    const gap = rec.raf[i]! - rec.raf[i - 1]!;
    worstGap = Math.max(worstGap, gap);
    if (gap > 25) skipped += gap - 1000 / 60;
  }
  // Messages a frame: how many renders coalescing would merge.
  const perFrame = new Map<number, number>();
  let j = 0;
  for (const m of rec.messages) {
    while (j < rec.raf.length && rec.raf[j]! <= m.at) j++;
    add(perFrame, j, 1);
  }
  const kinds: Record<string, number> = {};
  for (const m of rec.messages) kinds[m.kind] = (kinds[m.kind] ?? 0) + 1;
  const handlerMs = rec.messages.reduce((a, m) => a + m.ms, 0);

  const commits = rec.commits;
  const byName = new Map<string, [number, number]>();
  for (const c of commits)
    for (const [n, [r, s]] of Object.entries(c.byName)) {
      const row = byName.get(n) ?? [0, 0];
      row[0] += r;
      row[1] += s;
      byName.set(n, row);
    }
  const rendered = commits.reduce((a, c) => a + c.rendered, 0);

  const mechanisms = new Map<string, number>();
  const hot = new Map<string, number>();
  const forced = new Map<string, number>();
  const anims = new Map<string, number>();
  const notComposited = new Map<string, number>();
  const others = new Map<string, number>();
  let rasterMs = 0;
  const animKeys = new Set<string>();
  let busy = 0;
  let scriptMs = 0;
  const frameMech = frames.map(() => new Map<string, number>());
  const frameHot = frames.map(() => new Map<string, number>());
  const mapper = new Mapper(page);
  const nameMap = new Map<string, string>();

  // The page's own clock, in µs, is `pageMs * 1000 + offset` on the profile's and the trace's clock.
  if (profile !== null) {
    const urls = new Set(profile.nodes.map((n) => n.callFrame.url).filter((u) => u.includes('/assets/')));
    await mapper.load(urls);
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const parent = new Map<number, number>();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const mapped = new Map<number, { file: string; line: number; name: string | null }>();
    const where = (id: number) => {
      let m = mapped.get(id);
      if (m === undefined) {
        const f = byId.get(id)!.callFrame;
        m = mapper.at(f.url, f.lineNumber, f.columnNumber);
        mapped.set(id, m);
        // A minified component name → its source name and file, for the commit counts.
        if (f.functionName !== '' && isApp(m.file)) nameMap.set(f.functionName, `${m.name ?? f.functionName} ${shortFile(m.file)}`);
      }
      return m;
    };
    // Sample times, and the sync marks' first samples.
    const times: number[] = [];
    let t = profile.startTime;
    for (const d of profile.timeDeltas) times.push((t += d));
    const syncs: number[] = [];
    profile.samples.forEach((id, i) => {
      if (byId.get(id)!.callFrame.functionName === '__perfSyncMark' && (syncs.length === 0 || times[i]! - syncs[syncs.length - 1]! > 50_000)) syncs.push(times[i]!);
    });
    const offset = syncs.length > 0 ? syncs[0]! - rec.sync * 1000 : null;
    // Which long frame a sample falls in.
    const spans = frames.map((f, i) => ({
      i,
      from: f.start * 1000,
      to: (f.start + f.ms) * 1000,
    }));
    profile.samples.forEach((id, i) => {
      const fr = byId.get(id)!.callFrame;
      const dt = (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0) / 1000;
      if (fr.functionName === '(idle)') return;
      busy += dt;
      let bucket: Bucket;
      let label: string;
      if (fr.functionName === '(program)') {
        bucket = 'native';
        label = '(browser: style/layout/paint, see trace)';
      } else if (fr.functionName === '(garbage collector)') {
        bucket = 'gc';
        label = '(garbage collector)';
      } else {
        scriptMs += dt;
        let inReact = false;
        let app: {
          file: string;
          line: number;
          name: string | null;
          fn: string;
        } | null = null;
        let lib: string | null = null;
        for (let up: number | undefined = id; up !== undefined; up = parent.get(up)) {
          const f = byId.get(up)!.callFrame;
          if (f.url === '') continue;
          const w = where(up);
          if (isReact(w.file)) inReact = true;
          else if (app === null && isApp(w.file)) app = { ...w, fn: w.name ?? f.functionName };
          else if (lib === null && isLib(w.file)) lib = shortFile(w.file);
        }
        const leaf = where(id);
        const leafFn = leaf.name ?? fr.functionName;
        if (inReact && app !== null && !isReact(leaf.file)) {
          bucket = 'react:ours';
          label = `${app.fn || '(anonymous)'} ${shortFile(app.file)}:${app.line}`;
        } else if (inReact) {
          bucket = 'react:internals';
          label = app !== null ? `react under ${app.fn || '(anonymous)'} ${shortFile(app.file)}:${app.line}` : 'react (scheduler, reconcile, commit)';
        } else if (app !== null) {
          bucket = 'app';
          label = isApp(leaf.file)
            ? `${leafFn || '(anonymous)'} ${shortFile(leaf.file)}:${leaf.line}`
            : `${fr.functionName || '(native)'} ← ${app.fn || '(anonymous)'} ${shortFile(app.file)}:${app.line}`;
        } else if (lib !== null) {
          bucket = 'lib';
          label = lib;
        } else {
          bucket = 'other';
          label = `${fr.functionName || '(anonymous)'} ${leaf.file}`;
        }
      }
      if (offset === null) return;
      const at = times[i]! - offset;
      const span = spans.find((s) => at >= s.from && at <= s.to);
      if (span === undefined) return;
      if (bucket !== 'native') {
        add(mechanisms, bucket, dt);
        add(frameMech[span.i]!, bucket, dt);
      }
      add(hot, `${bucket}  ${label}`, dt);
      add(frameHot[span.i]!, `${bucket}  ${label}`, dt);
    });
  }

  // This page's renderer and main thread: the ones its start mark was recorded on.
  const markOf = (label: string): TraceEvent | undefined => trace.find((e) => e.name === 'TimeStamp' && (e.args?.data as { message?: string } | undefined)?.message === `perf-sync ${label}`);
  const markEv = markOf(seat);
  const endEv = markOf(`${seat} end`);
  let longestTask: SeatReport['longestTask'] = null;
  if (markEv !== undefined) {
    const tasks = tasksOn(trace, markEv.pid, markEv.tid).filter((t) => t.startUs >= markEv.ts && (endEv === undefined || t.startUs < endEv.ts));
    const longest = tasks.reduce<(typeof tasks)[number] | null>((a, t) => (a === null || t.cpuMs > a.cpuMs ? t : a), null);
    if (longest !== null) longestTask = { cpuMs: Math.round(longest.cpuMs), wallMs: Math.round(longest.wallMs), norm: Math.round(longest.cpuMs / cpu.factor) };
  }
  if (attribute) {
    if (markEv !== undefined) {
      const me = { pid: markEv.pid };
      const offset = markEv.ts - rec.sync * 1000;
      const tid = markEv.tid;
      const spans = frames.map((f, i) => ({
        i,
        from: f.start * 1000 + offset,
        to: (f.start + f.ms) * 1000 + offset,
      }));
      // Complete events on the main thread, nested by time: self time per event, with the script ancestor if any.
      const main = trace.filter((e) => e.pid === me.pid && e.tid === tid && e.ph === 'X' && e.dur !== undefined).sort((a, b) => a.ts - b.ts || b.dur! - a.dur!);
      const open: {
        e: TraceEvent;
        end: number;
        child: number;
        script: TraceEvent | null;
      }[] = [];
      const close = (o: (typeof open)[number]): void => {
        const self = o.e.dur! - o.child;
        const b = traceBucket(o.e.name);
        const span = spans.find((s) => o.e.ts >= s.from && o.e.ts <= s.to);
        if (span === undefined || b === 'script') return;
        add(mechanisms, b, self / 1000);
        add(frameMech[span.i]!, b, self / 1000);
        if (b === 'other') add(others, o.e.name, self / 1000);
        if ((b === 'style' || b === 'layout') && o.script !== null) {
          const st = o.e.args?.beginData?.stackTrace ?? [];
          // A trace's stack frames count lines and columns from 1; the profile's (and `Mapper.at`'s) from 0.
          const app = st
            .map((f) => ({
              f,
              w: mapper.at(f.url, f.lineNumber - 1, f.columnNumber - 1),
            }))
            .find((x) => isApp(x.w.file));
          const lib = st.map((f) => mapper.at(f.url, f.lineNumber - 1, f.columnNumber - 1)).find((w) => isLib(w.file));
          const key =
            app !== undefined
              ? `${b} forced by ${app.w.name ?? app.f.functionName} ${shortFile(app.w.file)}:${app.w.line}`
              : lib !== undefined
                ? `${b} forced by ${shortFile(lib.file)}`
                : `${b} forced (no stack)`;
          add(forced, key, o.e.dur! / 1000);
        }
      };
      for (const e of main) {
        while (open.length > 0 && e.ts >= open[open.length - 1]!.end) close(open.pop()!);
        const parentOpen = open[open.length - 1];
        if (parentOpen !== undefined) parentOpen.child += e.dur!;
        const script = SCRIPT_EVENTS.has(e.name) ? e : (parentOpen?.script ?? null);
        open.push({ e, end: e.ts + e.dur!, child: 0, script });
      }
      while (open.length > 0) close(open.pop()!);
      const from = rec.sync * 1000 + offset;
      for (const e of trace) {
        if (e.pid !== me.pid || e.ts < from) continue;
        if (e.name === 'RasterTask' && e.dur !== undefined) rasterMs += e.dur / 1000;
        if (e.name === 'Animation' && (e.ph === 'b' || e.ph === 'n')) {
          const d = e.args?.data as
            | {
                name?: string;
                displayName?: string;
                nodeName?: string;
                compositeFailed?: number;
                unsupportedProperties?: string[];
              }
            | undefined;
          const label = `${d?.displayName || d?.name || '(unnamed)'}${d?.nodeName ? ` on ${d.nodeName}` : ''}`;
          if (e.ph === 'b') add(anims, label, 1);
          if (d?.compositeFailed !== undefined && d.compositeFailed !== 0) add(notComposited, `${label}|${(d.unsupportedProperties ?? []).join(',') || `reason ${d.compositeFailed}`}`, 1);
          if (animKeys.size < 20) for (const k of Object.keys(d ?? {})) animKeys.add(k);
        }
      }
    }
  }

  const msgCount = rec.messages.length;
  const r: SeatReport = {
    seat,
    moment,
    ms,
    cpu,
    frames: {
      long: frames.length,
      over100: frames.filter((f) => f.ms > 100).length,
      worst: Math.round(worst),
      totalMs: Math.round(frames.reduce((a, f) => a + f.ms, 0)),
      blockingMs: Math.round(frames.reduce((a, f) => a + f.blocking, 0)),
    },
    longestTask,
    raf: {
      ticks: rec.raf.length,
      skippedMs: Math.round(skipped),
      worstGapMs: Math.round(worstGap),
    },
    messages: {
      count: msgCount,
      kinds,
      handlerMs: Math.round(handlerMs),
      perMessageBusyMs: profile !== null && msgCount > 0 ? Math.round((busy / msgCount) * 10) / 10 : null,
      perMessageScriptMs: profile !== null && msgCount > 0 ? Math.round((scriptMs / msgCount) * 10) / 10 : null,
      maxPerFrame: Math.max(0, ...perFrame.values()),
      framesWithSeveral: [...perFrame.values()].filter((n) => n > 1).length,
    },
    lists: { count: rec.lists, ms: Math.round(rec.listMs) },
    react: {
      commits: commits.length,
      commitWalkMs: Math.round(commits.reduce((a, c) => a + c.ms, 0)),
      renderedAvg: commits.length > 0 ? Math.round(rendered / commits.length) : 0,
      renderedMax: Math.max(0, ...commits.map((c) => c.rendered)),
      sameProps: commits.reduce((a, c) => a + c.sameProps, 0),
      rendered,
      fibersMax: Math.max(0, ...commits.map((c) => c.fibers)),
      top: [...byName]
        .sort((a, b) => b[1][0] - a[1][0])
        .slice(0, 15)
        .map(([n, [rc, sp]]) => [nameMap.get(n) ?? n, rc, sp]),
    },
    mechanisms: round(Object.fromEntries(mechanisms)),
    hot: top(hot, 25),
    forced: top(forced, 12),
    animations: {
      started: [...anims.values()].reduce((a, b) => a + b, 0),
      byName: top(anims, 12),
      notComposited: top(notComposited, 12).map(([k, n]) => [k.split('|')[0]!, k.split('|')[1]!, n]),
    },
    rasterMs: Math.round(rasterMs),
    others: top(others, 10),
    animKeys: [...animKeys],
    worstFrames: frames
      .map((f, i) => ({ f, i }))
      .sort((a, b) => b.f.ms - a.f.ms)
      .slice(0, 5)
      .map(({ f, i }) => ({
        ms: Math.round(f.ms),
        render: Math.round(f.render),
        styleLayout: Math.round(f.styleLayout),
        mech: round(Object.fromEntries(frameMech[i]!)),
        scripts: f.scripts.map((s) => `${s.invoker}${s.fn ? ` ${s.fn}` : ''}:${Math.round(s.ms)}/${Math.round(s.forced)}`),
        hot: top(frameHot[i]!, 6),
      })),
  };
  return r;
}

/** The evidence lines: one human summary and one JSON line per screen (claws keep no files on a green run). */
export function logReports(reports: SeatReport[]): void {
  for (const r of reports) {
    console.log(
      `[perf] ${r.moment} ${r.seat}: ${r.ms} ms; ${describeCpu(r.cpu)}; longest task ${r.longestTask === null ? '?' : `${r.longestTask.cpuMs} ms cpu (${r.longestTask.wallMs} wall, ${r.longestTask.norm} hokon-equivalent)`}; long frames ${r.frames.long} (>100: ${r.frames.over100}), worst ${r.frames.worst} ms, ` +
        `rAF skipped ${r.raf.skippedMs} ms (worst gap ${r.raf.worstGapMs}); ${r.messages.count} messages (${r.messages.perMessageBusyMs ?? '?'} ms busy each, max ${r.messages.maxPerFrame} a frame); ` +
        `${r.react.commits} commits, ${r.react.renderedAvg} components each (max ${r.react.renderedMax}, ${r.react.sameProps}/${r.react.rendered} with equal props); mechanisms ${JSON.stringify(r.mechanisms)}`,
    );
    console.log(`[perf-json] ${JSON.stringify(r)}`);
  }
}

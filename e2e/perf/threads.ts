/**
 * What every thread of the browser spent, from a trace that adds nothing to the page. `measure.ts` and
 * `instrument` run a `requestAnimationFrame` loop in the page, and a rAF loop is itself a cost: each frame
 * the main thread draws samples every running animation (`games/magic/ui/src/play/live/frame-watch.ts`'s
 * header has the case). A page left alone is only measurable without one, so this records nothing but a
 * browser trace: per thread, the CPU its top-level tasks took (the thread's own clock, so a loaded host
 * moves the wall but not this), and the heaviest kinds of work inside them.
 *
 * The real players this was built for spend their bad frames outside our script (prod's `perf` events,
 * 2026-11-06..20: our own JS is a median 2 % of a slow stretch), on the renderer's style and paint, the
 * compositor, the raster workers and the GPU process — the threads this reads.
 */
import type { Browser, CDPSession, Page } from '@playwright/test';

import { resizeWindow } from '../play/board.ts';

interface Event {
  name: string;
  cat?: string;
  ph: string;
  ts: number;
  dur?: number;
  tdur?: number;
  pid: number;
  tid: number;
  args?: Record<string, unknown> & { name?: string; data?: Record<string, unknown> };
}

/** One thread's cost over the window. */
export interface ThreadCost {
  process: string;
  thread: string;
  /** CPU of its top-level tasks, ms per second of window. */
  cpuPerS: number;
  /** Wall time of the same tasks, ms per second. */
  wallPerS: number;
  /** The heaviest kinds of work inside them, self CPU ms per second. */
  top: [string, number][];
}

export interface ThreadReport {
  ms: number;
  threads: ThreadCost[];
  /** Frames the page's compositor produced, per second. */
  framesPerS: number;
  /** Animations the trace saw that could not run on the compositor: `name (properties)` → count. */
  notComposited: [string, number][];
  /** The page's main thread's longest top-level tasks, by CPU. */
  longest: { cpuMs: number; wallMs: number }[];
}

const TOP = new Set(['ThreadControllerImpl::RunTask', 'ThreadPool_RunTask', 'RunTask']);
const CATEGORIES = [
  'toplevel',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'blink.animations',
  'cc',
  'gpu',
  'viz',
  'blink',
  'v8',
  'blink.user_timing',
  'blink.console',
  '__metadata',
];

/** Kinds of work worth naming; anything else counts toward its task but is not listed by name. */
const NAMED = new Set([
  'UpdateLayoutTree',
  'Layout',
  'Paint',
  'PrePaint',
  'Layerize',
  'UpdateLayer',
  'CompositeLayers',
  'Commit',
  'RasterTask',
  'ImageDecodeTask',
  'Decode Image',
  'ImageDecode',
  'FunctionCall',
  'EvaluateScript',
  'v8.run',
  'MajorGC',
  'MinorGC',
  'V8.GC_SCAVENGER',
  'BlinkGC.AtomicPhase',
  'ProxyMain::BeginMainFrame',
  'LayerTreeHostImpl::PrepareToDraw',
  'Display::DrawAndSwap',
  'SkiaOutputSurfaceImplOnGpu::SwapBuffers',
  'GpuChannel::ExecuteDeferredRequest',
  'DrawFrame',
  'TileManager::FlushAndIssueSignals',
  'Animation',
  'HitTest',
  'ParseHTML',
  'ResourceReceivedData',
]);

export interface ThreadTrace {
  stop(): Promise<ThreadReport>;
}

/** Start a browser-wide trace; `stop()` reports `page`'s renderer with the browser's and the GPU process's threads. */
export async function traceThreads(browser: Browser, page: Page): Promise<ThreadTrace> {
  const seats = await traceSeats(browser, [{ label: 'page', page }]);
  return {
    async stop() {
      const r = await seats.stop();
      const [page, shared] = [r.page!, r.shared!];
      return { ...page, threads: [...page.threads, ...shared.threads].sort((a, b) => b.cpuPerS - a.cpuPerS) };
    },
  };
}

/**
 * Start a browser-wide trace of several pages at once; `stop()` reports each page's renderer under its label,
 * and the browser's and GPU process's threads, which every page shares, once under `shared`.
 */
export async function traceSeats(browser: Browser, pages: { label: string; page: Page }[]): Promise<{ stop(): Promise<Record<string, ThreadReport>> }> {
  const events: Event[] = [];
  const tracer: CDPSession = await browser.newBrowserCDPSession();
  tracer.on('Tracing.dataCollected', ({ value }) => events.push(...(value as unknown as Event[])));
  await tracer.send('Tracing.start', { traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: CATEGORIES }, transferMode: 'ReportEvents' });
  const startedAt = Date.now();
  return {
    async stop() {
      const ms = Date.now() - startedAt;
      // Each page names its own renderer: a mark it stamps lands on its process. Neither its URL (two seats share
      // one) nor the trace's start (a cold load can move the page to a new process) can be trusted to.
      for (const [i, { page }] of pages.entries()) await page.evaluate((m) => console.timeStamp(m), `threads-mark-${i}`);
      const done = new Promise<void>((ok) => tracer.once('Tracing.tracingComplete', () => ok()));
      await tracer.send('Tracing.end');
      await done;
      await tracer.detach();
      const pids = new Map<string, number>();
      for (const [i, { label }] of pages.entries()) {
        const mark = events.find((e) => e.name === 'TimeStamp' && (e.args?.data as { message?: string } | undefined)?.message === `threads-mark-${i}`);
        if (mark === undefined) throw new Error(`the trace has no mark from ${label}'s page`);
        pids.set(label, mark.pid);
      }
      return report(events, pids, ms);
    },
  };
}

function report(events: Event[], pids: Map<string, number>, ms: number): Record<string, ThreadReport> {
  const threadName = new Map<string, string>();
  const procName = new Map<number, string>();
  for (const e of events) {
    if (e.ph !== 'M') continue;
    if (e.name === 'thread_name') threadName.set(`${e.pid}:${e.tid}`, e.args?.name ?? '');
    if (e.name === 'process_name') procName.set(e.pid, e.args?.name ?? '');
  }
  const shared = (pid: number): boolean => /GPU|Browser/i.test(procName.get(pid) ?? '');
  const secs = ms / 1000;
  const cpu = (e: Event): number => (e.tdur ?? e.dur ?? 0) / 1000;
  const byThread = new Map<string, Event[]>();
  for (const e of events) {
    if (e.ph !== 'X' || e.dur === undefined) continue;
    const k = `${e.pid}:${e.tid}`;
    let list = byThread.get(k);
    if (list === undefined) byThread.set(k, (list = []));
    list.push(e);
  }

  /** One thread's cost: its outermost tasks' CPU, and its named work's self CPU. */
  const costOf = (k: string, list: Event[], process: string): ThreadCost | null => {
    list.sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0));
    let cpuMs = 0;
    let wallMs = 0;
    let outerEnd = -1;
    const self = new Map<string, number>();
    const open: { end: number; name: string | null }[] = [];
    for (const e of list) {
      const end = e.ts + (e.dur ?? 0);
      if (TOP.has(e.name) && e.ts >= outerEnd) {
        cpuMs += cpu(e);
        wallMs += (e.dur ?? 0) / 1000;
        outerEnd = end;
      }
      while (open.length > 0 && open[open.length - 1]!.end <= e.ts) open.pop();
      if (NAMED.has(e.name)) {
        self.set(e.name, (self.get(e.name) ?? 0) + cpu(e));
        const parent = [...open].reverse().find((o) => o.name !== null);
        if (parent?.name != null) self.set(parent.name, (self.get(parent.name) ?? 0) - cpu(e));
        open.push({ end, name: e.name });
      } else open.push({ end, name: null });
    }
    if (cpuMs < 1) return null;
    return {
      process,
      thread: (threadName.get(k) ?? k).replace(/\d+$/, '').replace(/Worker.*$/, 'Worker'),
      cpuPerS: round(cpuMs / secs),
      wallPerS: round(wallMs / secs),
      top: [...self].filter(([, v]) => v / secs >= 0.5).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, v]) => [n, round(v / secs)]),
    };
  };
  /** Worker pools as one line (CompositorTileWorker1..n, ThreadPoolForegroundWorker..). */
  const merge = (threads: ThreadCost[]): ThreadCost[] => {
    const merged = new Map<string, ThreadCost>();
    for (const t of threads) {
      const key = `${t.process}/${t.thread}`;
      const m = merged.get(key);
      if (m === undefined) {
        merged.set(key, { ...t });
        continue;
      }
      m.cpuPerS = round(m.cpuPerS + t.cpuPerS);
      m.wallPerS = round(m.wallPerS + t.wallPerS);
      const top = new Map(m.top);
      for (const [n, v] of t.top) top.set(n, round((top.get(n) ?? 0) + v));
      m.top = [...top].sort((a, b) => b[1] - a[1]).slice(0, 6);
    }
    return [...merged.values()].sort((a, b) => b.cpuPerS - a.cpuPerS);
  };
  const threadsOf = (want: (pid: number) => boolean, process: (pid: number) => string): ThreadCost[] =>
    merge([...byThread].filter(([k]) => want(Number(k.split(':')[0]))).flatMap(([k, list]) => costOf(k, list, process(Number(k.split(':')[0]))) ?? []));

  const out: Record<string, ThreadReport> = {};
  for (const [label, pid] of pids) {
    let outer = -1;
    const mainTid = [...threadName].find(([k, n]) => n === 'CrRendererMain' && Number(k.split(':')[0]) === pid)?.[0];
    const longest = (byThread.get(mainTid ?? '') ?? [])
      .filter((e) => {
        // Outermost only: a task's own nested RunTask is the same work.
        if (!TOP.has(e.name) || e.ts < outer) return false;
        outer = e.ts + (e.dur ?? 0);
        return true;
      })
      .map((e) => ({ cpuMs: round(cpu(e)), wallMs: round((e.dur ?? 0) / 1000) }))
      .sort((a, b) => b.cpuMs - a.cpuMs)
      .slice(0, 5);
    const drawn = events.filter((e) => e.pid === pid && e.name === 'DrawFrame' && e.ph !== 'e').length;
    const notComposited = new Map<string, number>();
    for (const e of events) {
      if (e.name !== 'Animation' || e.pid !== pid) continue;
      const d = e.args?.data as { compositeFailed?: number; unsupportedProperties?: string[]; name?: string } | undefined;
      if (d?.compositeFailed === undefined || d.compositeFailed === 0) continue;
      const name = `${d.name || '(unnamed)'} (${(d.unsupportedProperties ?? []).join(',') || `reason ${d.compositeFailed}`})`;
      notComposited.set(name, (notComposited.get(name) ?? 0) + 1);
    }
    out[label] = {
      ms,
      threads: threadsOf((p) => p === pid, () => 'renderer'),
      framesPerS: round(drawn / secs),
      notComposited: [...notComposited].sort((a, b) => b[1] - a[1]).slice(0, 15),
      longest,
    };
  }
  out.shared = { ms, threads: threadsOf(shared, (p) => procName.get(p) ?? String(p)), framesPerS: 0, notComposited: [], longest: [] };
  return out;
}

const round = (n: number): number => Math.round(n * 10) / 10;

/** The total CPU, ms per second, of every thread the report lists. */
export const totalCpuPerS = (r: ThreadReport): number => round(r.threads.reduce((s, t) => s + t.cpuPerS, 0));

/** Print `r` as `[tag]` lines, one per thread. */
export function logThreads(tag: string, label: string, r: ThreadReport): void {
  console.log(`[${tag}] ${label}: ${r.ms} ms; all threads ${totalCpuPerS(r)} ms cpu/s; ${r.framesPerS} frames/s; longest main tasks ${r.longest.map((t) => `${t.cpuMs}cpu/${t.wallMs}wall`).join(' ')}; not composited: ${r.notComposited.map(([n, c]) => `${n}×${c}`).join(', ') || 'none'}`);
  for (const t of r.threads) {
    if (t.cpuPerS < 2) continue;
    console.log(`[${tag}] ${label}   ${t.process}/${t.thread}: ${t.cpuPerS} ms cpu/s (${t.wallPerS} wall)  ${t.top.map(([n, v]) => `${n}=${v}`).join(' ')}`);
  }
}

/**
 * What is animating in `page` right now, by name, as prod's `board` events name it (`frame-watch.ts`): a CSS
 * animation by its keyframes, a transition as `t:<property>`, a script animation by its id or `(script)`.
 */
export async function runningAnimations(page: Page): Promise<[string, number][]> {
  return page.evaluate(() => {
    const by = new Map<string, number>();
    for (const a of document.getAnimations()) {
      if (a.playState !== 'running') continue;
      const name = a instanceof CSSAnimation ? a.animationName : a instanceof CSSTransition ? `t:${a.transitionProperty}` : a.id || '(script)';
      by.set(name, (by.get(name) ?? 0) + 1);
    }
    return [...by].sort((x, y) => y[1] - x[1]);
  });
}

/**
 * Give `page` a real player's screen: `size` CSS pixels at `dpr` device pixels each (prod's `env` events: 1.5
 * is the common ratio). Kept for the page's life, across navigations: the session is never detached.
 */
export async function emulateScreen(page: Page, size: { width: number; height: number }, dpr: number): Promise<void> {
  await resizeWindow(page, size);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: dpr, mobile: false });
}

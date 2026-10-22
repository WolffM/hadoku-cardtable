/**
 * Chrome-trace and CPU-profile reading shared by the perf specs (`w69-perf.spec.ts`, `combat-perf.spec.ts`):
 * spans per thread, main-thread work per frame split by kind, the heaviest frames, and self time per
 * function mapped through the UI build's source maps.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { SourceMap } from 'node:module';
import { resolve } from 'node:path';

import type { Page } from '@playwright/test';

export const CATEGORIES = [
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

export type Kind = 'script' | 'style' | 'layout' | 'paint' | 'other';
export const KIND: Record<string, Kind> = {
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
export const SCRIPT_ROOTS = new Set(['FunctionCall', 'EvaluateScript', 'EventDispatch', 'TimerFire', 'FireAnimationFrame', 'RunMicrotasks', 'v8.callFunction', 'V8.Execute']);
export const TOP = new Set(['RunTask', 'ThreadControllerImpl::RunTask', 'ThreadPool_RunTask']);

export interface TraceEvent {
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
export interface StackFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}
export interface Span {
  name: string;
  ts: number;
  end: number;
  children: Span[];
}

export const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
export const f1 = (n: number): string => n.toFixed(1);
export const f2 = (n: number): string => n.toFixed(2);

/** The spans on one thread, nested, built from complete (`X`) and begin/end (`B`/`E`) events. */
export function spansOf(events: TraceEvent[]): Span[] {
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

export interface FrameWork {
  total: number;
  by: Record<Kind, number>;
  forced: number;
}

/** Main-thread work, in ms, inside [from, to), by kind; a forced layout is one under script. */
export function workIn(roots: Span[], from: number, to: number): FrameWork {
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

export interface Seen {
  starts: number[];
  frames: number;
  interval: number[];
  work: FrameWork[];
}

export function framesOf(events: TraceEvent[], from: number, to: number): Seen {
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
export function worstFrames(thread: TraceEvent[], seen: Seen, n: number): string {
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
export const MAPS = new Map<string, SourceMap | null>();
export function mapped(url: string, line: number, col: number): string {
  const file = url.split('/').pop() ?? '';
  if (!file.endsWith('.js')) return `${file}:${line + 1}:${col + 1}`;
  if (!MAPS.has(file)) {
    const dir = resolve(import.meta.dirname, '..', '..', 'apps/ui/dist/assets');
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

export interface CpuProfile {
  nodes: { id: number; children?: number[]; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number } }[];
  samples: number[];
  timeDeltas: number[];
}
/**
 * Self time per function, top `n`, ms over the whole profile. `inApp`: a browser built-in's own time
 * (a forced layout inside `getBoundingClientRect`, say) is charged to the nearest app function that
 * called it, with the built-in's name after it — the line to read for what to change.
 */
export function topSelf(profile: CpuProfile, n: number, inApp = false): string {
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


/** A rAF on every frame: makes every frame a `FireAnimationFrame` in the trace, which bounds it. */
export const tickEveryFrame = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const w = window as unknown as { __w69tick?: boolean };
    if (w.__w69tick === true) return;
    w.__w69tick = true;
    const tick = (): void => {
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

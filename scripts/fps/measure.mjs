/*
 * Browser-fps measurement: drives the built harness (`build.mjs`) in Chromium or Firefox and writes
 * one TSV row per board × animation × condition. Uses e2e's own Playwright, never the shared MCP browser.
 *
 *   node scripts/fps/measure.mjs frames  --browser chromium --throttle 1,4,6 --viewport desktop --out <tsv>
 *   node scripts/fps/measure.mjs trace   --throttle 4 --out <tsv>          (Chromium: where the time goes)
 *   node scripts/fps/measure.mjs leak    --minutes 10 --out <tsv>          (Chromium: heap + DOM over a loop)
 *
 * --drop-rules <regex> (frames, trace): CSS rules whose selector matches are deleted in the page before
 * recording — an A/B for a rule's cost that edits nothing in the app.
 *
 * Common: --dist <built harness dir> (default ~/.cache/cardtable-fps/dist), --cases a/b,c/d (board/anim),
 * --secs N recording window, --repeat N.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadavg } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from './serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, '../../e2e/package.json'));
const { chromium, firefox } = require('@playwright/test');
// source-map-js, through the toolchain that already carries it: apps/ui's vite → its postcss → source-map-js.
const viteEntry = createRequire(resolve(here, '../../apps/ui/package.json')).resolve('vite');
const postcssEntry = createRequire(viteEntry).resolve('postcss');
const { SourceMapConsumer } = createRequire(postcssEntry)('source-map-js');

const mode = process.argv[2];
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const dist = arg('dist', resolve(process.env.HOME, '.cache/cardtable-fps/dist'));
const out = arg('out', null);
const secs = Number(arg('secs', '8'));
const repeat = Number(arg('repeat', '1'));
const browserName = arg('browser', 'chromium');
const viewportName = arg('viewport', 'desktop');
const throttles = arg('throttle', '1').split(',').map(Number);
const dropRules = arg('drop-rules', null);

/** board query → label. `crowded-nofly` is `crowded` with the flyers swapped for ground creatures. */
const BOARDS = {
  early: 'size=early',
  mid: 'size=mid',
  crowded: 'size=crowded',
  'crowded-nofly': 'size=crowded&flyers=0',
  huge: 'size=huge',
};
const DEFAULT_CASES = [
  'early/idle', 'early/hover', 'early/click',
  'mid/idle', 'mid/tap', 'mid/attack', 'mid/stack', 'mid/hover', 'mid/click',
  'crowded/idle', 'crowded-nofly/idle', 'crowded/tap', 'crowded/attack', 'crowded/stack', 'crowded/hover', 'crowded/click',
  'huge/idle', 'huge/tap', 'huge/attack', 'huge/stack', 'huge/hover', 'huge/click',
];
const cases = (arg('cases', null)?.split(',') ?? DEFAULT_CASES).map((c) => {
  const [board, anim] = c.split('/');
  if (BOARDS[board] === undefined) throw new Error(`unknown board ${board}`);
  return { board, anim };
});

const VIEWPORTS = {
  desktop: { viewport: { width: 1920, height: 1080 } },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};
/** One packet per this many ms: Forge's own pace in a busy turn is a frame every few hundred ms. */
const LOOP_PERIOD = { tap: 1200, attack: 1000, stack: 1000, mix: 400 };

const q = (xs, p) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const load = () => loadavg()[0].toFixed(1);

function writeRow(header, row) {
  const line = header.map((h) => row[h] ?? '-').join('\t');
  console.log(line);
  if (out === null) return;
  if (!existsSync(out)) writeFileSync(out, header.join('\t') + '\n');
  appendFileSync(out, line + '\n');
}

async function launch(name) {
  return name === 'firefox' ? firefox.launch() : chromium.launch({ channel: 'chromium' });
}

async function openBoard(browser, board, viewport) {
  const context = await browser.newContext(VIEWPORTS[viewport]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${server.url}/harness.html?${BOARDS[board]}`);
  await page.waitForFunction(() => document.querySelectorAll('[data-card-id]').length > 0, null, { timeout: 30_000 });
  // Art from the CDN decoded, entry motion over.
  // Not `networkidle`: the app's own calls the harness has no server for (`/session/whoami`,
  // `/api/sounds/…`) keep the network from ever going idle, and every case waited out the 30 s timeout.
  await page
    .waitForFunction(() => [...document.images].every((img) => img.complete), null, { timeout: 10_000 })
    .catch(() => {});
  await page.waitForTimeout(2000);
  const dropped = dropRules === null ? 0 : await page.evaluate((source) => {
    const re = new RegExp(source);
    let n = 0;
    const walk = (rules, owner) => {
      for (let i = rules.length - 1; i >= 0; i--) {
        const r = rules[i];
        if (r.selectorText === undefined && r.cssRules !== undefined) walk(r.cssRules, r);
        else if (re.test(r.selectorText ?? '')) {
          owner.deleteRule(i);
          n += 1;
        }
      }
    };
    for (const sheet of document.styleSheets) walk(sheet.cssRules, sheet);
    return n;
  }, dropRules);
  return { context, page, errors, dropped };
}

/** Viewport points over battlefield and hand cards, for the input drivers. */
async function cardPoints(page) {
  return page.evaluate(() => {
    const seen = new Set();
    const pts = [];
    for (const el of document.querySelectorAll('[data-card-id]')) {
      const id = el.getAttribute('data-card-id');
      if (seen.has(id)) continue;
      seen.add(id);
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 20 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      pts.push([Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]);
    }
    return pts;
  });
}

async function drive(page, anim, viewport, ms) {
  const end = Date.now() + ms;
  if (anim === 'hover' || anim === 'click') {
    const pts = await cardPoints(page);
    let i = 0;
    while (Date.now() < end && pts.length > 0) {
      const [x, y] = pts[i++ % pts.length];
      if (anim === 'hover') {
        await page.mouse.move(x, y, { steps: 4 });
        await page.waitForTimeout(300);
      } else {
        if (viewport === 'phone') await page.touchscreen.tap(x, y);
        else await page.mouse.click(x, y);
        await page.waitForTimeout(250);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(250);
      }
    }
  }
  const rest = end - Date.now();
  if (rest > 0) await page.waitForTimeout(rest);
}

async function frames() {
  const header = ['browser', 'viewport', 'throttle', 'board', 'anim', 'run', 'n_frames', 'fps_p50', 'frame_p95_ms', 'frame_p99_ms', 'over16_7_pct', 'over33_pct', 'worst_ms', 'longtasks', 'longtask_ms_total', 'loaf_n', 'loaf_script_ms', 'loaf_stylelayout_ms', 'input_n', 'input_p50_ms', 'input_p95_ms', 'evt_n', 'evt_p95_ms', 'dom_nodes', 'load1_before', 'load1_after', 'dropped_rules', 'errors'];
  const browser = await launch(browserName);
  for (const throttle of throttles) {
    for (const { board, anim } of cases) {
      for (let run = 1; run <= repeat; run++) {
        const before = load();
        const { context, page, errors, dropped } = await openBoard(browser, board, viewportName);
        if (browserName === 'chromium' && throttle !== 1) {
          const cdp = await context.newCDPSession(page);
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
        }
        if (LOOP_PERIOD[anim] !== undefined) {
          await page.evaluate(([a, p]) => window.fps.loop(a, p), [anim, LOOP_PERIOD[anim]]);
          await page.waitForTimeout(1500);
        }
        await page.evaluate(() => window.fps.start());
        await drive(page, anim, viewportName, secs * 1000);
        const r = await page.evaluate(() => {
          window.fps.stop();
          return { ...window.fps.take(), dom: document.getElementsByTagName('*').length };
        });
        const fr = r.frames;
        writeRow(header, {
          browser: browserName,
          viewport: viewportName,
          throttle: browserName === 'chromium' ? `${throttle}x` : 'none',
          board,
          anim,
          run,
          n_frames: fr.length,
          fps_p50: f1(1000 / q(fr, 0.5)),
          frame_p95_ms: f1(q(fr, 0.95)),
          frame_p99_ms: f1(q(fr, 0.99)),
          over16_7_pct: f1((100 * fr.filter((x) => x > 16.7 * 1.25).length) / fr.length),
          over33_pct: f1((100 * fr.filter((x) => x > 33.4).length) / fr.length),
          worst_ms: f1(Math.max(...fr)),
          longtasks: r.longtasks.length,
          longtask_ms_total: f1(r.longtasks.reduce((s, x) => s + x, 0)),
          loaf_n: r.loaf.length,
          loaf_script_ms: f1(r.loaf.reduce((s, x) => s + x.script, 0)),
          loaf_stylelayout_ms: f1(r.loaf.reduce((s, x) => s + x.styleLayout, 0)),
          input_n: r.inputs.length,
          input_p50_ms: f1(q(r.inputs, 0.5)),
          input_p95_ms: f1(q(r.inputs, 0.95)),
          evt_n: r.events.length,
          evt_p95_ms: f1(q(r.events.map((e) => e.duration), 0.95)),
          dom_nodes: r.dom,
          load1_before: before,
          load1_after: load(),
          dropped_rules: dropRules === null ? '' : `${dropped}:${dropRules}`,
          errors: errors.length === 0 ? '' : errors.slice(0, 2).join(' | ').replace(/\s+/g, ' ').slice(0, 200),
        });
        await context.close();
      }
    }
  }
  await browser.close();
}

/** Chromium trace: main-thread time by kind, and the forced (in-script) layouts that are thrash. */
const KIND = {
  script: ['FunctionCall', 'EvaluateScript', 'v8.compile', 'TimerFire', 'EventDispatch', 'FireAnimationFrame', 'RunMicrotasks', 'v8.callFunction', 'FireIdleCallback'],
  style: ['UpdateLayoutTree', 'RecalculateStyles', 'ScheduleStyleRecalculation', 'ParseAuthorStyleSheet'],
  layout: ['Layout', 'UpdateLayerTree', 'PrePaint', 'IntersectionObserverController::computeIntersections'],
  paint: ['Paint', 'PaintImage', 'Decode Image', 'ImageDecodeTask', 'RasterTask', 'Rasterize'],
  composite: ['CompositeLayers', 'Layerize', 'Commit', 'UpdateLayer', 'ActivateLayerTree', 'DrawFrame'],
};
const kindOf = new Map(Object.entries(KIND).flatMap(([k, names]) => names.map((n) => [n, k])));

async function trace() {
  const header = ['viewport', 'throttle', 'board', 'anim', 'window_ms', 'script_ms', 'style_ms', 'layout_ms', 'paint_ms', 'composite_ms', 'layouts', 'forced_layouts', 'forced_layout_ms', 'style_recalcs', 'style_elements_p95', 'full_restyles', 'full_restyle_ms', 'dropped_rules', 'top_forced_from', 'top_script_fns', 'load1'];
  const browser = await launch('chromium');
  for (const throttle of throttles) {
    for (const { board, anim } of cases) {
      const { context, page, dropped } = await openBoard(browser, board, viewportName);
      const cdp = await context.newCDPSession(page);
      if (throttle !== 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
      if (LOOP_PERIOD[anim] !== undefined) {
        await page.evaluate(([a, p]) => window.fps.loop(a, p), [anim, LOOP_PERIOD[anim]]);
        await page.waitForTimeout(1500);
      }
      const events = [];
      cdp.on('Tracing.dataCollected', ({ value }) => events.push(...value));
      const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
      await cdp.send('Profiler.start');
      await cdp.send('Tracing.start', {
        categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,blink,cc,gpu,v8.execute',
        transferMode: 'ReportEvents',
      });
      const t0 = Date.now();
      await drive(page, anim, viewportName, secs * 1000);
      const windowMs = Date.now() - t0;
      await cdp.send('Tracing.end');
      await done;
      const { profile } = await cdp.send('Profiler.stop');
      await page.evaluate(() => window.fps.stop());

      // The renderer's main thread: the thread that ran the most FunctionCalls.
      const calls = new Map();
      for (const e of events) if (e.name === 'FunctionCall') calls.set(`${e.pid}:${e.tid}`, (calls.get(`${e.pid}:${e.tid}`) ?? 0) + 1);
      const main = [...calls.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const sums = { script: 0, style: 0, layout: 0, paint: 0, composite: 0 };
      let layouts = 0;
      let forced = 0;
      let forcedMs = 0;
      const forcedFrom = new Map();
      const styleElements = [];
      // A restyle of more elements than this is the whole board's, not one card's.
      let fullRestyles = 0;
      let fullRestyleMs = 0;
      // Self time per kind: sort complete events on the main thread and subtract children.
      const evs = events
        .filter((e) => `${e.pid}:${e.tid}` === main && e.ph === 'X' && typeof e.dur === 'number')
        .sort((a, b) => a.ts - b.ts || b.dur - a.dur);
      const stack = [];
      for (const e of evs) {
        while (stack.length > 0 && stack.at(-1).ts + stack.at(-1).dur <= e.ts) stack.pop();
        const parent = stack.at(-1);
        const kind = kindOf.get(e.name);
        if (parent !== undefined && kindOf.get(parent.name) !== undefined && kind !== undefined) parent.self -= e.dur;
        e.self = e.dur;
        e.kind = kind;
        if (e.name === 'Layout') {
          layouts += 1;
          // A layout inside script is forced: the script read geometry after a write.
          if (stack.some((s) => kindOf.get(s.name) === 'script')) {
            forced += 1;
            forcedMs += e.dur / 1000;
            const frame = e.args?.beginData?.stackTrace?.[0] ?? null;
            const at = frame === null ? 'unknown' : sourceOf(frame.functionName || '(anon)', frame.lineNumber, (frame.columnNumber ?? 1) - 1);
            forcedFrom.set(at, (forcedFrom.get(at) ?? 0) + e.dur / 1000);
          }
        }
        if (e.name === 'UpdateLayoutTree' && typeof e.args?.elementCount === 'number') {
          styleElements.push(e.args.elementCount);
          if (e.args.elementCount > 1000) {
            fullRestyles += 1;
            fullRestyleMs += e.dur / 1000;
          }
        }
        stack.push(e);
      }
      for (const e of evs) if (e.kind !== undefined) sums[e.kind] += Math.max(0, e.self) / 1000;
      // Compositor/raster threads: paint and composite also run off the main thread.
      for (const e of events) {
        if (`${e.pid}:${e.tid}` === main || e.ph !== 'X' || typeof e.dur !== 'number') continue;
        const kind = kindOf.get(e.name);
        if (kind === 'paint' || kind === 'composite') sums[kind] += e.dur / 1000;
      }
      writeRow(header, {
        viewport: viewportName,
        throttle: `${throttle}x`,
        board,
        anim,
        window_ms: windowMs,
        script_ms: f1(sums.script),
        style_ms: f1(sums.style),
        layout_ms: f1(sums.layout),
        paint_ms: f1(sums.paint),
        composite_ms: f1(sums.composite),
        layouts,
        forced_layouts: forced,
        forced_layout_ms: f1(forcedMs),
        style_recalcs: styleElements.length,
        style_elements_p95: q(styleElements, 0.95) ?? '-',
        full_restyles: fullRestyles,
        full_restyle_ms: f1(fullRestyleMs),
        dropped_rules: dropRules === null ? '' : `${dropped}:${dropRules}`,
        top_forced_from: [...forcedFrom.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}=${f1(v)}`).join(' '),
        top_script_fns: topFunctions(profile, 5),
        load1: load(),
      });
      await context.close();
    }
  }
  await browser.close();
}

/** The bundle's source map, so a profile's or a trace's bundle line reads as the app's own `file:line`. */
let consumer;
function sourceOf(name, line, column) {
  if (consumer === undefined) {
    const map = readdirSync(resolve(dist, 'assets')).find((f) => /^harness-.*\.js\.map$/.test(f));
    consumer = map === undefined ? null : new SourceMapConsumer(JSON.parse(readFileSync(resolve(dist, 'assets', map), 'utf8')));
  }
  const at = consumer?.originalPositionFor({ line, column: Math.max(0, column) });
  if (at?.source == null) return `${name}@bundle:${line}`;
  const file = at.source.replace(/^.*?(apps\/ui\/src\/|packages\/|scripts\/fps\/|node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?)/, '$1').replace(/^node_modules\/\.pnpm\/[^/]+\/node_modules\//, '');
  return `${name}@${file}:${at.line}`;
}

/** The CPU profile's top functions by self time, as `name@file:line=ms`. */
function topFunctions(profile, n) {
  const dt = new Map();
  for (let i = 0; i < profile.samples.length; i++) dt.set(profile.samples[i], (dt.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0));
  const self = new Map();
  for (const node of profile.nodes) {
    const cf = node.callFrame;
    if (cf.url === '' || cf.functionName === '(program)' || cf.functionName === '(idle)' || cf.functionName === '(garbage collector)') continue;
    const k = sourceOf(cf.functionName || '(anon)', cf.lineNumber + 1, cf.columnNumber);
    self.set(k, (self.get(k) ?? 0) + (dt.get(node.id) ?? 0) / 1000);
  }
  return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}=${f1(v)}`).join(' ');
}

/** Heap and DOM over a long loop of state updates: a leak grows with time, a cache plateaus. */
async function leak() {
  const minutes = Number(arg('minutes', '10'));
  const board = arg('board', 'crowded');
  const header = ['board', 'minute', 'packets_sent', 'heap_used_mb', 'heap_total_mb', 'dom_nodes', 'js_listeners', 'documents', 'fps_p50_last10s', 'frame_p95_last10s', 'load1'];
  const browser = await launch('chromium');
  const { context, page } = await openBoard(browser, board, viewportName);
  const cdp = await context.newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('Memory.enable').catch(() => {});
  let packets = 0;
  const sample = async (minute) => {
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage');
    const dom = await cdp.send('Memory.getDOMCounters');
    await page.evaluate(() => window.fps.start());
    await page.waitForTimeout(10_000);
    const r = await page.evaluate(() => window.fps.take());
    writeRow(header, {
      board,
      minute,
      packets_sent: packets,
      heap_used_mb: f1(heap.usedSize / 1048576),
      heap_total_mb: f1(heap.totalSize / 1048576),
      dom_nodes: dom.nodes,
      js_listeners: dom.jsEventListeners,
      documents: dom.documents,
      fps_p50_last10s: f1(1000 / q(r.frames, 0.5)),
      frame_p95_last10s: f1(q(r.frames, 0.95)),
      load1: load(),
    });
  };
  await sample(0);
  await page.evaluate((p) => window.fps.loop('mix', p), LOOP_PERIOD.mix);
  const start = Date.now();
  for (let m = 1; m <= minutes; m++) {
    const wait = start + m * 60_000 - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    packets = Math.round((Date.now() - start) / LOOP_PERIOD.mix);
    await sample(m);
  }
  await page.evaluate(() => window.fps.stop());
  await context.close();
  await browser.close();
}

const server = await serve(dist);
try {
  if (mode === 'frames') await frames();
  else if (mode === 'trace') await trace();
  else if (mode === 'leak') await leak();
  else throw new Error(`mode must be frames, trace or leak; got ${mode}`);
} finally {
  server.close();
}

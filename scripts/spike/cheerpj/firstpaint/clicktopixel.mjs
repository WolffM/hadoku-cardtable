// Wave 15, lane D -- drive the click-to-pixel rig and print every number, as
// JSON, to stdout.
//
//   node clicktopixel.mjs <url> [--reps 40] [--hold 50] [--quiet 300]
//                               [--budget 3000] [--target-x N --target-y N]
//                               [--no-click] [--ready PAINT-READY]
//                               [--strip-w 520 --strip-h 30]
//
// The protocol is Wave 14 lane C's, from docs/spikes/streaming.md:
//   "every figure below uses a fixed 50 ms hold and starts the clock at the
//    press" -- so --hold defaults to 50 and the clock starts at mousedown.
// n defaults to 40 and the output is min / median / p95 / max, because that is
// the shape streaming.md reports and a number in a different shape is not a
// comparison.
//
// EXIT CODES ARE A VERDICT ON THE RIG, NOT ON CHEERPJ:
//   0  the rig produced a distribution it can justify
//   1  the rig could not measure (no canvas, blank baseline, the warm-up click
//      changed nothing, or every rep was dropped) -- NO number is printed as if
//      it were real
//   2  bad usage
//
// playwright-core is resolved read-only out of the repo's existing pnpm store.
// Nothing is installed and no pnpm command is run.

import { createRequire } from 'node:module';
import { treeRssKb } from './procrss.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'playwright-core');

const argv = process.argv.slice(2);
const url = argv[0];
if (!url || url.startsWith('--')) { console.error('usage: clicktopixel.mjs <url> [opts]'); process.exit(2); }
// lastIndexOf, not indexOf: run.sh supplies the protocol's defaults first and
// anything the caller adds comes after, so the LAST occurrence must win.
const flag = (name, dflt) => {
  const i = argv.lastIndexOf('--' + name);
  return i === -1 ? dflt : Number(argv[i + 1]);
};
const has = (name) => argv.includes('--' + name);
const str = (name, dflt) => { const i = argv.lastIndexOf('--' + name); return i === -1 ? dflt : argv[i + 1]; };

const REPS = flag('reps', 40);
const HOLD = flag('hold', 50);
const QUIET = flag('quiet', 300);
const BUDGET = flag('budget', 3000);
const STRIP_W = flag('strip-w', 520);
const STRIP_H = flag('strip-h', 30);
const NO_CLICK = has('no-click');
const READY = str('ready', 'PAINT-READY');        // 'none' = no console marker to wait for
// --inject <path>: run rig.js in a page we do not own (e.g. noVNC), so BOTH
// sides of the comparison are measured by one instrument.
const INJECT = str('inject', null);
const SETTLE = flag('settle', 0);                 // ms to wait after load when READY is 'none'
const SELECTOR = str('selector', null);
// Detection sensitivity, exposed because it turned out to be load-bearing.
// rfb-latency.py uses --threshold 2.0, i.e. 2% of the watched rectangle must
// differ. This rig defaulted to 24 pixels of a 520x30 strip = 0.15%, about 13x
// more sensitive, and at that setting it triggers on a small press-driven
// repaint that streaming's harness never sees. --min-pixels-pct expresses the
// threshold the same way rfb-latency.py does.
const MIN_PCT = flag('min-pixels-pct', null);
const MIN_PIXELS = flag('min-pixels', null);
// Reuse a browser profile across runs, so CheerpJ's /files/ mount survives and
// the boot skips the unpack. See the launch site for why this is sound for an
// interaction number and wrong for a cold-load one.
const USER_DATA_DIR = str('user-data-dir', null);
// --pre <step> (repeatable): navigation performed AFTER boot and BEFORE the
// warm-up, in the same grammar explore.mjs uses -- click:<canvasX>,<canvasY> /
// wait:<ms> / shot:<name>. Forge's match UI is several screens in from its home
// screen, so getting there is part of the measurement setup, not part of the
// measurement.
const PRE = argv.reduce((a, v, i) => (v === '--pre' ? [...a, argv[i + 1]] : a), []);
const SHOT = str('screenshot', null);
// --clicks X,Y (repeatable) and --watch X,Y,W,H, both in CANVAS coordinates and
// both deliberately the same options scripts/spike/stream/rfb-latency.py takes.
// streaming.md's 63.7 ms was taken by alternating between the left-menu entries
// "Constructed" (68,253) and "Booster Draft" (71,285) and watching the
// "Sanctioned Format: ..." heading at 420,50,520,30. Clicking ONE target
// repeatedly measures nothing after the first rep (the second click on an
// already-selected item changes no pixels), which is why alternation is part
// of the protocol and not a detail.
const CLICKS = argv.reduce((a, v, i) => (v === '--clicks' ? [...a, argv[i + 1]] : a), [])
  .map((c) => { const [x, y] = c.split(',').map(Number); return { x, y }; });
const WATCH = (() => {
  const w = str('watch', null);
  if (!w) return null;
  const [x, y, ww, hh] = w.split(',').map(Number);
  return { x, y, w: ww, h: hh };
})();
const BOOT_BUDGET = flag('boot-budget', 180_000);
// The driver presses at a deterministic point after arm() resolves, which pins
// the press to a fixed phase of the 16.7 ms compositor frame clock and makes
// the composited-frame figure artificially tight. --jitter N waits a uniform
// 0..N ms first. With N > one frame the composited figure should SPREAD by
// about a frame while the backing-store figure should not move at all; that is
// the test that the gap between the two is frame-boundary wait and not
// something CheerpJ is doing.
const JITTER = flag('jitter', 0);

const pct = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
};
const stats = (a) => a.length ? {
  n: a.length,
  min: +pct(a, 0).toFixed(1),
  median: +pct(a, 0.5).toFixed(1),
  p95: +pct(a, 0.95).toFixed(1),
  max: +pct(a, 1).toFixed(1),
  mean: +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(1),
} : { n: 0 };

// A brand-new context every run: nothing is cached, so the transfer figures
// below are cold-cache figures by construction rather than by assertion.
//
// --user-data-dir gives that up ON PURPOSE, and only for click-to-pixel. With a
// persistent profile CheerpJ's /files/ mount survives from the previous run, so
// the ~30 s res/ unpack and the cold card load are skipped: a run costs ~3 min
// instead of ~10. That is sound for an INTERACTION number -- click-to-pixel is
// measured long after boot, against the same painted UI either way -- and it is
// NOT sound for a cold-load figure. Every transfer/boot number in this doc comes
// from a run WITHOUT this flag; coldload.mjs never takes it.
//
// It does NOT route around the boot stall described in cheerpj-firstpaint.md
// (§"The cold unpack stalls"). That was the hope when this flag was added and
// it was measured to be false: two runs with a persistent profile stalled in
// the unpack exactly as the fresh-profile runs did, so /files/ is evidently not
// surviving between runs here. Why it does not is unverified — lane B measured
// /files/ persisting across page loads WITHIN one browser, which is a weaker
// claim than across processes. Do not assume this flag makes a run cheap until
// someone shows a run that actually skipped the unpack.
const browser = USER_DATA_DIR
  ? await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: true, viewport: { width: 1280, height: 900 },
    })
  : await chromium.launch({ headless: true });
const page = USER_DATA_DIR
  ? (browser.pages()[0] || await browser.newPage())
  : await browser.newPage({ viewport: { width: 1280, height: 900 } });
// Baseline the browser's resident memory BEFORE the page does anything, so the
// reported cost is a delta and not a Chrome installation.
const browserPid = process.pid;   // the browser is our child; see procrss.mjs
await page.waitForTimeout(500);
const rssBlank = treeRssKb(browserPid, { excludeRoot: true });

if (INJECT) await page.addInitScript({ path: INJECT });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
const transfer = new Map();
page.on('requestfinished', async (req) => {
  try {
    const { responseBodySize, responseHeadersSize } = await req.sizes();
    const o = new URL(req.url()).origin;
    const e = transfer.get(o) || { bytes: 0, requests: 0 };
    e.bytes += (responseBodySize || 0) + (responseHeadersSize || 0);
    e.requests += 1;
    transfer.set(o, e);
  } catch { /* request gone with the navigation */ }
});

const fail = async (why, extra = {}) => {
  const lines = await page.evaluate(() => (window.__fp && window.__fp.lines ? window.__fp.lines.map((l) => `${l.t.toFixed(0)}ms ${l.s}`) : [])).catch(() => []);
  const marks = await page.evaluate(() => (window.__fp ? window.__fp.marks : {})).catch(() => ({}));
  console.log(JSON.stringify({
    url, ok: false, why, ...extra, marks, pageErrors,
    transferByOrigin: Object.fromEntries(transfer),
    lines,
  }, null, 2));
  await browser.close();
  process.exit(1);
};

const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded' });

// Boot: wait for the target's own readiness marker. Not a fixed sleep -- a
// sleep that is too short reads as "nothing rendered" and a sleep that is too
// long hides how slow the boot was.
let booted = false;
if (READY === 'none') {
  // No console marker: the page is not ours. Wait for the rig and a canvas,
  // then settle. This still cannot pass while measuring nothing -- the blank
  // baseline and no-change-on-warmup gates below are what stop that.
  await page.waitForFunction(() => !!(window.__fp && window.__fp.ctp), null, { timeout: BOOT_BUDGET });
  await page.waitForFunction(() => document.querySelector('canvas'), null, { timeout: BOOT_BUDGET });
  if (SETTLE) await page.waitForTimeout(SETTLE);
  booted = true;
}
while (!booted && Date.now() - t0 < BOOT_BUDGET) {
  const r = await page.evaluate((m) => {
    const S = window.__fp;
    if (!S) return { ready: false };
    if (S.error) return { ready: false, error: S.error };
    const hit = S.lines.find((l) => l.s.startsWith(m));
    return { ready: !!hit, at: hit ? hit.t : null };
  }, READY);
  if (r.ready) { booted = true; break; }
  if (r.error) await fail('PAGE-ERROR', { error: r.error });
  await page.waitForTimeout(250);
}
if (!booted) await fail('NO-READY-MARKER', { readyMarker: READY, waitedMs: Date.now() - t0 });

const bootMs = READY === 'none' ? null : await page.evaluate((m) => {
  const S = window.__fp;
  const hit = S.lines.find((l) => l.s.startsWith(m));
  return hit ? hit.t : null;
}, READY);

// ---- attach the rig -------------------------------------------------------
const att = await page.evaluate((sel) => window.__fp.ctp.attach(sel), SELECTOR);
if (!att.ok) await fail('NO-CANVAS');

if (MIN_PIXELS != null || MIN_PCT != null) {
  const px = WATCH ? WATCH.w * WATCH.h : STRIP_W * STRIP_H;
  const v = MIN_PIXELS != null ? MIN_PIXELS : Math.max(1, Math.round(px * MIN_PCT / 100));
  await page.evaluate((n) => { window.__fp.ctp.MIN_PIXELS = n; }, v);
}
const box = await page.evaluate(() => {
  const c = window.__fp.ctp.canvas;
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, cssW: r.width, cssH: r.height, pxW: c.width, pxH: c.height };
});
// --target-cx/--target-cy are CANVAS-relative and are what you want: a target
// read off a screenshot is in canvas coordinates, and the canvas sits at a
// different viewport offset for every viewport size. Getting this wrong put a
// noVNC run's click 60 px away from the widget it was aimed at; the rig
// refused to report a number (40/40 NO-PIXEL-CHANGE) rather than timing
// whatever else happened to move, which is the behaviour this lane wants, but
// the option exists so the mistake is not available.
const CX = flag('target-cx', null);
const CY = flag('target-cy', null);
const toViewport = (p) => ({ x: box.x + p.x * (box.cssW / box.pxW), y: box.y + p.y * (box.cssH / box.pxH) });
let TARGETS = CLICKS.length ? CLICKS.map(toViewport)
  : [{ x: CX != null ? box.x + CX * (box.cssW / box.pxW) : flag('target-x', box.x + box.cssW / 2),
       y: CY != null ? box.y + CY * (box.cssH / box.pxH) : flag('target-y', box.y + box.cssH / 2) }];
// The warm-up click goes on the LAST target so that rep 0, which clicks the
// first, is a real change rather than a click on what is already selected --
// the same reason rfb-latency.py does it.
let WARM = TARGETS[TARGETS.length - 1];
let TX = WARM.x, TY = WARM.y;
// Recomputed after pre-navigation, because awaitcanvas can swap the canvas
// underneath us (splash -> document frame) and every target is relative to it.
const retarget = () => {
  TARGETS = CLICKS.length ? CLICKS.map(toViewport)
    : [{ x: CX != null ? box.x + CX * (box.cssW / box.pxW) : flag('target-x', box.x + box.cssW / 2),
         y: CY != null ? box.y + CY * (box.cssH / box.pxH) : flag('target-y', box.y + box.cssH / 2) }];
  WARM = TARGETS[TARGETS.length - 1];
  TX = WARM.x; TY = WARM.y;
};

// ---- warm-up click: LOCATE what a click changes ---------------------------
// This is also the rig's first chance to fail honestly. If a click changes no
// pixels at all, there is nothing here to time and the run ends with exit 1.
// --- pre-navigation --------------------------------------------------------
const clickCanvas = async (cx, cy) => {
  const x = box.x + cx * (box.cssW / box.pxW);
  const y = box.y + cy * (box.cssH / box.pxH);
  await page.mouse.move(x, y);
  await page.waitForTimeout(150);
  await page.mouse.down();
  await page.waitForTimeout(HOLD || 50);
  await page.mouse.up();
};
const shotPath = (name) => (SHOT ? SHOT.replace(/\.png$/, '') + '-' + name + '.png' : null);
const grab = async (name) => {
  const f = shotPath(name);
  if (!f) return null;
  await page.screenshot({ path: f, clip: { x: box.x, y: box.y, width: box.cssW, height: box.cssH } });
  return f;
};
const preLog = [];
for (const st of PRE) {
  const [kind, arg] = st.split(':');
  if (kind === 'click') { const [cx, cy] = arg.split(',').map(Number); await clickCanvas(cx, cy); preLog.push(`click ${cx},${cy}`); }
  else if (kind === 'wait') { await page.waitForTimeout(Number(arg)); preLog.push(`wait ${arg}`); }
  else if (kind === 'shot') { preLog.push(`shot ${await grab(arg)}`); }
  else if (kind === 'awaitcanvas') {
    // Same deterministic signal explore.mjs uses: under CheerpJ each AWT window
    // is its own canvas, so the splash giving way to Forge's document frame is
    // a canvas-size change. Waiting on a fixed sleep instead either races the
    // boot or throws minutes away, and the boot's duration moves with host load
    // by nearly an order of magnitude.
    const [w, h] = arg.split(',')[0].split('x').map(Number);
    const ms = Number(arg.split(',')[1] || 600000);
    const deadline = Date.now() + ms;
    let got = null;
    while (Date.now() < deadline) {
      got = await page.evaluate(() => {
        const cs = [...document.querySelectorAll('canvas')];
        if (!cs.length) return null;
        const c = cs.sort((a, b) => b.width * b.height - a.width * a.height)[0];
        return { pxW: c.width, pxH: c.height };
      }).catch(() => null);
      if (got && got.pxW >= w && got.pxH >= h) break;
      await page.waitForTimeout(2000);
    }
    const ok = !!(got && got.pxW >= w && got.pxH >= h);
    preLog.push(`awaitcanvas ${arg} ${ok ? 'OK' : 'TIMEOUT'} ${got ? got.pxW + 'x' + got.pxH : 'none'}`);
    if (!ok) await fail('AWAITCANVAS-TIMEOUT', { preNavigation: preLog });
    // The canvas just changed identity, so re-attach and re-measure its box.
    await page.evaluate((sel) => window.__fp.ctp.attach(sel), SELECTOR);
    const nb = await page.evaluate(() => {
      const c = window.__fp.ctp.canvas; const r = c.getBoundingClientRect();
      return { x: r.x, y: r.y, cssW: r.width, cssH: r.height, pxW: c.width, pxH: c.height };
    });
    Object.assign(box, nb);
  }
  else preLog.push(`UNKNOWN STEP ${st}`);
}
retarget();
if (SHOT) await grab('measure-start');

if (!NO_CLICK) { await page.mouse.move(TX, TY); await page.waitForTimeout(400); }
const fb = await page.evaluate(() => window.__fp.ctp.fullBaseline());
if (!fb.ok) await fail('READ-FAILED', { readPath: att.readPath });
if (fb.uniform) await fail('BASELINE-BLANK', { readPath: att.readPath, note: 'the canvas read back as a single flat colour; nothing is being measured' });

if (!NO_CLICK) {
  await page.mouse.down();
  await page.waitForTimeout(HOLD);
  await page.mouse.up();
}
await page.waitForTimeout(600);
let loc;
if (WATCH) {
  // An explicit watch region: do not go looking for one. But still prove that a
  // click changes something INSIDE it, or there is nothing here to time.
  //
  // The warm-up tries each target in turn. With alternating targets the UI may
  // already be on the one the warm-up would click, in which case that click
  // legitimately changes nothing -- and a rig that called that a failure would
  // be failing on the state it inherited rather than on anything real. It only
  // gives up when NO target moves a pixel in the watched strip, which is the
  // genuine "nothing to measure" condition.
  loc = { ok: false, why: 'NO-CHANGE', watch: WATCH, warmupAttempts: [] };
  for (const T of (NO_CLICK ? [WARM] : TARGETS)) {
    await page.evaluate((r) => { window.__fp.ctp.region = r; }, WATCH);
    await page.evaluate((q) => window.__fp.ctp.arm(q), QUIET);
    if (!NO_CLICK) {
      await page.mouse.move(T.x, T.y); await page.waitForTimeout(250);
      await page.mouse.down(); await page.waitForTimeout(HOLD); await page.mouse.up();
    }
    const probe = await page.evaluate((b) => window.__fp.ctp.collect(b), BUDGET);
    loc.warmupAttempts.push({ target: T, pollMs: probe.pollMs, pressed: !!probe.press });
    if (probe.pollMs != null || probe.rafMs != null) {
      loc = { ok: true, watch: WATCH, warmupPollMs: probe.pollMs,
              changedPixels: probe.pollChangedPixels, warmupAttempts: loc.warmupAttempts };
      break;
    }
  }
} else {
  loc = await page.evaluate(() => window.__fp.ctp.locate());
}
if (!loc.ok) {
  await fail(NO_CLICK ? 'NO-CHANGE-WITHOUT-CLICK' : 'NO-CHANGE-ON-WARMUP', {
    locate: loc, readPath: att.readPath, box, target: { x: TX, y: TY },
    note: NO_CLICK
      ? 'control: no click was delivered and the canvas did not change -- the rig is not reporting a latency it invented'
      : 'a click was delivered at the target and no pixel on the canvas changed; there is no click-to-pixel here to measure',
  });
}
const region = WATCH
  ? WATCH
  : await page.evaluate(([b, w, h]) => window.__fp.ctp.setRegionFromBBox(b, w, h), [loc.bbox, STRIP_W, STRIP_H]);

// ---- the reps -------------------------------------------------------------
const reps = [];
for (let i = 0; i < REPS; i++) {
  // Move FIRST, then arm. A UI that highlights on hover (Forge's does) repaints
  // when the pointer arrives; if that repaint lands after the press it would be
  // timed as the click's own. Moving before the baseline is taken folds the
  // hover state into the baseline instead.
  const T = TARGETS[i % TARGETS.length];
  if (!NO_CLICK) { await page.mouse.move(T.x, T.y); await page.waitForTimeout(80); }
  const armed = await page.evaluate((q) => window.__fp.ctp.arm(q), QUIET);
  if (!armed.ok) { reps.push({ i, dropped: armed.why || 'ARM-FAILED', ...armed }); continue; }
  if (JITTER > 0) await page.waitForTimeout(Math.random() * JITTER);
  if (!NO_CLICK) {
    await page.mouse.move(T.x, T.y);
    await page.mouse.down();
    await page.waitForTimeout(HOLD);
    await page.mouse.up();
  }
  const r = await page.evaluate((b) => window.__fp.ctp.collect(b), BUDGET);
  const javaClicks = await page.evaluate(() => window.__fp.lines.filter((l) => l.s.startsWith('PAINT-CLICK')).length);
  reps.push({
    i,
    pressed: !!r.press,
    pollMs: r.pollMs, rafMs: r.rafMs,
    javaListenerMs: r.javaListenerMs, javaPaintDoneMs: r.javaPaintDoneMs,
    // Internal consistency: Java said it finished rasterising at
    // javaPaintDoneMs and the rig saw the pixels at pollMs. The second must not
    // precede the first by more than the sampler quantum, or the pixels the rig
    // timed came from something other than this click.
    orderOk: (r.javaPaintDoneMs == null || r.pollMs == null) ? null : (r.pollMs >= r.javaPaintDoneMs - 5),
    pollChangedPixels: r.pollChangedPixels, rafChangedPixels: r.rafChangedPixels,
    pollSamples: r.pollSamples, rafSamples: r.rafSamples,
    pollIntervalMedian: r.pollIntervals.length ? +pct(r.pollIntervals, 0.5).toFixed(2) : null,
    pollIntervalP95: r.pollIntervals.length ? +pct(r.pollIntervals, 0.95).toFixed(2) : null,
    pollIntervalMax: r.pollIntervals.length ? +pct(r.pollIntervals, 1).toFixed(2) : null,
    rafIntervalMedian: r.rafIntervals.length ? +pct(r.rafIntervals, 0.5).toFixed(2) : null,
    javaClicksSoFar: javaClicks,
    allChanges: r.allChanges,
    dropped: !r.press ? 'CLICK-NOT-DELIVERED-TO-DOM'
      : (r.pollMs == null && r.rafMs == null) ? 'NO-PIXEL-CHANGE'
      : null,
  });
}

const good = reps.filter((r) => !r.dropped);
const pollMs = good.map((r) => r.pollMs).filter((v) => v != null);
const rafMs = good.map((r) => r.rafMs).filter((v) => v != null);
const allPollIvl = good.map((r) => r.pollIntervalMedian).filter((v) => v != null);
const allRafIvl = good.map((r) => r.rafIntervalMedian).filter((v) => v != null);

const javaClickLines = await page.evaluate(() => (window.__fp.lines || []).filter((l) => l.s.startsWith('PAINT-CLICK')).length);
const javaDoneLines = await page.evaluate(() => (window.__fp.lines || []).filter((l) => l.s.startsWith('PAINT-DONE')).length);
if (SHOT) await grab('measure-end');
const rssLoaded = treeRssKb(browserPid, { excludeRoot: true });
const out = await page.evaluate(() => ({ marks: window.__fp.marks || {}, error: window.__fp.error || null, lines: (window.__fp.lines || []).map((l) => `${l.t.toFixed(0)}ms ${l.s}`) }));

const result = {
  url,
  ok: pollMs.length > 0 || rafMs.length > 0,
  method: {
    protocol: 'docs/spikes/streaming.md -- fixed hold, clock starts at the press, n reps, min/median/p95/max, dropped clicks counted not averaged',
    holdMs: HOLD, reps: REPS, quietMs: QUIET, budgetMs: BUDGET, jitterMs: JITTER,
    injected: INJECT || null,
    strip: region, watchGiven: !!WATCH, readPath: att.readPath,
    minChangedPixels: await page.evaluate(() => window.__fp.ctp.MIN_PIXELS),
    clockNote: 'press timestamp is the trusted MouseEvent.timeStamp read in the page; pixel timestamp is performance.now() in the same page. One clock.',
  },
  canvas: box,
  targets: { canvas: CLICKS.length ? CLICKS : [{ x: CX, y: CY }], viewport: TARGETS, alternating: TARGETS.length > 1 },
  watch: WATCH,
  warmupLocate: loc,
  preNavigation: preLog,
  screenshots: SHOT ? [shotPath('measure-start'), shotPath('measure-end')] : null,
  bootToReadyMs: bootMs,
  wallMs: Date.now() - t0,
  clickToPixel: {
    pollCanvasBackingStore: stats(pollMs),
    rafCompositedFrame: stats(rafMs),
  },
  decomposition: {
    clickToJavaListener: stats(good.map((r) => r.javaListenerMs).filter((v) => v != null)),
    clickToJavaPaintDone: stats(good.map((r) => r.javaPaintDoneMs).filter((v) => v != null)),
    repsWhereJavaPaintPrecededPixels: good.filter((r) => r.orderOk === true).length,
    repsWhereItDidNot: good.filter((r) => r.orderOk === false).length,
  },
  samplerQuantumMs: {
    pollMedianOfPerRepMedians: allPollIvl.length ? +pct(allPollIvl, 0.5).toFixed(2) : null,
    pollMaxOfPerRepMedians: allPollIvl.length ? +pct(allPollIvl, 1).toFixed(2) : null,
    rafMedianOfPerRepMedians: allRafIvl.length ? +pct(allRafIvl, 0.5).toFixed(2) : null,
  },
  drops: {
    total: reps.length - good.length,
    byReason: reps.filter((r) => r.dropped).reduce((m, r) => (m[r.dropped] = (m[r.dropped] || 0) + 1, m), {}),
  },
  javaSide: { paintClickLines: javaClickLines, paintDoneLines: javaDoneLines },
  memory: {
    blankBrowserRssKb: rssBlank ? rssBlank.rssKb : null,
    loadedBrowserRssKb: rssLoaded ? rssLoaded.rssKb : null,
    deltaKb: (rssBlank && rssLoaded) ? rssLoaded.rssKb - rssBlank.rssKb : null,
    processes: rssLoaded ? rssLoaded.processes : null,
    note: 'process-tree RSS from /proc; the DELTA is the honest figure (tree RSS double-counts shared pages)',
  },
  // If a stubbed Unsafe native was bound, how many times it was actually
  // called. Only-during-<clinit> means the stub affected nothing measured.
  nativeCalls: await page.evaluate(() => (window.__fp ? window.__fp.nativeCalls : null)),
  transferByOrigin: Object.fromEntries(transfer),
  marks: out.marks,
  pageError: out.error,
  pageErrors,
  reps,
  lines: out.lines,
};
console.log(JSON.stringify(result, null, 2));
await browser.close();
process.exitCode = result.ok ? 0 : 1;

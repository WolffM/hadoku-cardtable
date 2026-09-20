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
// --diag (wave 16 lane B): characterise the target BEFORE measuring it, in the
// same boot, because a boot costs minutes and a wrong target costs the run.
// It answers three questions wave 15 left open or paid for the hard way:
//   1. does the watched strip move on its own, with nothing clicked and the
//      pointer parked on dead canvas?  (the unexplained 47-60 px)
//   2. does the target repaint on HOVER rather than on the click?  If Forge's
//      Card Detail / Card Picture panels fill on mouse-over, a press->pixel
//      number taken there is timing the wrong event.
//   3. how many pixels does the click itself change, and where?
// --diag-only stops after that instead of taking the distribution.
const DIAG = has('diag');
const DIAG_ONLY = has('diag-only');
const DIAG_WINDOW = flag('diag-window', 3000);
// Somewhere the pointer can rest without hovering anything interactive. The
// default is the middle of the opponent's empty battlefield in Forge's match
// layout at 800x600; override for any other target.
const DIAG_PARK = (str('diag-park', '450,150')).split(',').map(Number);
// Declared here, above fail(), so a failure at ANY point still carries the
// navigation trace and whatever characterisation had been done. Wave 15's
// first attempt this wave lost a complete --diag pass because fail() reported
// only its own three fields: seven minutes of boot, and the one artifact that
// would have explained the failure was thrown away.
let diag = null;
const preLog = [];
// If the primary targets turn out to change no pixels -- which is what happens
// when Forge deals no hand, and costs a whole boot -- try a second set before
// giving up. The gate is NOT weakened: the run still exits 1 if neither set
// moves a pixel, and the output names which set produced the number.
const FALLBACK_CLICKS = argv.reduce((a, v, i) => (v === '--fallback-clicks' ? [...a, argv[i + 1]] : a), [])
  .map((c) => { const [x, y] = c.split(',').map(Number); return { x, y }; });
const FALLBACK_WATCH = (() => {
  const w = str('fallback-watch', null);
  if (!w) return null;
  const [x, y, ww, hh] = w.split(',').map(Number);
  return { x, y, w: ww, h: hh };
})();
// --edge press|move -- which input event starts the clock.
//
// 'press' is streaming.md's protocol and stays the default. 'move' exists
// because MEASURED on 2026-09-20 a click on a card in Forge's hand changes
// EXACTLY ZERO pixels while the pointer arriving over that card repaints
// 33,555-34,525 of them. Reading a card is the interaction a Magic player
// performs most, it is answered entirely inside the client, and it is the one
// this rig can time in that screen at all -- so it gets measured, and it gets
// labelled as what it is rather than quoted as a click.
const EDGE = str('edge', 'press');
// How long the pointer rests on dead canvas before a move-mode baseline. The
// pointer LEAVING a card repaints too, and a baseline taken while that is
// still settling is the NOISY-BASELINE wave 15 spent 39 of 40 reps on.
const PARK_MS = flag('park-ms', 1200);
// A second distribution taken in the same boot, because a boot costs seven
// minutes and the two numbers this wave needs are of two different events.
const P2_EDGE = str('phase2-edge', null);
const P2_CLICKS = argv.reduce((a, v, i) => (v === '--phase2-clicks' ? [...a, argv[i + 1]] : a), [])
  .map((c) => { const [x, y] = c.split(',').map(Number); return { x, y }; });
const P2_WATCH = (() => {
  const w = str('phase2-watch', null);
  if (!w) return null;
  const [x, y, ww, hh] = w.split(',').map(Number);
  return { x, y, w: ww, h: hh };
})();
const P2_REPS = flag('phase2-reps', null);

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
    url, ok: false, why, ...extra, preNavigation: preLog, diag, marks, pageErrors,
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
for (const st of PRE) {
  const [kind, arg] = st.split(':');
  if (kind === 'click') { const [cx, cy] = arg.split(',').map(Number); await clickCanvas(cx, cy); preLog.push(`click ${cx},${cy}`); }
  else if (kind === 'wait') { await page.waitForTimeout(Number(arg)); preLog.push(`wait ${arg}`); }
  else if (kind === 'shot') { preLog.push(`shot ${await grab(arg)}`); }
  // clickuntil:<cx>,<cy>,<rx>,<ry>,<rw>,<rh>,<minStd>,<tries>,<gapMs>
  //
  // Click a button until a watched region has CONTENT in it, then stop.
  // Forge's game-setup sequence is not deterministic: winning the coin toss
  // puts a Play/Draw question up first and losing it goes straight to
  // Keep/Mulligan, both render their first button at the same coordinate, and
  // a run can also arrive at a blank "Game Setup" prompt where that button
  // does nothing at all (observed 2026-09-20, screenshot measure-match.png).
  // A fixed number of clicks therefore either under-clicks and measures an
  // empty hand or over-clicks, answers the mulligan and starts a live game --
  // and wave 15 hit BOTH, losing 80 reps to NO-CHANGE-ON-WARMUP and
  // NOISY-BASELINE respectively.
  //
  // The stop condition is the region's own luma std, not "something changed",
  // because "changed" cannot tell "the hand was just dealt" from "I just
  // answered the mulligan and the cards flew away". Content is the thing we
  // need, so content is what is tested, and it is tested BEFORE the first
  // click so an already-dealt hand is never clicked past.
  else if (kind === 'clickuntil') {
    const [cx, cy, rx, ry, rw, rh, minStd, tries, gap] = arg.split(',').map(Number);
    const reg = { x: rx, y: ry, w: rw, h: rh };
    const seen = [];
    let done = false;
    for (let t = 0; t <= (tries || 4); t++) {
      const st = await page.evaluate((r) => window.__fp.ctp.regionStats(r), reg);
      seen.push({ try: t, std: st.std, mean: st.mean });
      if (st.ok && st.std >= minStd) { done = true; break; }
      if (t === (tries || 4)) break;
      await clickCanvas(cx, cy);
      await page.waitForTimeout(gap || 15000);
    }
    preLog.push(`clickuntil ${arg} -> ${done ? 'CONTENT' : 'GAVE-UP'} ${JSON.stringify(seen)}`);
  }
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

// ---- diagnostic characterisation of the target ---------------------------
if (DIAG || DIAG_ONLY) {
  const parkV = {
    x: box.x + DIAG_PARK[0] * (box.cssW / box.pxW),
    y: box.y + DIAG_PARK[1] * (box.cssH / box.pxH),
  };
  const park = async (ms) => { await page.mouse.move(parkV.x, parkV.y); await page.waitForTimeout(ms); };
  await park(1500);

  // 1. Is the strip quiet on its own? No click, no pointer movement, 1-pixel
  //    threshold -- deliberately more sensitive than arm() is.
  const qregion = WATCH || {
    x: Math.max(0, Math.round(box.pxW / 2 - STRIP_W / 2)),
    y: Math.max(0, Math.round(box.pxH / 2 - STRIP_H / 2)),
    w: Math.min(STRIP_W, box.pxW), h: Math.min(STRIP_H, box.pxH),
  };
  await page.evaluate((r) => { window.__fp.ctp.region = r; }, qregion);
  const idle = await page.evaluate((ms) => window.__fp.ctp.watchQuiet(ms, 1), DIAG_WINDOW);

  // 2/3. Hover versus click, per target, full-canvas so the answer includes
  //      WHERE it changed and not only whether the chosen strip moved.
  const perTarget = [];
  for (const [idx, T] of TARGETS.entries()) {
    await park(900);
    await page.evaluate(() => window.__fp.ctp.fullBaseline());
    await page.mouse.move(T.x, T.y);
    await page.waitForTimeout(1200);
    const hover = await page.evaluate(() => window.__fp.ctp.locate());
    // The pointer is already on the target and the hover repaint has settled,
    // so what this baseline-to-locate catches is the CLICK's own repaint.
    await page.evaluate(() => window.__fp.ctp.fullBaseline());
    await page.mouse.down();
    await page.waitForTimeout(HOLD || 50);
    await page.mouse.up();
    await page.waitForTimeout(1200);
    const click = await page.evaluate(() => window.__fp.ctp.locate());
    perTarget.push({ targetCanvas: CLICKS[idx] || null, hover, click });
  }
  await park(800);
  diag = { parkCanvas: DIAG_PARK, idleRegion: qregion, idle, perTarget };
  if (DIAG_ONLY) {
    const anyClick = perTarget.some((t) => t.click && t.click.ok);
    console.log(JSON.stringify({ url, ok: anyClick, diagOnly: true, canvas: box,
      targets: { canvas: CLICKS, viewport: TARGETS }, preNavigation: preLog,
      bootToReadyMs: bootMs, diag,
      lines: await page.evaluate(() => (window.__fp.lines || []).map((l) => `${l.t.toFixed(0)}ms ${l.s}`)),
    }, null, 2));
    await browser.close();
    process.exit(anyClick ? 0 : 1);
  }
}

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
let activeWatch = WATCH;
let targetSetUsed = 'primary';
// An explicit watch region: do not go looking for one. But still prove that a
// click changes something INSIDE it, or there is nothing here to time.
//
// The warm-up tries each target in turn. With alternating targets the UI may
// already be on the one the warm-up would click, in which case that click
// legitimately changes nothing -- and a rig that called that a failure would
// be failing on the state it inherited rather than on anything real. It only
// gives up when NO target moves a pixel in the watched strip, which is the
// genuine "nothing to measure" condition.
const parkViewport = () => ({
  x: box.x + DIAG_PARK[0] * (box.cssW / box.pxW),
  y: box.y + DIAG_PARK[1] * (box.cssH / box.pxH),
});
// Deliver the measured event at T, for whichever edge is configured.
//   press: move there first, settle, THEN press -- so a hover repaint is
//          folded into the baseline instead of being credited to the button.
//   move:  park on dead canvas, settle, THEN move onto T -- the arrival IS
//          the event, so it must happen after the baseline, never before.
const deliver = async (edge, T) => {
  if (edge === 'move') { await page.mouse.move(T.x, T.y); return; }
  await page.mouse.move(T.x, T.y);
  await page.mouse.down();
  await page.waitForTimeout(HOLD);
  await page.mouse.up();
};
const prepare = async (edge, T) => {
  if (edge === 'move') {
    const pv = parkViewport();
    await page.mouse.move(pv.x, pv.y);
    await page.waitForTimeout(PARK_MS);
  } else {
    await page.mouse.move(T.x, T.y);
    await page.waitForTimeout(80);
  }
};
// arm(), and BELIEVE IT. The warm-up used to throw arm()'s verdict away, and
// that is a gate that can pass while measuring nothing -- the exact defect
// this rig exists to prevent, one level up from where it was being prevented.
//
// The mechanism, MEASURED 2026-09-20: arm() takes the baseline, watches for
// quietMs, and CLEARS the change list before returning. If the region was
// repainting during that window the baseline is stale, so the very next sample
// after the event re-detects the old difference and the rig reports one or two
// sampler ticks -- 16.7 ms, 17.0 ms, 17.7 ms were all produced this way -- as
// though they were a latency. It is why a press-mode warm-up "succeeded" on
// Forge's hand (17.7 ms, 3,342 px) in the same boot in which a full-canvas
// diff proved the press changes ZERO pixels, and it is almost certainly why
// wave 15's warm-up reported 34,925 px for a click that changes nothing.
//
// The rep loop always honoured arm() and dropped the rep as NOISY-BASELINE;
// only the warm-up did not. So the distributions are unaffected and the gate
// that decides whether to take one was not.
const armQuiet = async (edge, T, tries = 3) => {
  let armed = { ok: false, why: 'NOT-ARMED' };
  for (let k = 0; k < tries; k++) {
    if (!NO_CLICK) await prepare(edge, T);
    armed = await page.evaluate((q) => window.__fp.ctp.arm(q), QUIET);
    if (armed.ok || NO_CLICK) return armed;
    await page.waitForTimeout(600 * (k + 1));
  }
  return armed;
};
const tryWatch = async (watch, targets, edge) => {
  const out = { ok: false, why: 'NO-CHANGE', watch, edge, warmupAttempts: [] };
  for (const T of (NO_CLICK ? [targets[targets.length - 1]] : targets)) {
    await page.evaluate((r) => { window.__fp.ctp.region = r; }, watch);
    await page.evaluate((e) => { window.__fp.ctp.edge = e; }, edge);
    const armed = await armQuiet(edge, T);
    if (!armed.ok) {
      out.warmupAttempts.push({ target: T, armRefused: armed.why, preClickChanges: armed.preClickChanges });
      continue;
    }
    if (!NO_CLICK) {
      if (edge === 'press') { await page.waitForTimeout(250); }
      await deliver(edge, T);
    }
    const probe = await page.evaluate((b) => window.__fp.ctp.collect(b), BUDGET);
    out.warmupAttempts.push({ target: T, pollMs: probe.pollMs, pressed: !!probe.press,
                              changedPixels: probe.pollChangedPixels });
    if (probe.pollMs != null || probe.rafMs != null) {
      return { ok: true, watch, edge, warmupPollMs: probe.pollMs,
               changedPixels: probe.pollChangedPixels, warmupAttempts: out.warmupAttempts };
    }
  }
  return out;
};
if (WATCH) {
  loc = await tryWatch(WATCH, TARGETS, EDGE);
  if (!loc.ok && FALLBACK_CLICKS.length) {
    // The primary target changed nothing. Rather than throw away a boot that
    // cost minutes, try the declared fallback -- and SAY which one was used,
    // because a number taken against a different target is a number of a
    // different thing.
    const fbTargets = FALLBACK_CLICKS.map(toViewport);
    const fbWatch = FALLBACK_WATCH || WATCH;
    const primary = loc;
    const alt = await tryWatch(fbWatch, fbTargets, EDGE);
    if (alt.ok) {
      targetSetUsed = 'fallback';
      activeWatch = fbWatch;
      TARGETS = fbTargets;
      WARM = fbTargets[fbTargets.length - 1];
      TX = WARM.x; TY = WARM.y;
      loc = { ...alt, primaryRefused: primary };
    } else {
      loc = { ...primary, fallbackAlsoRefused: alt };
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
const region = activeWatch
  ? activeWatch
  : await page.evaluate(([b, w, h]) => window.__fp.ctp.setRegionFromBBox(b, w, h), [loc.bbox, STRIP_W, STRIP_H]);

// ---- the reps -------------------------------------------------------------
// One pass of the protocol. Extracted so the same boot can take TWO
// distributions -- the events Forge answers in its match UI are not all
// button presses, and a seven-minute boot is too expensive to spend on one.
const runReps = async (edge, targets, watch, nreps) => {
const reps = [];
await page.evaluate((r) => { window.__fp.ctp.region = r; }, watch);
await page.evaluate((e) => { window.__fp.ctp.edge = e; }, edge);
for (let i = 0; i < nreps; i++) {
  // Prepare FIRST, then arm. In press mode that means moving to the target and
  // letting any hover repaint land in the baseline rather than in the number
  // (Forge's UI does highlight on hover). In move mode it means parking on
  // dead canvas, because there the arrival is the measured event.
  const T = targets[i % targets.length];
  if (!NO_CLICK) await prepare(edge, T);
  const armed = await page.evaluate((q) => window.__fp.ctp.arm(q), QUIET);
  if (!armed.ok) { reps.push({ i, dropped: armed.why || 'ARM-FAILED', ...armed }); continue; }
  if (JITTER > 0) await page.waitForTimeout(Math.random() * JITTER);
  if (!NO_CLICK) await deliver(edge, T);
  const r = await page.evaluate((b) => window.__fp.ctp.collect(b), BUDGET);
  const javaClicks = await page.evaluate(() => window.__fp.lines.filter((l) => l.s.startsWith('PAINT-CLICK')).length);
  reps.push({
    i,
    pressed: !!r.press,
    edge: r.edge,
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
    dropped: !r.press ? (edge === 'move' ? 'MOVE-NOT-DELIVERED-TO-DOM' : 'CLICK-NOT-DELIVERED-TO-DOM')
      : (r.pollMs == null && r.rafMs == null) ? 'NO-PIXEL-CHANGE'
      : null,
  });
}
return reps;
};

// A pass's numbers, in the shape streaming.md reports.
const summarise = (reps, edge, targets, watch) => {
  const g = reps.filter((r) => !r.dropped);
  const pm = g.map((r) => r.pollMs).filter((v) => v != null);
  const rm = g.map((r) => r.rafMs).filter((v) => v != null);
  const pi = g.map((r) => r.pollIntervalMedian).filter((v) => v != null);
  const ri = g.map((r) => r.rafIntervalMedian).filter((v) => v != null);
  return {
    edge,
    eventToPixel: edge === 'move'
      ? 'pointer arrives over the target -> pixels. NO hold is inside it.'
      : `press -> pixels, with the ${HOLD} ms hold inside it exactly as rfb-latency.py has its own`,
    targetsCanvas: targets, watch,
    // repsAttempted, NOT `reps`. This object also carries the rep ARRAY under
    // `reps`, and when the count was called `reps` too the later shorthand
    // silently won: every phase-2 summary declared no n at all. Caught by
    // no-dupe-keys, not by reading the output, which is the point -- a summary
    // whose self-declared n has quietly become an array of 40 objects still
    // serialises and still looks like a result.
    holdMs: HOLD, repsAttempted: reps.length,
    clickToPixel: { pollCanvasBackingStore: stats(pm), rafCompositedFrame: stats(rm) },
    decomposition: {
      clickToJavaListener: stats(g.map((r) => r.javaListenerMs).filter((v) => v != null)),
      clickToJavaPaintDone: stats(g.map((r) => r.javaPaintDoneMs).filter((v) => v != null)),
      repsWhereJavaPaintPrecededPixels: g.filter((r) => r.orderOk === true).length,
      repsWhereItDidNot: g.filter((r) => r.orderOk === false).length,
    },
    samplerQuantumMs: {
      pollMedianOfPerRepMedians: pi.length ? +pct(pi, 0.5).toFixed(2) : null,
      pollMaxOfPerRepMedians: pi.length ? +pct(pi, 1).toFixed(2) : null,
      rafMedianOfPerRepMedians: ri.length ? +pct(ri, 0.5).toFixed(2) : null,
    },
    changedPixelsAtDetection: stats(g.map((r) => r.pollChangedPixels).filter((v) => v != null)),
    drops: {
      total: reps.length - g.length,
      byReason: reps.filter((r) => r.dropped).reduce((m, r) => (m[r.dropped] = (m[r.dropped] || 0) + 1, m), {}),
    },
    reps,
  };
};

const reps = await runReps(EDGE, TARGETS, region, REPS);

// Phase 2: the other event, in the same boot, against its own targets.
let phase2 = null;
if (P2_EDGE) {
  const p2targets = (P2_CLICKS.length ? P2_CLICKS : CLICKS).map(toViewport);
  const p2watch = P2_WATCH || region;
  const warm = await tryWatch(p2watch, p2targets, P2_EDGE);
  const p2reps = warm.ok ? await runReps(P2_EDGE, p2targets, p2watch, P2_REPS || REPS) : [];
  phase2 = { warmupLocate: warm, ...(warm.ok
    ? summarise(p2reps, P2_EDGE, P2_CLICKS.length ? P2_CLICKS : CLICKS, p2watch)
    : { edge: P2_EDGE, refused: true, targetsCanvas: P2_CLICKS, watch: p2watch }) };
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
  phase2,
  method: {
    protocol: 'docs/spikes/streaming.md -- fixed hold, clock starts at the press, n reps, min/median/p95/max, dropped clicks counted not averaged',
    holdMs: HOLD, reps: REPS, quietMs: QUIET, budgetMs: BUDGET, jitterMs: JITTER,
    injected: INJECT || null,
    strip: region, watchGiven: !!WATCH, readPath: att.readPath,
    targetSetUsed, edge: EDGE, parkMs: PARK_MS, parkCanvas: DIAG_PARK,
    minChangedPixels: await page.evaluate(() => window.__fp.ctp.MIN_PIXELS),
    clockNote: 'press timestamp is the trusted MouseEvent.timeStamp read in the page; pixel timestamp is performance.now() in the same page. One clock.',
  },
  canvas: box,
  targets: { canvas: targetSetUsed === 'fallback' ? FALLBACK_CLICKS : (CLICKS.length ? CLICKS : [{ x: CX, y: CY }]),
             viewport: TARGETS, alternating: TARGETS.length > 1, targetSetUsed },
  watch: activeWatch,
  watchRequested: WATCH,
  warmupLocate: loc,
  diag,
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

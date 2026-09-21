// Wave 16, lane A -- drive ONE cold CheerpJ boot and classify the outcome.
//
// Wave 15 detected the boot stall by letting a 900 s budget expire. That costs
// 900 s per failure, reports "NO-READY-MARKER", and says nothing about where it
// stopped. This driver watches the harness page's monotonic console sequence
// number instead: a boot that has printed nothing for --stall ms IS stalled,
// which is visible in about a minute, and the transcript's last line names the
// call it stopped inside (boot/java/spike/Bootstrap.java's watchdog).
//
//   node boot.mjs <url> [--ready 'Read cards:'] [--stall 75000] [--budget 480000]
//                       [--home 800x600] [--home-ms 240000]
//                       [--out run.json] [--screenshot shot.png]
//
// The done-when is Forge's HOME SCREEN, not its card database, and the two are
// tens of seconds and one more crash apart. `Read cards:` is the last line
// Forge prints before the home screen is built; the home screen itself prints
// nothing. So a run is READY only when the marker has landed AND the biggest
// canvas has reached the document frame's size -- under CheerpJ every AWT
// top-level window is its own canvas, so the 450x450 splash giving way to an
// 800x600 frame IS the home screen appearing (wave 15 lane D's awaitcanvas,
// same signal, same reason). A run that gets the marker and then dies building
// a panel is classified NO-HOME, not READY.
//
// Exit code: 0 READY, 1 STALL, 2 anything else. The classification is also in
// the JSON, because an exit code alone has burned this project before.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'playwright-core');

const argv = process.argv.slice(2);
const url = argv[0];
if (!url || url.startsWith('--')) { console.error('usage: boot.mjs <url> [opts]'); process.exit(2); }
const str = (n, d) => { const i = argv.lastIndexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const num = (n, d) => { const i = argv.lastIndexOf('--' + n); return i === -1 ? d : Number(argv[i + 1]); };

const READY = str('ready', 'Read cards:');
const STALL_MS = num('stall', 75_000);
const BUDGET_MS = num('budget', 480_000);
const OUT = str('out', null);
const SHOT = str('screenshot', null);
const [HOME_W, HOME_H] = str('home', '800x600').split('x').map(Number);
const HOME_MS = num('home-ms', 240_000);
const FORGE_STALL_MS = num('forge-stall', 240_000);

const diskFree = (p) => {
  try {
    const l = execSync(`df -Pk ${p}`, { encoding: 'utf8' }).trim().split('\n')[1].split(/\s+/);
    return { fs: l[0], availKb: Number(l[3]), usePct: l[4], mount: l[5] };
  } catch { return null; }
};

const env0 = { load: os.loadavg(), tmp: diskFree(os.tmpdir()), t: new Date().toISOString() };

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1420, height: 980 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('crash', () => pageErrors.push('PAGE-CRASH'));

const canvasBox = () => page.evaluate(() => {
  const cs = [...document.querySelectorAll('canvas')];
  if (!cs.length) return null;
  const c = cs.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  return { pxW: c.width, pxH: c.height };
}).catch(() => null);

const t0 = Date.now();
let outcome = 'BUDGET';
let lastSeq = -1;
let lastSeqAt = Date.now();
let markerMs = null;
let maxInCallMs = 0;
let maxUnpackInCallMs = 0;   // the number that justifies --stall
let stalledIn = null;
let homeMs = null;
let homeCanvas = null;

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  while (Date.now() - t0 < BUDGET_MS) {
    const st = await page.evaluate((m) => {
      const S = window.__spike;
      if (!S) return { seq: 0, hit: false, err: null, wd: null };
      // The Java watchdog's own view: which call the unpack is inside and for
      // how long. During the unpack this is the ONLY honest liveness signal --
      // progress lines are printed every 500 entries and the watchdog and the
      // quota sampler both tick regardless.
      let wd = null;
      for (let i = S.lines.length - 1; i >= 0; i--) {
        const mm = /^BOOT wd phase=(\S+) .*inCallMs=(\d+)/.exec(S.lines[i].s);
        if (mm) { wd = { phase: mm[1], inCallMs: Number(mm[2]) }; break; }
      }
      return {
        seq: S.progressSeq,
        hit: S.lines.some((l) => l.s.includes(m)),
        err: S.error,
        wd,
      };
    }, READY).catch((e) => ({ seq: lastSeq, hit: false, err: 'EVAL-FAILED ' + e.message, wd: null }));
    if (st.hit) { markerMs = Date.now() - t0; outcome = 'NO-HOME'; break; }
    if (st.err) { outcome = 'ERROR'; break; }
    if (st.wd) {
      if (st.wd.inCallMs > maxInCallMs) maxInCallMs = st.wd.inCallMs;
      if (st.wd.phase !== 'forge' && st.wd.inCallMs > maxUnpackInCallMs) maxUnpackInCallMs = st.wd.inCallMs;
      // Inside the unpack every call is a filesystem call that takes
      // milliseconds; a call that has been running for STALL_MS is not slow,
      // it is dead. Forge's own boot (phase=forge) is a single reflective
      // invoke that legitimately runs for minutes, so it is timed by silence
      // instead, with a much longer threshold.
      if (st.wd.phase !== 'forge' && st.wd.inCallMs > STALL_MS) {
        outcome = 'STALL'; stalledIn = st.wd.phase; break;
      }
      if (st.wd.phase === 'forge' && Date.now() - lastSeqAt > FORGE_STALL_MS) {
        outcome = 'FORGE-STALL'; stalledIn = 'forge'; break;
      }
    } else if (Date.now() - lastSeqAt > STALL_MS) {
      // No watchdog line at all: CheerpJ could not run a second Java thread.
      outcome = 'STALL'; stalledIn = 'no-watchdog'; break;
    }
    if (st.seq !== lastSeq) { lastSeq = st.seq; lastSeqAt = Date.now(); }
    await page.waitForTimeout(1000);
  }

  // The marker landed. Now wait for the home screen to actually exist.
  // --home 0x0 disables the gate, for runs that never open an AWT window:
  // under CheerpJ a canvas exists only once a Java top-level window does, so
  // an unpack-only run has no canvas to wait for and the gate would fail every
  // run that had in fact succeeded. (It did, on the first one.)
  if (markerMs !== null && HOME_W === 0 && HOME_H === 0) {
    outcome = 'READY'; homeMs = markerMs;
  } else if (markerMs !== null) {
    const deadline = Date.now() + HOME_MS;
    while (Date.now() < deadline) {
      const b = await canvasBox();
      if (b && b.pxW >= HOME_W && b.pxH >= HOME_H) {
        homeCanvas = b; homeMs = Date.now() - t0; outcome = 'READY'; break;
      }
      homeCanvas = b;
      await page.waitForTimeout(2000);
    }
  }
} catch (e) {
  outcome = 'DRIVER-ERROR';
  pageErrors.push(String(e));
}

// On a stall, ask CheerpJ itself where the Java threads are. The runtime
// exports dumpAllThreads (cj3.js: `dumpAllThreads=ah2`, re-exported by
// loader.js as self.dumpAllThreads), and its output arrives as console lines,
// which this page already captures. This runs AFTER the stall verdict is in,
// so it cannot influence the outcome it is diagnosing.
if (outcome === 'STALL' || outcome === 'FORGE-STALL') {
  await page.evaluate(() => {
    try {
      if (typeof self.dumpAllThreads === 'function') {
        console.log('SPIKE-THREADDUMP begin');
        self.dumpAllThreads();
        console.log('SPIKE-THREADDUMP end');
      } else {
        console.log('SPIKE-THREADDUMP unavailable typeof=' + typeof self.dumpAllThreads);
      }
    } catch (e) { console.log('SPIKE-THREADDUMP threw ' + (e && e.stack ? e.stack : e)); }
  }).catch((e) => pageErrors.push('threaddump: ' + e.message));
  await page.waitForTimeout(4000).catch(() => {});
}

// A beat, so trailing stdout after the marker lands in the transcript.
await page.waitForTimeout(outcome === 'READY' ? 2000 : 500).catch(() => {});

const snap = await page.evaluate(() => {
  const S = window.__spike || {};
  return {
    lines: (S.lines || []).map((l) => `${l.t.toFixed(0)}ms ${l.s}`),
    dropped: S.dropped || 0,
    seq: S.seq || 0,
    marks: S.marks || {},
    error: S.error || null,
    quota: S.quota || null,
    // outstanding is a Map; page.evaluate cannot serialise one, and the SIZE is
    // the finding anyway -- see the request-level hook in index.html.
    idb: S.idb ? { transactions: S.idb.transactions, aborts: S.idb.aborts, errors: S.idb.errors,
                   events: S.idb.events.slice(0, 20), requests: S.idb.requests,
                   completed: S.idb.completed, failed: S.idb.failed,
                   outstanding: S.idb.outstanding.size,
                   outstandingOps: [...S.idb.outstanding.values()].slice(0, 20),
                   lastOps: S.idb.lastOps.slice(-20) } : null,
    net: S.net ? { fetches: S.net.fetches, done: S.net.done, failed: S.net.failed,
                   xhr: S.net.xhr, xhrDone: S.net.xhrDone,
                   outstanding: S.net.outstanding.size,
                   outstandingOps: [...S.net.outstanding.values()].slice(0, 20) } : null,
    rejections: S.rejections || [],
  };
}).catch(() => ({ lines: [], dropped: 0, seq: 0, marks: {}, error: 'SNAPSHOT-FAILED', quota: null, idb: null, rejections: [] }));

if (SHOT) { await page.screenshot({ path: SHOT }).catch(() => {}); }

const qs = (snap.quota && snap.quota.samples) || [];
const peakUsage = qs.reduce((m, s) => (s.usage > m ? s.usage : m), 0);
const lastQuota = qs.length ? qs[qs.length - 1] : null;

const result = {
  url, outcome, readyMarker: READY,
  wallMs: Date.now() - t0,
  markerMs, homeMs, homeCanvas, homeWant: `${HOME_W}x${HOME_H}`,
  stalledIn, maxInCallMs, maxUnpackInCallMs, forgeStallMs: FORGE_STALL_MS,
  stallMs: STALL_MS, budgetMs: BUDGET_MS,
  lastLine: snap.lines.length ? snap.lines[snap.lines.length - 1] : null,
  lastProgress: [...snap.lines].reverse().find((l) => l.includes('unpack progress')) || null,
  lastWatchdog: [...snap.lines].reverse().find((l) => l.includes('BOOT wd phase=')) || null,
  watchdogAlive: snap.lines.some((l) => l.includes('BOOT wd alive')),
  storage: {
    before: snap.quota ? snap.quota.before : null,
    peakUsage,
    quotaBytes: lastQuota ? lastQuota.quota : (snap.quota && snap.quota.before ? snap.quota.before.quota : null),
    lastSample: lastQuota,
    samples: qs.length,
  },
  idb: snap.idb,
  net: snap.net,
  rejections: snap.rejections.slice(0, 10),
  error: snap.error, pageErrors,
  linesDropped: snap.dropped, seq: snap.seq,
  marks: snap.marks,
  env: { start: env0, end: { load: os.loadavg(), tmp: diskFree(os.tmpdir()), t: new Date().toISOString() } },
  bootLines: snap.lines.filter((l) => /BOOT |SPIKE-IDB|SPIKE-REJECTION|SPIKE-PERSIST|SPIKE-THREADDUMP|CheerpJ|Thread-|java\\.|at /.test(l) && !/BOOT wd phase=/.test(l)),
  quotaSeries: qs.map((s) => ({ t: Math.round(s.t), usage: s.usage, quota: s.quota })),
  tail: snap.lines.slice(-40),
};

await browser.close().catch(() => {});

if (OUT) { fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); }
console.log(JSON.stringify(result, null, 2));
process.exitCode = outcome === 'READY' ? 0 : (outcome === 'STALL' ? 1 : 2);

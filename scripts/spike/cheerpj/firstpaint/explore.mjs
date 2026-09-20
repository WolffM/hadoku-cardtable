// Wave 15, lane D -- drive a booted Forge inside CheerpJ and look at it.
//
// This is the discovery tool, not the measurement tool. clicktopixel.mjs takes
// numbers; this one answers "what is on the screen and where do I have to click
// to get to a match", which has to be settled before any number means anything.
//
//   node explore.mjs <url> [--ready 'Read cards:'] [--budget 900000]
//                          [--shot-dir DIR] [--step click:319,141] [--step wait:3000]
//                          [--step shot:home] [--grep 'Match'] [--tail 40]
//
// Steps run in order after the ready marker. Click coordinates are CANVAS
// coordinates (what you read off a screenshot), never viewport coordinates --
// getting that wrong once already cost this lane a run.
//
// Exit 0 if the ready marker arrived, 1 if it did not. The transcript is the
// finding either way, so it always prints.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { treeRssKb } from './procrss.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'playwright-core');

const argv = process.argv.slice(2);
const url = argv[0];
if (!url || url.startsWith('--')) { console.error('usage: explore.mjs <url> [opts]'); process.exit(2); }
const str = (n, d) => { const i = argv.lastIndexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const num = (n, d) => { const i = argv.lastIndexOf('--' + n); return i === -1 ? d : Number(argv[i + 1]); };
const all = (n) => argv.reduce((a, v, i) => (v === '--' + n ? [...a, argv[i + 1]] : a), []);

const READY = str('ready', 'Read cards:');
const BUDGET = num('budget', 900_000);
const SHOT_DIR = str('shot-dir', '/tmp');
const STEPS = all('step');
const TAIL = num('tail', 60);
const GREP = str('grep', null);
const AWAIT_MS = num('await-ms', 600_000);
const stepLog = [];

fs.mkdirSync(SHOT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1420, height: 980 } });

// Sample the browser process tree's resident memory for the whole run. This is
// the figure that is comparable to streaming.md's 1.26 GiB of `docker stats`
// RSS per player: same kind of number, other side of the wire. The JS-heap APIs
// would miss it entirely -- CheerpJ's Java heap is WebAssembly linear memory,
// not JS heap.
const browserPid = process.pid;   // the browser is our child; see procrss.mjs
const rssBlank = treeRssKb(browserPid, { excludeRoot: true });
const rssSeries = [];
const rssTimer = setInterval(() => {
  const r = treeRssKb(browserPid, { excludeRoot: true });
  if (r) rssSeries.push({ t: Date.now(), kb: r.rssKb, procs: r.processes });
}, 2000);
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded' });

const lines = async () => page.evaluate(() => (window.__fp && window.__fp.lines ? window.__fp.lines.map((l) => `${l.t.toFixed(0)}ms ${l.s}`) : []));

let ready = false;
let lastCount = 0;
while (Date.now() - t0 < BUDGET) {
  const st = await page.evaluate((m) => {
    const S = window.__fp;
    if (!S) return { n: 0 };
    return { n: S.lines.length, hit: !!S.lines.find((l) => l.s.includes(m)), err: S.error };
  }, READY);
  if (st.n !== lastCount) { lastCount = st.n; }
  if (st.hit) { ready = true; break; }
  await page.waitForTimeout(1000);
}

const canvasBox = async () => page.evaluate(() => {
  const cs = [...document.querySelectorAll('canvas')];
  if (!cs.length) return null;
  const c = cs.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, cssW: r.width, cssH: r.height, pxW: c.width, pxH: c.height };
});

const shot = async (name) => {
  const b = await canvasBox();
  const f = path.join(SHOT_DIR, `${name}.png`);
  if (b) {
    await page.screenshot({ path: f, clip: { x: b.x, y: b.y, width: b.cssW, height: b.cssH } });
  } else {
    await page.screenshot({ path: f });
  }
  console.error(`SHOT ${f}`);
};

if (ready) {
  await shot('00-ready');
  for (const s of STEPS) {
    const [kind, arg] = s.split(':');
    if (kind === 'click') {
      const b = await canvasBox();
      const [cx, cy] = arg.split(',').map(Number);
      const x = b.x + cx * (b.cssW / b.pxW);
      const y = b.y + cy * (b.cssH / b.pxH);
      await page.mouse.move(x, y);
      await page.waitForTimeout(150);
      await page.mouse.down();
      await page.waitForTimeout(50);
      await page.mouse.up();
      console.error(`CLICK canvas ${cx},${cy} -> viewport ${x.toFixed(0)},${y.toFixed(0)}`);
      stepLog.push(`click ${cx},${cy}`);
    } else if (kind === 'wait') {
      await page.waitForTimeout(Number(arg));
    } else if (kind === 'shot') {
      await shot(arg);
    } else if (kind === 'awaitcanvas') {
      // Wait for the biggest canvas to reach a given size. Under CheerpJ each
      // AWT top-level window is its own canvas, so "the splash has been
      // replaced by the main document frame" IS a canvas-size change
      // (450x450 -> 800x600). That is a deterministic signal; Forge prints no
      // line when its home screen is up, and a fixed sleep either races the
      // boot or wastes minutes of it.
      const [w, h] = arg.split('x').map(Number);
      const deadline = Date.now() + AWAIT_MS;
      let got = null;
      while (Date.now() < deadline) {
        got = await canvasBox().catch(() => null);
        if (got && got.pxW >= w && got.pxH >= h) break;
        await page.waitForTimeout(2000);
      }
      const ok = !!(got && got.pxW >= w && got.pxH >= h);
      console.error(`AWAITCANVAS ${arg} -> ${ok ? 'OK' : 'TIMEOUT'} ${got ? got.pxW + 'x' + got.pxH : 'none'}`);
      stepLog.push(`awaitcanvas ${arg} ${ok ? 'OK' : 'TIMEOUT'}`);
      if (!ok) break;
    } else {
      console.error(`unknown step: ${s}`);
    }
  }
}

const L = await lines();
const box = await canvasBox();
if (rssTimer) clearInterval(rssTimer);
const rssPeak = rssSeries.reduce((m, r) => (r.kb > m ? r.kb : m), 0);
console.log(JSON.stringify({
  url, ready, readyMarker: READY, wallMs: Date.now() - t0, canvas: box, pageErrors, steps: stepLog,
  memory: {
    blankBrowserRssKb: rssBlank ? rssBlank.rssKb : null,
    peakRssKb: rssPeak || null,
    finalRssKb: rssSeries.length ? rssSeries[rssSeries.length - 1].kb : null,
    peakDeltaKb: (rssBlank && rssPeak) ? rssPeak - rssBlank.rssKb : null,
    samples: rssSeries.length,
    // one point every ~10 s, so the shape is visible without the noise
    trajectoryKb: rssSeries.filter((_, i) => i % 5 === 0).map((r) => r.kb),
    note: 'process-tree RSS from /proc; tree RSS double-counts shared pages, so the DELTA is the honest figure',
  },
  marks: await page.evaluate(() => (window.__fp ? window.__fp.marks : {})),
  nativeCalls: await page.evaluate(() => (window.__fp ? window.__fp.nativeCalls : null)),
  error: await page.evaluate(() => (window.__fp ? window.__fp.error : null)),
  lineCount: L.length,
}, null, 2));
const shown = GREP ? L.filter((l) => new RegExp(GREP, 'i').test(l)) : L.slice(-TAIL);
console.log('--- transcript ---');
for (const l of shown) console.log(l.split('\n')[0]);

await browser.close();
process.exitCode = ready ? 0 : 1;

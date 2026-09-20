// Wave 14, lane B -- drive the CheerpJ harness page in headless Chromium and
// print every number this spike quotes, as JSON, to stdout.
//
// playwright-core is resolved from the repo's existing pnpm store (read-only);
// this spike installs nothing. $PW_CORE is set by run.sh.
//
//   node measure.mjs 'http://127.0.0.1:8731/index.html?probe=net'
//
// Exit code is 0 if the page reached a terminal state, 1 if it timed out or the
// harness itself threw -- NOT a verdict on the probe. The probe's verdict is in
// the printed lines.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'playwright-core');

const url = process.argv[2];
if (!url) {
  console.error('usage: measure.mjs <url>');
  process.exit(2);
}
const probe = new URL(url).searchParams.get('probe') || 'net';
// The swing probe deliberately busy-paints for 5s and the forge jar is 39 MB
// plus a full JDK download, so the budgets differ by a lot.
const BUDGET_MS = probe === 'forgejar' ? 120_000 : 120_000;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

// request.sizes() reports real transferred bytes even cross-origin, where the
// Resource Timing API reports transferSize 0 without Timing-Allow-Origin. The
// CheerpJ runtime is served from cjrtnc.leaningtech.com, so this is the only way
// to get an honest cold-start download figure for it.
const transfer = new Map(); // origin -> { bytes, requests }
page.on('requestfinished', async (req) => {
  try {
    const { responseBodySize, responseHeadersSize } = await req.sizes();
    const o = new URL(req.url()).origin;
    const e = transfer.get(o) || { bytes: 0, requests: 0 };
    e.bytes += (responseBodySize || 0) + (responseHeadersSize || 0);
    e.requests += 1;
    transfer.set(o, e);
  } catch { /* request gone after navigation; not worth failing the run over */ }
});

const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded' });

// Terminal state = the harness set finished, OR the probe printed its own end
// marker, OR we ran out of budget. Polling beats waitForFunction here because we
// want the partial transcript on a timeout, not an exception.
const endMarker = { net: 'PROBE net end', fs: 'PROBE fs end', swing: 'SWING-READY', forgejar: null }[probe];
let timedOut = true;
while (Date.now() - t0 < BUDGET_MS) {
  const done = await page.evaluate(
    (m) => !!(window.__spike && (window.__spike.finished || window.__spike.error ||
      (m && window.__spike.lines.some((l) => l.s.startsWith(m))))),
    endMarker,
  );
  if (done) { timedOut = false; break; }
  await page.waitForTimeout(500);
}

// For the swing probe, once SWING-READY is printed, click the canvas and time how
// long it takes the Java mouse listener to fire. Both timestamps come from the
// page's clock (the console hook stamps every line with performance.now()), so
// there is no JVM/JS clock correlation involved.
let clickLatencyMs = null;
let clickPaintMs = null;
if (probe === 'swing' && !timedOut) {
  const box = await page.evaluate(() => {
    const c = document.querySelector('#display canvas') || document.querySelector('canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  if (box) {
    const clickAt = await page.evaluate(() => performance.now());
    await page.mouse.click(box.x + 400, box.y + 300);
    await page.waitForTimeout(3000);
    const res = await page.evaluate((t) => {
      const f = (p) => (window.__spike.lines.find((l) => l.s.startsWith(p)) || null);
      const a = f('SWING-CLICK at');
      const b = f('SWING-CLICKPAINT');
      return { a: a && a.t - t, b: b && b.t - t, canvas: true };
    }, clickAt);
    clickLatencyMs = res.a;
    clickPaintMs = res.b;
  }
}

const out = await page.evaluate(() => ({
  marks: window.__spike.marks,
  error: window.__spike.error,
  finished: window.__spike.finished,
  lines: window.__spike.lines,
}));

await page.waitForTimeout(500);
await browser.close();

const result = {
  url, probe,
  timedOut,
  wallMs: Date.now() - t0,
  marks: out.marks,
  error: out.error,
  pageErrors,
  clickToJavaListenerMs: clickLatencyMs,
  clickToRepaintDoneMs: clickPaintMs,
  transferByOrigin: Object.fromEntries(transfer),
  lines: out.lines.map((l) => `${l.t.toFixed(0)}ms ${l.s}`),
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = timedOut || out.error ? 1 : 0;

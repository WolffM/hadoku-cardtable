// Wave 15, lane B -- drive this lane's harness page in headless Chromium and
// print the transcript as JSON.
//
// The shared measure.mjs has a hardcoded probe->end-marker table and no way to
// pass a marker in; this lane runs a different probe every iteration and needs
// to stop on "PROBE zip end" or "Read cards:" rather than on `finished` (Forge's
// own main never returns -- it hands off to the Swing EDT).
//
//   node drive.mjs <url> [--marker 'PROBE zip end'] [--budget 180000]
//
// Exit code: 0 if a terminal state was reached, 1 on timeout or a harness throw.
// That is NOT the probe's verdict -- the verdict is in the printed lines.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'playwright-core');

const argv = process.argv.slice(2);
const url = argv[0];
if (!url) { console.error('usage: drive.mjs <url> [--marker M] [--budget MS]'); process.exit(2); }
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const markers = argv.flatMap((a, i) => (a === '--marker' ? [argv[i + 1]] : []));
const BUDGET_MS = Number(flag('--budget', '180000'));

const browser = await chromium.launch({ headless: true });
// An EXPLICIT context, not browser.newPage(): the implicit context that
// newPage() creates refuses a second page, and --twice needs two pages that
// share one origin store.
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
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
  } catch { /* request gone after navigation; not worth failing the run over */ }
});

const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded' });

let timedOut = true;
while (Date.now() - t0 < BUDGET_MS) {
  const done = await page.evaluate(
    (ms) => !!(window.__spike && (window.__spike.finished || window.__spike.error ||
      (ms.length > 0 && ms.some((m) => window.__spike.lines.some((l) => l.s.includes(m)))))),
    markers,
  );
  if (done) { timedOut = false; break; }
  await page.waitForTimeout(500);
}

// Give the page a beat to flush trailing stdout after the marker landed.
await page.waitForTimeout(1000);

// --twice opens a SECOND page in the same browser context, at the same URL minus
// any wipe, and drives it the same way. Same origin, same storage: this is what a
// real player's second visit does, and it is the only way to tell whether the
// 31 s unpack into /files/ is paid once per browser or once per page load.
//
// A second PAGE, not page.reload(): a reload path was tried first and returned a
// transcript byte-identical to the first run's, stamps and all, which is a
// measurement that reports a warm number without measuring anything. The check
// below refuses to report a second run whose marks match the first exactly.
let second = null;
if (argv.includes('--twice')) {
  const u2 = new URL(url);
  u2.searchParams.delete('wipe');
  const page2 = await context2Page(browser, pageErrors);
  const t1 = Date.now();
  await page2.goto(u2.toString(), { waitUntil: 'domcontentloaded' });
  let timedOut2 = true;
  while (Date.now() - t1 < BUDGET_MS) {
    const done = await page2.evaluate(
      (ms) => !!(window.__spike && (window.__spike.finished || window.__spike.error ||
        (ms.length > 0 && ms.some((m) => window.__spike.lines.some((l) => l.s.includes(m)))))),
      markers,
    );
    if (done) { timedOut2 = false; break; }
    await page2.waitForTimeout(500);
  }
  await page2.waitForTimeout(1000);
  const o2 = await page2.evaluate(() => ({
    marks: window.__spike.marks, error: window.__spike.error, lines: window.__spike.lines,
  }));
  second = {
    url: u2.toString(), timedOut: timedOut2, wallMs: Date.now() - t1,
    marks: o2.marks, error: o2.error,
    lines: o2.lines.map((l) => `${l.t.toFixed(0)}ms ${l.s}`),
  };
  await page2.close();
}

async function context2Page(b, errs) {
  // The SAME context as page, so origin storage (IndexedDB, where CheerpJ keeps
  // /files/) is shared. A newContext() would start empty and prove nothing.
  const pg = await context.newPage();
  pg.on('pageerror', (e) => errs.push(String(e)));
  return pg;
}

// There is deliberately no in-page reload path here. One was written, and its
// second transcript came back byte-identical to the first (same performance.now()
// stamps, an initDone of 48 ms that no real cheerpjInit has ever produced) -- a
// measurement that reports a warm number without measuring a warm start. Cold
// and warm are measured as two separate runs instead, made honest by ?wipe=1.

const out = await page.evaluate(() => ({
  marks: window.__spike.marks,
  error: window.__spike.error,
  finished: window.__spike.finished,
  lines: window.__spike.lines,
}));

const shot = flag('--screenshot', null);
if (shot) { await page.screenshot({ path: shot }); }

await browser.close();

console.log(JSON.stringify({
  url, markers, timedOut,
  wallMs: Date.now() - t0,
  marks: out.marks,
  error: out.error,
  pageErrors,
  transferByOrigin: Object.fromEntries(transfer),
  lines: out.lines.map((l) => `${l.t.toFixed(0)}ms ${l.s}`),
  second,
  secondIsDistinct: second ? JSON.stringify(second.marks) !== JSON.stringify(out.marks) : null,
}, null, 2));
process.exitCode = timedOut || out.error ? 1 : 0;

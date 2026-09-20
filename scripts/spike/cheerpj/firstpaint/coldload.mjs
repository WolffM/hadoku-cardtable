// Wave 15, lane D -- what a cold cache costs before a single pixel of Forge is
// on screen.
//
//   node coldload.mjs <url> [--runs 3]
//
// Every run is a fresh browser context, so nothing is cached and the byte
// counts are cold by construction. request.sizes() is used rather than the
// Resource Timing API because the CheerpJ runtime is served cross-origin from
// cjrtnc.leaningtech.com without Timing-Allow-Origin, where Resource Timing
// reports transferSize 0 -- i.e. the honest number is only visible from CDP.
//
// This matters for the wave's decision because the CheerpJ Community Licence
// does not permit self-hosting the runtime (docs/spikes/cheerpj.md, step 1), so
// these bytes are a permanent third-party dependency, not a build artefact we
// can shrink.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'playwright-core');

const url = process.argv[2];
if (!url) { console.error('usage: coldload.mjs <url> [--runs N]'); process.exit(2); }
const i = process.argv.lastIndexOf('--runs');
const RUNS = i === -1 ? 3 : Number(process.argv[i + 1]);
const j = process.argv.lastIndexOf('--ready');
const READY = j === -1 ? 'PAINT-READY' : process.argv[j + 1];

const runs = [];
for (let r = 0; r < RUNS; r++) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const transfer = new Map();
  const perFile = [];
  page.on('requestfinished', async (req) => {
    try {
      const { responseBodySize, responseHeadersSize } = await req.sizes();
      const b = (responseBodySize || 0) + (responseHeadersSize || 0);
      const o = new URL(req.url()).origin;
      const e = transfer.get(o) || { bytes: 0, requests: 0 };
      e.bytes += b; e.requests += 1; transfer.set(o, e);
      perFile.push({ url: req.url(), bytes: b });
    } catch { /* gone with the navigation */ }
  });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  let ready = null;
  while (Date.now() - t0 < 180_000) {
    ready = await page.evaluate((m) => {
      const S = window.__fp; if (!S) return null;
      const hit = S.lines.find((l) => l.s.startsWith(m));
      return hit ? hit.t : null;
    }, READY);
    if (ready != null) break;
    await page.waitForTimeout(200);
  }
  const marks = await page.evaluate(() => window.__fp.marks);
  // Let late runtime fetches settle before counting bytes.
  await page.waitForTimeout(1500);
  const byOrigin = Object.fromEntries(transfer);
  const cdn = Object.entries(byOrigin).filter(([o]) => !o.includes('127.0.0.1'));
  runs.push({
    run: r,
    readyMarker: READY,
    msToLoaderReady: marks.loaderReady != null ? +marks.loaderReady.toFixed(0) : null,
    msToCheerpjInitDone: marks.initDone != null ? +marks.initDone.toFixed(0) : null,
    msToDisplay: marks.displayDone != null ? +marks.displayDone.toFixed(0) : null,
    msToReadyMarker: ready != null ? +ready.toFixed(0) : null,
    cheerpjInitMs: (marks.initDone != null && marks.loaderReady != null)
      ? +(marks.initDone - marks.loaderReady).toFixed(0) : null,
    bytesByOrigin: byOrigin,
    thirdPartyBytes: cdn.reduce((s, [, v]) => s + v.bytes, 0),
    thirdPartyRequests: cdn.reduce((s, [, v]) => s + v.requests, 0),
    topThirdPartyFiles: perFile
      .filter((f) => !f.url.includes('127.0.0.1'))
      .sort((a, b) => b.bytes - a.bytes).slice(0, 8),
  });
  await browser.close();
}
console.log(JSON.stringify({ url, runs }, null, 2));

// Wave 15, lane A -- drive the page in headless Chromium and CHECK the round
// trip, rather than print a transcript and let a human squint at it.
//
// playwright-core comes from the repo's existing pnpm store, read-only; this
// spike installs nothing. $PW_CORE and $BUILD_ID are set by run.sh.
//
//   node measure.mjs 'http://127.0.0.1:8741/index.html'
//
// ## Every check here exists because of a specific way this could pass wrongly
//
//   build     the CLASS that ran was compiled by THIS build, not a stale jar.
//             Trap 7: a measurement ran against the previous jar and produced a
//             number that looked like a result.
//   nonce     the bytes Java printed are the bytes THIS server process minted.
//             A bridge that echoed its own request would fail this.
//   distinct  two asks with different defaultYes produced two DIFFERENT replies,
//             so a hard-coded reply cannot pass.
//   refused   a legal Tier B frame was declined BY NAME. A bridge that silently
//             ate unmodelled frames would look identical without this.
//   verdict   the server's own pass, from @hadoku/forge-wire's schemas.
//
// `proxySupported` is reported, not gated: java.lang.reflect.Proxy FAILS under
// CheerpJ and that is a finding, not a regression.
//
// Exit code is 0 only if every check passes.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'playwright-core');

const url = process.argv[2];
if (!url) { console.error('usage: measure.mjs <url>'); process.exit(2); }
const origin = new URL(url).origin;
const BUDGET_MS = 180_000;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded' });

let timedOut = true;
while (Date.now() - t0 < BUDGET_MS) {
  const done = await page.evaluate(() => !!(window.__spike && (window.__spike.error
    || window.__spike.lines.some((l) => l.s.startsWith('PROBE DONE')))));
  if (done) { timedOut = false; break; }
  await page.waitForTimeout(500);
}

const out = await page.evaluate(() => ({
  marks: window.__spike.marks,
  error: window.__spike.error,
  finished: window.__spike.finished,
  lines: window.__spike.lines,
}));
await browser.close();

const lines = out.lines.map((l) => `${l.t.toFixed(0)}ms ${l.s}`);
const bare = out.lines.map((l) => l.s);
const first = (p) => bare.find((s) => s.startsWith(p)) || null;

const verdict = await fetch(`${origin}/__verdict`).then((r) => r.json());

/* ── The checks ────────────────────────────────────────────────────────── */

const startLine = first('PROBE START build=');
const ranBuild = startLine ? startLine.slice('PROBE START build='.length).trim() : null;
const wantBuild = (process.env.BUILD_ID || '').trim();

const msgLine = bare.find((s) => s.startsWith('PROBE GUI message('));
const gotNonce = msgLine ? (/w15a-nonce:([0-9a-f]+)/.exec(msgLine) || [])[1] || null : null;

const replies = verdict.transcript
  .filter((e) => e.dir === 'C2S' && e.frame && e.frame.kind === 'reply')
  .map((e) => ({ callId: e.frame.callId, method: e.frame.method, result: e.frame.result }));

const checks = {
  reachedDone: !timedOut && !out.error,
  build: Boolean(wantBuild) && ranBuild === wantBuild,
  transportOpened: Boolean(first('PROBE OPEN PASS')),
  // NOT a gate: java.lang.reflect.Proxy does not work under CheerpJ and this
  // lane keeps measuring it rather than deleting the step. What must hold is
  // that the answer was RECORDED; `proxySupported` below carries which way.
  proxyRecorded: Boolean(first('PROBE PROXY')),
  pumpThread: Boolean(first('PROBE THREAD PASS')),
  actOut: verdict.transcript.some((e) => e.dir === 'C2S' && e.valid && e.frame.kind === 'act' && e.frame.method === 'selectButtonOk'),
  notifyIn: Boolean(msgLine),
  nonce: Boolean(gotNonce) && gotNonce === verdict.nonce,
  byteArg: verdict.transcript.some((e) => e.dir === 'C2S' && e.valid && e.frame.method === 'useMana' && e.frame.color === 3),
  askReplies: replies.length === 2,
  distinctReplies: replies.length === 2 && replies[0].result === true && replies[1].result === false,
  refusedTierB: bare.some((s) => s.includes('REFUSE-IN method=showPromptMessage')),
  serverVerdict: verdict.ok === true,
  rtt: Boolean(first('PROBE RTT n=')),
};
const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);

const result = {
  url,
  timedOut,
  wallMs: Date.now() - t0,
  build: { ran: ranBuild, expected: wantBuild || null },
  proxySupported: Boolean(first('PROBE PROXY PASS')),
  proxyLine: first('PROBE PROXY'),
  rttLine: first('PROBE RTT'),
  mutation: verdict.mutation,
  nonce: { java: gotNonce, server: verdict.nonce },
  replies,
  marks: out.marks,
  error: out.error,
  pageErrors,
  checks,
  failed,
  pass: failed.length === 0,
  serverFailures: verdict.failures,
  serverCounts: verdict.counts,
  lines,
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;

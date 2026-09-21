// Wave 16, lane A -- turn a batch directory of run JSONs into the table that
// goes in docs/spikes/cheerpj-boot.md.
//
//   node tally.mjs <runs-dir> [<runs-dir> ...]
//
// It prints, per batch: n, k, the outcome breakdown, where the stalls stopped,
// the load-average range across the runs, and the storage figures -- because a
// rate quoted without the conditions it was taken under is the thing wave 15's
// own "what Phase 2 did NOT verify" warns about.

import fs from 'node:fs';
import path from 'node:path';

const dirs = process.argv.slice(2);
if (!dirs.length) { console.error('usage: tally.mjs <runs-dir> [...]'); process.exit(2); }

const pct = (x) => (100 * x).toFixed(0) + '%';

for (const dir of dirs) {
  const files = fs.readdirSync(dir).filter((f) => /^run-\d+\.json$/.test(f)).sort();
  const runs = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  if (!runs.length) { console.log(`${dir}: no runs`); continue; }

  const n = runs.length;
  const ok = runs.filter((r) => r.outcome === 'READY');
  const k = n - ok.length;
  const by = {};
  for (const r of runs) { by[r.outcome] = (by[r.outcome] || 0) + 1; }

  const stallWhere = {};
  for (const r of runs.filter((x) => x.outcome !== 'READY')) {
    const m = /entry=(\S+) files=(\d+)/.exec(r.lastWatchdog || '');
    const key = `${r.stalledIn || r.outcome}${m ? ` @files=${m[2]} ${m[1]}` : ''}`;
    stallWhere[key] = (stallWhere[key] || 0) + 1;
  }

  const loads = runs.map((r) => r.env.start.load[0]);
  const meta = fs.existsSync(path.join(dir, 'META.txt')) ? fs.readFileSync(path.join(dir, 'META.txt'), 'utf8').trim() : '';
  const num = (a) => (a.length ? { min: Math.min(...a), med: a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)], max: Math.max(...a) } : null);

  console.log(`\n=== ${dir}`);
  if (meta) console.log(meta.split('\n').map((l) => '    ' + l).join('\n'));
  console.log(`  n=${n}  READY=${ok.length}  k=${k}  failure rate=${pct(k / n)}`);
  console.log(`  outcomes: ${JSON.stringify(by)}`);
  console.log(`  load(1m) at run start: ${JSON.stringify(num(loads))}`);
  console.log(`  homeMs (successes):    ${JSON.stringify(num(ok.map((r) => r.homeMs)))}`);
  console.log(`  markerMs (successes):  ${JSON.stringify(num(ok.map((r) => r.markerMs)))}`);
  console.log(`  max in-call ms during unpack, successes: ${JSON.stringify(num(ok.map((r) => r.maxUnpackInCallMs)))}`);
  const q = runs.map((r) => r.storage.quotaBytes).filter(Boolean);
  const u = runs.map((r) => r.storage.peakUsage).filter(Boolean);
  console.log(`  storage quota bytes:   ${JSON.stringify(num(q))}`);
  console.log(`  peak usage bytes:      ${JSON.stringify(num(u))}`);
  console.log(`  IDB aborts total=${runs.reduce((s, r) => s + (r.idb ? r.idb.aborts : 0), 0)}`
    + `  errors total=${runs.reduce((s, r) => s + (r.idb ? r.idb.errors : 0), 0)}`
    + `  failed requests total=${runs.reduce((s, r) => s + (r.idb && r.idb.failed ? r.idb.failed : 0), 0)}`
    + `  unhandled rejections total=${runs.reduce((s, r) => s + r.rejections.length, 0)}`);
  console.log(`  outstanding IDB requests at stall: ${JSON.stringify(
    runs.filter((r) => r.outcome !== 'READY').map((r) => (r.idb ? r.idb.outstanding : null)))}`);
  console.log(`  outstanding fetches at stall:      ${JSON.stringify(
    runs.filter((r) => r.outcome !== 'READY').map((r) => (r.net ? r.net.outstanding : null)))}`);
  if (k) console.log(`  where it stopped: ${JSON.stringify(stallWhere, null, 2).replace(/\n/g, '\n  ')}`);
}

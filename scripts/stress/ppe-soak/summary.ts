/*
 * One soak run, summarised: the 5-minute rows `sample.ts` wrote, what the driver's clients saw, and
 * the edge's own request rows for the run's window (request_logs keep 90 days).
 *
 *   node scripts/stress/ppe-soak/summary.ts <run dir>
 *
 * Writes `<run dir>/summary.json` (the curves, for the artifact) and prints the run's line for the
 * closing note's table and the pass/fail against the lane's bar: no fence or failover, loop max
 * under 1 s, no RSS growth trend, no 5xx.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '';
const lines = (file: string): Record<string, unknown>[] =>
  readFileSync(join(dir, file), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const KEY = (JSON.parse(readFileSync('/home/hadoku/repos/hadoku-cardtable/.devvault.local.json', 'utf8')) as { key: string }).key;

interface Cap {
  loopP99Ms: number;
  loopMaxMs: number;
  p95Ms: number;
  errors5xx: number;
  requests: number;
  peak: { sockets: number; matches: number; jvms: number; rssMb: number; heapMb: number; rooms: number; drafts: number };
}

const driver = lines('driver.jsonl');
const start = String(driver.find((r) => r.evt === 'run-start')?.at ?? '');
const end = String(driver.findLast((r) => r.evt === 'run-end')?.at ?? driver.at(-1)?.at ?? '');
const samples = lines('samples.jsonl').filter((s) => s.ppe !== undefined && String(s.at) >= start && String(s.at) <= new Date(Date.parse(end) + 6 * 60_000).toISOString());

const curve = samples.map((s) => {
  const c = s.ppe as Cap;
  const log = s.log as { counts: Record<string, number>; hosts: Record<string, number>; slowWrites: number[] };
  const psi = s.psi as { io: { some60: number; full60: number }; cpu: { some60: number } };
  return {
    at: String(s.at),
    loopP99: c.loopP99Ms,
    loopMax: c.loopMaxMs,
    p95: Math.round(c.p95Ms),
    sockets: c.peak.sockets,
    matches: c.peak.matches,
    jvms: c.peak.jvms,
    rss: c.peak.rssMb,
    heap: c.peak.heapMb,
    server5xx: c.errors5xx,
    edge5xx: (s.edge5xx as { n: number }).n,
    load1: (s.load as number[])[0] ?? 0,
    ioSome: psi.io.some60,
    ioFull: psi.io.full60,
    cpuSome: psi.cpu.some60,
    events: log.counts,
    hosts: log.hosts,
    slowWrites: log.slowWrites,
    prodMatches: (s.prod as { peak?: { matches?: number } } | null)?.peak?.matches ?? null,
  };
});

/** Least-squares slope of RSS over the run's second half, in MB an hour: the growth trend. */
function slopePerHour(points: { at: string; v: number }[]): number {
  const half = points.slice(Math.floor(points.length / 2));
  if (half.length < 3) return 0;
  const xs = half.map((p) => Date.parse(p.at) / 3_600_000);
  const ys = half.map((p) => p.v);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const num = xs.reduce((a, x, i) => a + (x - mx) * ((ys[i] ?? 0) - my), 0);
  const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  return den === 0 ? 0 : num / den;
}

async function edgeRows(): Promise<{ n: number; p95: number; slowSession: { at: string; ms: number; path: string }[]; fivexx: number }> {
  const rows: { timestamp: string; duration: number; status: number; path: string; server_timing: string | null }[] = [];
  for (let offset = 0; offset < 200_000; offset += 1000) {
    const url = `https://hadoku.me/health/api/logs/query?path=/cardtable-ppe&since=${start}&until=${end}&limit=1000&offset=${String(offset)}`;
    const body = (await (await fetch(url, { headers: { 'X-User-Key': KEY, 'User-Agent': 'Mozilla/5.0 hadoku-agent' } })).json()) as { logs?: typeof rows };
    rows.push(...(body.logs ?? []));
    if ((body.logs ?? []).length < 1000) break;
  }
  const durations = rows.map((r) => r.duration).sort((a, b) => a - b);
  const slowSession = rows
    .map((r) => ({ at: r.timestamp, ms: Number(/edge\.session;dur=(\d+)/.exec(r.server_timing ?? '')?.[1] ?? 0), path: r.path }))
    .filter((r) => r.ms > 2000);
  return { n: rows.length, p95: durations[Math.floor(durations.length * 0.95)] ?? 0, slowSession, fivexx: rows.filter((r) => r.status >= 500).length };
}

const edge = await edgeRows();
const ends = driver.filter((r) => r.evt === 'match-end');
const sum = (k: string): number => curve.reduce((a, c) => a + ((c.events as Record<string, number>)[k] ?? 0), 0);
const hosts: Record<string, number> = {};
for (const c of curve) for (const [h, n] of Object.entries(c.hosts)) hosts[h] = (hosts[h] ?? 0) + n;
const result = {
  start,
  end,
  hours: (Date.parse(end) - Date.parse(start)) / 3_600_000,
  pod: driver.find((r) => r.evt === 'pod-done') ?? null,
  matches: ends.length,
  matchesFinished: ends.filter((r) => r.over === true || r.ended !== null).length,
  matchTrouble: driver.filter((r) => r.evt === 'match-trouble').length,
  matchRefused: driver.filter((r) => r.evt === 'match-refused').length,
  watchTrouble: driver.filter((r) => r.evt === 'watch-trouble').length,
  clientHttpErrors: driver.filter((r) => (r.evt === 'http' && Number(r.status) >= 500) || r.evt === 'http-error').length,
  loopP99Max: Math.max(...curve.map((c) => c.loopP99)),
  loopMax: Math.max(...curve.map((c) => c.loopMax)),
  p95Max: Math.max(...curve.map((c) => c.p95)),
  socketsPeak: Math.max(...curve.map((c) => c.sockets)),
  matchesPeak: Math.max(...curve.map((c) => c.matches)),
  jvmsPeak: Math.max(...curve.map((c) => c.jvms)),
  rssFirst: curve[0]?.rss ?? 0,
  rssLast: curve.at(-1)?.rss ?? 0,
  rssSlopeMbPerHour: Math.round(slopePerHour(curve.map((c) => ({ at: c.at, v: c.rss })))),
  heapSlopeMbPerHour: Math.round(slopePerHour(curve.map((c) => ({ at: c.at, v: c.heap })))),
  fences: sum('fenced-over'),
  failovers: sum('claw-failed-over'),
  lost: sum('agent-lost') + sum('jvm-lost') + sum('match-lost'),
  slowWrites: curve.flatMap((c) => c.slowWrites),
  server5xx: curve.reduce((a, c) => a + c.server5xx, 0),
  edge,
  hosts,
  loadMax: Math.max(...curve.map((c) => c.load1)),
  ioFullMax: Math.max(...curve.map((c) => c.ioFull)),
};
const pass = {
  noFenceOrFailover: result.fences === 0 && result.failovers === 0,
  loopUnder1s: result.loopMax < 1000,
  noRssTrend: result.rssSlopeMbPerHour < 50,
  no5xx: result.edge.fivexx === 0 && result.server5xx === 0,
};
writeFileSync(join(dir, 'summary.json'), JSON.stringify({ result, pass, curve }, null, 1));
console.log(JSON.stringify({ ...result, edge: { ...edge, slowSession: edge.slowSession.length, slowSessionMax: Math.max(0, ...edge.slowSession.map((s) => s.ms)) }, pass }, null, 1));

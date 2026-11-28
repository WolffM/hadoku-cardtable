/*
 * One soak run, summarised: the 5-minute rows `sample.ts` wrote, what the driver's clients saw, and
 * the edge's own request rows for the run's window (request_logs keep 90 days).
 *
 *   node scripts/stress/ppe-soak/summary.ts <run dir> [--from <iso>] [--redeploy <iso>]…
 *
 * `--from` starts the run's window later than the driver did (run 1 counts from the deploy that
 * carried the fix it was waiting for). `--redeploy` names a PPE restart the samples missed; every
 * process start the sampler saw is one already.
 *
 * Writes `<run dir>/summary.json` (the curves, for the artifact) and prints the run's line for the
 * closing note's table and the pass/fail against the lane's bar: no fence or failover, loop max
 * under 1 s, no RSS growth trend, no 5xx.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dir = process.argv[2] ?? '';
const flag = (name: string): string[] => process.argv.flatMap((a, i) => (a === name && process.argv[i + 1] !== undefined ? [process.argv[i + 1] ?? ''] : []));
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
const start = flag('--from')[0] ?? String(driver.find((r) => r.evt === 'run-start')?.at ?? '');
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

interface EdgeRow {
  timestamp: string;
  duration: number;
  status: number;
  path: string;
  user_id: string | null;
  server_timing: string | null;
}

/**
 * Each slow session read with how long its account had been quiet at the edge before it (every path,
 * not only cardtable's): whether a stall follows an idle gap is the question the site was asked.
 */
async function idleBefore(userId: string | null, at: string): Promise<number | null> {
  if (userId === null) return null;
  const since = new Date(Date.parse(at) - 60 * 60_000).toISOString();
  const url = `https://hadoku.me/health/api/logs/query?userId=${userId}&since=${since}&until=${at}&limit=1000`;
  const body = (await (await fetch(url, { headers: { 'X-User-Key': KEY, 'User-Agent': 'Mozilla/5.0 hadoku-agent' } })).json()) as { logs?: EdgeRow[] };
  // `at` is when the slow request began; a row's timestamp is when it finished, so `until=at` is every earlier one.
  const before = (body.logs ?? []).map((r) => Date.parse(r.timestamp));
  return before.length === 0 ? null : Math.round((Date.parse(at) - Math.max(...before)) / 1000);
}

async function edgeRows(): Promise<{ n: number; p95: number; slowSession: { at: string; ms: number; path: string; user: string | null; idleS: number | null }[]; fivexx: number }> {
  const rows: EdgeRow[] = [];
  for (let offset = 0; offset < 200_000; offset += 1000) {
    const url = `https://hadoku.me/health/api/logs/query?path=/cardtable-ppe&since=${start}&until=${end}&limit=1000&offset=${String(offset)}`;
    const body = (await (await fetch(url, { headers: { 'X-User-Key': KEY, 'User-Agent': 'Mozilla/5.0 hadoku-agent' } })).json()) as { logs?: typeof rows };
    rows.push(...(body.logs ?? []));
    if ((body.logs ?? []).length < 1000) break;
  }
  const durations = rows.map((r) => r.duration).sort((a, b) => a - b);
  const slow = rows
    .map((r) => ({ at: r.timestamp, ms: Number(/edge\.session;dur=(\d+)/.exec(r.server_timing ?? '')?.[1] ?? 0), path: r.path, user: r.user_id }))
    .filter((r) => r.ms > 2000);
  const slowSession = [];
  for (const r of slow) slowSession.push({ ...r, idleS: await idleBefore(r.user, new Date(Date.parse(r.at) - r.ms).toISOString()) });
  return { n: rows.length, p95: durations[Math.floor(durations.length * 0.95)] ?? 0, slowSession, fivexx: rows.filter((r) => r.status >= 500).length };
}

const edge = await edgeRows();
const ends = driver.filter((r) => r.evt === 'match-end' && String(r.at) >= start);

/**
 * The edge's session stalls (hadoku_site, fixed 07:41:49Z on 2026-11-28): slow reads that began within
 * a minute of each other are one window. Its own row in the table, so cardtable is not blamed for it.
 */
const STALL_MS = 3000;
const stalls: { start: string; release: string; rows: number; users: number }[] = [];
for (const r of [...edge.slowSession].filter((x) => x.ms > STALL_MS).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
  const began = Date.parse(r.at) - r.ms;
  const last = stalls.at(-1);
  if (last !== undefined && began - Date.parse(last.start) < 60_000) {
    last.rows += 1;
    if (r.at > last.release) last.release = r.at;
    continue;
  }
  stalls.push({ start: new Date(began).toISOString(), release: r.at, rows: 1, users: 0 });
}
for (const w of stalls) {
  const inside = edge.slowSession.filter((x) => x.ms > STALL_MS && Date.parse(x.at) - x.ms >= Date.parse(w.start) - 1000 && x.at <= w.release);
  w.users = new Set(inside.map((x) => x.user)).size;
}
/** A client's trouble counts against the edge when it falls in a stall or the 45 s of reconnects after it. */
const inStall = (at: string): boolean => stalls.some((w) => at >= w.start && Date.parse(at) <= Date.parse(w.release) + 45_000);
/** A 5-minute sample is a stall window when any stall overlaps the five minutes it covers. */
const sampleInStall = (at: string): boolean => stalls.some((w) => w.start <= at && Date.parse(w.release) >= Date.parse(at) - 5 * 60_000);
for (const c of curve) Object.assign(c, { edgeStall: sampleInStall(c.at) });
const troubles = driver.filter((r) => (r.evt === 'match-trouble' || r.evt === 'watch-trouble') && String(r.at) >= start);

/** PPE restarts in the window: every process start a sample saw, and any given by hand. */
const sawStarts = lines('samples.jsonl').flatMap((x) => ((x.server as { procs?: { startedAt: string }[] } | undefined)?.procs ?? []).map((p) => p.startedAt));
const redeploys = [...new Set([...sawStarts, ...flag('--redeploy')])].filter((t) => t >= start && t <= end).sort();
/** A client's trouble counts against a restart from just before the new process starts to 90 s after. */
const inRedeploy = (at: string): boolean => redeploys.some((t) => Date.parse(at) >= Date.parse(t) - 10_000 && Date.parse(at) <= Date.parse(t) + 90_000);
const blame = (at: string): 'edge' | 'redeploy' | 'cardtable' => (inStall(at) ? 'edge' : inRedeploy(at) ? 'redeploy' : 'cardtable');

const pcts = (xs: number[]): { n: number; p50: number; p95: number; max: number } | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number): number => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0);
  return { n: s.length, p50: at(0.5), p95: at(0.95), max: Math.round(s.at(-1) ?? 0) };
};

/**
 * Every turn's wall time on PPE, from the server's `turn-snapshot` rows for this run's matches: both
 * seats' turns, so an upper bound on the AI's. The driver's own split (`aiTurnsMs`, `aiHoldsMs`, the
 * stretches the AI held priority) is the AI alone, where the driver recorded it.
 */
function turnWallMs(): number[] {
  const ids = new Set(driver.filter((r) => r.evt === 'match-end').map((r) => String(r.matchId)));
  const logs = join(homedir(), '.pm2/logs');
  const turns = new Map<string, { turn: number; t: number }[]>();
  for (const f of readdirSync(logs).filter((n) => n.startsWith('cardtable-ppe-out'))) {
    for (const line of readFileSync(join(logs, f), 'utf8').split('\n')) {
      if (!line.includes('"turn-snapshot"')) continue;
      const r = JSON.parse(line) as { t: string; matchId: string; turn: number };
      if (!ids.has(r.matchId) || r.t < start || r.t > end) continue;
      turns.set(r.matchId, [...(turns.get(r.matchId) ?? []), { turn: r.turn, t: Date.parse(r.t) }]);
    }
  }
  const out: number[] = [];
  for (const rows of turns.values()) {
    const seen = new Map(rows.map((r) => [r.turn, r.t]));
    for (const [turn, t] of seen) {
      const next = seen.get(turn + 1);
      if (next !== undefined && next > t) out.push(next - t);
    }
  }
  return out;
}
const aiTurns = ends.flatMap((r) => (Array.isArray(r.aiTurnsMs) ? (r.aiTurnsMs as number[]) : []));
const aiHolds = ends.flatMap((r) => (Array.isArray(r.aiHoldsMs) ? (r.aiHoldsMs as number[]) : []));
const outside = curve.filter((c) => !(c as { edgeStall?: boolean }).edgeStall);
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
  edgeStalls: stalls,
  redeploys,
  trouble: Object.fromEntries(
    (['edge', 'redeploy', 'cardtable'] as const).map((who) => {
      const mine = troubles.filter((r) => blame(String(r.at)) === who);
      const kinds: Record<string, number> = {};
      for (const r of mine) kinds[String(r.what)] = (kinds[String(r.what)] ?? 0) + 1;
      return [who, { n: mine.length, kinds, at: who === 'cardtable' ? mine.map((r) => String(r.at)) : undefined }];
    }),
  ),
  p95MaxOutsideStall: Math.max(0, ...outside.map((c) => c.p95)),
  loopMaxOutsideStall: Math.max(0, ...outside.map((c) => c.loopMax)),
  turnWallMs: pcts(turnWallMs()),
  aiTurnMs: pcts(aiTurns),
  aiHoldMs: pcts(aiHolds),
  decks: Object.fromEntries([...new Set(ends.map((r) => String(r.deck ?? 'library')))].map((d) => [d, ends.filter((r) => String(r.deck ?? 'library') === d).length])),
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
console.log(JSON.stringify({ ...result, edge: { ...edge, slowSession: edge.slowSession.length, slowSessionMax: Math.max(0, ...edge.slowSession.map((x) => x.ms)) }, pass }, null, 1));

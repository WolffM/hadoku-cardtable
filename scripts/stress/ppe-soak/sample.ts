/*
 * The soak's recorder: every 5 minutes, one row of what the server and its host did, into
 * `<out>/samples.jsonl`, and the prod guard.
 *
 *   node scripts/stress/ppe-soak/sample.ts --out <dir> --accounts <file> [--hours 2.6]
 *
 * A row: PPE's own `capacity` event (event loop p99/max, request p95, sockets, RSS, heap, JVMs,
 * matches, free Forge slots, 5xx it answered), what PPE's log said in the window (fences,
 * failovers, lost agents/JVMs/matches, slow snapshot writes, which hosts matches were placed on),
 * the edge's 5xx for /cardtable-ppe, hokon's load and CPU/IO pressure, and prod's capacity.
 *
 * Prod guard: prod shares hokon. When prod has a live match in a tournament room the run is ended
 * (`STOP`); the driver's matches and watchers wind down on it.
 */
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const get = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const out = get('out') ?? '';
const accounts = JSON.parse(readFileSync(get('accounts') ?? '', 'utf8')) as { session: string }[];
const stopAt = Date.now() + Number(get('hours') ?? '2.6') * 3_600_000;
const EVERY_MS = 5 * 60_000;
const KEY = (JSON.parse(readFileSync('/home/hadoku/repos/hadoku-cardtable/.devvault.local.json', 'utf8')) as { key: string }).key;
const PPE_LOG = '/home/hadoku/.pm2/logs/cardtable-ppe-out.log';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const WATCHED = ['fenced-over', 'claw-failed-over', 'agent-lost', 'jvm-lost', 'match-lost', 'match-failed', 'jvm-boot-failed', 'snapshot-write-slow', 'agent-watch-stalled', 'capacity-refused', 'rate-limited'];

async function monitoring(path: string): Promise<unknown> {
  const res = await fetch(`https://hadoku.me/health/api/${path}`, { headers: { 'X-User-Key': KEY, 'User-Agent': 'Mozilla/5.0 hadoku-agent' } });
  return res.json();
}

async function capacity(site: 'ppe' | 'prod'): Promise<Record<string, unknown> | null> {
  const body = (await monitoring('service-events?service=cardtable&event=capacity&limit=6')) as { events?: { context_json: string }[] };
  for (const e of body.events ?? []) {
    const c = JSON.parse(e.context_json) as Record<string, unknown>;
    if (c.site === site) return c;
  }
  return null;
}

async function edge5xx(since: string): Promise<{ n: number; paths: string[] }> {
  const body = (await monitoring(`logs/query?path=/cardtable-ppe&status=5xx&since=${since}&limit=1000`)) as { logs?: { path: string; status: number }[] };
  const logs = body.logs ?? [];
  return { n: logs.length, paths: [...new Set(logs.map((l) => `${String(l.status)} ${l.path}`))].slice(0, 10) };
}

let logOffset = existsSync(PPE_LOG) ? statSync(PPE_LOG).size : 0;
function ppeLogWindow(): { counts: Record<string, number>; hosts: Record<string, number>; slowWrites: number[] } {
  const counts: Record<string, number> = {};
  const hosts: Record<string, number> = {};
  const slowWrites: number[] = [];
  let size: number;
  let buf: Buffer;
  const fd = openSync(PPE_LOG, 'r');
  try {
    size = fstatSync(fd).size;
    if (size < logOffset) logOffset = 0; // rotated
    buf = Buffer.allocUnsafe(size - logOffset);
    readSync(fd, buf, 0, buf.length, logOffset);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString('utf8');
  const end = text.lastIndexOf('\n');
  logOffset += Buffer.byteLength(text.slice(0, end + 1));
  for (const line of text.slice(0, end).split('\n')) {
    const m = /"evt":"([a-z-]+)"/.exec(line);
    if (m === null) continue;
    const evt = m[1] ?? '';
    if (WATCHED.includes(evt)) counts[evt] = (counts[evt] ?? 0) + 1;
    if (evt === 'snapshot-write-slow') slowWrites.push(Number(/"ms":(\d+)/.exec(line)?.[1] ?? 0));
    if (evt === 'match-placed') {
      const host = /"host":"([^"]+)"/.exec(line)?.[1] ?? '?';
      hosts[host] = (hosts[host] ?? 0) + 1;
    }
  }
  return { counts, hosts, slowWrites };
}

function pressure(kind: 'io' | 'cpu' | 'memory'): { some60: number; full60: number } {
  const text = readFileSync(`/proc/pressure/${kind}`, 'utf8');
  const avg = (row: string): number => Number(new RegExp(`${row} avg10=[\\d.]+ avg60=([\\d.]+)`).exec(text)?.[1] ?? 0);
  return { some60: avg('some'), full60: avg('full') };
}

/** Prod's live matches, by whether their room is a tournament's. One read every 5 minutes. */
async function prodLive(): Promise<{ matches: number; tournament: number } | null> {
  const a = accounts[accounts.length - 1];
  if (a === undefined) return null;
  try {
    const res = await fetch('https://hadoku.me/cardtable/api/rooms', { headers: { cookie: `hadoku_session=${a.session}`, 'user-agent': UA } });
    const body = (await res.json()) as { rooms?: { settings?: { tournament?: boolean }; matchId?: string | null; tables?: { matchId: string | null }[] }[] };
    let matches = 0;
    let tournament = 0;
    for (const r of body.rooms ?? []) {
      const n = (r.tables ?? []).filter((t) => t.matchId !== null).length || (r.matchId ? 1 : 0);
      matches += n;
      if (r.settings?.tournament === true) tournament += n;
    }
    return { matches, tournament };
  } catch {
    return null;
  }
}

async function row(): Promise<void> {
  const since = new Date(Date.now() - EVERY_MS).toISOString();
  const [ppe, prod, e5, prodRooms] = await Promise.all([capacity('ppe'), capacity('prod'), edge5xx(since), prodLive()]);
  const r = {
    at: new Date().toISOString(),
    ppe,
    prod: prod === null ? null : { now: prod.now, peak: prod.peak, loopMaxMs: prod.loopMaxMs },
    prodRooms,
    edge5xx: e5,
    log: ppeLogWindow(),
    load: loadavg().map((x) => Math.round(x * 10) / 10),
    psi: { io: pressure('io'), cpu: pressure('cpu'), memory: pressure('memory') },
  };
  appendFileSync(join(out, 'samples.jsonl'), `${JSON.stringify(r)}\n`);
  if (prodRooms !== null && prodRooms.tournament > 0) writeFileSync(join(out, 'STOP'), `prod tournament match live at ${r.at}\n`);
}

while (Date.now() < stopAt && !existsSync(join(out, 'STOP'))) {
  try {
    await row();
  } catch (err) {
    appendFileSync(join(out, 'samples.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), error: (err as Error).message })}\n`);
  }
  await new Promise((r) => setTimeout(r, EVERY_MS));
}

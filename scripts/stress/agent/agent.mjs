#!/usr/bin/node
/*
 * The §A test agent: docs/planning/hosting-test-plan.md §A, on a fleet-manager hosting slice.
 *
 * NOT the host agent. It exists so the acceptance tests have real Forge load inside the slice:
 * it takes artifacts it can verify, unpacks a JDK and a stress stage, and runs ForgeScale under
 * its own user, in its own cgroup. Nothing here places, fails over or serves a match.
 *
 * fleet-manager runs it as `cardtable-agent` (no login, no sudo, home 0700) with
 * ProtectSystem=strict, ProtectHome=yes and PrivateTmp: it writes only under its home.
 *
 * Every request is signed with an Ed25519 key whose public half `agent.sh build` writes into
 * this file; the private half stays on the controller. A request carries
 *   x-agent-ts      unix ms, within 30 s of the agent's clock
 *   x-agent-body    sha256 hex of the body (of the empty string when there is none)
 *   x-agent-sig     base64 Ed25519 over "<METHOD>\n<path>\n<ts>\n<body sha>"
 * and a signature is accepted once. The body is hashed as it arrives and refused on a mismatch.
 */
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { cpSync, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const PUBLIC_KEY = createPublicKey('__AGENT_PUBLIC_KEY__');
const PORT = Number(process.env.CARDTABLE_AGENT_PORT);
const HOME = process.cwd();
const BLOBS = join(HOME, 'blobs');
const RUNS = join(HOME, 'runs');
const SKEW_MS = 30_000;
const SHA = /^[0-9a-f]{64}$/;
const UNPACK_INTO = { jdk: join(HOME, 'jdk'), stage: join(HOME, 'stage') };
const STRESS_PROP = /^stress\.[A-Za-z]+$/;
const STRESS_VALUE = /^[A-Za-z0-9._-]{1,64}$/;
const XMX = /^\d{2,5}m$/;
const STARTED = Date.now();

for (const d of [BLOBS, RUNS]) mkdirSync(d, { recursive: true });

const log = (what, data = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), what, ...data }));

const seen = new Map();
function signed(req) {
  const ts = Number(req.headers['x-agent-ts']);
  const body = String(req.headers['x-agent-body'] ?? '');
  const sig = String(req.headers['x-agent-sig'] ?? '');
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SKEW_MS) return 'stale or missing x-agent-ts';
  if (!SHA.test(body)) return 'missing x-agent-body';
  for (const [s, at] of seen) if (Date.now() - at > 2 * SKEW_MS) seen.delete(s);
  if (seen.has(sig)) return 'replayed signature';
  const ok = verify(null, Buffer.from(`${req.method}\n${req.url}\n${ts}\n${body}`), PUBLIC_KEY, Buffer.from(sig, 'base64'));
  if (!ok) return 'bad signature';
  seen.set(sig, Date.now());
  return null;
}

/** Reads the body into memory (JSON requests) or a file (blobs), hashing as it goes. */
function receive(req, file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const out = file ? createWriteStream(file) : null;
    const chunks = [];
    req.on('data', (c) => {
      hash.update(c);
      if (out) out.write(c);
      else if (chunks.push(c) > 1024) req.destroy(new Error('JSON body too large'));
    });
    req.on('error', reject);
    req.on('end', () => {
      const sha = hash.digest('hex');
      if (!out) return resolve({ sha, json: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} });
      out.end(() => resolve({ sha }));
    });
  });
}

/*
 * Matches outlive the agent. The unit is Delegate=yes and KillMode=process, so a restart kills only
 * the agent's own process: the agent moves itself into the leaf `agent/` and puts each JVM in a
 * leaf `run-<id>/` beside it (cgroup v2 allows no processes in a cgroup that has children), and a
 * restarted agent adopts every run cgroup that still holds a process. Without delegation the
 * JVMs stay in the agent's cgroup and die with it.
 */
const SERVICE_CG = join('/sys/fs/cgroup', readFileSync('/proc/self/cgroup', 'utf8').trim().split('::').pop().replace(/\/agent$/, ''));
const delegated = (() => {
  // Only in a hosting slice: anywhere else the cgroup is somebody else's (a shell's scope, say).
  if (!SERVICE_CG.includes('/hosting.slice/')) return false;
  try {
    mkdirSync(join(SERVICE_CG, 'agent'), { recursive: true });
    writeFileSync(join(SERVICE_CG, 'agent', 'cgroup.procs'), String(process.pid));
    return true;
  } catch (e) {
    log('not-delegated', { cgroup: SERVICE_CG, error: e.code });
    return false;
  }
})();

const procsIn = (cg) => {
  try {
    return readFileSync(join(cg, 'cgroup.procs'), 'utf8').trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
};

function sliceStats() {
  const slice = join(SERVICE_CG, '..');
  const read = (f) => {
    try {
      return readFileSync(join(slice, f), 'utf8').trim();
    } catch (e) {
      return `unreadable: ${e.code}`;
    }
  };
  return { cgroup: SERVICE_CG, delegated, memoryCurrent: read('memory.current'), memoryMax: read('memory.max'), memoryEvents: read('memory.events'), cpuStat: read('cpu.stat') };
}

const runs = new Map();

/** A run ends when its cgroup holds no process; its exit code is known only to the agent that spawned it. */
function watch(id, r) {
  const cg = join(SERVICE_CG, `run-${id}`);
  const timer = setInterval(() => {
    if (procsIn(cg).length) return;
    clearInterval(timer);
    r.exit ??= { code: null, signal: null, at: new Date().toISOString(), adopted: true };
    try {
      rmdirSync(cg);
    } catch (e) {
      log('rmdir', { cg, error: e.code });
    }
  }, 5000);
}

if (delegated) {
  for (const d of readdirSync(SERVICE_CG)) {
    const pids = d.startsWith('run-') ? procsIn(join(SERVICE_CG, d)) : [];
    if (!pids.length) continue;
    const id = d.slice(4);
    const r = { pid: pids[0], exit: null, adopted: true };
    runs.set(id, r);
    watch(id, r);
    log('adopted', { id, pids });
  }
}

function runStatus(id) {
  const r = runs.get(id);
  const dir = join(RUNS, id);
  const tail = (f, n) => {
    try {
      return readFileSync(join(dir, f), 'utf8').trim().split('\n').slice(-n);
    } catch {
      return [];
    }
  };
  return {
    id,
    pid: r?.pid ?? null,
    adopted: r?.adopted ?? false,
    exit: r ? r.exit : 'unknown (before this agent started)',
    result: tail('result.txt', 50).filter((l) => l.startsWith('RESULT')),
    series: tail('series.tsv', 3),
    stderr: tail('stderr.txt', 5),
  };
}

function startStress({ label, xmx, pretouch, props }) {
  const java = join(UNPACK_INTO.jdk, 'bin', 'java');
  const stage = UNPACK_INTO.stage;
  if (!existsSync(java)) throw new Error('no JDK unpacked');
  if (!existsSync(join(stage, 'forge.jar'))) throw new Error('no stage unpacked');
  if (!/^[a-z0-9-]{1,40}$/.test(String(label))) throw new Error('label: [a-z0-9-]{1,40}');
  if (!XMX.test(String(xmx))) throw new Error('xmx: like 2200m');
  const flags = [];
  for (const [k, v] of Object.entries(props ?? {})) {
    if (!STRESS_PROP.test(k) || !STRESS_VALUE.test(String(v))) throw new Error(`prop ${k}=${v} refused`);
    flags.push(`-D${k}=${v}`);
  }
  const id = `${label}-${Date.now()}`;
  const dir = join(RUNS, id);
  for (const d of ['user/preferences', 'user/decks/constructed', 'cache', 'tmp']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'forge.profile.properties'), `userDir=${dir}/user/\ncacheDir=${dir}/cache/\ndecksDir=${dir}/user/decks/\ndecksConstructedDir=${dir}/user/decks/constructed/\n`);
  const args = [
    '-Djava.awt.headless=true',
    `-Djava.io.tmpdir=${dir}/tmp`,
    `-Xmx${xmx}`,
    // The whole heap faulted in at start, so GC never asks the kernel for a page mid-match (H14).
    ...(pretouch ? [`-Xms${xmx}`, '-XX:+AlwaysPreTouch'] : []),
    '-XX:ActiveProcessorCount=4',
    '-XX:+ExitOnOutOfMemoryError',
    `-Dstress.series=${dir}/series.tsv`,
    `-Dstress.cubeNames=${stage}/cube-names.txt`,
    ...flags,
    '-cp',
    `${stage}/classes:${stage}/forge.jar`,
    'ForgeScale',
  ];
  // As scripts/stress/run.sh lays a run out: Forge finds res/ in the working directory, and
  // ForgeScale writes the decks it builds into decks/.
  symlinkSync(join(stage, 'res'), join(dir, 'res'));
  if (existsSync(join(stage, 'decks'))) cpSync(join(stage, 'decks'), join(dir, 'decks'), { recursive: true });
  // Files, not pipes: a JVM that outlives the agent must not lose its stdout.
  const out = openSync(join(dir, 'result.txt'), 'a');
  const err = openSync(join(dir, 'stderr.txt'), 'a');
  const child = spawn(java, args, { cwd: dir, stdio: ['ignore', out, err] });
  const r = { pid: child.pid, exit: null, adopted: false };
  child.on('exit', (code, signal) => {
    r.exit = { code, signal, at: new Date().toISOString() };
    log('stress-exit', { id, code, signal });
  });
  if (delegated) {
    const cg = join(SERVICE_CG, `run-${id}`);
    mkdirSync(cg);
    writeFileSync(join(cg, 'cgroup.procs'), String(child.pid));
    watch(id, r);
  }
  runs.set(id, r);
  log('stress-start', { id, xmx, pretouch: Boolean(pretouch), flags });
  return id;
}

function unpack(sha, as) {
  const into = UNPACK_INTO[as];
  if (!into) throw new Error(`unpack as: ${Object.keys(UNPACK_INTO).join('|')}`);
  const blob = join(BLOBS, sha);
  if (!existsSync(blob)) throw new Error(`no blob ${sha}`);
  const next = `${into}.next`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next);
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xzf', blob, '-C', next, '--strip-components=1', '--no-same-owner'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let e = '';
    tar.stderr.on('data', (c) => (e += c));
    tar.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`tar exited ${code}: ${e.trim()}`));
      rmSync(into, { recursive: true, force: true });
      renameSync(next, into);
      resolve(into);
    });
  });
}

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(`${JSON.stringify(body)}\n`);
};

async function handle(req, res) {
  const refused = signed(req);
  if (refused) {
    log('refused', { method: req.method, url: req.url, why: refused, from: req.socket.remoteAddress });
    return send(res, 401, { error: refused });
  }
  const declared = String(req.headers['x-agent-body']);
  const blob = /^\/blob\/([0-9a-f]{64})$/.exec(req.url);
  if (req.method === 'PUT' && blob) {
    const sha = blob[1];
    if (declared !== sha) return send(res, 400, { error: 'x-agent-body must be the blob sha' });
    const part = join(BLOBS, `${sha}.part`);
    const got = await receive(req, part);
    if (got.sha !== sha) {
      rmSync(part, { force: true });
      return send(res, 400, { error: `body hashed to ${got.sha}` });
    }
    renameSync(part, join(BLOBS, sha));
    log('blob', { sha, bytes: statSync(join(BLOBS, sha)).size });
    return send(res, 200, { sha });
  }
  const { sha, json } = await receive(req);
  if (sha !== declared) return send(res, 400, { error: `body hashed to ${sha}` });
  if (req.method === 'GET' && req.url === '/status') {
    return send(res, 200, {
      pid: process.pid,
      uid: process.getuid(),
      upSec: Math.round((Date.now() - STARTED) / 1000),
      node: process.version,
      jdk: existsSync(join(UNPACK_INTO.jdk, 'bin', 'java')),
      stage: existsSync(join(UNPACK_INTO.stage, 'forge.jar')),
      blobs: readdirSync(BLOBS),
      slice: sliceStats(),
      runs: [...runs.keys()].map(runStatus),
    });
  }
  if (req.method === 'POST' && req.url === '/unpack') return send(res, 200, { into: await unpack(String(json.sha), String(json.as)) });
  if (req.method === 'POST' && req.url === '/stress') return send(res, 200, { id: startStress(json) });
  const run = /^\/stress\/([a-z0-9-]+)$/.exec(req.url);
  if (run && req.method === 'GET') return send(res, 200, runStatus(run[1]));
  if (run && req.method === 'DELETE') {
    const r = runs.get(run[1]);
    if (!r) return send(res, 404, { error: 'no such run' });
    process.kill(r.pid, 'SIGTERM');
    return send(res, 200, { killed: r.pid });
  }
  return send(res, 404, { error: `${req.method} ${req.url}` });
}

createServer((req, res) => {
  handle(req, res).catch((e) => {
    log('error', { method: req.method, url: req.url, error: String(e?.message ?? e) });
    if (!res.headersSent) send(res, 500, { error: String(e?.message ?? e) });
  });
}).listen(PORT, () => log('listening', { port: PORT, pid: process.pid, uid: process.getuid() }));

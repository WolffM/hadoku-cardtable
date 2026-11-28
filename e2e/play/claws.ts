/**
 * A scratch claw fleet for a play stack (`CARDTABLE_PLAY_HOSTS=claws`): host agents this run starts
 * itself, each on its own loopback address (127.0.0.2, 127.0.0.3 …) at the agent port, standing in
 * for claws, and fleet-manager's CLI replaced by `scripts/stress/hosting/fake-fleet.mjs` over a state
 * file this run edits. The agents are built from this checkout with a fresh key (`deploy.sh keygen`
 * and `build`), so no production agent would ever answer this coordinator, nor it them.
 *
 * Only for a box that is not production's (a claw under a lease drain): every agent and JVM is this
 * run's own, found by its home directory, and killed only by the pids read from there.
 *
 *   const claws = await startClaws({ count: 2 });
 *   const stack = await startPlayStack(forge, { env: claws.env });
 *   … claws.agents[0].kill('SIGKILL') …
 *   await claws.stop();
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const FAKE_FLEET = join(ROOT, 'scripts', 'stress', 'hosting', 'fake-fleet.mjs');

export interface ClawAgent {
  /** The node name the coordinator places on: the agent's own loopback address. */
  node: string;
  home: string;
  log: string;
  pid(): number | null;
  /** The JVMs this agent launched, by their working directory under its home. */
  jvmPids(): number[];
  start(): void;
  kill(signal: NodeJS.Signals): void;
  /** Fill its home's filesystem (only when started with `diskMb`): every byte left, in one file. */
  fillDisk(): void;
  freeDisk(): void;
}

export interface Claws {
  agents: ClawAgent[];
  /** The server variables that put a stack on these claws. */
  env: Record<string, string>;
  /** fleet-manager's view of one node, as the coordinator's next poll reads it. */
  setReachable(node: string, reachable: boolean): void;
  stop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every process whose working directory is under `dir`. */
function pidsUnder(dir: string): number[] {
  const out: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readlinkSync(`/proc/${entry}/cwd`).startsWith(dir)) out.push(Number(entry));
    } catch {
      // gone, or not ours to read
    }
  }
  return out;
}

export async function startClaws(opts: { count?: number; diskMb?: Record<number, number>; fenceMs?: number } = {}): Promise<Claws> {
  const count = opts.count ?? 2;
  const dir = mkdtempSync(join(process.env.CARDTABLE_E2E_CLAWS_DIR ?? tmpdir(), 'claws-'));
  const deploy = join(ROOT, 'scripts', 'agent', 'deploy.sh');
  execFileSync('bash', [deploy, 'keygen', join(dir, 'keys')], { stdio: 'ignore' });
  execFileSync('bash', [deploy, 'build', join(dir, 'build')], {
    env: { ...process.env, AGENT_KEY_FILE: join(dir, 'keys', 'signing.key'), NODE22: process.execPath, FLEET: '/dev/null' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const key = readFileSync(join(dir, 'keys', 'signing.key'), 'utf8').trim();
  const stateFile = join(dir, 'fleet.json');
  const nodes = Array.from({ length: count }, (_, i) => ({ node: `127.0.0.${i + 2}`, reachable: true, memoryMb: 6000 }));
  const writeState = (): void => writeFileSync(stateFile, JSON.stringify({ nodes }));
  writeState();
  const mounted: string[] = [];

  const agents: ClawAgent[] = nodes.map(({ node }, i) => {
    const home = join(dir, node);
    const log = join(dir, `${node}.log`);
    mkdirSync(home, { recursive: true });
    const diskMb = opts.diskMb?.[i];
    if (diskMb !== undefined) {
      execFileSync('sudo', ['-n', 'mount', '-t', 'tmpfs', '-o', `size=${diskMb}m,uid=${process.getuid?.() ?? 1000},gid=${process.getgid?.() ?? 1000}`, 'tmpfs', home]);
      mounted.push(home);
    }
    let proc: ChildProcess | null = null;
    return {
      node,
      home,
      log,
      pid: () => (proc !== null && proc.exitCode === null && proc.signalCode === null ? (proc.pid ?? null) : null),
      jvmPids: () => pidsUnder(home).filter((p) => p !== proc?.pid),
      start() {
        proc = spawn(process.execPath, [join(dir, 'build', 'run')], {
          cwd: home,
          stdio: ['ignore', openSync(log, 'a'), openSync(log, 'a')],
          env: {
            PATH: process.env.PATH ?? '',
            HOME: process.env.HOME ?? '',
            CARDTABLE_AGENT_PORT: '7621',
            CARDTABLE_AGENT_LISTEN: node,
            CARDTABLE_AGENT_HOME: home,
            CARDTABLE_AGENT_NO_CGROUPS: '1',
            CARDTABLE_AGENT_MEMORY_MB: '6000',
            ...(opts.fenceMs === undefined ? {} : { CARDTABLE_AGENT_FENCE_MS: String(opts.fenceMs) }),
          },
        });
        console.log(`[claws] agent ${node} pid ${String(proc.pid)} (log ${log})`);
      },
      kill(signal) {
        const pid = proc?.pid;
        if (pid !== undefined && alive(pid)) process.kill(pid, signal);
      },
      fillDisk() {
        const free = Number(execFileSync('df', ['--output=avail', '-B1', home], { encoding: 'utf8' }).split('\n')[1]?.trim() ?? '0');
        // All but a block in one go, then the rest by writing until the filesystem refuses (ENOSPC is the point).
        execFileSync('fallocate', ['-l', String(Math.max(0, free - (1 << 20))), join(home, 'fill')]);
        try {
          execFileSync('dd', ['if=/dev/zero', `of=${join(home, 'fill2')}`, 'bs=4k'], { stdio: 'ignore' });
        } catch {
          // dd ends on ENOSPC: the disk is full
        }
        const left = execFileSync('df', ['--output=avail', '-B1', home], { encoding: 'utf8' }).split('\n')[1]?.trim();
        console.log(`[claws] ${node}: filled ${free} bytes, ${left} left`);
      },
      freeDisk() {
        execFileSync('rm', ['-f', join(home, 'fill'), join(home, 'fill2')]);
      },
    };
  });
  for (const a of agents) a.start();
  // Listening before the stack's first poll connects.
  for (let i = 0; i < 100 && !agents.every((a) => existsSync(a.log) && readFileSync(a.log, 'utf8').includes('listen')); i++) await sleep(100);

  return {
    agents,
    env: {
      CARDTABLE_PLAY_HOSTS: 'claws',
      CARDTABLE_FLEET_CLI: FAKE_FLEET,
      FAKE_FLEET_STATE: stateFile,
      CARDTABLE_AGENT_SIGNING_KEY: key,
      CARDTABLE_BACKSTOP_FORCE_FILE: join(dir, 'backstop-force.json'),
    },
    setReachable(node, reachable) {
      const n = nodes.find((x) => x.node === node);
      if (n !== undefined) n.reachable = reachable;
      writeState();
    },
    async stop() {
      for (const a of agents) {
        a.kill('SIGCONT');
        a.kill('SIGKILL');
        for (const pid of a.jvmPids()) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      }
      await sleep(500);
      for (const home of mounted) execFileSync('sudo', ['-n', 'umount', '-l', home]);
    },
  };
}

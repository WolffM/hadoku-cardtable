/**
 * Faults on a claws-mode play stack (`claws.ts`), and what the coordinator's log says about them: the
 * shared half of `scripts/stress/hosting/failover.spec.ts` (one match) and the claws field of
 * `tourney-blb.spec.ts` (a pod's round). Each fault's pass line is in the spec that fires it.
 */
import { execFileSync } from 'node:child_process';

import type { Page } from '@playwright/test';

import type { Claws } from './claws.ts';
import type { PlayStack } from './harness.ts';

export type Row = Record<string, unknown>;
export const FAULTS = ['agent-kill', 'agent-stall', 'coord-stall', 'jvm-kill', 'disk-full', 'coord-restart', 'coord-kill'] as const;
export type Fault = (typeof FAULTS)[number];
/** Faults whose matches are restored from a turn snapshot; the rest are re-attached or go on. */
export const RESTORING: ReadonlySet<Fault> = new Set(['agent-kill', 'agent-stall', 'jvm-kill', 'coord-stall']);

export const say = (what: string, data: Row = {}): void => console.log(`[failover] ${JSON.stringify({ at: new Date().toISOString(), what, ...data })}`);
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function rows(stack: PlayStack): Row[] {
  return execFileSync('cat', [stack.serverLogFile], { encoding: 'utf8', maxBuffer: 1 << 30 })
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => {
      try {
        return JSON.parse(l) as Row;
      } catch {
        return {};
      }
    });
}

export async function until<T>(what: string, ms: number, probe: () => T | null | undefined | false | Promise<T | null | undefined | false>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const got = await probe();
    if (got !== null && got !== undefined && got !== false) return got;
    if (Date.now() > end) throw new Error(`timed out (${ms} ms): ${what}`);
    await sleep(250);
  }
}

/** The server's pid, by the port it listens on. */
export function serverPid(stack: PlayStack): number {
  const out = execFileSync('ss', ['-ltnpH', `sport = :${stack.serverPort}`], { encoding: 'utf8' });
  const pid = /pid=(\d+)/.exec(out)?.[1];
  if (pid === undefined) throw new Error(`nothing listens on ${stack.serverPort}: ${out}`);
  return Number(pid);
}

export const hostOf = (log: readonly Row[], matchId: string): string | null =>
  (log.filter((r) => r.evt === 'match-host' && r.matchId === matchId).at(-1)?.host as string | undefined) ?? null;
export const latestTurn = (log: readonly Row[], matchId: string): number =>
  Math.max(0, ...log.filter((r) => r.evt === 'turn-snapshot' && r.matchId === matchId).map((r) => Number(r.turn)));
export const turnShown = async (page: Page): Promise<string> => (await page.getByTestId('live-turn-n').textContent({ timeout: 5_000 }).catch(() => '')) ?? '';
export const promptMethod = async (page: Page): Promise<string | null> => page.getByTestId('live-prompt').getAttribute('data-method', { timeout: 500 }).catch(() => null);

/** Every match a failover or a fence could not place anywhere (the coordinator's `lost`), and every second fatal. */
export function lostMatches(log: readonly Row[]): Row[] {
  const out: Row[] = [];
  for (const r of log) {
    if ((r.evt === 'claw-failed-over' || r.evt === 'fenced-over') && Array.isArray(r.lost)) for (const l of r.lost as Row[]) out.push({ ...l, evt: r.evt, cause: r.cause });
    if (r.evt === 'match-fatal-again') out.push(r);
  }
  return out;
}

/** Mark the document, so a page load after the fault shows as the mark gone. */
export async function mark(page: Page): Promise<void> {
  await page.evaluate(() => ((window as unknown as { __failoverMark?: number }).__failoverMark = 1));
}
export async function marked(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __failoverMark?: number }).__failoverMark === 1).catch(() => false);
}

/** Fire `fault` at claw `host` (the coordinator's faults ignore it). Returns when the fault is in place. */
export async function fire(fault: Fault, stack: PlayStack, claws: Claws, host: string): Promise<{ at: number; detail: Row }> {
  const agent = claws.agents.find((a) => a.node === host);
  if (agent === undefined) throw new Error(`no agent ${host}`);
  const at = Date.now();
  switch (fault) {
    case 'agent-kill': {
      const jvms = agent.jvmPids();
      agent.kill('SIGKILL');
      // As systemd would start it again.
      setTimeout(() => agent.start(), 20_000);
      return { at, detail: { agentKilled: host, jvms } };
    }
    case 'agent-stall': {
      // The claw's link silent, its JVMs still running: the coordinator must move the match, and the
      // agent, once it runs again, must end the JVMs it holds for a coordinator that gave up on them.
      const jvms = agent.jvmPids();
      agent.kill('SIGSTOP');
      setTimeout(() => agent.kill('SIGCONT'), 15_000);
      return { at, detail: { agentStopped: host, jvms } };
    }
    case 'jvm-kill': {
      const jvms = agent.jvmPids();
      for (const pid of jvms) process.kill(pid, 'SIGKILL');
      return { at, detail: { jvmsKilled: jvms } };
    }
    case 'disk-full':
      agent.fillDisk();
      return { at, detail: { filled: host } };
    case 'coord-stall': {
      const pid = serverPid(stack);
      process.kill(pid, 'SIGSTOP');
      await sleep(13_000);
      process.kill(pid, 'SIGCONT');
      return { at, detail: { stalledMs: Date.now() - at, pid } };
    }
    case 'coord-restart':
      await stack.restart();
      return { at, detail: { restartedMs: Date.now() - at } };
    case 'coord-kill': {
      const pid = serverPid(stack);
      process.kill(pid, 'SIGKILL');
      await sleep(5_000);
      await stack.restart();
      return { at, detail: { killed: pid, restartedMs: Date.now() - at } };
    }
  }
}

/**
 * One fault fired into a tournament round on claws (`tourney-blb.spec.ts`'s claws field), checked match by
 * match: once `minMatches` of the round's matches are past `minTurn`, `fault` is fired at the claw
 * holding the most of them (the coordinator's faults hit every match), and for each match it touched:
 *
 *  - restored (agent-kill, jvm-kill, coord-stall): from its latest turn snapshot, never from its spec, on a
 *    claw that is not the one that dropped it (a fence's claw stays in service, so it may come back there);
 *    re-attached (coord-restart, coord-kill): nothing restored;
 *  - both seats' pages: the same document as before the fault (no page load), the board drawn, no
 *    reconnect notice left, and, after a restore, the restored turn shown;
 *  - the game moves on within 3 min of the fault.
 *
 * Every miss is returned as a finding line, for the tournament's own findings list; the tournament then
 * plays on, so every pairing must still get its result.
 */
import type { Page } from '@playwright/test';

import type { Claws } from './claws.ts';
import { RESTORING, fire, hostOf, lostMatches, latestTurn, mark, marked, promptMethod, rows, say, sleep, turnShown, until, type Fault, type Row } from './failover.ts';
import type { PlayStack } from './harness.ts';

const MATCH = /#\/match\/(m-[0-9a-f]{12})$/;

export interface FieldPage {
  name: string;
  page: Page;
}

export async function failoverRound(opts: {
  stack: PlayStack;
  claws: Claws;
  pages: () => readonly FieldPage[];
  fault: Fault;
  minMatches: number;
  minTurn: number;
  /** Give up waiting for the round to be live past this. */
  deadline: number;
}): Promise<string[]> {
  const { stack, claws, fault } = opts;
  const findings: string[] = [];
  const onMatch = (): Map<string, FieldPage[]> => {
    const by = new Map<string, FieldPage[]>();
    for (const p of opts.pages()) {
      const id = MATCH.exec(p.page.url())?.[1];
      if (id !== undefined) by.set(id, [...(by.get(id) ?? []), p]);
    }
    return by;
  };
  const live = await until(`${opts.minMatches} matches past turn ${opts.minTurn}`, Math.max(0, opts.deadline - Date.now()), () => {
    const log = rows(stack);
    const ready = [...onMatch()].filter(([id, seats]) => seats.length === 2 && latestTurn(log, id) >= opts.minTurn && hostOf(log, id) !== null);
    return ready.length >= opts.minMatches ? ready : null;
  }).catch((err: Error) => {
    findings.push(`failover ${fault}: the round never had ${opts.minMatches} live matches: ${err.message}`);
    return null;
  });
  if (live === null) return findings;

  const before = rows(stack);
  const hosts = new Map<string, string>(live.map(([id]) => [id, hostOf(before, id)!]));
  const counts = new Map<string, number>();
  for (const h of hosts.values()) counts.set(h, (counts.get(h) ?? 0) + 1);
  const target = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  const coordinator = fault === 'coord-stall' || fault === 'coord-restart' || fault === 'coord-kill';
  const touched = live.filter(([id]) => coordinator || hosts.get(id) === target);
  for (const [, seats] of touched) for (const s of seats) await mark(s.page);
  const asks: Row = {};
  for (const [id, seats] of touched) for (const s of seats) asks[`${id}:${s.name}`] = await promptMethod(s.page);
  // Read last, just before the fault: marking and reading a dozen pages takes seconds, and the games go on meanwhile.
  const atFire = rows(stack);
  const turns = new Map(touched.map(([id]) => [id, latestTurn(atFire, id)]));
  say('field-fire', { fault, target, placement: Object.fromEntries(hosts), touched: touched.map(([id]) => id), turns: Object.fromEntries(turns), asks });
  const from = atFire.length;
  // What a player sees across the gap: each touched seat's status line and prompt, sampled every second.
  const seen = new Map<string, string[]>();
  const at = Date.now();
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      for (const [id, seats] of touched) {
        for (const s of seats) {
          const status = await s.page.getByTestId('live-status').textContent({ timeout: 300 }).catch(() => null);
          const says = await s.page.getByTestId('live-says').textContent({ timeout: 300 }).catch(() => null);
          const line = `${status ?? '-'} | ${says ?? '-'}`;
          const key = `${id}:${s.name}`;
          const was = seen.get(key) ?? [];
          if (was.at(-1) !== line) seen.set(key, [...was, `+${Math.round((Date.now() - at) / 1000)}s ${line}`]);
        }
      }
      await sleep(1000);
    }
  })();
  const { detail } = await fire(fault, stack, claws, target);
  say('field-fired', { fault, ...detail });
  setTimeout(() => {
    sampling = false;
  }, 45_000);

  await Promise.all(
    touched.map(async ([id, seats]) => {
      const turn = turns.get(id)!;
      try {
        if (RESTORING.has(fault)) {
          const restored = await until(`${id} restored`, 90_000, () => rows(stack).slice(from).find((r) => r.evt === 'match-restored' && r.matchId === id));
          const now = await until(`${id} on a host again`, 60_000, () => {
            const h = rows(stack).slice(from).filter((r) => r.evt === 'match-host' && r.matchId === id).at(-1)?.host;
            return typeof h === 'string' ? h : null;
          });
          say('field-restored', { id, from: restored.from, turn: restored.turn, was: turn, host: now, ms: Date.parse(String(restored.t)) - at });
          if (restored.from !== 'snapshot') findings.push(`failover ${fault}: ${id} restarted from its spec (a new game), not its turn-${turn} snapshot`);
          else if (restored.turn !== turn) findings.push(`failover ${fault}: ${id} restored to turn ${String(restored.turn)}, its latest snapshot was turn ${turn}`);
          if (fault !== 'coord-stall' && now === target) findings.push(`failover ${fault}: ${id} went back to ${target}, the claw that dropped it`);
        } else if (fault === 'coord-restart' || fault === 'coord-kill') {
          await sleep(5_000);
          const restored = rows(stack).slice(from).filter((r) => r.evt === 'match-restored' && r.matchId === id);
          if (restored.length > 0) findings.push(`failover ${fault}: ${id} was restored (${String(restored[0]!.from)}) where a restart re-attaches`);
        }
        for (const s of seats) {
          const board = await s.page.locator('[aria-label="Game board"]').waitFor({ state: 'visible', timeout: 90_000 }).then(() => true, () => false);
          const notice = await until(`${s.name}: no reconnect notice`, 90_000, async () => ((await s.page.getByTestId('live-status').count()) === 0 ? true : null)).catch(() => false);
          const same = await marked(s.page);
          const shown = await turnShown(s.page);
          say('field-screen', { id, who: s.name, board, notice: !notice, same, shown, prompt: await promptMethod(s.page) });
          if (!same) findings.push(`failover ${fault}: ${s.name}'s page on ${id} was loaded again`);
          if (!board) findings.push(`failover ${fault}: ${s.name} has no board on ${id} 90 s after the fault`);
          if (!notice) findings.push(`failover ${fault}: ${s.name} still shows a reconnect notice on ${id} 90 s after the fault`);
          if (RESTORING.has(fault) && board && shown !== String(turn) && Number(shown) < turn) findings.push(`failover ${fault}: ${s.name} shows turn ${shown} on ${id}, restored to ${turn}`);
        }
        const moved = await until(`${id} moves on`, 180_000, () => {
          const after = rows(stack).slice(from).filter((r) => r.matchId === id && (r.evt === 'turn-snapshot' || r.evt === 'game-over'));
          return after.some((r) => r.evt === 'game-over' || Number(r.turn) > turn) ? true : null;
        }).catch(() => false);
        if (!moved) findings.push(`failover ${fault}: ${id} did not move on in 3 min after the fault (was turn ${turn}, asks ${JSON.stringify(seats.map((s) => asks[`${id}:${s.name}`]))})`);
      } catch (err) {
        findings.push(`failover ${fault}: ${id}: ${(err as Error).message}`);
      }
    }),
  );
  sampling = false;
  await sampler;
  say('field-seen', Object.fromEntries(seen));
  const lost = lostMatches(rows(stack).slice(from));
  for (const r of lost) findings.push(`failover ${fault}: lost ${JSON.stringify(r).slice(0, 300)}`);
  say('field-done', { fault, findings: findings.length });
  return findings;
}

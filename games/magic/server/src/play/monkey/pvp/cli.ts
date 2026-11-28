#!/usr/bin/env -S node --
/*
 * Two monkey seats a match, watched, on a set-cube pod's decks, with Restart turn pressed on the way
 * (`docs/MONKEY.md`, "Two seats"). Each pod is drafted by eight bots and its decks play four matches.
 *
 *   apps/server/node_modules/.bin/tsx games/magic/server/src/play/monkey/pvp/cli.ts \
 *     --set BLB --pods 2 --seed 1 --restart-every 3 --concurrency 2 --out /tmp/pvp-report.json
 *
 * Exit 0: no finding (`findings.ts`). Exit 1: a finding. Exit 2: could not run.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PREFIX, SESSION_COOKIE } from '../../../../../../../e2e/identities.ts';
import { forgeAvailability, startPlayStack } from '../../../../../../../e2e/play/harness.ts';

import { watchExit } from '../exit-watch.ts';
import { RUN_STACK_ENV, runPool } from '../pool.ts';
import { makeRng, seedArg, seedFrom } from '../rng.ts';
import { findingsOf } from './findings.ts';
import { podBoard, podDecks } from './pod.ts';
import { lossyTally } from './restarts.ts';
import { runPvp, type PvpResult } from './run-pvp.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Three accounts a running match: two seats and the watcher, none shared with another match running beside it. */
const accountsOf = (slot: number): [string, string, string] => [0, 1, 2].map((k) => `${SESSION_COOKIE}=drafter${3 + slot * 3 + k}`) as [string, string, string];
const MAX_CONCURRENCY = 4;

async function main(): Promise<void> {
  const set = arg('set') ?? 'BLB';
  const pods = Number(arg('pods') ?? '1');
  const seed = seedFrom(seedArg(arg('seed')) ?? Date.now());
  const concurrency = Math.min(MAX_CONCURRENCY, Number(arg('concurrency') ?? '2'));
  const restartEvery = Number(arg('restart-every') ?? '3');
  const out = arg('out') ?? resolve(process.cwd(), 'pvp-report.json');
  const budgetMs = Number(arg('budget-ms') ?? String(60 * 60_000));
  const available = forgeAvailability();
  if (!available.ok) {
    console.error(`[pvp] no Forge: ${available.reason}`);
    process.exitCode = 2;
    return;
  }
  const games: { label: string; board: string; decks: { seat0: string; seat1: string }; seed: number }[] = [];
  for (let p = 0; p < pods; p += 1) {
    const podSeed = `${seed}:pod${p}`;
    const decks = await podDecks(available.res, set, podSeed);
    for (let t = 0; t < decks.length; t += 2) {
      const gameSeed = seedFrom(`${podSeed}:table${t / 2}`);
      const label = `pod ${p} table ${t / 2}`;
      games.push({ label, board: podBoard([decks[t]!, decks[t + 1]!], makeRng(gameSeed)), decks: { seat0: `${label} bot ${t}`, seat1: `${label} bot ${t + 1}` }, seed: gameSeed });
    }
  }
  console.log(`[pvp] ${set}: seed ${seed}, ${pods} pod(s), ${games.length} match(es), restart one turn in ${restartEvery}, ${concurrency} at a time`);

  const stack = await startPlayStack({ jar: available.jar, res: available.res }, { env: { ...RUN_STACK_ENV } });
  console.log(`[pvp] play stack up at ${stack.origin} (work dir ${stack.workDir})`);
  const stopAt = Date.now() + budgetMs;
  const results: PvpResult[] = [];
  const save = (): void => {
    const lossy = results.flatMap((r) => r.report.lossy);
    writeFileSync(out, JSON.stringify({ set, seed, pods, restartEvery, matches: results, tally: lossyTally(lossy) }, null, 1));
  };
  const free = Array.from({ length: concurrency }, (_, i) => i);
  try {
    const tasks = games.map((g) => async (): Promise<PvpResult> => {
      const slot = free.shift()!;
      try {
        const r = await runPvp({
          origin: stack.origin,
          prefix: PREFIX,
          cookies: accountsOf(slot),
          seed: g.seed,
          rng: makeRng(g.seed),
          scenario: g.board,
          decks: g.decks,
          stuckMs: Number(arg('stuck-ms') ?? '20000'),
          turnCap: Number(arg('turn-cap') ?? '40'),
          turnStallMs: Number(arg('turn-stall-ms') ?? String(5 * 60_000)),
          matchTimeoutMs: Number(arg('match-timeout-ms') ?? String(30 * 60_000)),
          stopAt,
          restartEvery,
          serverLogFile: stack.serverLogFile,
          workDir: stack.workDir,
        });
        results.push(r);
        save();
        const found = findingsOf(r);
        const restored = r.report.restores.filter((x) => x.same).length;
        console.log(`[pvp] ${g.label} ${r.matchId}: ${r.outcome} at turn ${r.turns ?? '?'} in ${Math.round(r.ms / 1000)}s; restarts asked ${r.restarts.asked.length}, restored right ${restored}, unavailable ${r.restarts.unavailable.length}; lossy turns ${r.report.lossy.length}; ${found.length} finding(s)`);
        for (const f of found) console.log(`[pvp]   FINDING ${f}`);
        for (const f of r.flags) for (const c of f.context.slice(-12)) console.log(`[pvp]     ${c}`);
        return r;
      } finally {
        free.push(slot);
      }
    });
    await runPool(tasks, concurrency, () => null, () => Date.now() >= stopAt);
    const all = results.flatMap(findingsOf);
    const tally = lossyTally(results.flatMap((r) => r.report.lossy));
    const asked = results.reduce((n, r) => n + r.restarts.asked.length, 0);
    const right = results.reduce((n, r) => n + r.report.restores.filter((x) => x.same).length, 0);
    const unavailable = results.reduce((n, r) => n + r.restarts.unavailable.length, 0);
    const lossyMatches = results.filter((r) => r.report.lossy.length > 0).length;
    console.log(`[pvp] lossy kinds (first turn each appeared): ${JSON.stringify(tally.kinds)}`);
    console.log(`[pvp] cards arrived with them: ${JSON.stringify(tally.cards)}`);
    console.log(`[pvp] ${results.length} match(es): ${all.length} finding(s); restarts asked ${asked}, restored right ${right}; a press found it unavailable ${unavailable} time(s); ${lossyMatches} match(es) with a lossy turn. Report: ${out}`);
    process.exitCode = all.length > 0 ? 1 : 0;
  } finally {
    save();
    await stack.stop();
    watchExit(30_000);
  }
}

main().catch((err) => {
  console.error('[pvp] fatal:', err);
  process.exitCode = 2;
});

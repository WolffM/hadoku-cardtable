/**
 * Splits the `*.jvm.test.ts` suites across `forge-jvm`'s matrix shards
 * (`.github/workflows/forge.yml`), balanced by how long each suite takes.
 *
 *   node scripts/ci/jvm-shards.ts count <files...>        the matrix, e.g. `[1, 2, 3]`
 *   node scripts/ci/jvm-shards.ts pick <i> <n> <files...> shard i of n's files, one per line
 *
 * WHY SHARDS. The suites run one file at a time (`--fileParallelism=false`:
 * every test starts its own Forge JVM), so a run's wall time is the sum of its
 * files and scales with ONE core's speed — a box's core count buys nothing. The
 * claws differ most on exactly that: claw-9's i7-5930K is locked at 3.0 GHz
 * with turbo off (hadoku-fleet-manager docs/planning/wave3l-2026-09-21.md),
 * claw-8 is an i7-9700F. The same full set took 1808 s on claw-8 alone (run
 * 39006155634) and timed out at the job's 50 min on claw-9 beside one
 * forge-e2e shard (run 39010330727): every suite 1.3–2.4× slower, 1.78× in
 * sum. Alone, claw-9 had already taken 1945–2575 s for the full set
 * (job-history, 2026-10-16/17). One serial job is one node's single-core
 * speed times everything, so a slow node or a busy one pushed it past any
 * fixed ceiling; split three ways, each shard is a third of that.
 *
 * WHY BY MEASURED SECONDS, NOT `vitest --shard`. vitest shards by file count;
 * `library-match` alone is 386 s of 1774, `prompts` 201, `scenario-start` 129,
 * and most files are 5–15 s, so a count split leaves one shard holding most
 * of the time. `jvm-seconds.json` is each file's duration in claw-8 seconds,
 * refreshed 2026-10-29 from full run 40791785977 (one shard on claw-8, two on hokon): a shard run
 * on claw-9 or hokon is divided by its median slowdown against the previous
 * table (claw-8 1.19×, hokon 2.4–2.5×), so all three machines read in one unit. A file missing
 * from it weighs the table's median, a stale entry makes the split uneven,
 * and every file still lands in exactly one shard either way. Refresh it from
 * a full run's `✓ <file> (N tests) <ms>ms` lines when the split drifts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A shard's budget in claw-8 seconds. claw-9 alone runs these suites ~1.8×
 * slower and a co-located forge-e2e shard adds to that, so 600 s here is
 * about 18–25 min there: inside the job's timeout with room, which one
 * serial job holding all 1774 s never was. 620 since 2026-10-22: the measured
 * suites had grown to 1796 s, so no further suite of more than ~4 s fit three
 * shards of 600; 620 × 2.4 (the worst slowdown measured) is ~25 min, plus a
 * cold bundle build, still inside forge-jvm's 35-minute timeout. 740 since
 * 2026-10-27: 113 suites measure 2153 s, three shards of ~720 s; 740 × 2.4 is
 * ~30 min, plus the build, so forge-jvm's timeout went to 45 minutes with it. 800 since
 * 2026-10-29: 124 suites measure 2377 s, three shards of ~790 s; claw-9 ran shard 1 past 45
 * minutes (run 40829932240, `library-match` alone 18 min there), so 800 × 2.8 is ~37 min plus
 * the build, and forge-jvm's timeout went to 60 minutes with it.
 */
export const SHARD_SECONDS = 800;

/** Three jdk21 claws: a fourth shard would only queue behind the other three. */
export const MAX_SHARDS = 3;

export type Seconds = Readonly<Record<string, number>>;

export function loadSeconds(path = join(import.meta.dirname, 'jvm-seconds.json')): Seconds {
  return JSON.parse(readFileSync(path, 'utf8')) as Seconds;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) throw new Error('jvm-seconds.json is empty');
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function weigh(files: string[], seconds: Seconds): Map<string, number> {
  const fallback = median(Object.values(seconds));
  return new Map([...new Set(files)].map((f) => [f, seconds[f] ?? fallback]));
}

/** How many shards these files need: one per {@link SHARD_SECONDS}, never more than {@link MAX_SHARDS} or than there are files. */
export function shardCount(files: string[], seconds: Seconds): number {
  const w = weigh(files, seconds);
  if (w.size === 0) throw new Error('no jvm suites to shard');
  const total = [...w.values()].reduce((a, b) => a + b, 0);
  return Math.max(1, Math.min(MAX_SHARDS, w.size, Math.ceil(total / SHARD_SECONDS)));
}

/**
 * Longest file first, each onto the lightest shard so far (ties: path, then the
 * lower shard). Deterministic for a given file set, so every shard job computes
 * the same split independently. Each shard's files come back in path order.
 */
export function assign(files: string[], seconds: Seconds, n: number): string[][] {
  const w = weigh(files, seconds);
  if (!Number.isInteger(n) || n < 1 || n > w.size) throw new Error(`cannot split ${w.size} suites into ${n} shards`);
  const shards = Array.from({ length: n }, () => ({ files: [] as string[], total: 0 }));
  const order = [...w].sort(([a, wa], [b, wb]) => wb - wa || a.localeCompare(b));
  for (const [file, sec] of order) {
    const lightest = shards.reduce((best, s) => (s.total < best.total ? s : best));
    lightest.files.push(file);
    lightest.total += sec;
  }
  return shards.map((s) => s.files.sort());
}

const USAGE = 'usage: jvm-shards.ts count <files...> | jvm-shards.ts pick <shard> <of> <files...>';

function main([cmd, ...rest]: string[]): void {
  const seconds = loadSeconds();
  if (cmd === 'count') {
    const n = shardCount(rest, seconds);
    console.log(JSON.stringify(Array.from({ length: n }, (_, i) => i + 1)).replaceAll(',', ', '));
    return;
  }
  if (cmd === 'pick') {
    const [shard, of, ...files] = rest;
    const i = Number(shard);
    const split = assign(files, seconds, Number(of));
    if (!Number.isInteger(i) || i < 1 || i > split.length) throw new Error(`shard ${shard} of ${of}`);
    console.log(split[i - 1].join('\n'));
    return;
  }
  throw new Error(USAGE);
}

if (import.meta.filename === process.argv[1]) main(process.argv.slice(2));

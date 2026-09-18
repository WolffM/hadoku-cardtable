/*
 * Validate EVERY decoded event of a capture run against the schemas — not just
 * the handful committed as fixtures.
 *
 *   node packages/forge-wire/src/events/capture/validate-dump.ts <OUT_DIR>/events.ndjson
 *
 * `events.ndjson` is written by `EventCapture.java` and is far too large to
 * commit (tens of thousands of lines for 12 games), so this is the check that
 * the schemas hold for the whole population and not merely the samples. It
 * also prints, per event and top-level field, how many instances carried null —
 * the evidence behind every `.nullable()` in `modelled.ts`.
 *
 * Exit 0 only if every line parsed, at least one line was read, and no line hit
 * a refused arm.
 */

import { readFileSync } from 'node:fs';

import { GameEventSchema, MODELLED_EVENTS } from '../index.ts';

const path = process.argv[2];
if (path == null) {
  console.error('usage: node validate-dump.ts <events.ndjson>');
  process.exit(2);
}

interface Tally {
  ok: number;
  failed: number;
  firstFailures: string[];
  nulls: Map<string, number>;
}

const tallies = new Map<string, Tally>();
let lines = 0;

for (const line of readFileSync(path, 'utf8').split('\n')) {
  if (line.length === 0) continue;
  lines++;
  const value = JSON.parse(line) as Record<string, unknown>;
  const name = String(value.event);
  let t = tallies.get(name);
  if (t == null) {
    t = { ok: 0, failed: 0, firstFailures: [], nulls: new Map() };
    tallies.set(name, t);
  }
  for (const [key, v] of Object.entries(value)) {
    if (v === null) t.nulls.set(key, (t.nulls.get(key) ?? 0) + 1);
  }
  const result = GameEventSchema.safeParse(value);
  if (result.success) {
    t.ok++;
  } else {
    t.failed++;
    if (t.firstFailures.length < 3) {
      t.firstFailures.push(
        result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
      );
    }
  }
}

let failed = 0;
const modelled = new Set(Object.keys(MODELLED_EVENTS));
for (const [name, t] of [...tallies].sort(([a], [b]) => a.localeCompare(b))) {
  const nulls = [...t.nulls].map(([k, n]) => `${k}=null x${n}`).join(' ');
  const arm = modelled.has(name) ? 'modelled' : 'NOT MODELLED';
  console.log(`${name.padEnd(34)} ${String(t.ok).padStart(7)} ok ${String(t.failed).padStart(5)} failed  ${arm}  ${nulls}`);
  for (const f of t.firstFailures) console.log(`    ${f}`);
  failed += t.failed;
}
console.log(`\n${lines} events, ${tallies.size} classes, ${failed} failed validation`);
process.exit(lines > 0 && failed === 0 ? 0 : 1);

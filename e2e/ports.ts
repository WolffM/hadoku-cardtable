/**
 * The four ports an e2e process's stacks bind: the draft server and its edge, the play server and
 * its edge. Each is the `CARDTABLE_E2E_*_PORT` this process was handed, or else a free one picked
 * here by `scripts/ci/pick-e2e-ports.mjs` (below the kernel's ephemeral range; it says why) and
 * written back into `process.env`, so every process started after this one — Playwright's workers,
 * the `webServer` harness, a stack's server — inherits the same four instead of picking its own.
 *
 * No fixed defaults: two stacks on one host (two jobs on a claw, two lanes, a monkey beside an e2e
 * run) on the same hardcoded port is a bind failure before a test runs (run 40471255011).
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const PICKER = resolve(import.meta.dirname, '..', 'scripts', 'ci', 'pick-e2e-ports.mjs');

const NAMES = ['CARDTABLE_E2E_SERVER_PORT', 'CARDTABLE_E2E_EDGE_PORT', 'CARDTABLE_E2E_PLAY_SERVER_PORT', 'CARDTABLE_E2E_PLAY_EDGE_PORT'] as const;

const unset = NAMES.filter((name) => !process.env[name]);
if (unset.length > 0) {
  const picked = execFileSync(process.execPath, [PICKER, ...unset], { encoding: 'utf8' });
  for (const line of picked.trim().split('\n')) {
    const [name, port] = line.split('=');
    process.env[name!] = port;
  }
}

function port(name: (typeof NAMES)[number]): number {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) throw new Error(`${name} is not a port: ${JSON.stringify(process.env[name])}`);
  return value;
}

export const SERVER_PORT = port('CARDTABLE_E2E_SERVER_PORT');
export const EDGE_PORT = port('CARDTABLE_E2E_EDGE_PORT');
export const PLAY_SERVER_PORT = port('CARDTABLE_E2E_PLAY_SERVER_PORT');
export const PLAY_EDGE_PORT = port('CARDTABLE_E2E_PLAY_EDGE_PORT');

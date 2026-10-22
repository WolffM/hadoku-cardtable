import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, 'claim.sh');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Claims `held` as one owner in a fresh file, then `asked` as another: true when the second is refused. */
function collides(held: string, asked: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'claim-test-'));
  dirs.push(dir);
  const env = { ...process.env, CARDTABLE_CLAIMS: join(dir, 'claims.tsv') };
  const run = (area: string, owner: string) => spawnSync('bash', [SCRIPT, 'claim', area, owner], { env, encoding: 'utf8' });
  expect(run(held, 'first').status).toBe(0);
  const second = run(asked, 'second');
  expect([0, 1]).toContain(second.status);
  return second.status === 1;
}

describe('claim.sh overlaps', () => {
  it.each([
    ['apps/ui/src/play/Board.tsx', 'apps/ui/src/play/Board.tsx#command'],
    ['apps/ui/src/play/Board.tsx#command', 'apps/ui/src/play/Board.tsx'],
    ['apps/ui/src/play/', 'apps/ui/src/play/Board.tsx#command'],
    ['apps/ui/src/play/Board.tsx#command', 'apps/ui/src/play'],
    ['apps/ui/src/play/*.tsx', 'apps/ui/src/play/Board.tsx#command'],
    ['apps/ui/src/play/Board.tsx#command', 'apps/ui/src/**/Board.tsx'],
    ['apps/ui/src/play/Board.tsx#command', 'apps/ui/src/play/Board.tsx#command'],
    ['apps/ui/src/play/Board.tsx', 'apps/ui/src/play/Board.tsx'],
    ['e2e/*.spec.ts', 'e2e/room-mode.spec.ts'],
  ])('%s blocks %s', (held, asked) => {
    expect(collides(held, asked)).toBe(true);
  });

  it.each([
    ['apps/ui/src/play/Board.tsx#command', 'apps/ui/src/play/Board.tsx#departures'],
    ['apps/ui/src/play/Board.tsx#command', 'apps/ui/src/play/board.css#command'],
    ['apps/ui/src/play/Board.tsx', 'apps/ui/src/play/Board.test.tsx'],
    ['apps/ui/src/play/Board.tsx#command', 'apps/ui/src/play/Board.tsxx'],
    ['cost-payment', 'apps/ui/src/play/Board.tsx#cost-payment'],
  ])('%s leaves %s free', (held, asked) => {
    expect(collides(held, asked)).toBe(false);
  });
});

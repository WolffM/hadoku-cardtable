/*
 * `parseArgs` and `runSyncCards`'s no-network paths (`--help`, a bad flag).
 * The real sync is `sync()` in `../scryfall/bulk.ts`, already covered there —
 * this file only pins the CLI surface `runSyncCards` now exposes for the
 * server's refresh job (wave 74 §G), and that importing this module never
 * runs the sync as a side effect (the `import.meta.main` guard this wave
 * added at the file's tail).
 */

import { describe, expect, it } from 'vitest';
import { parseArgs, runSyncCards } from './sync-cards.ts';

describe('parseArgs', () => {
  it('defaults to default_cards, no force, no limit', () => {
    const args = parseArgs([]);
    expect(args.bulkType).toBe('default_cards');
    expect(args.force).toBe(false);
    expect(args.limit).toBeNull();
  });

  it('reads --type=, --out=, --force and --limit=', () => {
    const args = parseArgs(['--type=oracle_cards', '--out=/tmp/x', '--force', '--limit=10']);
    expect(args.bulkType).toBe('oracle_cards');
    expect(args.outDir).toBe('/tmp/x');
    expect(args.force).toBe(true);
    expect(args.limit).toBe(10);
  });

  it('ignores a bare "--" (the pnpm run forwarding artifact)', () => {
    expect(() => parseArgs(['--', '--force'])).not.toThrow();
  });

  it('throws on an unknown flag', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown argument/);
  });

  it('throws on a non-positive --limit', () => {
    expect(() => parseArgs(['--limit=0'])).toThrow(/positive integer/);
  });
});

describe('runSyncCards', () => {
  it('--help prints usage and returns 0 without touching the network', async () => {
    const exitCode = await runSyncCards(['--help']);
    expect(exitCode).toBe(0);
  });

  it('a bad flag returns exit code 2 without touching the network', async () => {
    const exitCode = await runSyncCards(['--nope']);
    expect(exitCode).toBe(2);
  });
});

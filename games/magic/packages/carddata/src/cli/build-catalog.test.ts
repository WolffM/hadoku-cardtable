/*
 * `cli/build-catalog.ts`'s own CLI surface — spawned as a real child process
 * (never imported), so this is the one place that proves the thin wrapper
 * still argv-parses, calls `runBuildCatalog` and turns its throw into
 * `console.error` + `process.exit(1)` the way it always did. The library
 * logic (`buildCatalog`, `runBuildCatalog`, `printings`) moved to
 * `../catalog-build.test.ts` — see that file's and `catalog-build.ts`'s
 * headers for why (the 2026-10-22 bundling incident).
 */

import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL('./build-catalog.ts', import.meta.url));
const HERE = dirname(CLI_PATH);

const FIRE_ICE = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  name: 'Fire // Ice',
  lang: 'en',
  set: 'apc',
  collector_number: '119',
  released_at: '2001-06-04',
  layout: 'split',
  colors: null,
  mana_cost: null,
  cmc: 2,
  card_faces: [
    { name: 'Fire', mana_cost: '{1}{R}', colors: ['R'], type_line: 'Instant', oracle_text: 'Fire deals 2 damage divided as you choose among one or two targets.' },
    { name: 'Ice', mana_cost: '{1}{U}', colors: ['U'], type_line: 'Instant', oracle_text: 'Tap target permanent. Draw a card.' },
  ],
};

describe('cli/build-catalog.ts, spawned', () => {
  it('exits 1 with "No card cache" when --data has no cards.jsonl, never a stack trace', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'build-catalog-cli-empty-'));
    await expect(run(process.execPath, [CLI_PATH, `--data=${emptyDir}`, `--out=${join(emptyDir, 'cards.json')}`], { cwd: HERE })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('No card cache at'),
    });
  });

  it('builds a catalog and prints the two documented lines, given a real cards.jsonl', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'build-catalog-cli-data-'));
    const outDir = await mkdtemp(join(tmpdir(), 'build-catalog-cli-out-'));
    await writeFile(join(dataDir, 'cards.jsonl'), `${JSON.stringify(FIRE_ICE)}\n`, 'utf8');
    const outPath = join(outDir, 'cards.json');

    const { stdout } = await run(process.execPath, [CLI_PATH, `--data=${dataDir}`, `--out=${outPath}`], { cwd: HERE });

    expect(stdout).toMatch(/^catalog: 1 cards, \d+ aliases, from \d+ printings -> .*cards\.json$/m);
    expect(stdout).toMatch(/^D13 control: 1 cards, no image field and no image URL\.$/m);
  });
});

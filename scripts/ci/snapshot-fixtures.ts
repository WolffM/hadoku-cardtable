/**
 * Write the files a replayed fixture reads, as they stood at its commit.
 *
 * `select-forge-tests.test.ts` replays real landed diffs. A diff's hunks only
 * mean what they meant against the file they were cut from: read against
 * today's `card.css`, a historical patch lands on rules written since and picks
 * other specs (main's check went red twice this way, a6f7ffee and 9e58f72c).
 * So each fixture carries the changed files `select()` reads, at
 * `fixtures/at/<sha>/<path>.at` — byte-identical to the blob git already holds,
 * so the copies add nothing to the repository's history. The `.at` suffix keeps
 * them out of every tool that globs by extension.
 *
 *   node scripts/ci/snapshot-fixtures.ts [fixture.json …]   (default: all)
 *
 * Needs the commits in the local history (run it in a full clone, not on CI).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Change, Repo, select } from './select-forge-tests.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = join(ROOT, 'scripts/ci/fixtures');

/** The commit a fixture's files stand at: a miss's own commit, or the end of a landed range. */
export function fixtureSha(fixture: { commit?: string; range?: string }): string {
  const sha = fixture.commit ?? fixture.range?.split('..')[1];
  if (!sha) throw new Error('a fixture names neither a commit nor a range');
  return sha;
}

/** Where a fixture's copy of `path` lives. */
export function snapshotPath(sha: string, path: string): string {
  return join(FIXTURES, 'at', sha, `${path}.at`);
}

/** Today's tree, noting which of the diff's own files `select()` reads. */
class Reading extends Repo {
  readonly wanted = new Set<string>();
  private readonly changed: Set<string>;
  constructor(changed: Set<string>) {
    super(ROOT);
    this.changed = changed;
  }
  override read(path: string): string | null {
    if (this.changed.has(path)) this.wanted.add(path);
    return super.read(path);
  }
}

function snapshot(name: string): void {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as { commit?: string; range?: string; files: Change[] };
  const sha = fixtureSha(fixture);
  const repo = new Reading(new Set(fixture.files.map((c) => c.filename)));
  select(repo, fixture.files, { deferFull: true });
  for (const path of repo.wanted) {
    const at = execFileSync('git', ['-C', ROOT, 'show', `${sha}:${path}`], { maxBuffer: 1 << 28 });
    mkdirSync(dirname(snapshotPath(sha, path)), { recursive: true });
    writeFileSync(snapshotPath(sha, path), at);
  }
  console.log(`${name}: ${repo.wanted.size} file(s) at ${sha.slice(0, 8)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = process.argv.slice(2);
  for (const name of names.length ? names : readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))) snapshot(name);
}

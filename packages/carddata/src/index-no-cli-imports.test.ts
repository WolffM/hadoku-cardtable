/*
 * The guard for the 2026-10-22 bundling incident (`catalog-build.ts`'s
 * header has the full account): `index.ts` re-exported straight from a
 * `cli/` file, which ends in `if (import.meta.main) …`. That guard reads
 * `true` for every module a bundler inlines, not only the real entry point,
 * so the moment that `cli/` file became reachable from `index.ts` it became
 * reachable from the SERVER's bundle — and its whole CLI body ran on every
 * server boot.
 *
 * This is not a convention to remember; it is a graph property this test
 * checks by reading the files, not by trusting a comment. `index.ts` must
 * never import a `./cli/*` module, directly or through anything it imports.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));
const INDEX_PATH = resolve(SRC_DIR, 'index.ts');

/** Every relative `from '...'` specifier (import or re-export) in a file's source text. */
function relativeImportsOf(filePath: string): string[] {
  const text = readFileSync(filePath, 'utf8');
  const specifiers: string[] = [];
  const re = /from\s+['"](\.[^'"]+)['"]/g;
  for (const match of text.matchAll(re)) {
    const spec = match[1];
    if (spec !== undefined) specifiers.push(spec);
  }
  return specifiers;
}

/** Resolve a relative specifier against the importing file's own directory, defaulting to `.ts`. */
function resolveSpecifier(fromFile: string, spec: string): string {
  const base = resolve(dirname(fromFile), spec);
  return base.endsWith('.ts') || base.endsWith('.json') ? base : `${base}.ts`;
}

function underCliDir(filePath: string): boolean {
  return filePath.includes(`${sep}cli${sep}`);
}

describe('packages/carddata/src/index.ts import graph', () => {
  it('never imports a ./cli/ module directly', () => {
    const direct = relativeImportsOf(INDEX_PATH).filter((spec) => spec.includes('/cli/'));
    expect(direct).toEqual([]);
  });

  it('never imports a cli/ module transitively either — the whole reachable graph is checked, not just index.ts\'s own line', () => {
    const visited = new Set<string>();
    const queue: string[] = [INDEX_PATH];
    const cliFiles: string[] = [];

    while (queue.length > 0) {
      const file = queue.pop();
      if (file === undefined || visited.has(file)) continue;
      visited.add(file);
      if (underCliDir(file)) cliFiles.push(file);

      let specifiers: string[];
      try {
        specifiers = relativeImportsOf(file);
      } catch {
        // A specifier that does not resolve to a readable file on disk under
        // this guess (e.g. a directory import, or an extension this test did
        // not anticipate) is not this test's job to chase further.
        continue;
      }
      for (const spec of specifiers) {
        const next = resolveSpecifier(file, spec);
        if (!visited.has(next)) queue.push(next);
      }
    }

    // `index.ts` itself is not under cli/, so any hit here came from
    // something it imports, directly or transitively.
    expect(cliFiles).toEqual([]);
    // A sanity floor: the graph should have walked more than just index.ts
    // itself, or this test would pass vacuously on a broken resolver.
    expect(visited.size).toBeGreaterThan(5);
  });
});

/**
 * Nothing the server runs may reach a stylesheet.
 *
 * The server imports a few of the UI's own modules (the monkey drives a seat
 * with `apps/ui/src/play/live/match.ts`), and some of them run under plain
 * Node through tsx, which has no loader for `.css`: one `import './dice.css'`
 * anywhere down that graph is an ERR_UNKNOWN_FILE_EXTENSION before the first
 * line runs (hadoku-cardtable#17, forge-monkey red on main for a day). Vitest
 * swallows CSS, so no other test notices.
 *
 * This walks every runtime import (`import type` is erased, so it is skipped)
 * reachable from the server's source and names each chain that ends in a
 * `.css`. A state module that needs a drawing's helper takes it from a module
 * that imports no stylesheet (`apps/ui/src/play/live/shown.ts`).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SERVER_SRC = dirname(fileURLToPath(import.meta.url));
const ROOT = normalize(join(SERVER_SRC, '../../..'));

// `import x from './a.ts'`, `import './a.css'`, `export { y } from './b.ts'` and
// `import('./c.ts')` — but not `import type …` or `export type …`.
const RUNTIME_IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === 'dist' ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function cssChains(entries: string[]): string[] {
  const parent = new Map<string, string | null>();
  const found: string[] = [];
  const walk = (file: string, from: string | null): void => {
    if (parent.has(file)) return;
    parent.set(file, from);
    if (!existsSync(file)) return;
    for (const m of readFileSync(file, 'utf8').matchAll(RUNTIME_IMPORT)) {
      const spec = m[1] ?? m[2];
      if (spec === undefined || !spec.startsWith('.')) continue;
      const target = normalize(join(dirname(file), spec));
      if (target.endsWith('.css')) {
        const chain = [file];
        for (let p = parent.get(file); p; p = parent.get(p) ?? null) chain.push(p);
        found.push([...chain.reverse().map((f) => relative(ROOT, f)), spec].join(' -> '));
      } else {
        walk(target, file);
      }
    }
  };
  for (const entry of entries) walk(entry, null);
  return found;
}

describe('the server never imports a stylesheet', () => {
  it('reaches no .css from any server source file', () => {
    expect(cssChains(sources(SERVER_SRC))).toEqual([]);
  });

  it('would name the chain if one did', () => {
    // The walker itself, on the UI module that draws the die: it imports dice.css.
    const dice = join(ROOT, 'apps/ui/src/play/live/dice.ts');
    expect(cssChains([dice])).toEqual(['apps/ui/src/play/live/dice.ts -> ./dice.css']);
  });
});

/*
 * A `:has()` whose argument counts children — `:has(> li:nth-child(3))` — is one Chromium cannot
 * invalidate narrowly: every node inserted or removed anywhere under the board restyled the whole
 * board (2,300 elements crowded, 3,700 huge; 34-46 ms each at a 4x CPU throttle). Three such rules on
 * the command zone were most of the board's input lag on a slow laptop (`docs/spikes/browser-fps.md`).
 * Dropping them took whole-board restyles per 6 s of clicking from 25 to 0; dropping the sibling-
 * combinator `:has()` rules (`li + li`, `[data-empty] ~ [data-empty]`) instead changed nothing.
 *
 * So a count reads the element's own `data-count` (or a class React sets), never `:nth-*` inside `:has()`.
 * Measured on `:nth-child`; the other `:nth-*` forms are refused with it, unmeasured.
 */
// @reads apps/ui/src/
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));

function sheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sheets(path);
    return e.name.endsWith('.css') ? [path] : [];
  });
}

/** Each `:has(...)` argument in a sheet, with its line, comments stripped and parentheses balanced. */
function hasArguments(text: string): { line: number; arg: string }[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const out: { line: number; arg: string }[] = [];
  for (const m of code.matchAll(/:has\(/g)) {
    let i = m.index + m[0].length;
    for (let depth = 1; depth > 0; i += 1) depth += code[i] === '(' ? 1 : code[i] === ')' ? -1 : 0;
    out.push({ line: code.slice(0, m.index).split('\n').length, arg: code.slice(m.index + m[0].length, i - 1) });
  }
  return out;
}

describe(':has() never counts children', () => {
  it('no stylesheet puts an :nth-* pseudo-class inside :has()', () => {
    const offenders = sheets(SRC).flatMap((file) =>
      hasArguments(readFileSync(file, 'utf8'))
        .filter(({ arg }) => /:nth-/.test(arg))
        .map(({ line, arg }) => `${relative(SRC, file)}:${line} :has(${arg})`),
    );
    expect(offenders).toEqual([]);
  });

  it('finds one when it is there', () => {
    expect(hasArguments('/* :has(> li:nth-child(9)) */\n.a:has(> li:nth-child(3)) {}').map((h) => h.arg)).toEqual(['> li:nth-child(3)']);
  });
});

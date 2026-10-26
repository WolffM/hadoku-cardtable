/*
 * No size container (`container-type: size` / `inline-size`) in the match's own stylesheets. Chromium
 * restyles a size container's descendants inside its layout, so every style change under it costs a
 * layout of it. On `.live`, that was the whole board for every frame of the other seat's mirrored
 * pointer: with the command zone's old `:has(nth-child)` rule restyling the board on each insert, layout
 * took 0.05 to 0.3 of a drag's main-thread work on that screen (`e2e/w69-perf.spec.ts`), and without it
 * still twice what it was. A length the board needs from an ancestor is measured and written as a custom
 * property (`LiveBoard.tsx`'s `--live-h` and `--live-w`) instead.
 */
// @reads apps/ui/src/play/
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

/** Each declaration making a size container in `text`, with its line; comments stripped. */
function sizeContainers(text: string): { line: number; decl: string }[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  return [...code.matchAll(/container(?:-type)?\s*:[^;}]*\b(?:size|inline-size)\b[^;}]*/g)].map((m) => ({
    line: code.slice(0, m.index).split('\n').length,
    decl: m[0].trim(),
  }));
}

describe('the match has no size container', () => {
  it('no stylesheet under play/ makes one', () => {
    const offenders = sheets(join(SRC, 'play')).flatMap((file) =>
      sizeContainers(readFileSync(file, 'utf8')).map(({ line, decl }) => `${relative(SRC, file)}:${line} ${decl}`),
    );
    expect(offenders).toEqual([]);
  });

  it('finds one when it is there, in either spelling', () => {
    const text = '/* container-type: size */\n.a { container-type: inline-size; }\n.b { container: board / size }\n.c { container-name: x; }';
    expect(sizeContainers(text).map((c) => c.line)).toEqual([2, 3]);
  });
});

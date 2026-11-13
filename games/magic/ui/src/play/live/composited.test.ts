/*
 * The motion that runs many at once on a busy board animates only what the compositor can run on its own:
 * opacity and the transforms. Anything else (a background, its position, a border colour) is restyled,
 * repainted and re-rastered on the main thread every frame for every element in flight. The perf bench
 * (e2e/perf) counted 1,527 trail embers and 131 P/T glints a run animating `background` and
 * `background-position`, and every stack card's slide transitioning `left` and `top` (477).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPOSITED = new Set(['opacity', 'transform', 'translate', 'scale', 'rotate', 'animation-timing-function']);

const sheetText = (sheet: string): string => readFileSync(resolve(import.meta.dirname ?? 'games/magic/ui/src/play/live', sheet), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every property each `@keyframes` in `sheet` animates, by name. */
function keyframes(sheet: string): Map<string, Set<string>> {
  const css = sheetText(sheet);
  const out = new Map<string, Set<string>>();
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)) {
    const props = new Set<string>();
    for (const d of m[2]!.matchAll(/([\w-]+)\s*:/g)) props.add(d[1]!);
    out.set(m[1]!, props);
  }
  return out;
}

describe('busy-board motion runs on the compositor', () => {
  for (const [sheet, prefix] of [
    ['projectile.css', 'effect-trail'],
    ['pt-impact.css', 'pt-glint'],
  ] as const) {
    it(`${sheet}: every ${prefix} keyframe animates only opacity and transforms`, () => {
      const found = [...keyframes(sheet)].filter(([name]) => name.startsWith(prefix));
      expect(found.length, `${sheet} has ${prefix} keyframes`).toBeGreaterThan(0);
      for (const [name, props] of found) expect([...props].filter((p) => !COMPOSITED.has(p)), name).toEqual([]);
    });
  }

  it('placed.css: a stack card moves by transitions on opacity and transforms only', () => {
    const transitioned = [...sheetText('placed.css').matchAll(/transition\s*:([^;]*);/g)].flatMap((m) =>
      m[1]!.split(/,(?![^(]*\))/).map((part) => part.trim().split(/\s+/)[0]!),
    );
    expect(transitioned.length).toBeGreaterThan(0);
    expect(transitioned.filter((p) => p !== 'none' && !COMPOSITED.has(p))).toEqual([]);
  });
});

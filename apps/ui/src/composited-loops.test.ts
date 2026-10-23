/*
 * An animation that never ends runs on every frame the page draws, for as long as its element stands. One
 * that animates a property the compositor cannot take — a filter, a shadow, a position, a size, a
 * background, a custom property — has the browser draw its element again on every one of those frames,
 * on the main thread. The stack's float breathed its shadow in `filter` that way: 22 triggers on the
 * stack ran the operator's own game at 7 fps for fifteen seconds (2026-10-23, match m-14703a9e2126).
 *
 * So an `infinite` animation names keyframes that move only what the compositor moves (`transform`,
 * `translate`, `rotate`, `scale`, `opacity`), or it is listed below with why it is not yet.
 */
// @reads apps/ui/src/
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));

/** What an endless animation may move: the compositor's own properties. */
const COMPOSITED = new Set(['transform', 'translate', 'rotate', 'scale', 'opacity', 'offset', 'animation-timing-function']);

/** Endless animations that still draw on the main thread, each with why — to be worked off, never added to. */
const NOT_YET: Record<string, string> = {
  'live-ok-pulse': 'one button’s ring, while a decision waits',
  'live-end-turn-nudge': 'one button’s glow, once End Turn has waited',
  'seat-picking': 'the draft lobby, never a match',
  'skeleton-sheen': 'a loading placeholder, gone once its content draws',
};

function sheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sheets(path);
    return e.name.endsWith('.css') ? [path] : [];
  });
}

/** Every `@keyframes` block's name and the properties its frames set, across the given sheets. */
function keyframes(texts: readonly string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const text of texts) {
    for (const m of text.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
      let i = m.index + m[0].length;
      for (let depth = 1; depth > 0; i += 1) depth += text[i] === '{' ? 1 : text[i] === '}' ? -1 : 0;
      const props = out.get(m[1]!) ?? new Set<string>();
      for (const p of text.slice(m.index + m[0].length, i).matchAll(/([\w-]+)\s*:/g)) props.add(p[1]!);
      out.set(m[1]!, props);
    }
  }
  return out;
}

describe('endless animations move only what the compositor moves', () => {
  const files = sheets(SRC);
  const texts = files.map((f) => readFileSync(f, 'utf8'));
  const frames = keyframes(texts);

  it('names every keyframe an endless animation runs, and each one is compositor-only or listed with why', () => {
    const offenders: string[] = [];
    texts.forEach((text, n) => {
      // `animation` itself, and a custom property holding an animation list (`--stack-hover`).
      for (const decl of text.matchAll(/(?:animation|--[\w-]+)\s*:([^;]*);/g)) {
        for (const part of decl[1]!.split(',')) {
          if (!/\binfinite\b/.test(part)) continue;
          for (const name of part.match(/[\w-]+/g) ?? []) {
            const props = frames.get(name);
            if (props === undefined || name in NOT_YET) continue;
            const drawn = [...props].filter((p) => !COMPOSITED.has(p));
            if (drawn.length > 0) offenders.push(`${relative(SRC, files[n]!)}: ${name} animates ${drawn.join(', ')}`);
          }
        }
      }
    });
    expect([...new Set(offenders)]).toEqual([]);
  });

  it('lists only keyframes that still exist and still need it', () => {
    for (const [name, why] of Object.entries(NOT_YET)) {
      const props = frames.get(name);
      expect(props, `${name}: ${why}`).toBeDefined();
      expect([...props!].some((p) => !COMPOSITED.has(p)), `${name} moves only composited properties now: take it off the list`).toBe(true);
    }
  });
});

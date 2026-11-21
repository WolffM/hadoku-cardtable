/*
 * An animation that never ends must run on the compositor. Chromium's compositor animates `transform`,
 * the individual `translate` / `rotate` / `scale`, and `opacity` without the page; any other property in
 * a keyframe — `box-shadow`, `filter`, `background-position`, `stroke-dashoffset`, a custom property —
 * makes the main thread restyle, re-layerize and repaint, and the raster workers re-raster, every frame
 * for as long as the loop runs. The OK button's `box-shadow` pulse (`live-ok-pulse`) cost both screens
 * 324 ms/s of main thread and 247 ms/s of raster with a spell waiting on the stack; paused alone, 15–77
 * and ~0 (`e2e/perf/ambient.spec.ts`, claw-9, run 44843242250; perf catalogue P28).
 *
 * So every looping animation (an `infinite` anywhere in a declaration's value, a custom property that
 * carries an `animation` shorthand included) names keyframes that animate those properties only. The
 * loops that predate this test are listed with what they animate; the list only shrinks: fixing one means
 * deleting its line, and a new loop on a paint property fails here.
 */
// @reads games/magic/ui/src/ apps/ui/src/ packages/ui-shell/src/ packages/game-ui/src/
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { uiPath, uiSheets } from './ui-sources.testing.ts';

/** What the compositor can run alone; the timing function inside a keyframe is not an animated property. */
const COMPOSITED = new Set(['transform', 'translate', 'rotate', 'scale', 'opacity', 'animation-timing-function']);

/** The loops that repaint today, each with the paint properties it animates: only ever removed from. */
const KNOWN: Record<string, string> = {
  'arrow-travel-core': 'stroke-dashoffset',
  'arrow-travel-rim': 'stroke-dashoffset',
  'live-end-turn-nudge': 'filter',
  'live-ok-pulse': 'box-shadow',
  'skeleton-sheen': 'background-position',
};

const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));

/** Each `@keyframes` block's name and the properties its frames set. */
export function keyframes(text: string): Map<string, Set<string>> {
  const code = strip(text);
  const out = new Map<string, Set<string>>();
  for (const m of code.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    let i = m.index + m[0].length;
    for (let depth = 1; depth > 0; i += 1) depth += code[i] === '{' ? 1 : code[i] === '}' ? -1 : 0;
    const body = code.slice(m.index + m[0].length, i - 1);
    const props = new Set([...body.matchAll(/([\w-]+)\s*:/g)].map((p) => p[1]!).filter((p) => p !== 'from' && p !== 'to'));
    out.set(m[1]!, props);
  }
  return out;
}

/** Every identifier in a declaration value's comma-separated part that says `infinite`: the names of looping animations, among others. */
export function loopingWords(text: string): Set<string> {
  const code = strip(text).replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const out = new Set<string>();
  for (const decl of code.matchAll(/:\s*([^;{}]*\binfinite\b[^;{}]*)/g))
    for (const part of decl[1]!.split(','))
      if (/\binfinite\b/.test(part)) for (const w of part.match(/[\w-]+/g) ?? []) out.add(w);
  return out;
}

/** Each looping animation and the properties it animates that the compositor cannot. */
function paintLoops(): Map<string, string> {
  const frames = new Map<string, { props: Set<string>; file: string }>();
  const looping = new Set<string>();
  for (const file of uiSheets()) {
    const text = readFileSync(file, 'utf8');
    for (const [name, props] of keyframes(text)) frames.set(name, { props, file: uiPath(file) });
    for (const w of loopingWords(text)) looping.add(w);
  }
  const out = new Map<string, string>();
  for (const name of looping) {
    const f = frames.get(name);
    if (f === undefined) continue;
    const paint = [...f.props].filter((p) => !COMPOSITED.has(p)).sort();
    if (paint.length > 0) out.set(name, paint.join(','));
  }
  return out;
}

describe('a looping animation runs on the compositor', () => {
  it('no new looping animation animates a paint property, and every listed one still exists', () => {
    expect(Object.fromEntries([...paintLoops()].sort())).toEqual(KNOWN);
  });

  it('finds a box-shadow loop, through a custom property too, and passes a transform one', () => {
    const css = `
      @keyframes glow { 50% { box-shadow: 0 0 4px red; } }
      @keyframes bob { from { translate: 0 0; animation-timing-function: ease; } to { translate: 0 -4px; opacity: .5 } }
      /* .x { animation: comment-only 1s infinite; } */
      .a { --hover: glow 1s ease-in-out infinite; }
      .b { animation: bob 2s infinite alternate, glow 1s 1; }`;
    expect([...keyframes(css)].map(([n, p]) => `${n}:${[...p].join('+')}`)).toEqual(['glow:box-shadow', 'bob:translate+animation-timing-function+opacity']);
    const loops = loopingWords(css);
    expect(loops.has('glow') && loops.has('bob') && !loops.has('comment-only')).toBe(true);
  });
});

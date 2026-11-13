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
 *
 * `:hover` inside `:has()` is the same trap: two rules lifting a hovered card's overlays
 * (`.board-card:has(> .board-card__face:hover) > …`) restyled the whole board 141 times in 8 s of a
 * board wipe with no pointer on it at all, 2.9 s of style; without them, 6 times and 65 ms
 * (`scripts/fps/measure.mjs trace --cases crowded/wipe --drop-rules face:hover`, cut 3, 2026-11-01).
 * A hovered element's later siblings are reached with `~` instead. Measured on `:hover`; the other
 * `:has()` rules that test a state (`:checked`, `:focus-visible`) changed nothing and stay.
 */
// @reads games/magic/ui/src/ apps/ui/src/ packages/ui-shell/src/ packages/game-ui/src/
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { uiPath, uiSheets } from './ui-sources.testing.ts';

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

describe(':has() never counts children and never asks for a hover', () => {
  it('no stylesheet puts an :nth-* pseudo-class inside :has()', () => {
    const offenders = uiSheets().flatMap((file) =>
      hasArguments(readFileSync(file, 'utf8'))
        .filter(({ arg }) => /:nth-/.test(arg))
        .map(({ line, arg }) => `${uiPath(file)}:${line} :has(${arg})`),
    );
    expect(offenders).toEqual([]);
  });

  it('no stylesheet puts :hover inside :has()', () => {
    const offenders = uiSheets().flatMap((file) =>
      hasArguments(readFileSync(file, 'utf8'))
        .filter(({ arg }) => /:hover\b/.test(arg))
        .map(({ line, arg }) => `${uiPath(file)}:${line} :has(${arg})`),
    );
    expect(offenders).toEqual([]);
  });

  it('finds one when it is there', () => {
    expect(hasArguments('/* :has(> li:nth-child(9)) */\n.a:has(> li:nth-child(3)) {}').map((h) => h.arg)).toEqual(['> li:nth-child(3)']);
  });
});

/*
 * A line drawn on by its dash (`pathLength="1"`, `stroke-dasharray: 1`, `stroke-dashoffset` from 1 to 0) is hidden
 * before it is drawn only while its dash is measured in the path's own units. `vector-effect: non-scaling-stroke`
 * measures it on screen instead: in Chromium the "hidden" line shows its far half from the moment it is built. A
 * card killed by Blasphemous Act showed its crack as the spell began to resolve, before its fireball hit (the
 * operator, 2026-11-01, trailer cut 4: "the crack shouldn't appear until the death animation actually starts,
 * after the fireball animation from the card actually hits").
 */
// @reads apps/ui/src/*.css packages/ui-shell/src/*.css packages/game-ui/src/*.css
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { uiPath, uiSheets } from '../../ui-sources.testing.ts';


describe('a line drawn on by its dash', () => {
  it('never measures its dash on screen: no rule both dashes a stroke and keeps it from scaling', () => {
    const offending: string[] = [];
    let dashed = 0;
    for (const file of uiSheets()) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (/stroke-dasharray/.test(body!)) dashed += 1;
        if (/stroke-dasharray/.test(body!) && /non-scaling-stroke/.test(body!)) offending.push(`${uiPath(file)}: ${selector!.trim()}`);
      }
    }
    expect(dashed, 'the scan found the dashed lines: the departures\' crack, the countered stack card\'s, the gauntlet\'s cross').toBeGreaterThanOrEqual(3);
    expect(offending).toEqual([]);
  });
});

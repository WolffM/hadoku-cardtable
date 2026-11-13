/*
 * Every radial-gradient blends in sRGB, said out loud. A gradient with any non-legacy stop — a
 * `color-mix()` result, a `color()` — blends in Oklab by default (CSS Color 4), and Firefox's GPU
 * renderer (WebRender, NVIDIA RTX 4090, driver 595) draws a radial gradient blended in anything but
 * sRGB with a few pixels of saturated garbage at its centre: the stray red/cyan/yellow dot at 85%/15%
 * on every non-tournament room card (the operator, 2026-11-05; the trophy covered it on the others).
 * Bisected in the operator's own Firefox: forcing `in oklab`, `in oklch` or `in srgb-linear` on plain
 * rgba stops reproduces it, opaque stops too; `in srgb` on the exact card CSS clears it; linear
 * gradients are unaffected; software rendering in Firefox and Chromium draws every variant clean.
 */
// @reads apps/ui/src/ packages/ui-shell/src/ packages/game-ui/src/
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { uiFiles, uiPath } from './ui-sources.testing.ts';

const sources = (): string[] => uiFiles((name) => /\.(css|tsx?)$/.test(name) && !/\.test\.tsx?$/.test(name));

describe('radial gradients', () => {
  it('every radial-gradient declares `in srgb`, so Firefox’s GPU path never draws a garbage centre', () => {
    const missing = sources().flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return [...text.matchAll(/radial-gradient\((?!in srgb[ ,])/g)].map((m) => {
        const line = text.slice(0, m.index).split('\n').length;
        return `${uiPath(file)}:${line}`;
      });
    });
    expect(missing).toEqual([]);
  });
});

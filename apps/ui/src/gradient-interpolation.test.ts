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
// @reads apps/ui/src/
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.(css|tsx?)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : [];
  });
}

describe('radial gradients', () => {
  it('every radial-gradient declares `in srgb`, so Firefox’s GPU path never draws a garbage centre', () => {
    const missing = sources(SRC).flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return [...text.matchAll(/radial-gradient\((?!in srgb[ ,])/g)].map((m) => {
        const line = text.slice(0, m.index).split('\n').length;
        return `${relative(SRC, file)}:${line}`;
      });
    });
    expect(missing).toEqual([]);
  });
});

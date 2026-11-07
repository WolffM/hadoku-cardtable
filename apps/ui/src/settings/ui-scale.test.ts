// @vitest-environment jsdom
/*
 * The generic UI-scale behaviour (scaling, clamping, the remembered-scale storage key) is tested
 * where it now lives: packages/ui-shell/src/settings/ui-scale.test.ts. What is left here is
 * cardtable's own: the scale is a valid preference, and the app's CSS plays along with the scaling
 * rewrite everywhere it matters.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PlayPrefsSchema } from '../play/live/prefs.ts';
import { scaleCssValue, UI_SCALE } from '@hadoku/ui-shell/settings';

describe('the scale as a saved preference', () => {
  it('is a saved preference within its range', () => {
    expect(PlayPrefsSchema.safeParse({ uiScale: 1.15 }).success).toBe(true);
    expect(PlayPrefsSchema.safeParse({ uiScale: UI_SCALE.max + 0.5 }).success).toBe(false);
    expect(PlayPrefsSchema.safeParse({ uiScale: 'big' }).success).toBe(false);
  });
});

describe('a property Chromium will not take as calc()', () => {
  // `overflow-clip-margin` written as calc() is dropped to 0px (measured), and the rewrite makes every
  // authored px a calc(): main's run on b98ddd62 clipped every combat-ready creature by its battlefield
  // (cr-combat-clip.spec.ts) once `--emphasis-room: 28px` became `calc(28 * var(--ui-px))`.
  const src = resolve(import.meta.dirname ?? 'apps/ui/src/settings', '..');
  const sheets = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sheets(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []));
  const all = sheets(src)
    .map((file) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))
    .join('\n');

  it('reads its length from a custom property registered as a <length>, so the scaled calc() reaches it as plain px', () => {
    const uses = [...all.matchAll(/overflow-clip-margin:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(uses.length, 'the battlefield and its lanes').toBeGreaterThan(0);
    for (const value of uses) {
      expect(scaleCssValue(value), `${value}: nothing the rewrite turns into calc()`).toBe(value);
      const name = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
      expect(name, `${value} is one custom property`).toBeDefined();
      const registered = new RegExp(`@property ${name} \\{[^}]*syntax:\\s*'<length>'`).test(all);
      expect(registered, `${name} is registered as a <length>`).toBe(true);
    }
  });
});

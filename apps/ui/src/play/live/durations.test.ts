/*
 * A length a module times and its sheet animates over is written once, in the module: it sets a
 * `--*-ms` its sheet reads with `var()`. A loop nobody waits on (`infinite`) is the sheet's own.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = import.meta.dirname ?? 'apps/ui/src/play/live';
const text = (file: string): string => readFileSync(resolve(here, file), 'utf8');

/** Each sheet, and the modules that write what it reads: its own, and `motion.ts`'s house durations. */
const SHEETS: Record<string, readonly string[]> = {
  'numbers.css': ['numbers.ts'],
  'placed.css': ['placed.ts', '../motion.ts'],
  'presence.css': ['presence.ts', '../motion.ts'],
  'gestures/gestures.css': ['gestures/install.ts', '../motion.ts'],
};

/** A `transition` or `animation` value's parts, split on the commas outside parentheses. */
function motions(css: string): string[] {
  const out: string[] = [];
  for (const [, value] of css.matchAll(/(?<![\w-])(?:transition|animation)\s*:([^;{}]*)/g)) {
    let depth = 0;
    let part = '';
    for (const ch of value!) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) {
        out.push(part.trim());
        part = '';
      } else part += ch;
    }
    out.push(part.trim());
  }
  return out;
}

describe('a sheet reads each duration from the module that times it', () => {
  for (const [sheet, writers] of Object.entries(SHEETS)) {
    const css = text(sheet).replace(/\/\*[\s\S]*?\*\//g, '');

    it(`${sheet} writes no duration of its own`, () => {
      expect(motions(css).filter((m) => !m.includes('infinite') && /(?<![\w.-])\d+(\.\d+)?m?s\b/.test(m))).toEqual([]);
    });

    it(`every duration ${sheet} reads is one its module writes`, () => {
      const source = writers.map(text).join('\n');
      for (const [, name] of css.matchAll(/var\((--[\w-]+-ms)\)/g)) expect(source, name).toContain(`'${name}'`);
    });
  }
});

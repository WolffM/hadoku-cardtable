// @vitest-environment jsdom
/*
 * The one place a colour set becomes a symbol or a key. Order-free: Scryfall
 * and Forge hand colours over in their own order (Flame of Anor arrives as
 * ['R','U']), so every answer here must be the same for both orders.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';

import type { ManaColor } from '../draft/types.ts';
import { ColorSymbol, colorSymbolOf, wubrgKey } from './ColorSymbol.tsx';

afterEach(cleanup);

const WUBRG: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];
const PAIRS = WUBRG.flatMap((a, i) => WUBRG.slice(i + 1).map((b) => [a, b] as const));

describe('colorSymbolOf', () => {
  it('a mono colour is that colour', () => {
    for (const c of WUBRG) expect(colorSymbolOf([c])).toBe(c);
  });

  it('every two-colour pair is gold, in either order', () => {
    expect(PAIRS).toHaveLength(10);
    for (const [a, b] of PAIRS) {
      expect(colorSymbolOf([a, b])).toBe('M');
      expect(colorSymbolOf([b, a])).toBe('M');
    }
  });

  it('three, four and five colours are gold', () => {
    expect(colorSymbolOf(['G', 'U', 'R'])).toBe('M');
    expect(colorSymbolOf(['W', 'U', 'B', 'R'])).toBe('M');
    expect(colorSymbolOf([...WUBRG].reverse())).toBe('M');
  });

  it('no colour is colourless', () => {
    expect(colorSymbolOf([])).toBe('C');
  });

  it('a repeated colour is still one colour', () => {
    expect(colorSymbolOf(['R', 'R'])).toBe('R');
  });
});

describe('wubrgKey', () => {
  it('every pair has one key in WUBRG order, whichever order it arrives in', () => {
    for (const [a, b] of PAIRS) {
      expect(wubrgKey([a, b])).toBe(`${a}${b}`);
      expect(wubrgKey([b, a])).toBe(`${a}${b}`);
    }
    expect(wubrgKey(['R', 'U'])).toBe('UR');
    expect(wubrgKey(['W', 'R'])).toBe('WR');
  });

  it('mono, many and none', () => {
    expect(wubrgKey(['G'])).toBe('G');
    expect(wubrgKey(['G', 'W', 'U'])).toBe('WUG');
    expect(wubrgKey([])).toBe('');
  });
});

describe('ColorSymbol', () => {
  const css = readFileSync(resolve(__dirname, '../symbols/mana.css'), 'utf8');

  it('gold is the Mana font’s own multicolour symbol, every class of it vendored', () => {
    const { container } = render(createElement(ColorSymbol, { colors: ['R', 'U'] }));
    const glyph = container.querySelector('i')!;
    expect(glyph.getAttribute('aria-label')).toBe('multicolour');
    for (const cls of ['ms-multicolor', 'ms-duo', 'ms-duo-color', 'ms-grad']) {
      expect(glyph.classList.contains(cls)).toBe(true);
      expect(css).toContain(`.${cls}`);
    }
  });

  it('mono and colourless draw the mana pip', () => {
    const { container } = render(createElement('div', null, createElement(ColorSymbol, { colors: ['U'] }), createElement(ColorSymbol, { colors: [] })));
    const glyphs = [...container.querySelectorAll('i')];
    expect(glyphs.map((g) => g.classList.contains('ms-u'))).toEqual([true, false]);
    expect(glyphs[1]!.classList.contains('ms-c')).toBe(true);
  });
});

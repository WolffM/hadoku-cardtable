// @vitest-environment jsdom
/**
 * Pips are drawn, not licensed.
 *
 * The repo's rule is "no WotC trademarks in the UI — no mana symbols, set
 * symbols, tap symbol, card frames". These assert the two halves of complying
 * with it: every symbol resolves to a DOM element we build, and the ones that
 * are specifically trademarked glyphs — the Phyrexian mark and the tap symbol —
 * are rendered as our own treatments rather than reproduced.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';

import { ManaCost, ManaPip, readManaToken } from './ManaPip.tsx';
import { CardTile } from './CardTile.tsx';
import type { DraftCard } from '../draft/types.ts';

afterEach(cleanup);

describe('reading a cost token', () => {
  it('maps the five colours to our own colour names', () => {
    expect(readManaToken('W').fill).toBe('white');
    expect(readManaToken('U').fill).toBe('blue');
    expect(readManaToken('B').fill).toBe('black');
    expect(readManaToken('R').fill).toBe('red');
    expect(readManaToken('G').fill).toBe('green');
  });

  it('treats generic, colourless and variable costs as one grey pip each', () => {
    for (const token of ['0', '3', '12', 'C', 'X']) {
      expect(readManaToken(token).fill).toBe('generic');
      expect(readManaToken(token).label).toBe(token);
    }
  });

  it('splits a hybrid into two fills', () => {
    const hybrid = readManaToken('W/U');
    expect(hybrid.fill).toBe('white');
    expect(hybrid.fillB).toBe('blue');
    expect(hybrid.phyrexian).toBe(false);
  });

  it('marks Phyrexian without reproducing the glyph', () => {
    const phyrexian = readManaToken('B/P');
    expect(phyrexian.phyrexian).toBe(true);
    expect(phyrexian.fill).toBe('black');
    // The label is the colour letter. The Φ mark appears nowhere.
    expect(phyrexian.label).toBe('B');
  });

  it('renders an unknown token rather than dropping it', () => {
    expect(readManaToken('ZZZ').label).toBe('ZZZ');
  });
});

describe('rendering', () => {
  it('a pip is an element we build, never an image', () => {
    const { container } = render(createElement(ManaPip, { token: 'R' }));
    expect(container.querySelectorAll('img')).toHaveLength(0);
    const pip = container.querySelector('.pip');
    expect(pip?.className).toContain('pip--red');
    expect(pip?.textContent).toBe('R');
  });

  it('a cost renders one pip per token, in order', () => {
    const { container } = render(createElement(ManaCost, { cost: ['1', 'B/P', 'B/P'] }));
    const pips = [...container.querySelectorAll('.pip')];
    expect(pips.map((p) => p.getAttribute('data-token'))).toEqual(['1', 'B/P', 'B/P']);
    expect(pips[1].className).toContain('pip--phyrexian');
  });

  it('an empty cost renders nothing at all, so a land shows no pip', () => {
    const { container } = render(createElement(ManaCost, { cost: [] }));
    expect(container.querySelectorAll('.pip')).toHaveLength(0);
  });
});

const TAP_CARD: DraftCard = {
  cardId: 'test/tap',
  name: 'Test Lands',
  manaCost: [],
  manaValue: 0,
  colors: [],
  typeLine: 'Land',
  oracleText: '{T}: Add {C}.\n{T}, Sacrifice Test Lands: Draw a card.',
  setCode: 'TST',
  collectorNumber: '1',
  rarity: 'uncommon',
};

describe('rules text', () => {
  it('spells the tap symbol out as a word, because the symbol is a mark', () => {
    const { container } = render(createElement(CardTile, { card: TAP_CARD }));
    const taps = [...container.querySelectorAll('.pip')].filter((p) => p.textContent === 'TAP');
    expect(taps).toHaveLength(2);
    // The braces are consumed, not printed.
    expect(container.textContent).not.toContain('{T}');
  });

  it('turns inline mana symbols in rules text into the same pips as a cost', () => {
    const { container } = render(createElement(CardTile, { card: TAP_CARD }));
    const tokens = [...container.querySelectorAll('.pip[data-token]')].map((p) =>
      p.getAttribute('data-token'),
    );
    expect(tokens).toContain('C');
    expect(container.textContent).not.toContain('{C}');
  });
});

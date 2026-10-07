// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

import { RulesText } from './RulesText.tsx';

afterEach(cleanup);

const draw = (text: string) => render(createElement('p', null, createElement(RulesText, { text }))).container.querySelector('p')!;

describe('RulesText — a decision box draws Forge’s mana symbols as symbols', () => {
  it('draws {1}{B} as two Mana-font symbols, never the letters', () => {
    const p = draw('Pay Mana Cost: {1}{B}');
    expect([...p.querySelectorAll('i.ms')].map((i) => i.className)).toEqual(['ms ms-1 ms-cost', 'ms ms-b ms-cost']);
    expect(p.textContent).toBe('Pay Mana Cost: ');
  });

  it('keeps the words around the symbols, in order', () => {
    const p = draw('{T}: Add {G}.');
    expect(p.querySelectorAll('i.ms')).toHaveLength(2);
    expect(p.textContent).toBe(': Add .');
  });

  it('passes text with no symbols through unchanged, and still reads Forge’s raw target expressions as words', () => {
    expect(draw('Select target permanent or Card.inZoneStack').textContent).toBe('Select target permanent or spell');
  });

  it('falls back to words for a brace token the font has no glyph for', () => {
    expect(draw('Choose {zzz}').textContent).toBe('Choose zzz');
  });
});

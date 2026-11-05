// @vitest-environment jsdom
/*
 * A name wears its effect, gradient and font; a name with none is plain text.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';

import { PlayerName } from './look.tsx';

afterEach(cleanup);

describe('PlayerName', () => {
  it('is plain text, with the class it was given, for someone who wears nothing on their name', () => {
    const { container } = render(createElement(PlayerName, { name: 'Ari', face: { id: 'sage', look: { cosmetics: { overlay: 'overlay.halo' } } }, className: 'n' }));
    expect(container.innerHTML).toBe('<span class="n">Ari</span>');
    expect(render(createElement(PlayerName, { name: 'Bo', face: { id: null } })).container.textContent).toBe('Bo');
  });

  it('draws the fleet’s name for someone who wears an effect, a gradient or a font, and escapes the name', () => {
    for (const cosmetics of [{ effect: 'effect.glint' }, { gradient: 'gradient.gild' }, { font: 'font.script' }]) {
      const { container, unmount } = render(createElement(PlayerName, { name: '<b>Ari</b>', face: { id: 'sage', look: { cosmetics } }, className: 'n' }));
      const span = container.querySelector('span.n')!;
      expect(span.hasAttribute('data-dressed')).toBe(true);
      expect(span.querySelector('.hc-name')).not.toBeNull();
      expect(span.querySelector('b')).toBeNull();
      expect(span.textContent).toContain('<b>Ari</b>');
      unmount();
    }
  });

  it('puts the stylesheet in the page once', () => {
    render(createElement(PlayerName, { name: 'Ari', face: { id: 'sage', look: { cosmetics: { effect: 'effect.aura' } } } }));
    render(createElement(PlayerName, { name: 'Bo', face: { id: 'mage', look: { cosmetics: { font: 'font.surf' } } } }));
    expect(document.querySelectorAll('style#hadoku-cosmetics')).toHaveLength(1);
  });
});

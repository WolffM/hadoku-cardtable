// @vitest-environment jsdom
/*
 * Every face falls back the same way: with no id, and when the image will not load.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';

import { Avatar } from './Avatar.tsx';

afterEach(cleanup);

describe('Avatar', () => {
  it('draws the image for an id, and the fallback once it fails to load', () => {
    for (const [fallback, after] of [
      ['mark', 'svg'],
      ['initial', 'span'],
    ] as const) {
      const { container, unmount } = render(createElement(Avatar, { id: 'wanderer', fallback, name: 'alice', className: 'face', 'data-testid': 'face' }));
      const img = container.querySelector('img')!;
      expect(img.getAttribute('src')).toMatch(/\/watchparty\/media\/sprites\/square_wanderer\.png$/);
      expect(img.getAttribute('alt')).toBe('');
      expect(img.getAttribute('data-testid')).toBe('face');
      fireEvent.error(img);
      expect(container.querySelector('img')).toBeNull();
      expect(container.firstElementChild!.tagName.toLowerCase()).toBe(after);
      unmount();
    }
  });

  it('with no id draws the mark, the initial, or nothing', () => {
    expect(render(createElement(Avatar, { id: undefined, fallback: 'mark' })).container.querySelector('svg.player-mark')).not.toBeNull();
    expect(render(createElement(Avatar, { id: '  ', fallback: 'initial', name: 'bob' })).container.textContent).toBe('B');
    expect(render(createElement(Avatar, { id: null, fallback: 'none' })).container.innerHTML).toBe('');
  });

  /* One avatar, everywhere (the operator, 2026-11-05): the picture they chose, then their character. */
  const PICTURE = 'https://cdn.discordapp.com/avatars/1/a.png';

  it('draws the picture instead of the character, the character when the picture fails, then the fallback', () => {
    const { container } = render(createElement(Avatar, { id: 'wanderer', look: { picture: PICTURE }, fallback: 'mark' }));
    const img = (): HTMLImageElement | null => container.querySelector('img');
    expect(img()?.getAttribute('src')).toBe(PICTURE);
    fireEvent.error(img()!);
    expect(img()?.getAttribute('src')).toMatch(/square_wanderer\.png$/);
    fireEvent.error(img()!);
    expect(img()).toBeNull();
    expect(container.querySelector('svg.player-mark')).not.toBeNull();
  });

  it('draws a picture for someone with no character', () => {
    const { container } = render(createElement(Avatar, { id: null, look: { picture: PICTURE }, fallback: 'none' }));
    expect(container.querySelector('img')?.getAttribute('src')).toBe(PICTURE);
  });

  it('lays the overlay they wear over the face, at the face’s own size, and nothing for what this build does not know', () => {
    const worn = render(createElement(Avatar, { id: 'sage', look: { cosmetics: { overlay: 'overlay.halo' } }, fallback: 'mark' }));
    const decor = worn.getByTestId('face-decor');
    expect(decor.classList.contains('hc-av')).toBe(true);
    expect(decor.innerHTML).toContain('hc-ol');
    expect(decor.style.getPropertyValue('--hc-sz')).toMatch(/px$/);
    worn.unmount();
    const unknown = render(createElement(Avatar, { id: 'sage', look: { cosmetics: { overlay: 'overlay.not-a-thing' } }, fallback: 'mark' }));
    expect(unknown.queryByTestId('face-decor')).toBeNull();
  });

  it('draws an overlay outside the face-sized ring that would clip it', () => {
    const { container } = render(
      createElement('span', { className: 'outer' }, createElement('span', { className: 'ring', style: { overflow: 'hidden' } }, createElement(Avatar, { id: 'sage', look: { cosmetics: { overlay: 'overlay.halo' } }, fallback: 'mark' }))),
    );
    const decor = container.querySelector('[data-testid="face-decor"]')!;
    expect(decor.parentElement?.className).toBe('outer');
  });
});

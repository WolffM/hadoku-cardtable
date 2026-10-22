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
});

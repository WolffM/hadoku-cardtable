// @vitest-environment jsdom
/*
 * The front-page module's own contract: a caller that passes none of the three slots gets no
 * banner, no nav and no featured markup — no wrapper element for any of them (the settled
 * contract's own words, `docs/planning/wave120-2026-11-17.md` §F).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { RoomFront, type RoomFrontClient, type RoomFrontRoom } from './RoomFront.tsx';

afterEach(cleanup);

interface ToyRoom extends RoomFrontRoom {
  view: RoomFrontRoom['view'];
}

function toyClient(rooms: ToyRoom[] = []): RoomFrontClient<ToyRoom> {
  return {
    list: () => Promise.resolve({ rooms }),
    create: () => Promise.reject(new Error('not used in this test')),
    join: () => Promise.reject(new Error('not used in this test')),
  };
}

describe('RoomFront with no slots', () => {
  it('draws no banner, no nav and no featured element — only the list itself', async () => {
    const { container } = render(
      createElement(RoomFront<ToyRoom>, {
        rooms: toyClient(),
        gameTypes: [{ id: 'toy', label: 'Toy' }],
        onOpenRoom: () => undefined,
      }),
    );
    await waitFor(() => expect(screen.getByTestId('rooms-empty')).toBeTruthy());

    expect(container.querySelector('nav')).toBeNull();
    expect(screen.queryByTestId('front-banner')).toBeNull();
    // The rooms section is the only thing drawn: no extra wrapper around it, for either slot.
    expect(container.children).toHaveLength(1);
    expect(screen.getByTestId('rooms')).toBe(container.firstElementChild);
  });

  it('draws exactly what it is given for each slot, and nothing more', async () => {
    render(
      createElement(RoomFront<ToyRoom>, {
        rooms: toyClient(),
        gameTypes: [{ id: 'toy', label: 'Toy' }],
        onOpenRoom: () => undefined,
        navTools: createElement('button', { 'data-testid': 'toy-nav' }, 'Nav'),
        banner: createElement('div', { 'data-testid': 'toy-banner' }, 'Banner'),
        featured: createElement('div', { 'data-testid': 'toy-featured' }, 'Featured'),
      }),
    );
    await waitFor(() => expect(screen.getByTestId('rooms-empty')).toBeTruthy());

    expect(screen.getByTestId('toy-nav')).toBeTruthy();
    expect(screen.getByTestId('toy-banner')).toBeTruthy();
    expect(screen.getByTestId('toy-featured')).toBeTruthy();
    expect(container_order()).toEqual(['toy-nav', 'toy-featured', 'toy-banner', 'rooms']);

    function container_order(): (string | null)[] {
      return [...document.body.querySelectorAll('[data-testid="toy-nav"], [data-testid="toy-featured"], [data-testid="toy-banner"], [data-testid="rooms"]')].map((el) =>
        el.getAttribute('data-testid'),
      );
    }
  });

  // "Empty or absent renders nothing": `undefined` is one way a caller omits a slot, but a caller
  // that computes one conditionally hands `null` or `false` just as often — each must draw no
  // wrapper either, same as leaving the prop out entirely.
  it.each([
    ['null', null],
    ['false', false],
  ] as const)('draws no nav, no banner section and no featured element for %s', async (_label, empty) => {
    const { container } = render(
      createElement(RoomFront<ToyRoom>, {
        rooms: toyClient(),
        gameTypes: [{ id: 'toy', label: 'Toy' }],
        onOpenRoom: () => undefined,
        navTools: empty,
        banner: empty,
        featured: empty,
      }),
    );
    await waitFor(() => expect(screen.getByTestId('rooms-empty')).toBeTruthy());

    expect(container.querySelector('nav')).toBeNull();
    expect(container.children).toHaveLength(1);
    expect(screen.getByTestId('rooms')).toBe(container.firstElementChild);
  });
});

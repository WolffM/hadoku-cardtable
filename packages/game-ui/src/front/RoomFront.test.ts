// @vitest-environment jsdom
/*
 * The front-page module's own contract: a caller that passes none of the three slots gets no
 * banner, no nav and no featured markup — no wrapper element for any of them (the settled
 * contract's own words, `docs/planning/wave120-2026-11-17.md` §F).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

// RoomFront's own `playRole('ui.select')` on Create-room-open/submit/deny needs a registered
// `Sound` instance (`../composition.tsx`'s own job in a real app); this file tests RoomFront in
// isolation, so it stubs the one function RoomFront.tsx actually imports from it rather than
// wiring a whole role registry and sound client just to open the dialog in a test.
vi.mock('../sound/index.ts', () => ({ playRole: () => undefined }));

// The page's one room feed (`roomFeed()` answers the same one every call), as `RoomFront` follows it
// by default: a test pings it by hand.
const feedPings = vi.hoisted(() => {
  const state = { targets: [] as unknown[], refreshes: [] as (() => void)[] };
  const feed = {
    follow(target: unknown, refresh: () => void) {
      state.targets.push(target);
      state.refreshes.push(refresh);
      refresh();
      return () => {
        state.refreshes = state.refreshes.filter((r) => r !== refresh);
      };
    },
  };
  return Object.assign(state, { feed });
});
vi.mock('../rooms/feed.ts', () => ({ roomFeed: () => feedPings.feed }));

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

describe('createPanelClassName', () => {
  it("is this module's own styled block, and a caller's own classes are added to it, never in its place", async () => {
    const { unmount } = render(
      createElement(RoomFront<ToyRoom>, {
        rooms: toyClient(),
        gameTypes: [{ id: 'toy', label: 'Toy' }],
        onOpenRoom: () => undefined,
      }),
    );
    await waitFor(() => expect(screen.getByTestId('rooms-empty')).toBeTruthy());
    screen.getByTestId('room-create-open').click();
    await waitFor(() => expect(screen.getByTestId('room-create')).toBeTruthy());
    expect(screen.getByTestId('room-create').className).toBe('room-front-create');
    unmount();

    render(
      createElement(RoomFront<ToyRoom>, {
        rooms: toyClient(),
        gameTypes: [{ id: 'toy', label: 'Toy' }],
        onOpenRoom: () => undefined,
        createPanelClassName: 'ct-surface ct-panel',
      }),
    );
    await waitFor(() => expect(screen.getByTestId('rooms-empty')).toBeTruthy());
    screen.getByTestId('room-create-open').click();
    await waitFor(() => expect(screen.getByTestId('room-create')).toBeTruthy());
    expect(screen.getByTestId('room-create').className).toBe('room-front-create ct-surface ct-panel');
  });
});

describe('the create form’s game type', () => {
  async function openCreate(gameTypes: { id: string; label: string }[]): Promise<void> {
    render(createElement(RoomFront<ToyRoom>, { rooms: toyClient(), gameTypes, onOpenRoom: () => undefined }));
    await waitFor(() => expect(screen.getByTestId('rooms-empty')).toBeTruthy());
    screen.getByTestId('room-create-open').click();
    await waitFor(() => expect(screen.getByTestId('room-create')).toBeTruthy());
  }

  it('is not asked when the game has one room type', async () => {
    await openCreate([{ id: 'toy', label: 'Toy' }]);
    expect(screen.queryByText('Game type')).toBeNull();
    expect(screen.queryByTestId('room-create-type-toy')).toBeNull();
  });

  it('is a radio when there is a choice', async () => {
    await openCreate([
      { id: 'toy', label: 'Toy' },
      { id: 'other', label: 'Other' },
    ]);
    expect(screen.getByTestId('room-create-type-toy')).toBeTruthy();
    expect(screen.getByTestId('room-create-type-other')).toBeTruthy();
  });
});

describe('the list follows the page’s room feed', () => {
  it('by default: it reads the list again on every ping, with no timer of its own', async () => {
    feedPings.targets = [];
    let reads = 0;
    const rooms: RoomFrontClient<ToyRoom> = { ...toyClient(), list: () => ((reads += 1), Promise.resolve({ rooms: [] })) };
    render(createElement(RoomFront<ToyRoom>, { rooms, gameTypes: [{ id: 'toy', label: 'Toy' }], onOpenRoom: () => undefined }));
    await waitFor(() => expect(screen.getByTestId('rooms-empty')).toBeTruthy());
    expect(feedPings.targets).toEqual(['list']);
    expect(reads).toBe(1);
    for (const refresh of feedPings.refreshes) refresh();
    await waitFor(() => expect(reads).toBe(2));
  });
});

describe('a row’s own colours', () => {
  it('are the game’s custom properties, set on the row itself', async () => {
    const vars = { '--room-front-tint': 'var(--c-green)', '--room-front-dot': 'var(--color-primary)' } as const;
    const room: ToyRoom = {
      id: 'r-1',
      name: 'One',
      gameType: 'toy',
      locked: false,
      members: [],
      you: { id: 'me' },
      view: { seatsFilled: 0, seatsCapacity: 2, state: { key: 'drafting', label: 'Drafting', detail: null }, primaryAction: 'Join', extraWatch: false },
    };
    render(
      createElement(RoomFront<ToyRoom>, {
        rooms: toyClient([room]),
        gameTypes: [{ id: 'toy', label: 'Toy' }],
        onOpenRoom: () => undefined,
        rowExtras: () => ({ vars }),
      }),
    );
    const row = await screen.findByTestId('room-row');
    expect(row.style.getPropertyValue('--room-front-tint')).toBe(vars['--room-front-tint']);
    expect(row.style.getPropertyValue('--room-front-dot')).toBe(vars['--room-front-dot']);
  });
});

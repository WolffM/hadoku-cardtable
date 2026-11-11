// @vitest-environment jsdom
/*
 * BundleSlot's own proof: a stub bundle module mounts and receives the context, an update
 * reaches it on a seat change (never a remount), it unmounts on leave, and a bundle that throws
 * is reported through the error UI rather than crashing the render.
 *
 * `.test.ts`, not `.test.tsx` — the root vitest config globs `apps/*\/src/**\/*.test.ts`, so
 * `createElement` stands in for JSX here (see `chrome/theme-agreement.test.ts`, which explains
 * the same constraint).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { HadokuThemeProvider, type HadokuThemeValue } from '@wolffm/themes';

import type { Who } from '../room/whoami.ts';

let who: Who | null | 'pending' = { userId: 'u1', tier: 'friend', name: 'Ann' };
vi.mock('../room/whoami.ts', () => ({ useWhoami: () => who }));

// Hoisted above the mocked import above it resolves, so the mock is in place before BundleSlot
// (and its import of `../room/whoami.ts`) loads.
import { BundleSlot } from './BundleSlot.tsx';
import type { RoomViewBase } from './game-setup.ts';
import { calls as fixtureCalls } from './bundle-slot.fixture.ts';
import type { GameBundleContext } from '@wolffm/rooms-protocol';

// `BundleSlot` resolves `src` by dynamic `import()` relative to ITS OWN file, the same directory
// this fixture lives in — so a bare relative specifier here is what `BundleSlot` also receives:
// no `import.meta.url`/URL wrapping, which this vitest config's module runner does not accept on
// a dynamic `import()` (it is served over an internal http: origin, and Node's loader accepts
// only file:/data: URLs there).
const BUNDLE_SRC = './bundle-slot.fixture.ts';
const fixture = { calls: fixtureCalls };

function themeValue(theme: string): HadokuThemeValue {
  return {
    theme,
    setTheme: () => undefined,
    themeFamilies: [],
    getThemeIcon: () => null,
    isDarkTheme: false,
    isThemeReady: true,
    isInitialThemeLoad: false,
  };
}

function aView(members: RoomViewBase['members'], overrides: Partial<RoomViewBase> = {}): RoomViewBase {
  return { id: 'room-a', name: 'Test room', gameType: 'bomberman', members, you: { id: 'u1', leader: false }, ...overrides };
}

function renderSlot(props: { view: RoomViewBase | null; me: { userId: string; isLeader: boolean } }) {
  return render(
    createElement(HadokuThemeProvider, {
      value: themeValue('dark'),
      children: createElement(BundleSlot, { src: BUNDLE_SRC, ...props }),
    }),
  );
}

beforeEach(() => {
  fixture.calls.length = 0;
  who = { userId: 'u1', tier: 'friend', name: 'Ann' };
});

afterEach(() => {
  cleanup();
});

describe('BundleSlot', () => {
  it('mounts the bundle with roomKey, identity, theme, isLeader and match', async () => {
    const members = [{ id: 'u1', name: 'u1' }, { id: 'u2', name: 'u2' }];
    renderSlot({ view: aView(members), me: { userId: 'u1', isLeader: true } });

    await waitFor(() => expect(fixture.calls.length).toBeGreaterThan(0));
    const first = fixture.calls[0] as ['mount', GameBundleContext];
    expect(first[0]).toBe('mount');
    const ctx = first[1];
    expect(ctx.roomKey).toBe('room-a');
    expect(ctx.identity).toEqual({ userId: 'u1', userType: 'friend', name: 'Ann' });
    expect(ctx.theme).toBe('dark');
    expect(ctx.isLeader).toBe(true);
    expect(ctx.match).toEqual({
      id: 'room-a',
      seat: 0,
      seats: [
        { seat: 0, userId: 'u1', name: 'u1' },
        { seat: 1, userId: 'u2', name: 'u2' },
      ],
    });
  });

  it('sends an update (not a remount) when the member list changes', async () => {
    const { rerender } = renderSlot({ view: aView([{ id: 'u1', name: 'u1' }]), me: { userId: 'u1', isLeader: false } });
    await waitFor(() => expect(fixture.calls.some((c) => c[0] === 'mount')).toBe(true));

    rerender(
      createElement(HadokuThemeProvider, {
        value: themeValue('dark'),
        children: createElement(BundleSlot, {
          src: BUNDLE_SRC,
          view: aView([{ id: 'u1', name: 'u1' }, { id: 'u2', name: 'u2' }]),
          me: { userId: 'u1', isLeader: false },
        }),
      }),
    );

    await waitFor(() => expect(fixture.calls.some((c) => c[0] === 'update')).toBe(true));
    const update = fixture.calls.find((c) => c[0] === 'update') as ['update', GameBundleContext];
    expect(update[1].match).toEqual({
      id: 'room-a',
      seat: 0,
      seats: [
        { seat: 0, userId: 'u1', name: 'u1' },
        { seat: 1, userId: 'u2', name: 'u2' },
      ],
    });
    expect(fixture.calls.filter((c) => c[0] === 'mount')).toHaveLength(1);
  });

  it('unmounts the bundle when the component unmounts', async () => {
    const { unmount } = renderSlot({ view: aView([{ id: 'u1', name: 'u1' }]), me: { userId: 'u1', isLeader: false } });
    await waitFor(() => expect(fixture.calls.some((c) => c[0] === 'mount')).toBe(true));

    unmount();

    await waitFor(() => expect(fixture.calls.some((c) => c[0] === 'unmount')).toBe(true));
  });

  it('reports a bundle that throws through its own error UI, without crashing the render', async () => {
    renderSlot({ view: aView([{ id: 'u1', name: 'u1' }], { id: 'throw' }), me: { userId: 'u1', isLeader: false } });

    await waitFor(() => expect(screen.getByTestId('room-bundle-slot-error')).toBeTruthy());
    expect(screen.getByTestId('room-bundle-slot-error').textContent).toBe('the game failed to start: mount exploded');
  });

  it('renders an empty slot and mounts nothing while the view has not resolved', () => {
    // No wait: with `view: null` nothing is ever scheduled to load the bundle (the mount effect
    // sees a null context and no-ops), so there is no later state for a `waitFor` to wait on —
    // `render` itself (wrapped in `act` by testing-library) already flushes that effect.
    renderSlot({ view: null, me: { userId: '', isLeader: false } });

    expect(fixture.calls).toEqual([]);
    expect(screen.getByTestId('room-bundle-slot')).toBeTruthy();
  });
});

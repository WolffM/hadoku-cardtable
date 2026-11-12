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
import { registerGameType } from '@hadoku/shared';

import type { Who } from '../room/whoami.ts';

let who: Who | null | 'pending' = { userId: 'u1', tier: 'friend', name: 'Ann' };
vi.mock('../room/whoami.ts', () => ({ useWhoami: () => who }));

/** `relayChannelCalls`: every `openRelayChannel`/`close()` call, so a test can assert on the
 *  room this file opened a channel for and that unmounting disposed it — a real socket is
 *  `relay-channel.test.ts`'s own job, not this component's. */
const relayChannelCalls: { matchId: string; closed: boolean }[] = [];
vi.mock('./relay-channel.ts', () => ({
  openRelayChannel: (matchId: string) => {
    const entry = { matchId, closed: false };
    relayChannelCalls.push(entry);
    return {
      send: vi.fn(),
      on: () => () => {},
      close: () => {
        entry.closed = true;
      },
    };
  },
}));

// Hoisted above the mocked imports above it resolves, so both mocks are in place before
// BundleSlot (and its imports of `../room/whoami.ts` and `./relay-channel.ts`) load.
import { BundleSlot } from './BundleSlot.tsx';
import type { RoomViewBase } from './game-setup.ts';
import { calls as fixtureCalls } from './bundle-slot.fixture.ts';
import type { GameBundleContext } from '@wolffm/rooms-protocol';

registerGameType({
  id: 'relay-room-test',
  runtime: 'relay',
  seats: { min: 2, max: 2 },
  ready: false,
  series: { length: 1 },
  canStart: (seated) => (seated >= 2 ? { ok: true } : { ok: false, reason: 'not-enough-players' }),
});

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
  relayChannelCalls.length = 0;
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

describe("BundleSlot's ctx.channel (a runtime: 'relay' room)", () => {
  it("opens a relay channel for the room and hands it to the bundle as ctx.channel, once attached", async () => {
    const members = [{ id: 'u1', name: 'u1' }, { id: 'u2', name: 'u2' }];
    renderSlot({ view: aView(members, { id: 'room-relay', gameType: 'relay-room-test' }), me: { userId: 'u1', isLeader: true } });

    await waitFor(() => expect(relayChannelCalls).toEqual([{ matchId: 'room-relay', closed: false }]));
    // Whichever call carries it first: `mountGameBundle` applies any `update()` that lands while
    // its dynamic `import()` is still in flight to the mount itself (`@hadoku/rooms-client`'s own
    // `mountedCtx`/`latest`), so the channel — attached moments after the first render — often
    // reaches the bundle's own `mount()` rather than a separate `update()`.
    await waitFor(() => expect(fixture.calls.some((c) => (c[1] as GameBundleContext | undefined)?.channel !== undefined)).toBe(true));
    const withChannel = fixture.calls.find((c) => (c[1] as GameBundleContext | undefined)?.channel !== undefined) as [string, GameBundleContext];
    expect(withChannel[1].channel).toBeDefined();
  });

  it('closes the channel on unmount', async () => {
    const { unmount } = renderSlot({ view: aView([{ id: 'u1', name: 'u1' }], { id: 'room-relay', gameType: 'relay-room-test' }), me: { userId: 'u1', isLeader: false } });
    await waitFor(() => expect(relayChannelCalls).toHaveLength(1));

    unmount();

    expect(relayChannelCalls[0]).toEqual({ matchId: 'room-relay', closed: true });
  });

  it('never opens a channel for an ordinary (non-relay) game type', async () => {
    renderSlot({ view: aView([{ id: 'u1', name: 'u1' }]), me: { userId: 'u1', isLeader: false } });
    await waitFor(() => expect(fixture.calls.some((c) => c[0] === 'mount')).toBe(true));

    expect(relayChannelCalls).toEqual([]);
    const mounted = fixture.calls.find((c) => c[0] === 'mount') as ['mount', GameBundleContext];
    expect(mounted[1].channel).toBeUndefined();
  });

  it("at most one channel is ever live: moving to a different relay room closes the first BEFORE the second opens, never both at once", async () => {
    const { rerender } = renderSlot({ view: aView([{ id: 'u1', name: 'u1' }], { id: 'room-relay-1', gameType: 'relay-room-test' }), me: { userId: 'u1', isLeader: false } });
    await waitFor(() => expect(relayChannelCalls).toHaveLength(1));
    expect(relayChannelCalls[0]).toEqual({ matchId: 'room-relay-1', closed: false });

    rerender(
      createElement(HadokuThemeProvider, {
        value: themeValue('dark'),
        children: createElement(BundleSlot, {
          src: BUNDLE_SRC,
          view: aView([{ id: 'u1', name: 'u1' }], { id: 'room-relay-2', gameType: 'relay-room-test' }),
          me: { userId: 'u1', isLeader: false },
        }),
      }),
    );

    await waitFor(() => expect(relayChannelCalls).toHaveLength(2));
    // The FIRST room's channel is closed; never two live channels for one slot at once.
    expect(relayChannelCalls[0]).toEqual({ matchId: 'room-relay-1', closed: true });
    expect(relayChannelCalls[1]).toEqual({ matchId: 'room-relay-2', closed: false });
  });
});

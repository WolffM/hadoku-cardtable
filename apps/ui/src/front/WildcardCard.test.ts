// @vitest-environment jsdom
// The wildcard warms its other pages' art only once its box is shown: never on a timer of its own
// the fade's length, which can fire before the box says so (and compete with the first paint).
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ART = '7673784e-db4b-43a1-8d55-1bb9fc1e284f';
const warmed: { urls: string[]; phase: string | null }[] = [];

vi.mock('../rooms/api.ts', () => ({
  onRoomList: (cb: (rooms: unknown[]) => void) => {
    cb([]);
    return () => undefined;
  },
  roomsClient: () => ({}),
  poolsClient: () => ({
    listCubes: async () => [{ id: 'c-1', name: 'A Cube', size: 360, artId: ART }],
    cubeArts: async () => [ART],
  }),
}));
vi.mock('../http.ts', async (real) => ({ ...(await real<object>()), getJson: () => Promise.reject(new Error('offline')) }));
vi.mock('../draft/useArtLoaded.ts', () => ({ useArtLoaded: () => true }));
vi.mock('../draft/cardImage.ts', async (real) => ({
  ...(await real<object>()),
  warmArt: (urls: readonly string[]) => {
    warmed.push({ urls: [...urls], phase: document.querySelector('[data-reveal="wildcard"]')?.getAttribute('data-phase') ?? null });
    return urls.length;
  },
}));

const { WildcardCard } = await import('./WildcardCard.tsx');
const { REVEAL_MS } = await import('../components/Reveal.tsx');

describe('the wildcard warms its other pages’ art', () => {
  beforeEach(() => {
    warmed.length = 0;
    vi.useFakeTimers();
    // It opens on the bare invite (the last kind), so the cube's art is another page's.
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('only once its box says it is shown', async () => {
    render(createElement(WildcardCard));
    // A millisecond at a time, each in its own act: React runs the effects a step committed before
    // the clock moves on, as a browser would.
    for (let ms = 0; ms < 3_000 + REVEAL_MS * 2; ms += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
    }
    expect(warmed.length, 'the cube page’s art is warmed').toBeGreaterThan(0);
    expect(warmed.map((w) => w.phase)).toEqual(warmed.map(() => 'shown'));
    expect(warmed[0]!.urls).toContain(`/api/art/${ART}`);
  });
});

// @vitest-environment jsdom
/**
 * The portrait switch: a fake `matchMedia` stands in for jsdom's missing one
 * (`chrome/matchMedia.ts`'s doc — jsdom has never implemented it), one that
 * can actually fire a `change` event, which the real fallback's no-op
 * listeners cannot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import {
  clampZoom,
  compactCount,
  dispatchZoomEvent,
  LANE_GROW_MAX,
  PORTRAIT_MEDIA_QUERY,
  portraitLaneFit,
  usePortraitLayout,
  ZOOM_EVENT,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_RESET_EVENT,
} from './portrait.ts';

/** A `MediaQueryList` whose `matches` this test can flip and whose `change` listeners it can fire. */
function fakeMediaQueryList(initialMatches: boolean): MediaQueryList & { fire(matches: boolean): void } {
  const listeners = new Set<(ev: MediaQueryListEvent) => void>();
  let matches = initialMatches;
  return {
    get matches() {
      return matches;
    },
    media: PORTRAIT_MEDIA_QUERY,
    onchange: null,
    addEventListener: (_type: string, listener: (ev: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (ev: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
    fire(next: boolean) {
      matches = next;
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
    },
  } as MediaQueryList & { fire(matches: boolean): void };
}

describe('usePortraitLayout', () => {
  let mql: ReturnType<typeof fakeMediaQueryList>;
  let originalMatchMedia: typeof window.matchMedia | undefined;

  beforeEach(() => {
    delete document.documentElement.dataset.layout;
    originalMatchMedia = window.matchMedia;
    mql = fakeMediaQueryList(false);
    window.matchMedia = vi.fn().mockReturnValue(mql);
  });

  afterEach(() => {
    /*
     * Every `renderHook` in this suite but the ones that call `unmount()` themselves — this codebase
     * does not rely on `@testing-library/react`'s implicit global cleanup (`Board.test.ts` calls
     * `cleanup()` itself for the same reason). Without it, `activeSubscribers` (`portrait.ts`) never
     * comes back down between cases, and the two "unmounts clear the attribute" cases below would
     * fail only because an EARLIER case's hook was still "mounted".
     */
    cleanup();
    delete document.documentElement.dataset.layout;
    if (originalMatchMedia === undefined) delete (window as { matchMedia?: typeof window.matchMedia }).matchMedia;
    else window.matchMedia = originalMatchMedia;
  });

  it('queries exactly the Settled-1 condition: ≤600px wide and taller than wide', () => {
    renderHook(() => usePortraitLayout());
    expect(window.matchMedia).toHaveBeenCalledWith('(max-width: 600px) and (orientation: portrait)');
  });

  it('starts false and leaves <html> with no data-layout when the query does not match', () => {
    const { result } = renderHook(() => usePortraitLayout());
    expect(result.current).toBe(false);
    expect(document.documentElement.dataset.layout).toBeUndefined();
  });

  it('sets data-layout="portrait" the moment it mounts matching', () => {
    mql = fakeMediaQueryList(true);
    window.matchMedia = vi.fn().mockReturnValue(mql);
    const { result } = renderHook(() => usePortraitLayout());
    expect(result.current).toBe(true);
    expect(document.documentElement.dataset.layout).toBe('portrait');
  });

  it('flips the hook and the attribute together when the viewport crosses the breakpoint', () => {
    const { result } = renderHook(() => usePortraitLayout());
    expect(result.current).toBe(false);
    act(() => mql.fire(true));
    expect(result.current).toBe(true);
    expect(document.documentElement.dataset.layout).toBe('portrait');
    act(() => mql.fire(false));
    expect(result.current).toBe(false);
    expect(document.documentElement.dataset.layout).toBeUndefined();
  });

  it('reports not-portrait and touches nothing when the host has no matchMedia at all', () => {
    delete (window as { matchMedia?: typeof window.matchMedia }).matchMedia;
    const { result } = renderHook(() => usePortraitLayout());
    expect(result.current).toBe(false);
    expect(document.documentElement.dataset.layout).toBeUndefined();
  });

  it('clears data-layout when the last mounted consumer unmounts (Settled 10: never leaks into the room)', () => {
    mql = fakeMediaQueryList(true);
    window.matchMedia = vi.fn().mockReturnValue(mql);
    const { unmount } = renderHook(() => usePortraitLayout());
    expect(document.documentElement.dataset.layout).toBe('portrait');
    unmount();
    expect(document.documentElement.dataset.layout).toBeUndefined();
  });

  it('keeps data-layout while a second consumer is still mounted, clears it once both are gone', () => {
    mql = fakeMediaQueryList(true);
    window.matchMedia = vi.fn().mockReturnValue(mql);
    const a = renderHook(() => usePortraitLayout());
    const b = renderHook(() => usePortraitLayout());
    expect(document.documentElement.dataset.layout).toBe('portrait');
    a.unmount();
    expect(document.documentElement.dataset.layout, 'b is still mounted').toBe('portrait');
    b.unmount();
    expect(document.documentElement.dataset.layout).toBeUndefined();
  });
});

describe('zoom contract', () => {
  it('clamps to [ZOOM_MIN, ZOOM_MAX]', () => {
    expect(clampZoom(0)).toBe(ZOOM_MIN);
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(1.7)).toBe(1.7);
    expect(clampZoom(99)).toBe(ZOOM_MAX);
  });

  it('names the reset event distinctly from the zoom event (B dispatches it with no detail)', () => {
    expect(ZOOM_RESET_EVENT).toBe('cardtable:zoom-reset');
    expect(ZOOM_RESET_EVENT).not.toBe(ZOOM_EVENT);
  });

  it('dispatches cardtable:zoom on window with the zoom in detail', () => {
    const seen: number[] = [];
    const onZoom = (ev: Event) => seen.push((ev as CustomEvent<{ zoom: number }>).detail.zoom);
    window.addEventListener(ZOOM_EVENT, onZoom);
    try {
      dispatchZoomEvent(1.5);
      expect(seen).toEqual([1.5]);
    } finally {
      window.removeEventListener(ZOOM_EVENT, onZoom);
    }
  });
});

describe('compactCount: a chip zone button’s number', () => {
  it('is exact below a thousand, whole thousands rounded down after', () => {
    expect([0, 7, 46, 102, 999].map(compactCount)).toEqual(['0', '7', '46', '102', '999']);
    expect([1000, 1999, 9999, 12_345].map(compactCount)).toEqual(['1k', '1k', '9k', '12k']);
  });
  it('never draws more than three glyphs for a four-digit count', () => {
    for (let n = 1000; n < 10_000; n += 137) expect(compactCount(n).length).toBeLessThanOrEqual(3);
  });
});

describe('portraitLaneFit: how big a permanents lane draws its cards', () => {
  // 390px phone: lane 388 wide, the stylesheet's 8/6/22 tokens, 1×.
  const at = (count: number, height = 248) => portraitLaneFit({ width: 388, height, pad: 8, gap: 6, peek: 22, rise: 18, zoom: 1, count });
  const cw0 = (388 - 16 - 12 - 22) / 3;

  it('grows a sparse lane’s cards, never past the ceiling', () => {
    expect(at(1)).toEqual({ k: LANE_GROW_MAX, rows: 1 });
    expect(at(2).k).toBeLessThanOrEqual(LANE_GROW_MAX);
    expect(at(2).k).toBeGreaterThan(1);
  });
  it('fits three across the lane’s width', () => {
    const { k, rows } = at(3);
    expect(rows).toBe(1);
    expect(3 * k * cw0 + 2 * 6 + 16).toBeLessThanOrEqual(388 + 0.01);
  });
  it('keeps four at the 3-across width, a peek of the fourth to scroll to', () => {
    expect(at(4)).toEqual({ k: 1, rows: 1 });
  });
  it('wraps five or more to two rows when two rows still draw a card big enough', () => {
    const fit = at(7);
    expect(fit.rows).toBe(2);
    expect(fit.k).toBeGreaterThanOrEqual(0.62);
    expect(2 * fit.k * cw0 * (88 / 63) + 6 + 18).toBeLessThanOrEqual(248 + 0.01);
  });
  it('stays one row, and scrolls, in a lane too short for two', () => {
    expect(at(7, 190)).toEqual({ k: 1, rows: 1 });
  });
  it('never shrinks a card below the 3-across width in one row', () => {
    expect(at(1, 120).k).toBe(1);
  });
  it('is 1 for an empty lane', () => {
    expect(at(0)).toEqual({ k: 1, rows: 1 });
  });
});

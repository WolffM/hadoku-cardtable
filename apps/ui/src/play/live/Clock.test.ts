// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

import { clockLeft, clockText, MatchClock } from './Clock.tsx';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the chess clock', () => {
  it('reads m:ss, rounded up, so it says 0:00 only once the time is gone', () => {
    expect(clockText(20 * 60_000)).toBe('20:00');
    expect(clockText(59_001)).toBe('1:00');
    expect(clockText(9_000)).toBe('0:09');
    expect(clockText(1)).toBe('0:01');
    expect(clockText(0)).toBe('0:00');
    expect(clockText(-5)).toBe('0:00');
  });

  it("counts a running clock down from when the server's reading arrived, and holds a stopped one", () => {
    expect(clockLeft({ ms: 30_000, running: true, at: 1_000 }, 6_000)).toBe(25_000);
    expect(clockLeft({ ms: 30_000, running: false, at: 1_000 }, 60_000)).toBe(30_000);
    expect(clockLeft({ ms: 3_000, running: true, at: 0 }, 9_000)).toBe(0);
  });

  it('ticks while running and colours the last minute and the last ten seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const { getByTestId } = render(createElement(MatchClock, { clock: { ms: 61_000, running: true, at: 100_000 } }));
    const clock = getByTestId('match-clock');
    expect(clock.textContent).toBe('1:01');
    expect(clock.hasAttribute('data-running')).toBe(true);
    expect(clock.hasAttribute('data-low')).toBe(false);
    act(() => vi.advanceTimersByTime(2_000));
    expect(clock.textContent).toBe('0:59');
    expect(clock.hasAttribute('data-low')).toBe(true);
    act(() => vi.advanceTimersByTime(50_000));
    expect(clock.textContent).toBe('0:09');
    expect(clock.hasAttribute('data-low')).toBe(false);
    expect(clock.hasAttribute('data-out')).toBe(true);
  });
});

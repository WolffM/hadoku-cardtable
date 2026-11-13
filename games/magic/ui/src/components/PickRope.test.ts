// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';

import { burnMs, ROPE_URGENT_MS } from '../draft/rope.ts';
import { PickRope } from './PackView.tsx';

interface Burn {
  duration: number;
  currentTime: number;
  cancelled: boolean;
  startedAt: number;
}

/** Every burn the fuse started, with the page clock it started at. */
let burns: Burn[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  burns = [];
  Element.prototype.animate = function (_frames: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
    const burn: Burn = { duration: Number((options as KeyframeAnimationOptions).duration), currentTime: 0, cancelled: false, startedAt: performance.now() };
    burns.push(burn);
    return {
      set currentTime(t: number) {
        burn.currentTime = t;
      },
      cancel: () => {
        burn.cancelled = true;
      },
    } as unknown as Animation;
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (Element.prototype as { animate?: unknown }).animate;
});

/** When the live burn reaches its end on the page's clock: where it started, minus how far in it was seeked, plus its length. */
function burnEnds(burn: Burn): number {
  return burn.startedAt - burn.currentTime + burn.duration;
}

const rope = () => screen.getByTestId('pick-rope');

describe('PickRope', () => {
  it('ends the burn at the server deadline the latest envelope gives, however late in the pick it arrived', () => {
    const timer = { totalMs: 30_000, msLeft: 30_000 };
    const { rerender } = render(createElement(PickRope, { timer, pickKey: '1:1' }));
    expect(burnEnds(burns.at(-1)!)).toBe(30_000);

    // 12 s on, another seat picks and a new envelope says 18 s are left: the same deadline.
    act(() => vi.advanceTimersByTime(12_000));
    rerender(createElement(PickRope, { timer: { totalMs: 30_000, msLeft: 18_000 }, pickKey: '1:1' }));
    const live = burns.filter((b) => !b.cancelled);
    expect(live).toHaveLength(1);
    expect(burnEnds(live[0]!)).toBe(30_000);
    expect(live[0]!.duration).toBe(burnMs({ endsAt: 0, totalMs: 30_000 }));
  });

  it('follows a later envelope that moves the deadline: the server, not the first envelope, is the clock', () => {
    const { rerender } = render(createElement(PickRope, { timer: { totalMs: 30_000, msLeft: 30_000 }, pickKey: '1:1' }));
    act(() => vi.advanceTimersByTime(5_000));
    // The first envelope was late by 2 s: the server now says 23 s, not 25.
    rerender(createElement(PickRope, { timer: { totalMs: 30_000, msLeft: 23_000 }, pickKey: '1:1' }));
    expect(burnEnds(burns.filter((b) => !b.cancelled)[0]!)).toBe(28_000);
    act(() => vi.advanceTimersByTime(22_999));
    expect(rope().dataset.state).toBe('urgent');
    act(() => vi.advanceTimersByTime(1));
    expect(rope().dataset.state).toBe('out');
  });

  it('walks waiting → burning → urgent → out on the deadline’s own clock', () => {
    render(createElement(PickRope, { timer: { totalMs: 30_000, msLeft: 30_000 }, pickKey: '1:1' }));
    expect(rope().dataset.state).toBe('waiting');
    act(() => vi.advanceTimersByTime(20_000));
    expect(rope().dataset.state).toBe('burning');
    act(() => vi.advanceTimersByTime(10_000 - ROPE_URGENT_MS));
    expect(rope().dataset.state).toBe('urgent');
    act(() => vi.advanceTimersByTime(ROPE_URGENT_MS));
    expect(rope().dataset.state).toBe('out');
  });

  it('a re-render with the same envelope re-anchors nothing', () => {
    const timer = { totalMs: 30_000, msLeft: 30_000 };
    const { rerender } = render(createElement(PickRope, { timer, pickKey: '1:1' }));
    act(() => vi.advanceTimersByTime(10_000));
    rerender(createElement(PickRope, { timer, pickKey: '1:1' }));
    expect(burns).toHaveLength(1);
    expect(burnEnds(burns[0]!)).toBe(30_000);
  });
});

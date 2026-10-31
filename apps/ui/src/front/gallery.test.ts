/*
 * The front cards' manual gallery (`./gallery.ts`): arrows and dots wrap, a swipe is a mostly
 * sideways drag past a threshold, and a page list that shrinks keeps the reader where they were.
 */
import { describe, expect, it } from 'vitest';

import { keepPage, stepPage, swipeStep, SWIPE_PX } from './gallery.ts';

describe('stepPage', () => {
  it('moves one page either way and wraps at both ends', () => {
    expect(stepPage(0, 1, 3)).toBe(1);
    expect(stepPage(2, 1, 3)).toBe(0);
    expect(stepPage(0, -1, 3)).toBe(2);
    expect(stepPage(1, -1, 3)).toBe(0);
  });
  it('stays at 0 with one page or none', () => {
    expect(stepPage(0, 1, 1)).toBe(0);
    expect(stepPage(0, -1, 0)).toBe(0);
  });
});

describe('swipeStep', () => {
  it('a drag left past the threshold is the next page, right the previous', () => {
    expect(swipeStep(-SWIPE_PX - 1, 4)).toBe(1);
    expect(swipeStep(SWIPE_PX + 1, -6)).toBe(-1);
  });
  it('a short drag, or one more vertical than sideways (scrolling the list), is no step', () => {
    expect(swipeStep(-SWIPE_PX + 1, 0)).toBe(0);
    expect(swipeStep(-SWIPE_PX - 10, SWIPE_PX + 20)).toBe(0);
  });
});

describe('keepPage', () => {
  it('follows the page the reader was on by key when the list changes around it', () => {
    expect(keepPage(['a', 'b', 'c'], 'c', 2)).toBe(2);
    expect(keepPage(['a', 'c'], 'c', 2)).toBe(1);
  });
  it('falls back to the default page when that page has gone', () => {
    expect(keepPage(['a', 'c'], 'b', 0)).toBe(0);
    expect(keepPage([], 'b', 0)).toBe(0);
  });
});

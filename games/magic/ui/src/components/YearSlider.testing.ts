/*
 * Test helpers for `YearSlider`, imported by the `*.test.ts` files that drive one and by nothing that
 * ships. jsdom lays nothing out, and a held pill follows the pointer through the line's box and its
 * own width, so `layOutYearSlider` gives a mounted slider the boxes a browser would and
 * `dragYearSlider` presses, moves and lets go as a pointer does. Both find the slider by its range's
 * role, never by its classes, which are `YearSlider`'s own.
 */

import { fireEvent, within } from '@testing-library/react';
import { onTestFinished, vi } from 'vitest';

export interface YearSliderBox {
  /** The line's left edge and width, in px. */
  left: number;
  width: number;
  /** The pill's width, in px. */
  pill: number;
}

/**
 * The mounted `slider` measures as `box` until the test ends. A slider measures two things: the
 * line its range lies over (an element holding the range) and the pill (one that holds none).
 */
export function layOutYearSlider(slider: HTMLElement, box: YearSliderBox): void {
  const range = within(slider).getByRole('slider');
  const rect = (left: number, width: number): DOMRect => ({ left, width, x: left, right: left + width, top: 0, y: 0, bottom: 48, height: 48, toJSON: () => ({}) }) as DOMRect;
  const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (!slider.contains(this)) return rect(0, 0);
    return this.contains(range) ? rect(box.left, box.width) : rect(0, box.pill);
  });
  onTestFinished(() => spy.mockRestore());
}

/** The x a pill's centre has at `fraction` (0 to 1) along a slider laid out as `box`. */
export function yearSliderX(box: YearSliderBox, fraction: number): number {
  return box.left + box.pill / 2 + fraction * (box.width - box.pill);
}

/** A press on `slider`'s line, where its range lies, at `x`; it reaches the line as a real press does. */
export function pressYearSlider(slider: HTMLElement, x: number, pointerId = 1): void {
  fireEvent.pointerDown(within(slider).getByRole('slider'), { pointerId, clientX: x });
}

/** A pointer pressed on `slider`'s line at the first x, moved through the rest, and let go at the last. */
export function dragYearSlider(slider: HTMLElement, xs: readonly number[], pointerId = 1): void {
  if (xs.length === 0) throw new Error('a drag goes somewhere');
  pressYearSlider(slider, xs[0]!, pointerId);
  for (const clientX of xs.slice(1)) fireEvent.pointerMove(window, { pointerId, clientX });
  fireEvent.pointerUp(window, { pointerId, clientX: xs.at(-1) });
}

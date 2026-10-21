/*
 * What every popover on a screen does the same way: where it stands inside the
 * box it may not leave, and when it goes away.
 */
import { useEffect } from 'react';

import { eventTarget } from './dom.ts';

/**
 * `at`, moved as little as needed for a span of `size` to stay `gap` inside
 * `lo`…`hi`; against the low edge when it cannot fit at all.
 */
export function clampSpan(at: number, size: number, lo: number, hi: number, gap: number): number {
  return Math.max(lo + gap, Math.min(at, hi - gap - size));
}

/**
 * Close on Escape, or on a press anywhere `keeps` does not claim — the popover
 * itself, and whatever opened it when its own click toggles it. Listened in
 * capture on the document, so a board gesture that stops propagation still
 * closes it, and read through `eventTarget`, so a press inside the embed's
 * shadow root is the element it landed on.
 */
export function useDismiss(onClose: () => void, keeps: (target: Node) => boolean): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    const onPress = (event: PointerEvent): void => {
      const target = eventTarget(event);
      if (target instanceof Node && !keeps(target)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPress, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPress, true);
    };
  }, [onClose, keeps]);
}

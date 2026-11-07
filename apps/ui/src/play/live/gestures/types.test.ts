import { describe, expect, it } from 'vitest';

import { clickLatch, DRAG_SLOP_PX, pastSlopAcross, pastSlopUpward } from './types.ts';

describe('pastSlopUpward — when a sideways-pannable touch press becomes a drag', () => {
  const press = { x: 100, y: 300 };

  it('straight up, past the slop: a drag', () => {
    expect(pastSlopUpward(press, { x: 100, y: 300 - DRAG_SLOP_PX })).toBe(true);
  });

  it('up but still inside the slop: not yet', () => {
    expect(pastSlopUpward(press, { x: 100, y: 300 - (DRAG_SLOP_PX - 1) })).toBe(false);
  });

  it('more up than sideways: a drag', () => {
    expect(pastSlopUpward(press, { x: 120, y: 270 })).toBe(true);
  });

  it('more sideways than up: the browser’s pan', () => {
    expect(pastSlopUpward(press, { x: 140, y: 280 })).toBe(false);
  });

  it('exactly diagonal: the browser’s pan — up must win outright', () => {
    expect(pastSlopUpward(press, { x: 120, y: 280 })).toBe(false);
  });

  it('straight sideways, either way: the browser’s pan', () => {
    expect(pastSlopUpward(press, { x: 200, y: 300 })).toBe(false);
    expect(pastSlopUpward(press, { x: 0, y: 300 })).toBe(false);
  });

  it('downward: never', () => {
    expect(pastSlopUpward(press, { x: 100, y: 400 })).toBe(false);
  });
});

describe('pastSlopAcross — when a lane card’s touch press becomes a drag', () => {
  const press = { x: 100, y: 300 };

  it('up or down past the slop: a drag', () => {
    expect(pastSlopAcross(press, { x: 100, y: 300 - DRAG_SLOP_PX })).toBe(true);
    expect(pastSlopAcross(press, { x: 100, y: 300 + DRAG_SLOP_PX })).toBe(true);
  });

  it('a diagonal toward a target off to the side: a drag', () => {
    expect(pastSlopAcross(press, { x: 130, y: 270 })).toBe(true);
  });

  it('more sideways than up or down: the lane’s pan', () => {
    expect(pastSlopAcross(press, { x: 140, y: 280 })).toBe(false);
  });

  it('inside the slop: not yet', () => {
    expect(pastSlopAcross(press, { x: 100, y: 300 - (DRAG_SLOP_PX - 1) })).toBe(false);
  });
});

describe('clickLatch — the click a drag leaves behind, swallowed once', () => {
  const click = (detail: number) => {
    const seen = { prevented: false, stopped: false };
    const event = { detail, preventDefault: () => void (seen.prevented = true), stopPropagation: () => void (seen.stopped = true) };
    return { event, seen };
  };

  it('swallows the pointer click that follows an armed press, and only that one', () => {
    const latch = clickLatch();
    latch.arm('arrange-drag');
    const first = click(1);
    expect(latch.swallow(first.event)).toBe('arrange-drag');
    expect(first.seen).toEqual({ prevented: true, stopped: true });
    expect(latch.swallow(click(1).event)).toBeNull();
  });

  /**
   * A drag that ends over another element leaves no click, so the latch stays armed until the next
   * press. A click with no pointer behind it (Enter or Space on a button, `element.click()`) is
   * `detail` 0 and never a drag's own: swallowing it ate the bar's Next Phase after a land was dragged
   * (watcher.spec, run 42411143950: the press was made, Forge never heard it).
   */
  it('lets a click with no pointer press behind it through, and stays armed for the drag’s own', () => {
    const latch = clickLatch();
    latch.arm('arrange-drag');
    const key = click(0);
    expect(latch.swallow(key.event)).toBeNull();
    expect(key.seen).toEqual({ prevented: false, stopped: false });
    expect(latch.swallow(click(1).event)).toBe('arrange-drag');
  });
});

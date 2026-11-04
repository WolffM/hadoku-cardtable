import { describe, expect, it } from 'vitest';

import { DRAG_SLOP_PX, pastSlopAcross, pastSlopUpward } from './types.ts';

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

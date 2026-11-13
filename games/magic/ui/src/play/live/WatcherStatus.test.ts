import { describe, expect, it } from 'vitest';

import { watchSpot, type Box } from './WatcherStatus.tsx';

const box = (left: number, top: number, w: number, h: number): Box => ({ left, top, right: left + w, bottom: top + h });

describe('watchSpot — the watching line between the two avatars (the operator, 2026-11-01)', () => {
  // 1920×1080, as drawn: the two 40px marks at x 31–71, the top seat's ending at 524, the bottom's starting at 556.
  const root = box(0, 0, 1920, 1080);
  const top = box(31, 484, 40, 40);
  const bottom = box(31, 556, 40, 40);

  it('is centred on the marks, halfway between them', () => {
    expect(watchSpot(root, top, bottom, 80)).toEqual({ x: 51, y: 540 });
  });

  it('is in the root’s own coordinates', () => {
    expect(watchSpot(box(100, 50, 1920, 1080), box(131, 534, 40, 40), box(131, 606, 40, 40), 80)).toEqual({ x: 51, y: 540 });
  });

  it('moves right only as far as keeps a wide line off the board’s left edge', () => {
    expect(watchSpot(root, top, bottom, 120)).toEqual({ x: 64, y: 540 });
  });

  it('is nowhere until both marks are drawn', () => {
    expect(watchSpot(root, null, bottom, 80)).toBeNull();
    expect(watchSpot(root, top, null, 80)).toBeNull();
  });
});

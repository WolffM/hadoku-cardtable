/*
 * A projectile's path (`projectile.ts`): a curve off the straight line, stable per hit, landing exactly
 * where it was aimed.
 */

import { describe, expect, it } from 'vitest';

import { along, arcControl, keyframes, seedOf } from './projectile.ts';

describe('projectile path', () => {
  const start = { x: 500, y: 300 };
  const end = { x: 200, y: 600 };

  it('starts at the source and lands exactly on the target', () => {
    const c = arcControl(start, end, 0.3);
    expect(along(start, c, end, 0)).toEqual(start);
    expect(along(start, c, end, 1)).toEqual(end);
  });

  it('bows off the straight line, to one side or the other by the seed', () => {
    const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    const left = along(start, arcControl(start, end, 0.2), end, 0.5);
    const right = along(start, arcControl(start, end, 0.8), end, 0.5);
    const off = (p: { x: number; y: number }) => Math.hypot(p.x - mid.x, p.y - mid.y);
    expect(off(left), 'well off the line').toBeGreaterThan(40);
    expect(off(right)).toBeGreaterThan(40);
    expect(Math.hypot(left.x - right.x, left.y - right.y), 'the two sides differ').toBeGreaterThan(80);
  });

  it('the same hit always draws the same arc; a sweeper’s hits draw different ones', () => {
    expect(seedOf('card:7:1')).toBe(seedOf('card:7:1'));
    const seeds = ['card:7:1', 'card:9:2', 'card:11:3', 'card:12:4'].map(seedOf);
    expect(new Set(seeds.map((s) => s.toFixed(3))).size).toBe(4);
    for (const s of seeds) expect(s >= 0 && s < 1).toBe(true);
  });
});

describe('keyframes', () => {
  it('a heavier bolt is bigger, never further: its size scales the ball after the move, so every bolt ends on the target’s centre', () => {
    const start = { x: 700, y: 120 };
    const end = { x: 138, y: 334 };
    const control = arcControl(start, end, 0.3);
    const last = (size: number): string => keyframes(start, control, end, size).at(-1)!.transform as string;
    for (const size of [0.8, 1.2, 1.6]) {
      expect(last(size), `size ${size}`).toMatch(/^translate\(138px, 334px\) translate\(-50%, -50%\) scale\(/);
    }
    expect(last(1.6)).toContain('scale(1.600)');
    expect(last(0.8)).toContain('scale(0.800)');
  });
});

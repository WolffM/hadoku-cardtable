/*
 * A projectile's path (`projectile.ts`): a sling off the straight line, stable per hit, landing exactly
 * where it was aimed, never carrying off the board.
 */

import { describe, expect, it } from 'vitest';

import { along, seedOf, slingFrames } from './projectile.ts';

/** A keyframe's own `translate(Xpx, Ypx)` point, parsed back out of its transform string. */
function pointOf(frame: Keyframe): { x: number; y: number } {
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(frame.transform as string);
  if (m === null) throw new Error(`no translate in ${String(frame.transform)}`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

describe('seedOf', () => {
  it('the same hit always draws the same arc; a sweeper’s hits draw different ones', () => {
    expect(seedOf('card:7:1')).toBe(seedOf('card:7:1'));
    const seeds = ['card:7:1', 'card:9:2', 'card:11:3', 'card:12:4'].map(seedOf);
    expect(new Set(seeds.map((s) => s.toFixed(3))).size).toBe(4);
    for (const s of seeds) expect(s >= 0 && s < 1).toBe(true);
  });

  it('spreads keys that differ only in their last character, instead of clustering (FNV-1a alone barely moves them)', () => {
    const seeds = Array.from({ length: 20 }, (_, i) => seedOf(`k:${i + 1}`));
    const range = Math.max(...seeds) - Math.min(...seeds);
    expect(range, 'the 20 seeds should spread across most of the unit interval').toBeGreaterThan(0.6);
    const distinctAtTwoDp = new Set(seeds.map((s) => s.toFixed(2))).size;
    expect(distinctAtTwoDp, 'at least 18 of the 20 should land in distinct hundredths').toBeGreaterThanOrEqual(18);
  });
});

describe('along', () => {
  it('a creature’s own ram arc (ram.ts) starts at the source and lands exactly on the target', () => {
    const start = { x: 500, y: 300 };
    const control = { x: 400, y: 100 };
    const end = { x: 200, y: 600 };
    expect(along(start, control, end, 0)).toEqual(start);
    expect(along(start, control, end, 1)).toEqual(end);
  });
});

describe('slingFrames', () => {
  const bounds = { w: 1000, h: 800 };

  it('starts exactly at the source and lands exactly on the target — a cubic Bezier’s own ends', () => {
    const start = { x: 700, y: 120 };
    const end = { x: 138, y: 334 };
    const frames = slingFrames(start, end, 0.5, 1, 'k', bounds);
    expect(pointOf(frames[0]!)).toEqual(start);
    expect(pointOf(frames.at(-1)!)).toEqual(end);
  });

  it('a heavier bolt is bigger, never further: its size scales the ball after the move, so every bolt ends on the target’s centre', () => {
    const start = { x: 700, y: 120 };
    const end = { x: 138, y: 334 };
    const last = (size: number): string => slingFrames(start, end, 0.5, size, 'k', bounds).at(-1)!.transform as string;
    for (const size of [0.8, 1.2, 1.6]) {
      expect(last(size), `size ${size}`).toMatch(/^translate\(138\.0px, 334\.0px\) translate\(-50%, -50%\) scale\(/);
    }
    expect(last(1.6)).toContain('scale(1.600)');
    expect(last(0.8)).toContain('scale(0.800)');
  });

  it('sets off AWAY from the target first — a heavier blow pulls back further — then swings in', () => {
    const start = { x: 200, y: 400 };
    const end = { x: 800, y: 400 };
    const distTo = (p: { x: number; y: number }, q: { x: number; y: number }): number => Math.hypot(p.x - q.x, p.y - q.y);
    const earlyPull = (power: number): number => {
      const frames = slingFrames(start, end, power, 1, 'k:same', bounds);
      // A little way in, before the swing-in takes over: how much further from the target it is than the start was.
      return distTo(pointOf(frames[2]!), end) - distTo(start, end);
    };
    expect(earlyPull(0.1), 'a light blow barely winds up').toBeGreaterThan(0);
    expect(earlyPull(1), 'a heavy blow pulls back further').toBeGreaterThan(earlyPull(0.1));
  });

  it('two different hits (seeded by key) fly two different arcs; the same key always flies the same one', () => {
    const start = { x: 200, y: 400 };
    const end = { x: 800, y: 400 };
    const mid = (key: string): { x: number; y: number } => pointOf(slingFrames(start, end, 0.6, 1, key, bounds)[8]!);
    const a = mid('player:1:101');
    const b = mid('player:1:102');
    expect(a, 'the same key is stable').toEqual(mid('player:1:101'));
    expect(Math.hypot(a.x - b.x, a.y - b.y), 'two different casts fly visibly different arcs').toBeGreaterThan(5);
  });

  it('every point of the flight stays inside the overlay, 16px in from every edge — for a hit starting or landing right at the clamp’s own boundary, at the heaviest pull', () => {
    const pad = 16;
    // Each anchor sits exactly on the clamp boundary: if the control points’ own clamp works, nothing
    // the curve passes through can go further out than that boundary, however hard the pull.
    const cases: { start: { x: number; y: number }; end: { x: number; y: number } }[] = [
      { start: { x: pad, y: pad }, end: { x: 400, y: 400 } },
      { start: { x: 1000 - pad, y: pad }, end: { x: 600, y: 400 } },
      { start: { x: pad, y: 800 - pad }, end: { x: 400, y: 400 } },
      { start: { x: 1000 - pad, y: 800 - pad }, end: { x: 600, y: 400 } },
      { start: { x: 500, y: 400 }, end: { x: pad, y: pad } },
      { start: { x: 500, y: 400 }, end: { x: 1000 - pad, y: 800 - pad } },
    ];
    for (const { start, end } of cases) {
      for (const key of ['k1', 'k2', 'k3']) {
        const frames = slingFrames(start, end, 1, 1, key, bounds);
        for (const frame of frames) {
          const p = pointOf(frame);
          expect(p.x, `${key} ${JSON.stringify({ start, end })} x`).toBeGreaterThanOrEqual(pad - 0.6);
          expect(p.x).toBeLessThanOrEqual(bounds.w - pad + 0.6);
          expect(p.y, `${key} ${JSON.stringify({ start, end })} y`).toBeGreaterThanOrEqual(pad - 0.6);
          expect(p.y).toBeLessThanOrEqual(bounds.h - pad + 0.6);
        }
      }
    }
  });
});

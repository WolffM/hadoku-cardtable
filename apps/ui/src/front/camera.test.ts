/*
 * `./camera.ts`: the default capture region, and the temporary ones the cursor opens by staying out.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_AFTER_MS, DEFAULT_REGION, initialCamera, stepCamera, TEMPORARY_AFTER_MS, temporaryRegion, type CameraState, type Point } from './camera.ts';

/** Steps every 16 ms from `state` for `ms`, the cursor at `cursor` throughout. */
function run(state: CameraState, ms: number, cursor: Point | null, bottom: number | null = 0): CameraState {
  let s = state;
  for (let t = 16; t <= ms; t += 16) s = stepCamera(s, state.now + t, cursor, bottom);
  return s;
}

const near = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;

const OUT: Point = { x: 1100, y: 120 }; // the far top-right: the other player's side
const HOME_CURSOR: Point = { x: 200, y: 700 }; // the active player's own hand

describe('the camera', () => {
  it('stays on the default region with no cursor at all — a recording made before cursors were kept', () => {
    const s = run(initialCamera(0, 0), 10_000, null);
    expect(s.region).toBe('default');
    expect(s.at).toEqual(DEFAULT_REGION);
  });

  it('a stroke out and back inside the dwell moves nothing', () => {
    let s = run(initialCamera(0, 0), TEMPORARY_AFTER_MS - 100, OUT);
    s = run(s, 2000, HOME_CURSOR);
    expect(s.region).toBe('default');
    expect(s.at).toEqual(DEFAULT_REGION);
  });

  it('a cursor parked outside opens a temporary region centred on it, kept on the board, reached by a glide', () => {
    let s = run(initialCamera(0, 0), TEMPORARY_AFTER_MS + 32, OUT);
    expect(s.region).toBe('temporary');
    expect(s.at.x, 'the camera has only just set off').toBeLessThan(100);
    const halfway = run(s, 200, OUT);
    expect(halfway.at.x, 'gliding, not jumped').toBeGreaterThan(0);
    expect(halfway.at.x).toBeLessThan(temporaryRegion(OUT).x - 50);
    s = run(halfway, 2000, OUT);
    expect(temporaryRegion(OUT)).toEqual({ x: 740, y: 0 });
    expect(near(s.at, { x: 740, y: 0 }), 'centred on the cursor, clamped to the board').toBe(true);
  });

  it('the temporary region follows the cursor while it stays out', () => {
    let s = run(initialCamera(0, 0), TEMPORARY_AFTER_MS + 2000, OUT);
    const elsewhere = { x: 640, y: 300 };
    s = run(s, 2000, elsewhere);
    expect(s.region).toBe('temporary');
    expect(near(s.at, temporaryRegion(elsewhere))).toBe(true);
  });

  it('retires to the default region once the cursor has been back inside long enough — not on a pass through', () => {
    let s = run(initialCamera(0, 0), TEMPORARY_AFTER_MS + 2000, OUT);
    s = run(s, DEFAULT_AFTER_MS - 100, HOME_CURSOR);
    s = run(s, 300, OUT);
    expect(s.region, 'a pass through the default region is not a return').toBe('temporary');
    s = run(s, DEFAULT_AFTER_MS + 2000, HOME_CURSOR);
    expect(s.region).toBe('default');
    expect(near(s.at, DEFAULT_REGION)).toBe(true);
  });

  it('a cursor that is gone (the pointer left, or went stale) counts as back: the temporary region retires', () => {
    let s = run(initialCamera(0, 0), TEMPORARY_AFTER_MS + 2000, OUT);
    s = run(s, DEFAULT_AFTER_MS + 2000, null);
    expect(s.region).toBe('default');
  });

  it('a turn change starts the new active player on their default region at once — no glide across the flip', () => {
    let s = run(initialCamera(0, 0), TEMPORARY_AFTER_MS + 2000, OUT, 0);
    expect(s.region).toBe('temporary');
    s = stepCamera(s, s.now + 16, OUT, 1);
    expect(s.region).toBe('default');
    expect(s.at).toEqual(DEFAULT_REGION);
  });
});

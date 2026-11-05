/*
 * `./camera.ts`: the default capture region, and the temporary ones the cursor opens by staying out.
 */

import { describe, expect, it } from 'vitest';

import {
  BOARD_HEIGHT,
  DEFAULT_AFTER_MS,
  DEFAULT_REGION,
  GLIDE_TAU_MS,
  inDefaultRegion,
  initialCamera,
  stepCamera,
  TEMPORARY_AFTER_MS,
  temporaryRegion,
  type CameraState,
  type Point,
} from './camera.ts';

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
    s = run(halfway, 3000, OUT);
    expect(temporaryRegion(OUT)).toEqual({ x: 740, y: 0 });
    expect(near(s.at, { x: 740, y: 0 }), 'centred on the cursor, clamped to the board').toBe(true);
  });

  it('the temporary region follows the cursor while it stays out', () => {
    let s = run(initialCamera(0, 0), TEMPORARY_AFTER_MS + 2000, OUT);
    const elsewhere = { x: 640, y: 300 };
    s = run(s, 3000, elsewhere);
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

  it('opens a temporary region 900 ms after the cursor leaves — 40% sooner than the 1500 it was', () => {
    expect(TEMPORARY_AFTER_MS).toBe(900);
    expect(run(initialCamera(0, 0), 880, OUT).region).toBe('default');
    expect(run(initialCamera(0, 0), 940, OUT).region).toBe('temporary');
  });

  it('the outer 20% of the default region counts as outside: home is the 432 px square nearest the corner', () => {
    const top = BOARD_HEIGHT - 432; // 368
    expect(inDefaultRegion({ x: 431, y: 700 }), 'just inside the band, on the right').toBe(true);
    expect(inDefaultRegion({ x: 432, y: 700 }), 'on the band, on the right').toBe(false);
    expect(inDefaultRegion({ x: 539, y: 700 }), 'inside the shown square, in its band').toBe(false);
    expect(inDefaultRegion({ x: 100, y: top + 1 }), 'just inside the band, at the top').toBe(true);
    expect(inDefaultRegion({ x: 100, y: top }), 'on the band, at the top').toBe(false);
    expect(inDefaultRegion({ x: 100, y: 300 }), 'inside the shown square, in its band').toBe(false);
    expect(inDefaultRegion({ x: 0, y: BOARD_HEIGHT }), 'the corner itself').toBe(true);
  });

  it('a cursor parked in the band opens a temporary region, and stays out: the band is never a return', () => {
    const band: Point = { x: 480, y: 600 };
    let s = run(initialCamera(0, 0), TEMPORARY_AFTER_MS + 32, band);
    expect(s.region).toBe('temporary');
    s = run(s, DEFAULT_AFTER_MS + 2000, band);
    expect(s.region).toBe('temporary');
    expect(near(s.at, temporaryRegion(band))).toBe(true);
  });

  it('glides 30% slower than before: 357 ms to cover 63% of the way (1 − 1/e), the view still shown whole', () => {
    expect(GLIDE_TAU_MS).toBe(357);
    expect(GLIDE_TAU_MS / 250, 'the old pan at 0.7× its speed').toBeCloseTo(1 / 0.7, 2);
    let s = run(initialCamera(0, 0), TEMPORARY_AFTER_MS + 48, OUT);
    expect(s.region).toBe('temporary');
    const from = s.at;
    const to = temporaryRegion(OUT);
    s = stepCamera(s, s.now + GLIDE_TAU_MS, OUT, 0);
    expect((s.at.x - from.x) / (to.x - from.x)).toBeCloseTo(1 - Math.exp(-1), 5);
  });
});

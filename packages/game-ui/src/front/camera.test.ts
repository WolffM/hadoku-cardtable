/*
 * `./camera.ts`: the default capture region, and the temporary ones the cursor opens by staying out.
 */

import { describe, expect, it } from 'vitest';

import {
  BOARD_HEIGHT,
  CAMERA,
  cameraConfigFromHash,
  defaultRegion,
  inDefaultRegion,
  initialCamera,
  panStep,
  stepCamera,
  temporaryRegion,
  type CameraState,
  type Point,
} from './camera.ts';

const TEMPORARY_AFTER_MS = CAMERA.temporaryAfterMs;
const DEFAULT_AFTER_MS = CAMERA.defaultAfterMs;
const PAN_SETTLE_MS = CAMERA.panSettleMs;
const DEFAULT_REGION = defaultRegion();

/** Steps every 16 ms from `state` for `ms`, the cursor at `cursor` throughout. */
function run(state: CameraState, ms: number, cursor: Point | null, bottom: number | null = 0): CameraState {
  let s = state;
  for (let t = 16; t <= ms; t += 16) s = stepCamera(s, state.now + t, cursor, bottom);
  return s;
}

const near_ = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;

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
    expect(near_(s.at, { x: 740, y: 0 }), 'centred on the cursor, clamped to the board').toBe(true);
  });

  it('the temporary region follows the cursor while it stays out', () => {
    let s = run(initialCamera(0, 0), TEMPORARY_AFTER_MS + 2000, OUT);
    const elsewhere = { x: 640, y: 300 };
    s = run(s, 3000, elsewhere);
    expect(s.region).toBe('temporary');
    expect(near_(s.at, temporaryRegion(elsewhere))).toBe(true);
  });

  it('retires to the default region once the cursor has been back inside long enough — not on a pass through', () => {
    let s = run(initialCamera(0, 0), TEMPORARY_AFTER_MS + 2000, OUT);
    s = run(s, DEFAULT_AFTER_MS - 100, HOME_CURSOR);
    s = run(s, 300, OUT);
    expect(s.region, 'a pass through the default region is not a return').toBe('temporary');
    s = run(s, DEFAULT_AFTER_MS + 2000, HOME_CURSOR);
    expect(s.region).toBe('default');
    expect(near_(s.at, DEFAULT_REGION)).toBe(true);
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

  it('opens a temporary region 500 ms after the cursor leaves', () => {
    expect(TEMPORARY_AFTER_MS).toBe(500);
    expect(run(initialCamera(0, 0), 496, OUT).region).toBe('default');
    expect(run(initialCamera(0, 0), 540, OUT).region).toBe('temporary');
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
    expect(near_(s.at, temporaryRegion(band))).toBe(true);
  });

  /** Every frame of a pan of `ms` toward a cursor at `cursor`, from the moment the temporary region opens. */
  function pan(cursor: Point, ms: number): CameraState[] {
    let s = run(initialCamera(0, 0), TEMPORARY_AFTER_MS + 32, cursor);
    expect(s.region).toBe('temporary');
    const frames = [s];
    for (let t = 16; t <= ms; t += 16) frames.push((s = stepCamera(s, s.now + 16, cursor, 0)));
    return frames;
  }
  const peakAccel = (frames: CameraState[]): number =>
    Math.max(...frames.slice(1).map((f, i) => Math.hypot(f.vel.x - frames[i]!.vel.x, f.vel.y - frames[i]!.vel.y) / 16));

  it('a pan starts from rest: its first frame covers next to nothing, where the old glide took 6% of the way at once', () => {
    const [first, second] = pan(OUT, 16);
    const to = temporaryRegion(OUT);
    expect(Math.abs(first!.at.x - DEFAULT_REGION.x) / (to.x - DEFAULT_REGION.x), 'the frame the region opened').toBeLessThan(0.005);
    expect((second!.at.x - first!.at.x) / (to.x - DEFAULT_REGION.x)).toBeLessThan(0.01);
  });

  it('a far target pulls harder than a near one, and neither is passed', () => {
    const far: Point = { x: 1180, y: 100 }; // the other player's far corner
    const near: Point = { x: 500, y: 560 }; // just out of the inner square
    const farPan = pan(far, 3000);
    const nearPan = pan(near, 3000);
    expect(peakAccel(farPan), 'a long move accelerates harder').toBeGreaterThan(peakAccel(nearPan) * 2);
    for (const [cursor, frames] of [[far, farPan], [near, nearPan]] as const) {
      const to = temporaryRegion(cursor);
      for (const axis of ['x', 'y'] as const) {
        const from = DEFAULT_REGION[axis];
        const past = frames.filter((f) => (to[axis] - f.at[axis]) * Math.sign(to[axis] - from) < -1e-6);
        expect(past, `never past the region on ${axis}`).toEqual([]);
      }
      expect(near_(frames.at(-1)!.at, to), 'and it gets there').toBe(true);
    }
  });

  it('a corner-to-centre move covers 95% in PAN_SETTLE_MS, 1.3× the old glide’s 750 ms', () => {
    expect(PAN_SETTLE_MS).toBe(975);
    const centre: Point = { x: 640, y: 400 };
    const to = temporaryRegion(centre);
    const frames = pan(centre, 1500);
    const covered = (f: CameraState): number => Math.hypot(f.at.x - DEFAULT_REGION.x, f.at.y - DEFAULT_REGION.y) / Math.hypot(to.x - DEFAULT_REGION.x, to.y - DEFAULT_REGION.y);
    const at95 = frames.findIndex((f) => covered(f) >= 0.95) * 16;
    expect(at95).toBeGreaterThan(PAN_SETTLE_MS - 40);
    expect(at95).toBeLessThan(PAN_SETTLE_MS + 40);
  });

  it('a cursor that keeps going is followed smoothly: the pan keeps its speed when the target moves', () => {
    const frames = pan(OUT, 300);
    const moving = frames.at(-1)!;
    const next = stepCamera(moving, moving.now + 16, { x: 900, y: 300 }, 0);
    const before = Math.hypot(moving.vel.x, moving.vel.y);
    expect(before, 'mid-pan').toBeGreaterThan(0.1);
    expect(Math.abs(Math.hypot(next.vel.x, next.vel.y) - before) / before, 'no restart from rest').toBeLessThan(0.2);
  });

  it('panStep is exact: one long step lands where many short ones do', () => {
    let a = { pos: 0, vel: 0 };
    for (let t = 0; t < 400; t += 4) a = panStep(a.pos, a.vel, 500, 4);
    const b = panStep(0, 0, 500, 400);
    expect(b.pos).toBeCloseTo(a.pos, 6);
    expect(b.vel).toBeCloseTo(a.vel, 9);
  });
});

describe("the camera's hash overrides", () => {
  it('no cam= in the hash is the defaults, untouched', () => {
    expect(cameraConfigFromHash('')).toEqual(CAMERA);
    expect(cameraConfigFromHash('#/')).toEqual(CAMERA);
    expect(cameraConfigFromHash('#/replay/m-1')).toEqual(CAMERA);
  });

  it('reads every key, in any order, whether the hash is #cam= or #/?cam=', () => {
    const want = { temporaryAfterMs: 400, defaultAfterMs: 800, edgeBand: 0.25, panSettleMs: 900, corner: 600 };
    expect(cameraConfigFromHash('#cam=after:400,back:800,band:0.25,t95:900,corner:600')).toEqual(want);
    expect(cameraConfigFromHash('#/?cam=corner:600,t95:900,band:0.25,back:800,after:400')).toEqual(want);
    expect(cameraConfigFromHash('#cam=after%3A400%2Cband%3A0.25')).toEqual({ ...CAMERA, temporaryAfterMs: 400, edgeBand: 0.25 });
  });

  it('a subset overrides only what it names', () => {
    expect(cameraConfigFromHash('#cam=t95:1200')).toEqual({ ...CAMERA, panSettleMs: 1200 });
  });

  it('clamps each value to its range', () => {
    expect(cameraConfigFromHash('#cam=after:-5,back:99999,band:0.9,t95:1,corner:2000')).toEqual({
      temporaryAfterMs: 0,
      defaultAfterMs: 10_000,
      edgeBand: 0.45,
      panSettleMs: 50,
      corner: BOARD_HEIGHT,
    });
    expect(cameraConfigFromHash('#cam=corner:10').corner).toBe(300);
  });

  it('ignores unknown keys, values that are not numbers, and stray commas', () => {
    expect(cameraConfigFromHash('#cam=zoom:3,after:abc,band:,,t95, after:300')).toEqual({ ...CAMERA, temporaryAfterMs: 300 });
  });

  it('the overrides reach the camera: a shorter after opens the temporary region sooner, a wider band counts more as out', () => {
    const quick = cameraConfigFromHash('#cam=after:100');
    let s = initialCamera(0, 0, quick);
    for (let t = 16; t <= 128; t += 16) s = stepCamera(s, t, OUT, 0, quick);
    expect(s.region).toBe('temporary');
    expect(inDefaultRegion({ x: 300, y: 700 }, cameraConfigFromHash('#cam=band:0.45'))).toBe(false);
    expect(inDefaultRegion({ x: 300, y: 700 })).toBe(true);
  });

  it('a different corner moves the default region and sizes the temporary one', () => {
    const wide = cameraConfigFromHash('#cam=corner:700');
    expect(defaultRegion(wide)).toEqual({ x: 0, y: 100 });
    expect(temporaryRegion({ x: 1200, y: 50 }, wide)).toEqual({ x: 580, y: 0 });
  });

  it("a longer t95 settles slower: the spring's stiffness follows it", () => {
    const at = (settleMs: number): number => panStep(0, 0, 100, 500, settleMs).pos;
    expect(at(1950)).toBeLessThan(at(975));
  });
});

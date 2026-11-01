/**
 * The rig's timing, through the real ffmpeg: a still screen holds its picture until the next frame
 * arrives, and a missed frame is still blended.
 *
 *   node --test e2e/promo/frame-list.test.ts
 *
 * Cut 4's constructed clip: a deck's list opened, the screen stood still 2.5 s, the list closed. The
 * screencast sent nothing in between, and the film faded the list out over all 2.5 s, a linear ramp
 * from the last frame with it to the first without, while the pointer still rested on its deck.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { FILM_FILTER, FPS, frameList } from './frame-list.ts';

const dir = mkdtempSync(join(tmpdir(), 'promo-frame-list-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Films frames whose corner patch is each of `greys` on a mid-grey screen, arriving at `arrivals` ms, and
 * returns the patch's grey in each 60 fps frame. A patch, not the whole frame: minterpolate takes a
 * whole-frame change for a scene cut and blends nothing, while a list closing over a grid is a small change.
 */
function film(greys: readonly number[], arrivals: readonly number[], end: number): number[] {
  greys.forEach((g, i) => {
    const hex = g.toString(16).padStart(2, '0').repeat(3);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x646464:s=64x64', '-vf', `drawbox=x=0:y=0:w=16:h=16:c=0x${hex}:t=fill`, '-frames:v', '1', join(dir, `${String(i + 1).padStart(6, '0')}.jpg`)]);
  });
  writeFileSync(join(dir, 'list.txt'), frameList(arrivals, arrivals[0]!, end));
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-vf', `${FILM_FILTER},crop=16:16:0:0,scale=1:1:flags=area,format=gray`, '-t', (end / 1000).toFixed(3), '-f', 'rawvideo', '-']);
  return [...raw];
}

const near = (got: number, want: number): boolean => Math.abs(got - want) <= 4;
const at = (ms: number): number => Math.round((ms / 1000) * FPS);

/** A still screen of `still` ms between two frames: every frame of it is the first picture, and the change lands on the second's arrival. */
function holds(still: number): void {
  const frames = film([40, 200], [0, still], still + 500);
  for (const ms of [still / 4, still / 2, still - 50]) {
    const got = frames[at(ms)]!;
    assert.ok(near(got, 40), `${Math.round(ms)} ms into a ${still} ms still: ${got} is not the still picture 40`);
  }
  assert.ok(near(frames[at(still + 100)]!, 200), `after the change: ${frames[at(still + 100)]}`);
}

// Cut 4's three reports, each at the still it was filmed with (the clips' frames.json):
test('a hovered deck list stays solid while the pointer rests (constructed, 16.502 to 18.989 s)', () => holds(2487));
test('a Gauntlet pick does not fade in before it is made (gauntlet, 15.701 to 17.871 s)', () => holds(2170));
test('a face turned by the wheel snaps over (draft, a 1.3 s rest between notches)', () => holds(1300));

test('a missed frame is blended from its two neighbours', () => {
  // Frames every 1/60 s, then one missing: the one in the hole is part of each, not a repeat of either.
  const step = 1000 / FPS;
  const frames = film([40, 200], [0, 2 * step], 10 * step);
  assert.ok(frames[1]! > 60 && frames[1]! < 180, `the missed frame is ${frames[1]}, not a blend of 40 and 200`);
});

test('the last frame holds to the clip end', () => {
  const frames = film([40, 200], [0, 100], 2000);
  assert.ok(frames.length >= at(2000) - 1, `the film ends at frame ${frames.length}`);
  assert.ok(near(frames.at(-1)!, 200));
});

// @vitest-environment jsdom
/*
 * `everyFrame`: every loop's read before any loop's write, on one requestAnimationFrame — the guard on
 * the cut 3 capture's per-frame forced layouts (eleven trails and stand-ins each reading after the one
 * before it wrote).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { everyFrame } from './frame-phases.ts';

/** A requestAnimationFrame the test steps by hand: `tick()` runs the frame's callbacks. */
function frames(): { tick: () => void; queued: () => number } {
  let queue: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => queue.push(cb));
  return {
    tick: () => {
      const run = queue;
      queue = [];
      for (const cb of run) cb(performance.now());
    },
    queued: () => queue.length,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('everyFrame', () => {
  it('runs every loop’s read, then every loop’s write, on one frame request', () => {
    const f = frames();
    const log: string[] = [];
    const loop = (name: string) => () => {
      log.push(`read ${name}`);
      return () => log.push(`write ${name}`);
    };
    const stops = ['a', 'b', 'c'].map((n) => everyFrame(loop(n)));
    expect(f.queued(), 'one request for every loop').toBe(1);
    f.tick();
    expect(log).toEqual(['read a', 'read b', 'read c', 'write a', 'write b', 'write c']);
    log.length = 0;
    f.tick();
    expect(log, 'and again the next frame').toEqual(['read a', 'read b', 'read c', 'write a', 'write b', 'write c']);
    for (const stop of stops) stop();
    f.tick();
    expect(f.queued(), 'nothing asks for a frame once every loop is over').toBe(0);
  });

  it('a read returning null ends that loop alone', () => {
    const f = frames();
    let n = 0;
    const log: string[] = [];
    everyFrame(() => (++n > 2 ? null : () => log.push(`short ${n}`)));
    const stop = everyFrame(() => () => log.push('long'));
    f.tick();
    f.tick();
    f.tick();
    expect(log).toEqual(['short 1', 'long', 'short 2', 'long', 'long']);
    stop();
    f.tick();
    expect(f.queued()).toBe(0);
  });

  it('a loop that throws ends itself and is rethrown once the others have run', () => {
    const f = frames();
    const log: string[] = [];
    everyFrame(() => {
      throw new Error('boom');
    });
    const stop = everyFrame(() => () => log.push('still drawn'));
    expect(() => f.tick()).toThrow('boom');
    expect(log).toEqual(['still drawn']);
    f.tick();
    expect(log).toEqual(['still drawn', 'still drawn']);
    stop();
    f.tick();
  });
});

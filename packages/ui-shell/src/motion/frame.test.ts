// @vitest-environment jsdom
/*
 * `everyFrame`: every loop's read before any loop's write, on one requestAnimationFrame — the guard on
 * the cut 3 capture's per-frame forced layouts (eleven trails and stand-ins each reading after the one
 * before it wrote).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { everyFrame, resetFrames } from './frame.ts';

/** A requestAnimationFrame the test steps by hand: `tick()` runs the frame's callbacks. */
function frames(): { tick: (at?: number) => void; queued: () => number } {
  let queue: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => queue.push(cb));
  return {
    tick: (at = performance.now()) => {
      const run = queue;
      queue = [];
      for (const cb of run) cb(at);
    },
    queued: () => queue.length,
  };
}

afterEach(() => {
  resetFrames();
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

  it('a loop added from inside a write leaves one frame request, so every loop still runs once a frame', () => {
    const f = frames();
    let reads = 0;
    const stopLong = everyFrame(() => {
      reads++;
      return () => {
        const stop = everyFrame(() => () => stop());
      };
    });
    f.tick();
    expect(f.queued(), 'one request after a write added a loop').toBe(1);
    reads = 0;
    for (let i = 0; i < 4; i++) {
      f.tick();
      expect(f.queued(), `one request after frame ${i + 1}`).toBe(1);
    }
    expect(reads, 'the long loop read once a frame').toBe(4);
    stopLong();
    f.tick();
    f.tick();
    expect(f.queued()).toBe(0);
  });

  it('hands every step the frame’s start time', () => {
    const f = frames();
    const seen: number[] = [];
    const stop = everyFrame((now) => (seen.push(now), () => undefined));
    f.tick(1000);
    f.tick(1016.5);
    expect(seen).toEqual([1000, 1016.5]);
    stop();
  });

  it('resetFrames forgets a frame owed to a clock that is gone, so the next loop asks again', () => {
    let owed = 0;
    vi.stubGlobal('requestAnimationFrame', () => ++owed);
    everyFrame(() => () => undefined);
    expect(owed).toBe(1);
    // The frame never comes (fake timers restored): without the reset, no loop would ask for one again.
    resetFrames();
    const f = frames();
    const log: string[] = [];
    everyFrame(() => () => log.push('drawn'));
    f.tick();
    expect(log).toEqual(['drawn']);
  });
});

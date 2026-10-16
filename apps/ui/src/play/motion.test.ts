// @vitest-environment jsdom
/*
 * `afterGlide`: a stand-in's glide ends when its own `left`/`top` transitions have finished, not
 * when a clock started at the style change says so.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { afterGlide, GLIDE_MS } from './motion.ts';

afterEach(() => {
  vi.useRealTimers();
});

/** A transition the test finishes (or cancels) by hand. */
function transition(property: string): { anim: Animation; end: () => void; cancel: () => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const finished = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const anim = { transitionProperty: property, finished } as unknown as Animation;
  return { anim, end: resolve, cancel: () => reject(new Error('cancelled')) };
}

/** Every microtask queued so far, and those they queue: a settled transition's `finished`, and `afterGlide`'s look after it. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('afterGlide', () => {
  it('waits for the glide’s running left/top transitions, however long past GLIDE_MS they run', async () => {
    const el = document.createElement('div');
    const left = transition('left');
    const top = transition('top');
    let running = [left.anim, top.anim, transition('opacity').anim];
    el.getAnimations = () => running;
    const done = vi.fn();
    afterGlide(el, done);
    await settle();
    left.end();
    await settle();
    expect(done, 'one of two still running').not.toHaveBeenCalled();
    running = [];
    top.end();
    await settle();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('a cancelled transition is looked at again: a retargeted glide is waited for in turn', async () => {
    const el = document.createElement('div');
    const first = transition('left');
    const second = transition('left');
    let running = [first.anim];
    el.getAnimations = () => running;
    const done = vi.fn();
    afterGlide(el, done);
    await settle();
    running = [second.anim];
    first.cancel();
    await settle();
    expect(done, 'the new glide still runs').not.toHaveBeenCalled();
    running = [];
    second.end();
    await settle();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('nothing running is done on the next microtask; a cancel stops it', async () => {
    const el = document.createElement('div');
    el.getAnimations = () => [];
    const done = vi.fn();
    afterGlide(el, done);
    expect(done, 'never synchronously').not.toHaveBeenCalled();
    await settle();
    expect(done).toHaveBeenCalledTimes(1);
    const cancelled = vi.fn();
    afterGlide(el, cancelled)();
    await settle();
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('a document that cannot list its animations falls back to GLIDE_MS', () => {
    vi.useFakeTimers();
    const el = document.createElement('div');
    Object.defineProperty(el, 'getAnimations', { value: undefined });
    const done = vi.fn();
    afterGlide(el, done);
    vi.advanceTimersByTime(GLIDE_MS - 1);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom
/*
 * `afterGlide`: a stand-in's glide ends when its own `left`/`top` transitions have finished, not
 * when a clock started at the style change says so. The board's stillness, likewise, is what it is
 * drawing having finished — its beats, then its animations — never a clock.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { afterGlide, animationsSettled, BEAT_ANIMATION_ID, boardWaitingOn, damagePower, GLIDE_MS, MAX_DAMAGE, noteBoardDrawing, powerSize, whenBoardStill } from './motion.ts';

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

/** An animation the test finishes by hand, with how long its timing says it runs. */
function running(endTime: number, name: { id?: string; animationName?: string; transitionProperty?: string } = { id: BEAT_ANIMATION_ID }): { anim: Animation; end: () => void } {
  let resolve!: () => void;
  const finished = new Promise<void>((res) => (resolve = res));
  const anim = { playState: 'running', finished, effect: { getComputedTiming: () => ({ endTime }) }, id: '', ...name } as unknown as Animation;
  const end = (): void => {
    (anim as { playState: string }).playState = 'finished';
    resolve();
  };
  return { anim, end };
}

describe('the board’s stillness', () => {
  it('whenBoardStill waits for every view drawing, and is at once when nothing is', async () => {
    let first!: () => void;
    let second!: () => void;
    noteBoardDrawing(new Promise<void>((res) => (first = res)));
    noteBoardDrawing(new Promise<void>((res) => (second = res)));
    let still = 0;
    whenBoardStill(() => (still += 1));
    first();
    await settle();
    expect(still, 'one drawing still playing').toBe(0);
    second();
    await settle();
    expect(still).toBe(1);
    whenBoardStill(() => (still += 1));
    expect(still, 'still: at once').toBe(2);
  });

  it('a cancelled wait never runs', async () => {
    let done!: () => void;
    noteBoardDrawing(new Promise<void>((res) => (done = res)));
    let ran = false;
    const cancel = whenBoardStill(() => (ran = true));
    cancel();
    done();
    await settle();
    expect(ran).toBe(false);
  });

  it('animationsSettled waits for the finite animations on the board, looking again for any that start meanwhile, and not for an endless one', async () => {
    const ram = running(1200);
    const pulse = running(Infinity);
    const crash = running(400);
    let anims = [ram.anim, pulse.anim];
    const root = { getAnimations: () => anims } as unknown as Element;
    let settled = false;
    void animationsSettled(root).then(() => (settled = true));
    await settle();
    expect(settled).toBe(false);
    anims = [ram.anim, pulse.anim, crash.anim];
    ram.end();
    await settle();
    expect(settled, 'a crash started while the ram ran').toBe(false);
    crash.end();
    await settle();
    expect(settled).toBe(true);
  });

  it('animationsSettled waits for the beats only: a turn banner, a stack settling or a glide under the board holds nothing', async () => {
    const ram = running(1200);
    const rise = running(900, { animationName: 'board-number-rise' });
    const banner = running(2400, { animationName: 'turn-cue' });
    const glide = running(300, { transitionProperty: 'left' });
    let anims = [ram.anim, rise.anim, banner.anim, glide.anim];
    const root = { getAnimations: () => anims } as unknown as Element;
    let settled = false;
    void animationsSettled(root).then(() => (settled = true));
    await settle();
    expect(boardWaitingOn(), 'what the board waits on, by name').toBe('beat×1 board-number-rise×1');
    ram.end();
    anims = [rise.anim, banner.anim, glide.anim];
    await settle();
    expect(settled, 'the number still rises').toBe(false);
    rise.end();
    anims = [banner.anim, glide.anim];
    await settle();
    expect(settled, 'the banner and the glide are not beats').toBe(true);
    expect(boardWaitingOn()).toBe('');
  });
});

describe('how heavy a hit is', () => {
  // The operator, 2026-10-17 (ledger AF149): "we should escalate the effects a bit faster then. our
  // escalation is too linear" — full weight at ten, the p99 creature power across every loaded deck,
  // where it used to take twenty.
  it('a point is the lightest, a ten and anything above the heaviest, and the middle climbs fast', () => {
    expect(MAX_DAMAGE).toBe(10);
    expect(damagePower(1)).toBe(0);
    expect(damagePower(2)).toBeCloseTo(1 / 3, 5);
    expect(damagePower(5)).toBeCloseTo(2 / 3, 5);
    expect(damagePower(10)).toBe(1);
    expect(damagePower(20)).toBe(1);
    expect(damagePower(0)).toBe(0);
  });
  it('an effect is four fifths for a point and about one and a half at five', () => {
    expect(powerSize(damagePower(1))).toBeCloseTo(0.8, 5);
    expect(powerSize(damagePower(5))).toBeCloseTo(1.533, 2);
    expect(powerSize(damagePower(10))).toBeCloseTo(1.9, 5);
  });
});

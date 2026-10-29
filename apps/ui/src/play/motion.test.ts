// @vitest-environment jsdom
/*
 * `afterGlide`: a stand-in's glide ends when its own `left`/`top` transitions have finished, not
 * when a clock started at the style change says so. The board's stillness, likewise, is what it is
 * drawing having finished — its beats, then its animations — never a clock.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { afterGlide, animationsSettled, BEAT_ANIMATION_ID, boardWaitingOn, damagePower, damageSize, GLIDE_MS, MAX_DAMAGE, noteBoardDrawing, powerSize, UNLOCK_AT, unlockAfter, whenBoardStill, whenBoardUnlocked } from './motion.ts';

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

describe('unlocking on the last tenth of a beat (the operator, 2026-10-28)', () => {
  /** A beat on the page's clock: `currentTime` follows the fake timers from `startedAt`, at `rate`. */
  function playing(endTime: number, rate = 1): Animation {
    const startedAt = Date.now();
    const anim = {
      id: BEAT_ANIMATION_ID,
      playbackRate: rate,
      effect: { getComputedTiming: () => ({ endTime }) },
      finished: new Promise<void>(() => undefined),
      get currentTime() {
        return Math.min(endTime, (Date.now() - startedAt) * rate);
      },
      get playState() {
        return (Date.now() - startedAt) * rate >= endTime ? 'finished' : 'running';
      },
    };
    return anim as unknown as Animation;
  }

  it('UNLOCK_AT is 90%, and a timed beat lets go that far through', () => {
    expect(UNLOCK_AT).toBe(0.9);
    expect(unlockAfter(1000)).toBe(900);
    expect(unlockAfter(600), 'an attack beat').toBe(540);
  });

  it('animationsSettled at UNLOCK_AT settles once the beat is 90% through, while it still plays', async () => {
    vi.useFakeTimers();
    const ram = playing(1000);
    const root = { getAnimations: () => [ram] } as unknown as Element;
    let settled = false;
    void animationsSettled(root, UNLOCK_AT).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(899);
    expect(settled, 'at 89.9%').toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled, 'at 90%').toBe(true);
    expect(ram.playState, 'the beat itself plays on to its end').toBe('running');
  });

  it('respects the beat’s playback rate', async () => {
    vi.useFakeTimers();
    const fast = playing(1000, 2);
    const root = { getAnimations: () => [fast] } as unknown as Element;
    let settled = false;
    void animationsSettled(root, UNLOCK_AT).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(449);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled, 'twice as fast: 90% at 450 ms').toBe(true);
  });

  it('waits for the latest 90% of all, looking again for a beat that starts meanwhile', async () => {
    vi.useFakeTimers();
    let anims = [playing(400), playing(1000)];
    const root = { getAnimations: () => anims } as unknown as Element;
    let settled = false;
    void animationsSettled(root, UNLOCK_AT).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(500);
    anims = [...anims, playing(1000)]; // a crash set off by the ram, at 500
    await vi.advanceTimersByTimeAsync(899);
    expect(settled, 'the crash is 89.9% through').toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  it('a beat already 90% through holds nothing', async () => {
    vi.useFakeTimers();
    const ram = playing(1000);
    await vi.advanceTimersByTimeAsync(950);
    let settled = false;
    void animationsSettled({ getAnimations: () => [ram] } as unknown as Element, UNLOCK_AT).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });
  it('animationsSettled with no fraction still waits for the beat to be over', async () => {
    vi.useFakeTimers();
    const ram = playing(1000);
    let settled = false;
    void animationsSettled({ getAnimations: () => [ram] } as unknown as Element).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  it('the pacer’s wait lets go at 90% of a drawing; the board is still only once it is over (the result screen’s wait)', async () => {
    vi.useFakeTimers();
    let over!: () => void;
    noteBoardDrawing(new Promise<void>((res) => (over = res)), { endsInMs: 1000 });
    let unlocked = false;
    let still = false;
    whenBoardUnlocked(() => (unlocked = true));
    whenBoardStill(() => (still = true));
    await vi.advanceTimersByTimeAsync(899);
    expect(unlocked, 'at 89.9%').toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(unlocked, 'at 90%').toBe(true);
    expect(still, 'a bolt still in the air: the result screen waits').toBe(false);
    over();
    await vi.advanceTimersByTimeAsync(0);
    expect(still).toBe(true);
  });

  it('once its time has come, a drawing still waits for its beats running on the board to be 90% through', async () => {
    vi.useFakeTimers();
    let anims: Animation[] = [];
    const root = { getAnimations: () => anims } as unknown as Element;
    noteBoardDrawing(new Promise<void>(() => undefined), { endsInMs: 500, root });
    await vi.advanceTimersByTimeAsync(100);
    anims = [playing(1000)]; // a crash its beat set off, longer than the view said
    let unlocked = false;
    whenBoardUnlocked(() => (unlocked = true));
    await vi.advanceTimersByTimeAsync(350);
    expect(unlocked, 'the view’s own 90% has come, the crash is at 35%').toBe(false);
    await vi.advanceTimersByTimeAsync(549);
    expect(unlocked).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(unlocked, 'the crash is 90% through').toBe(true);
  });

  it('a drawing over before its 90% lets go at once; one with no length is locked until it is over', async () => {
    vi.useFakeTimers();
    let over!: () => void;
    noteBoardDrawing(new Promise<void>((res) => (over = res)), { endsInMs: 1000 });
    let unlocked = false;
    whenBoardUnlocked(() => (unlocked = true));
    over();
    await vi.advanceTimersByTimeAsync(0);
    expect(unlocked, 'cut short (a board taken down)').toBe(true);
    let done!: () => void;
    noteBoardDrawing(new Promise<void>((res) => (done = res)));
    let later = false;
    whenBoardUnlocked(() => (later = true));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(later).toBe(false);
    done();
    await vi.advanceTimersByTimeAsync(0);
    expect(later).toBe(true);
  });
});

describe('how heavy a hit is', () => {
  // AF420 (2026-10-27): the spell-damage preview put the cap back at twenty — the ten-point scale
  // (ledger AF149) left a spell's biggest hits all looking the same size — as one constant every
  // damage effect shares, creature combat blows included.
  it('a point is the lightest, TWENTY and anything above the heaviest, and the middle climbs fast', () => {
    expect(MAX_DAMAGE).toBe(20);
    expect(damagePower(1)).toBe(0);
    expect(damagePower(5)).toBeCloseTo(Math.sqrt(4 / 19), 5);
    expect(damagePower(10)).toBeCloseTo(Math.sqrt(9 / 19), 5);
    expect(damagePower(20)).toBe(1);
    expect(damagePower(30), 'damage above the cap is no heavier than the cap itself').toBe(damagePower(20));
    expect(damagePower(0)).toBe(0);
  });
  it('powerSize (a creature landing’s own curve, `entries.ts`) is four fifths for nothing and 1.9 times at full power — untouched by AF420’s bigger damage scale', () => {
    expect(powerSize(0)).toBeCloseTo(0.8, 5);
    expect(powerSize(1)).toBeCloseTo(1.9, 5);
  });
  it('damageSize (a spell’s ball and burst, a combat blow’s crash) is four fifths for a point and two and a half at twenty and beyond', () => {
    expect(damageSize(damagePower(1))).toBeCloseTo(0.8, 5);
    expect(damageSize(damagePower(5))).toBeCloseTo(0.8 + 1.7 * Math.sqrt(4 / 19), 5);
    expect(damageSize(damagePower(10))).toBeCloseTo(0.8 + 1.7 * Math.sqrt(9 / 19), 5);
    expect(damageSize(damagePower(20))).toBeCloseTo(2.5, 5);
    expect(damageSize(damagePower(30)), 'damage above the cap is no bigger than the cap itself').toBe(damageSize(damagePower(20)));
  });
});

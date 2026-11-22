// @vitest-environment jsdom
/*
 * The stage: its stillness is what it is drawing having finished — its drawings, then its beats — never a
 * clock; its unlock is each drawing's `unlockAt`. And `afterGlide`: a stand-in's glide ends when its own
 * `left`/`top` transitions have finished, not when a clock started at the style change says so.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { animate, at, hold, markTempo, moment, quicken, runningOf, STILL, TEMPO_PROPERTY, together, type MotionContext, type Running } from './animate.ts';
import { Stage, type TrackOptions } from './stage.ts';
import { afterGlide } from './stand-in.ts';

const GLIDE_MS = 300;
const UNLOCK_AT = 0.9;
const stage = new Stage({ unlockAt: UNLOCK_AT });
/** `anim` is one of `on`'s beats, as `animate()` with a stage registers it. */
const register = <T extends Animation>(anim: T, on = stage): T => (on.beat(runningOf([anim])), anim);
const animationsSettled = (root: Element, through?: number): Promise<void> => stage.settled(root, through);
const whenBoardStill = (done: () => void): (() => void) => stage.whenStill(done);
const whenBoardUnlocked = (done: () => void): (() => void) => stage.whenUnlocked(done);
/** A drawing of `endsInMs` (endless when not given) settling with `over`. */
const noteBoardDrawing = (over: Promise<void>, o?: TrackOptions & { endsInMs: number }): Running => stage.track({ finished: over, cancel: () => undefined, endsInMs: o?.endsInMs ?? Infinity }, o);

afterEach(() => {
  vi.useRealTimers();
});

/** Fake timers with the page's frames among them: a look at the board's beats runs in the next frame (every 16 ms). */
const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
/** A frame: how long after its time a look at the board's beats may come. */
const FRAME = 16;

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

/** Every microtask queued so far, and those they queue (a settled transition's `finished`, and `afterGlide`'s look after it), and a frame. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  // A look at the board's beats waits for the next frame.
  await new Promise<void>((frame) => requestAnimationFrame(() => frame()));
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
    afterGlide(el, done, GLIDE_MS);
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
    afterGlide(el, done, GLIDE_MS);
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
    afterGlide(el, done, GLIDE_MS);
    expect(done, 'never synchronously').not.toHaveBeenCalled();
    await settle();
    expect(done).toHaveBeenCalledTimes(1);
    const cancelled = vi.fn();
    afterGlide(el, cancelled, GLIDE_MS)();
    await settle();
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('a document that cannot list its animations falls back to GLIDE_MS', () => {
    fakeTimers();
    const el = document.createElement('div');
    Object.defineProperty(el, 'getAnimations', { value: undefined });
    const done = vi.fn();
    afterGlide(el, done, GLIDE_MS);
    vi.advanceTimersByTime(GLIDE_MS - 1);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(1);
  });
});

/** An animation the test finishes by hand, with how long its timing says it runs: one of `stage`'s beats, unless named (a stylesheet's, on `target`). */
function running(endTime: number, name?: { animationName?: string; transitionProperty?: string }, target: Element | null = null): { anim: Animation; end: () => void } {
  let resolve!: () => void;
  const finished = new Promise<void>((res) => (resolve = res));
  const anim = { playState: 'running', finished, effect: { getComputedTiming: () => ({ endTime }), target }, id: '', ...name } as unknown as Animation;
  if (name === undefined) register(anim);
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

  it('a stage waits for its beats only (registered, and the stylesheet animations trackCss names): a turn banner, a card’s own glint or a glide holds nothing', async () => {
    const named = new Stage();
    const number = document.createElement('div');
    const face = number.appendChild(document.createElement('span'));
    named.trackCss(number, 'board-number-');
    const ram = running(1200);
    register(ram.anim, named);
    const rise = running(900, { animationName: 'board-number-rise' }, face);
    const glint = running(950, { animationName: 'pt-glint-up' }, face);
    const banner = running(2400, { animationName: 'board-number-rise' }, document.createElement('div'));
    const glide = running(300, { transitionProperty: 'left' }, number);
    let anims = [ram.anim, rise.anim, glint.anim, banner.anim, glide.anim];
    const root = { getAnimations: () => anims } as unknown as Element;
    let settled = false;
    void named.settled(root).then(() => (settled = true));
    await settle();
    expect(named.waitingOn(), 'what the board waits on, by name').toBe('unnamed×1 board-number-rise×1');
    ram.end();
    anims = [rise.anim, glint.anim, banner.anim, glide.anim];
    await settle();
    expect(settled, 'the number still rises').toBe(false);
    rise.end();
    anims = [glint.anim, banner.anim, glide.anim];
    await settle();
    expect(settled, 'the glint, the banner off the tracked element and the glide are not beats').toBe(true);
    expect(named.waitingOn()).toBe('');
  });
});

describe('unlocking on the last tenth of a beat (the operator, 2026-10-28)', () => {
  /** A beat on the page's clock: `currentTime` follows the fake timers from `startedAt`, at `rate`. */
  function playing(endTime: number, rate = 1): Animation {
    const startedAt = Date.now();
    const anim = {
      id: '',
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
    return register(anim as unknown as Animation);
  }

  it('animationsSettled at UNLOCK_AT settles once the beat is 90% through, while it still plays', async () => {
    fakeTimers();
    const ram = playing(1000);
    const root = { getAnimations: () => [ram] } as unknown as Element;
    let settled = false;
    void animationsSettled(root, UNLOCK_AT).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(899);
    expect(settled, 'at 89.9%').toBe(false);
    await vi.advanceTimersByTimeAsync(FRAME);
    expect(settled, 'at 90%, within a frame').toBe(true);
    expect(ram.playState, 'the beat itself plays on to its end').toBe('running');
  });

  it('respects the beat’s playback rate', async () => {
    fakeTimers();
    const fast = playing(1000, 2);
    const root = { getAnimations: () => [fast] } as unknown as Element;
    let settled = false;
    void animationsSettled(root, UNLOCK_AT).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(449);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(FRAME);
    expect(settled, 'twice as fast: 90% at 450 ms').toBe(true);
  });

  it('waits for the latest 90% of all, looking again for a beat that starts meanwhile', async () => {
    fakeTimers();
    let anims = [playing(400), playing(1000)];
    const root = { getAnimations: () => anims } as unknown as Element;
    let settled = false;
    void animationsSettled(root, UNLOCK_AT).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(500);
    anims = [...anims, playing(1000)]; // a crash set off by the ram, at 500
    await vi.advanceTimersByTimeAsync(899);
    expect(settled, 'the crash is 89.9% through').toBe(false);
    await vi.advanceTimersByTimeAsync(FRAME);
    expect(settled).toBe(true);
  });

  it('every wait on one board shares its looks: a burst of views waiting at once lists the board’s animations once a round, each settling at its own fraction', async () => {
    fakeTimers();
    const ram = playing(1000);
    let lists = 0;
    const root = {
      getAnimations: () => {
        lists += 1;
        return [ram];
      },
    } as unknown as Element;
    const unlocked: number[] = [];
    const over: number[] = [];
    for (let i = 0; i < 20; i++) {
      void animationsSettled(root, UNLOCK_AT).then(() => unlocked.push(Date.now()));
      void animationsSettled(root).then(() => over.push(Date.now()));
    }
    await vi.advanceTimersByTimeAsync(FRAME);
    expect(lists, 'forty waits in one task: one look').toBe(1);
    await vi.advanceTimersByTimeAsync(900);
    expect(unlocked, 'every unlock at 90%').toHaveLength(20);
    expect(over, 'none over yet').toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(over, 'every end at 100%').toHaveLength(20);
    expect(lists, 'one look a round: now, at 90%, at the end').toBe(3);
  });

  it('a beat already 90% through holds nothing', async () => {
    fakeTimers();
    const ram = playing(1000);
    await vi.advanceTimersByTimeAsync(950);
    let settled = false;
    void animationsSettled({ getAnimations: () => [ram] } as unknown as Element, UNLOCK_AT).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(FRAME);
    expect(settled).toBe(true);
  });
  it('animationsSettled with no fraction still waits for the beat to be over', async () => {
    fakeTimers();
    const ram = playing(1000);
    let settled = false;
    void animationsSettled({ getAnimations: () => [ram] } as unknown as Element).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(FRAME);
    expect(settled).toBe(true);
  });

  it('the pacer’s wait lets go at 90% of a drawing; the board is still only once it is over (the result screen’s wait)', async () => {
    fakeTimers();
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
    fakeTimers();
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
    await vi.advanceTimersByTimeAsync(FRAME);
    expect(unlocked, 'the crash is 90% through').toBe(true);
  });

  it('a drawing over before its 90% lets go at once; one with no length is locked until it is over', async () => {
    fakeTimers();
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

describe('Running and the stage', () => {
  it('markTempo writes the property every beat sheet divides by; quicken plays an animation that much faster', () => {
    const el = document.createElement('div');
    markTempo(el, 2.25);
    expect(el.style.getPropertyValue(TEMPO_PROPERTY)).toBe('2.25');
    const anim = { playbackRate: 1 } as Animation;
    expect(quicken(anim, 1.5).playbackRate).toBe(1.5);
    expect(quicken({ playbackRate: 1 } as Animation, 1).playbackRate).toBe(1);
  });

  /** A Web Animation stand-in: `finish()` ends it; its timing says it runs `endTime` at `rate`. */
  function anim(endTime: number): Animation & { finish: () => void } {
    let resolve!: () => void;
    const a = {
      id: '',
      playbackRate: 1,
      currentTime: 0,
      playState: 'running',
      effect: { getComputedTiming: () => ({ endTime }) },
      finished: new Promise<void>((res) => (resolve = res)),
      cancel: vi.fn(() => resolve()),
      finish: () => {
        a.playState = 'finished';
        resolve();
      },
    };
    return a as unknown as Animation & { finish: () => void };
  }

  it('animate is already over where the page has no Web Animations, or motion is reduced', () => {
    const el = document.createElement('div');
    expect(animate(el, [{ opacity: 0 }], { duration: 100 })).toBe(STILL);
    const played = vi.fn(() => anim(100));
    Object.defineProperty(el, 'animate', { value: played });
    expect(animate(el, [{ opacity: 0 }], { duration: 100 }, { reduced: true })).toBe(STILL);
    expect(played).not.toHaveBeenCalled();
  });

  it('animate plays at the tempo, its end in wall time, and with a stage is one of its beats', () => {
    const el = document.createElement('div');
    const a = anim(1000);
    Object.defineProperty(el, 'animate', { value: () => a });
    const own = new Stage();
    const r = animate(el, [{ opacity: 0 }], { duration: 1000 }, { tempo: 2, stage: own });
    expect(a.playbackRate).toBe(2);
    expect(r.endsInMs).toBe(500);
    expect(own.isBeat(a), 'registered, not recognised by name').toBe(true);
    expect(new Stage().isBeat(a), 'another stage’s beat is not this one’s').toBe(false);
  });

  it('runningOf is over once every animation is, and cancels them together', async () => {
    const a = anim(200);
    const b = anim(400);
    const r = runningOf([a, b]);
    expect(r.endsInMs).toBe(400);
    let over = false;
    void r.finished.then(() => (over = true));
    a.finish();
    await settle();
    expect(over).toBe(false);
    r.cancel();
    await settle();
    expect(b.cancel).toHaveBeenCalledTimes(1);
    expect(over).toBe(true);
  });

  it('trackCss names an element’s stylesheet beats: by keyframes, on it and inside it, set off before or after', () => {
    const el = document.createElement('div');
    const inner = el.appendChild(document.createElement('i'));
    const css = (animationName: string, target: Element) => ({ animationName, effect: { target } }) as unknown as Animation;
    const own = new Stage();
    own.trackCss(el, 'board-exit-');
    own.trackCss(el, 'placed-');
    expect([css('board-exit-shard', inner), css('placed-resolve', el), css('pt-glint-up', inner), css('board-exit-shard', document.body)].map((a) => own.isBeat(a))).toEqual([true, true, false, false]);
    expect(new Stage().isBeat(css('board-exit-shard', inner)), 'another stage’s').toBe(false);
  });

  it('a stage attached to a board is found from anything on it, and only while attached', () => {
    const board = document.createElement('div');
    const card = board.appendChild(document.createElement('div')).appendChild(document.createElement('div'));
    const own = new Stage();
    const detach = own.attach(board);
    expect(Stage.of(card)).toBe(own);
    expect(Stage.of(document.createElement('div'))).toBeUndefined();
    detach();
    expect(Stage.of(card)).toBeUndefined();
  });

  it('a tracked Running holds the stage until it is over, and unlocks at its unlockAt', async () => {
    fakeTimers();
    const own = new Stage({ unlockAt: 0.5 });
    let end!: () => void;
    const r: Running = { finished: new Promise<void>((res) => (end = res)), cancel: () => undefined, endsInMs: 1000 };
    own.track(r);
    expect(own.drawingCount).toBe(1);
    let unlocked = false;
    let still = false;
    own.whenUnlocked(() => (unlocked = true));
    own.whenStill(() => (still = true));
    await vi.advanceTimersByTimeAsync(499);
    expect(unlocked).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect([unlocked, still]).toEqual([true, false]);
    end();
    await vi.advanceTimersByTimeAsync(0);
    expect([still, own.drawingCount]).toEqual([true, 0]);
  });

  it('a cue belongs to the drawing that set it: another asks and gets null', () => {
    const own = new Stage();
    own.cue('life', 7, 1234);
    own.cue<readonly string[]>('sounds', 7, ['hit']);
    expect(own.cueAt('life', 7)).toBe(1234);
    expect(own.cueAt('life', 6)).toBeNull();
    expect(own.cueAt<readonly string[]>('sounds', 7)).toEqual(['hit']);
    own.cue('life', 8, 99);
    expect(own.cueAt('life', 7), 'one per name: the latest drawing’s').toBeNull();
  });
});

describe('a timeline: at, moment, hold, together', () => {
  const ctx = (tempo: number): MotionContext => ({ tempo }) as MotionContext;

  it('a timeline’s length comes from its parts, on its clock, and each part runs at its moment', async () => {
    fakeTimers();
    const log: string[] = [];
    const t0 = Date.now();
    const mark = (what: string, ms = 0) => moment(() => log.push(`${what}@${Date.now() - t0}`), ms);
    const clip = at(400, mark('hit', 850));
    expect(clip.ms).toBe(1250);
    const r = together([mark('now')(ctx(2)), clip(ctx(2)), at(100, mark('second'))(ctx(2)), hold(300)(ctx(2))]);
    expect(r.endsInMs, 'at tempo 2, half as long').toBe(625);
    expect(log, 'a part with nothing before it runs at once').toEqual(['now@0']);
    let over = false;
    void r.finished.then(() => (over = true));
    await vi.advanceTimersByTimeAsync(624);
    expect(log).toEqual(['now@0', 'second@50', 'hit@200']);
    expect(over).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(over).toBe(true);
  });

  it('cancelled, a part still to come never runs, and the whole is over at once', async () => {
    fakeTimers();
    const ran = vi.fn();
    const r = together([at(500, moment(ran, 200))(ctx(1)), hold(100)(ctx(1))]);
    let over = false;
    void r.finished.then(() => (over = true));
    r.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(over).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ran).not.toHaveBeenCalled();
  });
});

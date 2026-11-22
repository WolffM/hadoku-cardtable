/*
 * `animate()`, the one `.animate()` call a game needs, and `Running`, the one shape every motion hands back.
 * Effects take a `MotionContext` instead of reading globals.
 */

import type { everyFrame } from './frame.ts';
import type { ParticlePool } from './particles.ts';
import type { Stage } from './stage.ts';

/** A motion under way: settles (never rejects) once it is over or cancelled, and is meant to last `endsInMs` from when it was made. */
export interface Running {
  readonly finished: Promise<void>;
  cancel(): void;
  readonly endsInMs: number;
}

/** A motion not yet started: what a recipe is, given where and how to play. */
export type Clip = (ctx: MotionContext) => Running;

export interface MotionContext {
  stage: Stage;
  overlay: HTMLElement;
  /** Every length is divided by it ({@link quicken}, {@link markTempo}). */
  tempo: number;
  reduced: boolean;
  frame: typeof everyFrame;
  particles: ParticlePool;
}

export type AnimateContext = Partial<Pick<MotionContext, 'tempo' | 'reduced' | 'stage'>>;

/** A motion that is already over: reduced motion's, or one with nothing to move. */
export const STILL: Running = { finished: Promise.resolve(), cancel: () => undefined, endsInMs: 0 };

/** The Web Animations a {@link runningOf} plays, for a stage to count as beats. */
const ANIMATIONS = new WeakMap<Running, readonly Animation[]>();
export const animationsOf = (r: Running): readonly Animation[] => ANIMATIONS.get(r) ?? [];

/** `anims` as one {@link Running}: over once every one is, cancelled together. */
export function runningOf(anims: readonly Animation[]): Running {
  if (anims.length === 0) return STILL;
  const ends = anims.map((a) => (Number(a.effect?.getComputedTiming().endTime ?? 0) - Number(a.currentTime ?? 0)) / (Math.abs(a.playbackRate) || 1));
  const r: Running = {
    finished: Promise.allSettled(anims.map((a) => a.finished)).then(() => undefined),
    cancel: () => {
      for (const a of anims) a.cancel();
    },
    endsInMs: Math.max(0, ...ends),
  };
  ANIMATIONS.set(r, anims);
  return r;
}

/** A layer's timers: `after` runs `fn` in `ms`, unless `clear` (the layer taken down) came first; after it, none starts. */
export function timerSet(): { after: (fn: () => void, ms: number) => void; clear: () => void } {
  const due = new Set<ReturnType<typeof setTimeout>>();
  let open = true;
  return {
    after: (fn, ms) => {
      if (!open) return;
      const timer = setTimeout(() => (due.delete(timer), fn()), ms);
      due.add(timer);
    },
    clear: () => {
      open = false;
      due.forEach(clearTimeout);
    },
  };
}

/** A clip and how long it lasts on its own clock (before `ctx.tempo` divides it): what a timeline adds up. */
export type Timed = Clip & { readonly ms: number };

/** The `runs` as one: over once every one is, cancelled together, as long as the longest. */
export const together = (runs: readonly Running[]): Running => ({
  finished: Promise.all(runs.map((r) => r.finished)).then(() => undefined),
  cancel: () => runs.forEach((r) => r.cancel()),
  endsInMs: Math.max(0, ...runs.map((r) => r.endsInMs)),
});

/** `clip` `ms` from now on its clock, at once for none: cancelled before then, it never starts, and is over. */
export function at(ms: number, clip: Timed): Timed {
  if (ms <= 0) return clip;
  return Object.assign((ctx: MotionContext): Running => {
    let started: Running | null = null;
    let stop = (): void => undefined;
    const finished = new Promise<void>((over) => {
      const timer = setTimeout(() => void (started = clip(ctx)).finished.then(over), ms / ctx.tempo);
      stop = () => (clearTimeout(timer), over());
    });
    return { finished, cancel: () => (started === null ? stop() : started.cancel()), endsInMs: (ms + clip.ms) / ctx.tempo };
  }, { ms: ms + clip.ms });
}

/** Nothing, `ms` long: a part a timeline waits for that something else draws. */
export const hold = (ms: number): Timed => at(ms, Object.assign(() => STILL, { ms: 0 }));

/** `fn` as a clip `ms` long: what it sets off plays on its own, and the clip is over once that long is. */
export const moment = (fn: () => void, ms = 0): Timed => Object.assign((ctx: MotionContext) => (fn(), hold(ms)(ctx)), { ms });

/** `el.animate(frames, options)` at `ctx.tempo`: already over without Web Animations (jsdom) or when `ctx.reduced`; with `ctx.stage`, one of its beats. */
export function animate(el: Element, frames: Keyframe[] | PropertyIndexedKeyframes, options: KeyframeAnimationOptions, ctx: AnimateContext = {}): Running {
  if (ctx.reduced === true || typeof (el as HTMLElement).animate !== 'function') return STILL;
  const r = runningOf([quicken((el as HTMLElement).animate(frames, options), ctx.tempo ?? 1)]);
  ctx.stage?.beat(r);
  return r;
}

/** The custom property every beat's sheet divides its lengths by. */
export const TEMPO_PROPERTY = '--tempo';

/** `el` animates at `tempo`: its sheet's lengths, and its children's, divide by it. */
export const markTempo = (el: Element, tempo: number): void => (el as HTMLElement).style.setProperty(TEMPO_PROPERTY, String(tempo));

/** `anim` plays at `tempo`, its delay and duration both. Returns it. */
export function quicken<T extends Animation>(anim: T, tempo: number): T {
  if (tempo !== 1) anim.playbackRate = tempo;
  return anim;
}

/**
 * The pace of a move of `weight` (0 to 1), always the same length: at 0 nearly even (half speed to one and a
 * half), at 1 a creep that ends at about nine times its average speed, so a heavy one lands harder.
 */
export function weightEase(weight: number): string {
  const p = Math.min(1, Math.max(0, weight));
  const x1 = 0.4 + 0.52 * p;
  const y1 = 0.2 * (1 - p);
  const x2 = 0.75 + 0.2 * p;
  const y2 = 0.6 - 0.05 * p;
  return `cubic-bezier(${x1.toFixed(3)}, ${y1.toFixed(3)}, ${x2.toFixed(3)}, ${y2.toFixed(3)})`;
}

/** The way home at `weight`: the same length, setting off slower the heavier, always settling gently into place. */
export function homeEase(weight: number): string {
  const p = Math.min(1, Math.max(0, weight));
  return `cubic-bezier(${(0.3 + 0.45 * p).toFixed(3)}, 0, 0.25, 1)`;
}

/** Writes each `[name, ms]` on `el` as `<ms>ms` for a sheet's `var()`: a length is written once, by what times it. */
export function writeDurations(el: HTMLElement, durations: readonly (readonly [string, number])[]): void {
  for (const [name, ms] of durations) el.style.setProperty(name, `${ms}ms`);
}

/*
 * A board's stage: what it is drawing, for what waits on that. It is STILL once every tracked drawing is over
 * (`whenStill`: a game's end) and UNLOCKED once each is `unlockAt` through (`whenUnlocked`: a pacer's wait),
 * the motion playing on to its end. A real-time game asks for neither.
 *
 * Its waits look at its beats, the animations registered with it (`beat`, `animate()` with a stage, and the
 * stylesheet animations `trackCss` names); an endless pulse, a banner or a glide is no beat. Cues are moments a
 * drawing tells the page about (its first hit, a sound's moment): one per name, keyed by the drawing's number.
 * A board's stage is attached to its element (`attach`), where what draws on it finds it (`Stage.of`).
 */

import { animationsOf, type Running } from './animate.ts';

/** `unlockAt`: how far through its drawings the stage unlocks (1: once over). */
export interface StageOptions {
  unlockAt?: number;
}

/** `root`: where its beats run, each still running there at its time waited for to `unlockAt`. `after`: not unlocked before it settles. */
export interface TrackOptions {
  root?: Element;
  after?: Promise<unknown>;
}

/** What a held frame was waiting on: the drawings, the beats by name, when the last drawing began. */
export type StageHold = { drawing: number; waitingOn: string; lastBeatAt: number | null };

/** An animation's name: its id, a stylesheet animation's keyframes, or the property a transition moves. */
export function animationName(a: Animation): string {
  const named = a as Animation & { animationName?: string; transitionProperty?: string };
  if (typeof named.animationName === 'string' && named.animationName !== '') return named.animationName;
  if (typeof named.transitionProperty === 'string' && named.transitionProperty !== '') return `transition:${named.transitionProperty}`;
  return a.id === '' ? 'unnamed' : a.id;
}

/** A beat as one look read it. */
type BeatAt = { anim: Animation; end: number; at: number; rate: number };
const untilThrough = (b: BeatAt, through: number): number => Math.max(0, (through * b.end - b.at) / b.rate);

/**
 * One root's waits and its one look at them: listing a root's animations brings the page's style up to date,
 * so a burst of waits shares a look a round, and each beat's timing is read once.
 */
type RootBeats = { waits: Set<{ through: number; settle: () => void }>; queued: boolean; timer: ReturnType<typeof setTimeout> | null; watched: WeakSet<Animation> };

/** How long a look waits for a frame before running without one: a hidden tab draws none. */
const FRAME_FALLBACK_MS = 100;

/** A set of holds and who waits for it to empty. */
class Holds {
  private readonly held = new Set<Promise<void>>();
  private readonly waiters = new Set<() => void>();

  readonly size = (): number => this.held.size;

  add(until: Promise<void>): void {
    this.held.add(until);
    void until.then(() => {
      this.held.delete(until);
      if (this.held.size > 0) return;
      for (const wake of [...this.waiters]) {
        this.waiters.delete(wake);
        wake();
      }
    });
  }

  whenEmpty(done: () => void): () => void {
    if (this.held.size === 0) {
      done();
      return () => undefined;
    }
    this.waiters.add(done);
    return () => void this.waiters.delete(done);
  }
}

/** Each attached element's stage. */
const STAGES = new WeakMap<Element, Stage>();

export class Stage {
  readonly unlockAt: number;
  private readonly drawing = new Holds();
  private readonly locked = new Holds();
  private readonly registered = new WeakSet<Animation>();
  /** The elements whose stylesheet animations are beats, each with the names they start with. */
  private readonly css = new WeakMap<Element, string[]>();
  private readonly roots = new Map<Element, RootBeats>();
  private readonly cues = new Map<string, { seq: number; value: unknown }>();
  private lastBeatAt: number | null = null;
  private waiting: readonly Animation[] = [];

  constructor(options: StageOptions = {}) {
    this.unlockAt = options.unlockAt ?? 1;
  }

  /** The stage of the board `el` is on: the nearest element up from it that one is attached to. */
  static of(el: Element | null): Stage | undefined {
    for (let at = el; at !== null; at = at.parentElement) {
      const stage = STAGES.get(at);
      if (stage !== undefined) return stage;
    }
    return undefined;
  }

  /** What draws inside `el` draws on this stage. Returns the detach. */
  attach(el: Element): () => void {
    STAGES.set(el, this);
    return () => void (STAGES.get(el) === this && STAGES.delete(el));
  }

  /** `r`'s animations are this stage's beats. Returns `r`. */
  beat(r: Running): Running {
    for (const a of animationsOf(r)) this.registered.add(a);
    return r;
  }

  /**
   * The stylesheet animations named `prefix…` on `el` and inside it, whenever they run, are beats: a card's own
   * glint or shimmer inside it is not, nor a transition. Read at each look, so one set off later counts too.
   */
  trackCss(el: Element, prefix: string): void {
    const prefixes = this.css.get(el);
    if (prefixes === undefined) this.css.set(el, [prefix]);
    else if (!prefixes.includes(prefix)) prefixes.push(prefix);
  }

  /** The stage draws `r`: busy until it is over, locked until it is `unlockAt` through its `endsInMs` (an endless one: over). */
  track(r: Running, o: TrackOptions = {}): Running {
    this.beat(r);
    this.lastBeatAt = Date.now();
    let done = false;
    const settled = r.finished.then(() => void (done = true), () => void (done = true));
    this.drawing.add(settled);
    const unlocked = new Promise<void>((at) => {
      if (!Number.isFinite(r.endsInMs)) return;
      const look = (): void => (done || o.root === undefined ? at() : void this.settled(o.root, this.unlockAt).then(at));
      setTimeout(() => void Promise.resolve(o.after).then(look, look), Math.round(r.endsInMs * this.unlockAt));
    });
    this.locked.add(Promise.race([settled, unlocked]));
    return r;
  }

  get drawingCount(): number {
    return this.drawing.size();
  }

  held(): StageHold {
    return { drawing: this.drawing.size(), waitingOn: this.waitingOn(), lastBeatAt: this.lastBeatAt };
  }

  /** Runs `done` once nothing tracked plays, at once when still. Returns a cancel. */
  whenStill(done: () => void): () => void {
    return this.drawing.whenEmpty(done);
  }

  /** Runs `done` once everything tracked is `unlockAt` through, at once when it is. Returns a cancel. */
  whenUnlocked(done: () => void): () => void {
    return this.locked.whenEmpty(done);
  }

  /** Drawing `seq`'s moment `name` is `value` (an epoch ms, or what the cue carries). */
  cue<T = number>(name: string, seq: number, value: T): void {
    this.cues.set(name, { seq, value });
  }

  /** Drawing `seq`'s moment `name`, or null when it had none. */
  cueAt<T = number>(name: string, seq: number): T | null {
    const c = this.cues.get(name);
    return c !== undefined && c.seq === seq ? (c.value as T) : null;
  }

  isBeat(a: Animation): boolean {
    if (this.registered.has(a)) return true;
    const name = (a as Animation & { animationName?: string }).animationName;
    if (typeof name !== 'string') return false;
    for (let at = (a.effect as KeyframeEffect | null)?.target ?? null; at !== null; at = at.parentElement) {
      if (this.css.get(at)?.some((prefix) => name.startsWith(prefix)) === true) return true;
    }
    return false;
  }

  /** The beats still waited on, by name (`unnamed×2 board-number-rise×1`: a script animation has none). */
  waitingOn(): string {
    const counts = new Map<string, number>();
    for (const a of this.waiting) if (a.playState !== 'finished' && a.playState !== 'idle') counts.set(animationName(a), (counts.get(animationName(a)) ?? 0) + 1);
    return [...counts].map(([name, n]) => `${name}×${n}`).join(' ');
  }

  /** Settles once every finite beat on `root` and inside it is `through` of the way through, looking again as each comes due (one may start another). */
  settled(root: Element, through = 1): Promise<void> {
    return new Promise((resolve) => {
      if (typeof root.getAnimations !== 'function') return resolve();
      let beats = this.roots.get(root);
      if (beats === undefined) this.roots.set(root, (beats = { waits: new Set(), queued: false, timer: null, watched: new WeakSet() }));
      beats.waits.add({ through, settle: resolve });
      this.lookSoon(root, beats);
    });
  }

  /** A look in the next frame, before it is drawn (its style pass is then done once), unless one is coming. */
  private lookSoon(root: Element, beats: RootBeats): void {
    if (beats.queued) return;
    beats.queued = true;
    let frame: number | null = null;
    const run = (): void => {
      clearTimeout(fallback);
      if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      if (beats.queued) this.look(root, beats);
    };
    const fallback = setTimeout(run, FRAME_FALLBACK_MS);
    if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(run);
  }

  private look(root: Element, beats: RootBeats): void {
    beats.queued = false;
    if (beats.timer !== null) clearTimeout(beats.timer);
    beats.timer = null;
    const now: BeatAt[] = [];
    for (const anim of root.getAnimations({ subtree: true })) {
      // Whether it is a beat first: reading a timing is not free.
      if (!this.isBeat(anim) || anim.playState === 'finished' || anim.playState === 'idle') continue;
      const end = Number(anim.effect?.getComputedTiming().endTime ?? 0);
      if (end !== Infinity) now.push({ anim, end, at: Number(anim.currentTime ?? 0), rate: Math.abs(anim.playbackRate) || 1 });
    }
    const holding = new Set<BeatAt>();
    let soonest = Infinity;
    for (const wait of [...beats.waits]) {
      const left = now.filter((b) => untilThrough(b, wait.through) > 0);
      if (left.length === 0) {
        beats.waits.delete(wait);
        wait.settle();
      }
      for (const b of left) {
        holding.add(b);
        soonest = Math.min(soonest, untilThrough(b, wait.through));
      }
    }
    this.waiting = [...holding].map((b) => b.anim);
    if (beats.waits.size === 0) return void this.roots.delete(root);
    // Again as soon as one is far enough through, or one ends early (cancelled, its element gone).
    beats.timer = setTimeout(() => this.lookSoon(root, beats), soonest);
    for (const b of holding) {
      if (beats.watched.has(b.anim)) continue;
      beats.watched.add(b.anim);
      const again = (): void => this.lookSoon(root, beats);
      void b.anim.finished.then(again, again);
    }
  }
}
